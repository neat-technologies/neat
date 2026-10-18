// The pod-template fields a config fault lives in (#1487), as `observedSpec` on
// `infra:k8s-deployment:<name>` beside #1490's container ports: DNS policy,
// priority class, scheduling constraints, security context, the rollout
// strategy, init containers, and per container its image, resources, probes and
// security context. A change against a healthy snapshot shows in the graph diff.
//
// Env never carries a value. A literal env var keeps its name only; a `valueFrom`
// keeps the name of the ConfigMap or Secret and the key it reads, never what's in
// it; `envFrom` keeps the source's name. Commands and args (init containers, exec
// probes) pass through the same redaction the process-&-config fusion uses
// (ADR-237). Field names are listed in connectors.md §10.

import type { Container, Deployment, EnvVar } from './types.js'
import { redactArgs } from './process-context.js'

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function nonEmpty(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0
  if (isObject(v)) return Object.keys(v).length > 0
  return v !== undefined
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : []
}

// A probe as the API returns it, with an exec probe's command redacted.
function probe(p: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!isObject(p)) return undefined
  const out: Record<string, unknown> = { ...p }
  const exec = p['exec']
  if (isObject(exec)) {
    const command = redactArgs(strings(exec['command']))
    out['exec'] = command.length > 0 ? { command } : {}
  }
  return out
}

// One env var by name, with where a `valueFrom` reads from; never a value.
function envRef(ev: EnvVar): Record<string, unknown> | undefined {
  const name = str(ev.name)
  if (!name) return undefined
  const from = ev.valueFrom
  if (!from) return { name }
  if (from.secretKeyRef) return { name, secret: from.secretKeyRef.name ?? '', key: from.secretKeyRef.key ?? '' }
  if (from.configMapKeyRef) return { name, configMap: from.configMapKeyRef.name ?? '', key: from.configMapKeyRef.key ?? '' }
  if (from.fieldRef) return { name, field: from.fieldRef.fieldPath ?? '' }
  if (from.resourceFieldRef) return { name, resource: from.resourceFieldRef.resource ?? '' }
  return { name }
}

function envFrom(c: Container): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(c.envFrom) || c.envFrom.length === 0) return undefined
  return c.envFrom.map((e) => {
    const out: Record<string, unknown> = {}
    if (e.configMapRef?.name) out['configMap'] = e.configMapRef.name
    if (e.secretRef?.name) out['secret'] = e.secretRef.name
    if (e.prefix) out['prefix'] = e.prefix
    return out
  })
}

function container(c: Container, init: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const name = str(c.name)
  if (name) out['name'] = name
  const image = str(c.image)
  if (image) out['image'] = image
  if (init) {
    // Command and args are one argv: redacted together, so a flag in one and its
    // value in the other (`command: [mysql]`, `args: [-psecret]`) still pair.
    const command = strings(c.command)
    const args = strings(c.args)
    const argv = redactArgs([...command, ...args])
    if (command.length > 0) out['command'] = argv.slice(0, command.length)
    if (args.length > 0) out['args'] = argv.slice(command.length)
  }
  if (nonEmpty(c.resources)) out['resources'] = c.resources
  for (const key of ['readinessProbe', 'livenessProbe', 'startupProbe'] as const) {
    const p = probe(c[key])
    if (p) out[key] = p
  }
  if (nonEmpty(c.securityContext)) out['securityContext'] = c.securityContext
  const env = (c.env ?? []).map(envRef).filter((e): e is Record<string, unknown> => e !== undefined)
  if (env.length > 0) out['env'] = env
  const from = envFrom(c)
  if (from) out['envFrom'] = from
  return out
}

/** The pod-template fields of one Deployment, for its `observedSpec`. */
export function podTemplateSpec(deployment: Deployment): Record<string, unknown> {
  const spec = deployment.spec?.template?.spec ?? {}
  const out: Record<string, unknown> = {}
  if (nonEmpty(deployment.spec?.strategy)) out['strategy'] = deployment.spec!.strategy
  const dnsPolicy = str(spec.dnsPolicy)
  if (dnsPolicy) out['dnsPolicy'] = dnsPolicy
  if (nonEmpty(spec.dnsConfig)) out['dnsConfig'] = spec.dnsConfig
  const priorityClassName = str(spec.priorityClassName)
  if (priorityClassName) out['priorityClassName'] = priorityClassName
  if (nonEmpty(spec.nodeSelector)) out['nodeSelector'] = spec.nodeSelector
  if (nonEmpty(spec.affinity)) out['affinity'] = spec.affinity
  if (nonEmpty(spec.tolerations)) out['tolerations'] = spec.tolerations
  if (nonEmpty(spec.securityContext)) out['securityContext'] = spec.securityContext
  if (Array.isArray(spec.initContainers) && spec.initContainers.length > 0) {
    out['initContainers'] = spec.initContainers.map((c) => container(c, true))
  }
  if (Array.isArray(spec.containers) && spec.containers.length > 0) {
    out['containers'] = spec.containers.map((c) => container(c, false))
  }
  return out
}
