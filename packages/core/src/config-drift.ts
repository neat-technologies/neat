// Config drift — the `config-mismatch` divergence (ADR-265, divergence-query.md §5i).
//
// Two configuration values that have to agree and don't. The fault that bites
// here is often a single value a cluster reader shows in one call: a Service
// selector widened onto another workload's pods, a caller's address pointing at a
// port its callee doesn't serve. Some of them never raise an incident (the caller
// is Pending, the misrouted traffic happens to succeed), so the check runs over
// the graph on every divergence query, incident or not, and the incident card
// picks up the findings on its node through its existing divergence field.
//
// No verdict. A mismatch does not say which side is wrong: the code can be wrong
// and correctly overridden at deploy time, the live object can be the stale one.
// Each finding lists every side as evidence (value, where it was read,
// provenance) and leaves the decision to the reader.
//
// Pure: reads node attributes, never mutates, no I/O. Branches only on node type,
// node kind and generic configuration semantics, never on a provider, framework,
// language or service name (the ADR-158 §6 scan covers this file).

import type {
  ConfigEvidence,
  ConfigMismatchDivergence,
  ConfigMismatchKind,
  GraphNode,
  InfraNode,
  ServiceNode,
} from '@neat.is/types'
import { NodeType, Provenance } from '@neat.is/types'
import type { NeatGraph } from './graph.js'

// ── The fields this pass reads ──────────────────────────────────────────────
//
// The live object specs are the k8s substrate's `observedSpec` on the object's
// InfraNode, under the field names connectors.md §10 lists (#1481 part 3, #1484).
// Three more are read where present and minted by nothing yet: a workload's full
// container env (`observedSpec.containerEnv`, today only a faulted workload
// carries its env, as `observedDeployContext.containerEnv`), and on the
// ServiceNode the code-declared listen ports and the manifest/compose-declared env
// (`listenPorts`, `declaredEnv`, both EXTRACTED). A node without a field
// contributes nothing: every comparison needs both sides before it says anything.

// `observedSpec` on a `k8s-service` InfraNode.
interface K8sServiceSpec {
  selector?: unknown
  // The workload names the selector covers, sorted; present when the Service
  // has a selector.
  selectsWorkloads?: unknown
  ports?: unknown
}

interface ServicePortSpec {
  name?: unknown
  port?: unknown
  targetPort?: unknown
}

// `observedSpec` on a k8s workload InfraNode.
interface WorkloadSpec {
  containerPorts?: unknown
  containerEnv?: unknown
}

interface ContainerPortSpec {
  port?: unknown
  name?: unknown
  container?: unknown
}

// EXTRACTED declarations on the ServiceNode.
interface ServiceDeclarations {
  listenPorts?: unknown
  declaredEnv?: unknown
}

const K8S_SERVICE_KIND = 'k8s-service'
// k8s workload kind → the API kind named in an evidence location.
const K8S_WORKLOAD_KINDS: Record<string, string> = {
  'k8s-deployment': 'Deployment',
  'k8s-statefulset': 'StatefulSet',
  'k8s-daemonset': 'DaemonSet',
}

// Confidence per comparison. Both sides are exact facts in every case; what
// varies is how often the disagreement is legitimate.
//  - address-port: a caller dialing a port its callee does not expose has no
//    benign reading NEAT knows of, short of a port the graph doesn't carry.
//  - selector-overlap / selector-empty: a Service spanning two workloads is
//    sometimes intended (a canary beside a stable deployment), and one selecting
//    nothing can be a workload scaled away on purpose.
//  - target-port: containerPort is informational in the pod spec, so a process
//    can listen on a port its container never lists.
const CONFIDENCE: Record<ConfigMismatchKind, number> = {
  'address-port': 0.8,
  'selector-overlap': 0.7,
  'selector-empty': 0.7,
  'target-port': 0.6,
}

const RECOMMENDATION =
  'These values have to agree and do not. NEAT does not know which side is wrong: check each source listed, ' +
  'decide which one holds the intended value, and change the other.'

// ── helpers ─────────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isRecordOfStrings(v: unknown): v is Record<string, string> {
  return isObject(v) && Object.values(v).every((x) => typeof x === 'string')
}

function isPort(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 65536
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function stringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))].sort()
}

function objectList<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v.filter(isObject) as T[]) : []
}

function selectorText(sel: Record<string, string>): string {
  return Object.entries(sel)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',')
}

function at(file: unknown, line: unknown, fallback: string): string {
  const f = nonEmpty(file)
  if (!f) return fallback
  return typeof line === 'number' ? `${f}:${line}` : f
}

function observedSpecOf<T>(node: InfraNode): T | undefined {
  const spec = (node as InfraNode & { observedSpec?: unknown }).observedSpec
  return isObject(spec) ? (spec as T) : undefined
}

interface K8sService {
  node: InfraNode
  spec: K8sServiceSpec
}

interface Workload {
  node: InfraNode
  apiKind: string
  spec: WorkloadSpec
}

interface Index {
  servicesByName: Map<string, ServiceNode>
  aliasToService: Map<string, ServiceNode>
  k8sServices: Map<string, K8sService>
  workloads: Map<string, Workload[]>
}

function buildIndex(graph: NeatGraph): Index {
  const servicesByName = new Map<string, ServiceNode>()
  const aliasToService = new Map<string, ServiceNode>()
  const k8sServices = new Map<string, K8sService>()
  const workloads = new Map<string, Workload[]>()
  graph.forEachNode((_id, attrs) => {
    const n = attrs as GraphNode
    if (n.type === NodeType.ServiceNode) {
      const svc = n as ServiceNode
      // Prefer the env-less node when one name carries several env variants.
      const prior = servicesByName.get(svc.name)
      if (!prior || (prior.env !== undefined && svc.env === undefined)) servicesByName.set(svc.name, svc)
      for (const a of svc.aliases ?? []) if (!aliasToService.has(a)) aliasToService.set(a, svc)
      return
    }
    if (n.type !== NodeType.InfraNode) return
    const infra = n as InfraNode
    if (infra.kind === K8S_SERVICE_KIND) {
      k8sServices.set(infra.name, { node: infra, spec: observedSpecOf<K8sServiceSpec>(infra) ?? {} })
      return
    }
    const apiKind = infra.kind ? K8S_WORKLOAD_KINDS[infra.kind] : undefined
    if (apiKind) {
      const list = workloads.get(infra.name) ?? []
      list.push({ node: infra, apiKind, spec: observedSpecOf<WorkloadSpec>(infra) ?? {} })
      workloads.set(infra.name, list)
    }
  })
  return { servicesByName, aliasToService, k8sServices, workloads }
}

// The node a workload's findings land on: its ServiceNode (where the incident
// card is composed), else its k8s workload node.
function workloadNodeId(index: Index, name: string): string | undefined {
  return index.servicesByName.get(name)?.id ?? index.workloads.get(name)?.[0]?.node.id
}

interface PortSide {
  port?: number
  name?: string
  evidence: ConfigEvidence
}

// The ports a workload's own containers serve: the pod template's containerPorts
// and the code-declared listen ports. Empty means the graph doesn't know, not
// "none".
function workloadPorts(index: Index, name: string): PortSide[] {
  const out: PortSide[] = []
  const seen = new Set<string>()
  for (const w of index.workloads.get(name) ?? []) {
    for (const cp of objectList<ContainerPortSpec>(w.spec.containerPorts)) {
      if (!isPort(cp.port)) continue
      const pname = nonEmpty(cp.name)
      const key = `c:${cp.port}:${pname ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      const container = nonEmpty(cp.container)
      out.push({
        port: cp.port,
        ...(pname ? { name: pname } : {}),
        evidence: {
          role: 'container port',
          value: pname ? `${cp.port} (${pname})` : String(cp.port),
          location: `${w.apiKind} ${name} containers[${container ?? ''}].ports[].containerPort`,
          provenance: Provenance.OBSERVED,
        },
      })
    }
  }
  const svc = index.servicesByName.get(name) as (ServiceNode & ServiceDeclarations) | undefined
  for (const lp of objectList<{ port?: unknown; file?: unknown; line?: unknown }>(svc?.listenPorts)) {
    if (!isPort(lp.port)) continue
    const location = at(lp.file, lp.line, `service ${name} source`)
    const key = `l:${lp.port}:${location}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      port: lp.port,
      evidence: {
        role: 'declared listen port',
        value: String(lp.port),
        location,
        provenance: Provenance.EXTRACTED,
      },
    })
  }
  return out
}

function finding(
  kind: ConfigMismatchKind,
  source: string,
  target: string,
  field: string,
  evidence: ConfigEvidence[],
  reason: string,
): ConfigMismatchDivergence {
  return {
    type: 'config-mismatch',
    kind,
    source,
    target,
    field,
    evidence,
    confidence: CONFIDENCE[kind],
    reason,
    recommendation: RECOMMENDATION,
  }
}

// ── selector: matches more than one workload, or none while workloads run ───

function detectSelector(index: Index): ConfigMismatchDivergence[] {
  const out: ConfigMismatchDivergence[] = []
  // "Workloads run": another Service covers a workload, or a service node
  // reports ready replicas.
  let workloadsRun = false
  for (const s of index.k8sServices.values()) {
    if ((stringList(s.spec.selectsWorkloads) ?? []).length > 0) workloadsRun = true
  }
  for (const svc of index.servicesByName.values()) {
    if (typeof svc.observedReadyReplicas === 'number' && svc.observedReadyReplicas > 0) workloadsRun = true
  }

  for (const { node, spec } of index.k8sServices.values()) {
    if (!isRecordOfStrings(spec.selector) || Object.keys(spec.selector).length === 0) continue
    const selected = stringList(spec.selectsWorkloads)
    if (!selected) continue
    const sel = selectorText(spec.selector)
    const selectorSide: ConfigEvidence = {
      role: 'service selector',
      value: sel,
      location: `Service ${node.name} spec.selector`,
      provenance: Provenance.OBSERVED,
    }
    const target = index.servicesByName.get(node.name)?.id ?? node.id
    if (selected.length > 1) {
      const sides = selected.map<ConfigEvidence>((w) => ({
        role: 'selected workload',
        value: w,
        location: `${index.workloads.get(w)?.[0]?.apiKind ?? 'workload'} ${w} pod labels`,
        provenance: Provenance.OBSERVED,
      }))
      out.push(
        finding(
          'selector-overlap',
          node.id,
          target,
          'spec.selector',
          [selectorSide, ...sides],
          `Service ${node.name} selector ${sel} covers ${selected.length} workloads (${selected.join(', ')}), so its traffic is split across them.`,
        ),
      )
    } else if (selected.length === 0 && workloadsRun) {
      out.push(
        finding(
          'selector-empty',
          node.id,
          target,
          'spec.selector',
          [
            selectorSide,
            {
              role: 'covered workloads',
              value: 'none',
              location: `Service ${node.name} spec.selector`,
              provenance: Provenance.OBSERVED,
            },
          ],
          `Service ${node.name} selector ${sel} covers no workload while other workloads are running, so it has nowhere to send traffic.`,
        ),
      )
    }
  }
  return out
}

// ── targetPort: no selected container serves it ─────────────────────────────

function detectTargetPort(index: Index): ConfigMismatchDivergence[] {
  const out: ConfigMismatchDivergence[] = []
  for (const { node, spec } of index.k8sServices.values()) {
    const selected = stringList(spec.selectsWorkloads)
    if (!Array.isArray(spec.ports) || !selected) continue
    spec.ports.forEach((raw: unknown, i: number) => {
      if (!isObject(raw)) return
      const p = raw as ServicePortSpec
      // targetPort defaults to port when unset.
      const tp = p.targetPort ?? p.port
      const asNumber = isPort(tp) ? tp : typeof tp === 'string' && /^\d+$/.test(tp) ? Number(tp) : undefined
      const named = asNumber === undefined ? nonEmpty(tp) : undefined
      if (asNumber === undefined && named === undefined) return
      for (const w of selected) {
        const ports = workloadPorts(index, w)
        if (ports.length === 0) continue
        let served: boolean
        if (named !== undefined) {
          // A named targetPort resolves against named container ports only; with
          // none named the graph can't tell, so say nothing.
          if (!ports.some((x) => x.name !== undefined)) continue
          served = ports.some((x) => x.name === named)
        } else {
          served = ports.some((x) => x.port === asNumber)
        }
        if (served) continue
        const value = named ?? String(asNumber)
        out.push(
          finding(
            'target-port',
            node.id,
            workloadNodeId(index, w) ?? node.id,
            `spec.ports[${i}].targetPort`,
            [
              {
                role: 'service targetPort',
                value,
                location: `Service ${node.name} spec.ports[${i}].targetPort`,
                provenance: Provenance.OBSERVED,
              },
              ...ports.map((x) => x.evidence),
            ],
            `Service ${node.name} sends port ${isPort(p.port) ? p.port : '?'} to targetPort ${value}, which no port of the workload it selects (${w}) declares (${ports.map((x) => x.evidence.value).join(', ')}).`,
          ),
        )
      }
    })
  }
  return out
}

// ── address config: a caller names a port its callee does not expose ────────

// Names that carry an address by convention: FOO_ADDR, FOO_HOST, FOO_URL, ...
const ADDRESS_NAME_RE = /^(.*?)_?(ADDR|ADDRESS|HOST|HOSTNAME|URL|URI|ENDPOINT|PORT)$/i
const HOST_PORT_RE = /^([A-Za-z0-9][A-Za-z0-9.-]*):(\d{1,5})(?:\/.*)?$/
const BARE_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/
const LOOPBACK_HOSTS = new Set(['localhost', '0.0.0.0', '127.0.0.1', '::', '::1'])

interface EnvEntry {
  name: string
  value: string
  location: string
  provenance: ConfigEvidence['provenance']
}

function envEntries(index: Index, name: string): EnvEntry[] {
  const out: EnvEntry[] = []
  const fromDescriptors = (list: unknown, location: (envName: string) => string): void => {
    if (!Array.isArray(list)) return
    for (const d of list) {
      if (typeof d !== 'string') continue
      const eq = d.indexOf('=')
      if (eq <= 0) continue
      const envName = d.slice(0, eq)
      out.push({ name: envName, value: d.slice(eq + 1), location: location(envName), provenance: Provenance.OBSERVED })
    }
  }
  for (const w of index.workloads.get(name) ?? []) {
    fromDescriptors(w.spec.containerEnv, (e) => `${w.apiKind} ${name} containers[].env ${e}`)
  }
  const svc = index.servicesByName.get(name) as (ServiceNode & ServiceDeclarations) | undefined
  if (svc) {
    fromDescriptors(svc.observedDeployContext?.containerEnv, (e) => `pod of ${name} containers[].env ${e}`)
    for (const e of objectList<{ name?: unknown; value?: unknown; file?: unknown; line?: unknown }>(svc.declaredEnv)) {
      const envName = nonEmpty(e.name)
      if (!envName || typeof e.value !== 'string') continue
      out.push({
        name: envName,
        value: e.value,
        location: at(e.file, e.line, `service ${name} declared env ${envName}`),
        provenance: Provenance.EXTRACTED,
      })
    }
  }
  return out
}

// host + port from an address value. Only an explicit port counts: a URL with no
// port, a reference descriptor (`<from configMap …>`) or a redacted value names
// nothing to compare.
function parseAddress(value: string): { host?: string; port?: number } | null {
  const v = value.trim()
  if (v.length === 0 || v.startsWith('<') || v.includes('REDACTED')) return null
  if (/^\d{1,5}$/.test(v)) {
    const port = Number(v)
    return isPort(port) ? { port } : null
  }
  if (v.includes('://')) {
    try {
      const u = new URL(v)
      if (u.port === '') return null
      const port = Number(u.port)
      return isPort(port) ? { host: u.hostname, port } : null
    } catch {
      return null
    }
  }
  const m = HOST_PORT_RE.exec(v)
  if (!m) return null
  const port = Number(m[2])
  return isPort(port) ? { host: m[1]!, port } : null
}

// The prefix of an address var as a workload name: PRODUCT_CATALOG -> product-catalog.
function prefixName(prefix: string): string {
  return prefix.toLowerCase().replace(/_/g, '-')
}

interface Callee {
  name: string
  nodeId: string
}

function resolveCallee(index: Index, host: string): Callee | null {
  const h = host.toLowerCase()
  if (LOOPBACK_HOSTS.has(h) || IPV4_RE.test(h) || h.includes(':')) return null
  const label = h.split('.')[0]!
  const svc = index.servicesByName.get(label) ?? index.aliasToService.get(h) ?? index.aliasToService.get(label)
  const k8s = index.k8sServices.get(label)
  if (svc) return { name: k8s ? label : svc.name, nodeId: svc.id }
  if (k8s) return { name: label, nodeId: k8s.node.id }
  const workload = index.workloads.get(label)?.[0]
  if (workload) return { name: label, nodeId: workload.node.id }
  return null
}

// The ports a caller can reach the callee on. Dialing a Service name means the
// Service's own `port` is what has to match; with no Service ports in the graph,
// the workload's container and declared listen ports stand in.
function calleePorts(index: Index, callee: Callee): PortSide[] {
  const k8s = index.k8sServices.get(callee.name)
  if (k8s && Array.isArray(k8s.spec.ports)) {
    const sides: PortSide[] = []
    k8s.spec.ports.forEach((raw: unknown, i: number) => {
      const port = isObject(raw) ? (raw as ServicePortSpec).port : undefined
      if (!isPort(port)) return
      sides.push({
        port,
        evidence: {
          role: 'service port',
          value: String(port),
          location: `Service ${k8s.node.name} spec.ports[${i}].port`,
          provenance: Provenance.OBSERVED,
        },
      })
    })
    if (sides.length > 0) return sides
  }
  return workloadPorts(index, callee.name)
}

function detectAddressPort(index: Index): ConfigMismatchDivergence[] {
  const out = new Map<string, ConfigMismatchDivergence>()
  const callers = [...new Set([...index.servicesByName.keys(), ...index.workloads.keys()])].sort()
  for (const callerName of callers) {
    const callerId = workloadNodeId(index, callerName)
    if (!callerId) continue
    const entries = envEntries(index, callerName)
    if (entries.length === 0) continue
    // A *_PORT var takes its host from a sibling address var with the same prefix.
    const hostByPrefix = new Map<string, string>()
    for (const e of entries) {
      const m = ADDRESS_NAME_RE.exec(e.name)
      if (!m || m[2]!.toUpperCase() === 'PORT') continue
      const parsed = parseAddress(e.value)
      const host = parsed?.host ?? (BARE_HOST_RE.test(e.value.trim()) ? e.value.trim() : undefined)
      if (host) hostByPrefix.set(m[1]!.toUpperCase(), host)
    }
    for (const e of entries) {
      const m = ADDRESS_NAME_RE.exec(e.name)
      if (!m) continue
      const parsed = parseAddress(e.value)
      if (!parsed?.port) continue
      const prefix = m[1]!.toUpperCase()
      const host = parsed.host ?? hostByPrefix.get(prefix) ?? (prefix.length > 0 ? prefixName(prefix) : undefined)
      if (!host) continue
      const callee = resolveCallee(index, host)
      if (!callee || callee.nodeId === callerId || callee.name === callerName) continue
      const ports = calleePorts(index, callee)
      if (ports.length === 0) continue
      if (ports.some((p) => p.port === parsed.port)) continue
      const key = `${callerId}\u0000${e.name}\u0000${parsed.port}`
      const callerSide: ConfigEvidence = {
        role: 'caller address',
        value: `${e.name}=${e.value}`,
        location: e.location,
        provenance: e.provenance,
      }
      const existing = out.get(key)
      if (existing) {
        // The same var read from a second source (declared and live): one
        // finding, every source listed.
        if (!existing.evidence.some((x) => x.location === callerSide.location && x.value === callerSide.value)) {
          const callerSides = existing.evidence.filter((x) => x.role === 'caller address')
          existing.evidence.splice(callerSides.length, 0, callerSide)
        }
        continue
      }
      out.set(
        key,
        finding(
          'address-port',
          callerId,
          callee.nodeId,
          e.name,
          [callerSide, ...ports.map((p) => p.evidence)],
          `${callerName} points ${e.name} at port ${parsed.port} of ${callee.name}, which exposes ${[...new Set(ports.map((p) => p.port))].join(', ')}.`,
        ),
      )
    }
  }
  return [...out.values()]
}

/**
 * Every config mismatch the graph can show. Each comparison needs both sides on
 * the graph; a node missing a field contributes nothing.
 */
export function detectConfigMismatches(graph: NeatGraph): ConfigMismatchDivergence[] {
  const index = buildIndex(graph)
  return [...detectSelector(index), ...detectAddressPort(index), ...detectTargetPort(index)]
}
