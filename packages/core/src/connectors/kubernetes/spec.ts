// The operational spec of a Kubernetes object, normalized for comparison
// (ADR-270): what decides whether the workload runs and is reachable, without
// status, server-managed metadata, or anything secret. Pure: no fetch, no graph.
//
// Every list the API keys by name (containers, env, ports, volumes, volume
// mounts) becomes a map keyed by that name, so a change reads by name. Removing
// one env var from a positional list shifts every later entry and reads as a
// dozen renames; keyed, it is one removed key. A name that repeats (an env var
// defined twice, the shadowing shape) keeps every definition: the second is
// keyed `NAME#2`.
//
// Values pass the same redaction the process context uses (ADR-237): an env or
// arg whose name is a secret is masked whole, credential URLs are masked by shape,
// a secretKeyRef is a reference descriptor and never resolved. ConfigMap and
// Secret data are recorded as key → sha256, never the value.

import { createHash } from 'node:crypto'
import type { ConfigMap, Container, Deployment, PodSpec, Service } from './types.js'
import { describeEnvVar, redactArg, redactText } from './process-context.js'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// A JSON-safe copy with undefined dropped, for the free-form sub-objects
// (resources, probes, affinity) the API owns the shape of.
function plain(v: unknown): Json | undefined {
  if (v === undefined) return undefined
  if (v === null || typeof v === 'boolean' || typeof v === 'number') return v
  if (typeof v === 'string') return redactText(v)
  if (Array.isArray(v)) return v.map((x) => plain(x) ?? null)
  if (isObj(v)) {
    const out: Record<string, Json> = {}
    for (const [k, x] of Object.entries(v)) {
      const p = plain(x)
      if (p !== undefined) out[k] = p
    }
    return out
  }
  return undefined
}

// A list keyed by each entry's name; repeats keep their order as NAME#2, NAME#3.
function keyed<T>(items: readonly T[] | undefined, nameOf: (t: T, i: number) => string, body: (t: T) => Json): Record<string, Json> | undefined {
  if (!items || items.length === 0) return undefined
  const out: Record<string, Json> = {}
  const seen = new Map<string, number>()
  items.forEach((t, i) => {
    const base = nameOf(t, i)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    out[n === 1 ? base : `${base}#${n}`] = body(t)
  })
  return out
}

function set(out: Record<string, Json>, key: string, v: Json | undefined): void {
  if (v !== undefined && !(isObj(v) && Object.keys(v).length === 0)) out[key] = v
}

function containerSpec(c: Container): Json {
  const out: Record<string, Json> = {}
  set(out, 'image', c.image)
  set(out, 'command', c.command?.map((a) => redactArg(a)))
  set(out, 'args', c.args?.map((a) => redactArg(a)))
  set(
    out,
    'env',
    keyed(
      c.env,
      (e, i) => e.name ?? `#${i}`,
      (e) => {
        const d = describeEnvVar(e)
        return d === undefined ? null : d.slice(d.indexOf('=') + 1)
      },
    ),
  )
  set(out, 'envFrom', plain(c.envFrom))
  set(
    out,
    'ports',
    keyed(
      c.ports,
      (p, i) => p.name ?? String(p.containerPort ?? `#${i}`),
      (p) => plain({ containerPort: p.containerPort, protocol: p.protocol }) ?? null,
    ),
  )
  set(out, 'resources', plain(c.resources))
  set(out, 'livenessProbe', plain(c.livenessProbe))
  set(out, 'readinessProbe', plain(c.readinessProbe))
  set(out, 'startupProbe', plain(c.startupProbe))
  set(
    out,
    'volumeMounts',
    keyed(c.volumeMounts, (m, i) => m.name ?? `#${i}`, (m) => plain({ mountPath: m.mountPath, subPath: m.subPath, readOnly: m.readOnly }) ?? null),
  )
  set(out, 'securityContext', plain(c.securityContext))
  return out
}

function podSpec(s: PodSpec | undefined): Json | undefined {
  if (!s) return undefined
  const out: Record<string, Json> = {}
  set(out, 'containers', keyed(s.containers, (c, i) => c.name ?? `#${i}`, containerSpec))
  set(out, 'initContainers', keyed(s.initContainers, (c, i) => c.name ?? `#${i}`, containerSpec))
  set(out, 'volumes', keyed(s.volumes, (v, i) => (isObj(v) && typeof v['name'] === 'string' ? v['name'] : `#${i}`), (v) => {
    if (!isObj(v)) return null
    const { name: _name, ...source } = v
    return plain(source) ?? null
  }))
  for (const k of ['nodeSelector', 'affinity', 'tolerations', 'serviceAccountName', 'securityContext', 'hostNetwork', 'dnsPolicy', 'priorityClassName', 'schedulerName', 'nodeName', 'hostAliases', 'terminationGracePeriodSeconds'] as const) {
    set(out, k, plain((s as Record<string, unknown>)[k]))
  }
  return out
}

/** A Deployment's operational spec: replicas, selector, strategy, pod template. */
export function deploymentOperationalSpec(d: Deployment): Record<string, Json> {
  const out: Record<string, Json> = {}
  set(out, 'replicas', d.spec?.replicas ?? 1)
  set(out, 'selector', plain(d.spec?.selector))
  set(out, 'strategy', plain(d.spec?.strategy))
  set(out, 'templateLabels', plain(d.spec?.template?.metadata?.labels))
  set(out, 'template', podSpec(d.spec?.template?.spec))
  return out
}

/** A Service's operational spec, the fields #1490 records, ports keyed by name. */
export function serviceOperationalSpec(s: Service): Record<string, Json> {
  const sp = s.spec ?? {}
  const out: Record<string, Json> = {}
  set(out, 'type', sp.type ?? 'ClusterIP')
  set(out, 'selector', plain(sp.selector))
  set(out, 'internalTrafficPolicy', sp.internalTrafficPolicy)
  set(out, 'externalTrafficPolicy', sp.externalTrafficPolicy)
  set(out, 'ports', keyed(sp.ports, (p, i) => p.name ?? String(p.port ?? `#${i}`), (p) => plain({ port: p.port, targetPort: p.targetPort, protocol: p.protocol, nodePort: p.nodePort }) ?? null))
  return out
}

/** A ConfigMap's data and binaryData as key → sha256 prefix; never a value. */
export function configMapOperationalSpec(cm: ConfigMap): Record<string, Json> {
  const data: Record<string, Json> = {}
  for (const [k, v] of Object.entries(cm.data ?? {})) data[k] = sha(String(v))
  for (const [k, v] of Object.entries(cm.binaryData ?? {})) data[k] = sha(String(v))
  return { data }
}

function sha(s: string): string {
  return `sha256:${createHash('sha256').update(s).digest('hex').slice(0, 16)}`
}
