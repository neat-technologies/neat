// Deployment + Pod state -> ObservedSignal mapping (ADR-224, connectors.md §10).
// One incident-bearing signal per *unhealthy* workload — a bad image, zero
// replicas, a crashloop — carrying the concrete cause the shared pipeline writes
// as an OBSERVED incident on the service node (not an edge). A healthy workload
// mints nothing in v1: the bench value is the incidents, the faults a dead pod
// emits no span for (#1124). The EAS mapper turns a build failure into an
// incident signal; this turns a deployment fault into one — same interface,
// same terminal write.

import type { ObservedSignal } from '../types.js'
import { specHash } from '../../spec-diff.js'
import { configMapOperationalSpec, deploymentOperationalSpec, serviceOperationalSpec } from './spec.js'
import type { SpanAttributes, DeployContext } from '@neat.is/types'
import type {
  ConfigMap,
  Container,
  ContainerStatus,
  Deployment,
  K8sConnectorConfig,
  K8sEvent,
  K8sFaultKind,
  Pod,
  ReplicaSet,
  Service,
} from './types.js'
import {
  CRASH_LOOP_REASON,
  IMAGE_PULL_REASONS,
  K8S_DEPLOY_STATE,
  K8S_OBJECT_TARGET_KIND,
  K8S_TARGET_KIND,
  packK8sObjectName,
  packK8sTargetName,
} from './types.js'
import { buildProcessContext } from './process-context.js'

// The NEAT service a workload maps to: an explicit config map wins (a workload
// whose name doesn't equal the OTel `service.name`), else the deployment name
// itself — resolved once, never guessed (resolve.ts drops honestly if the id
// names no extracted node, so a wrong guess never fabricates one).
function serviceNameFor(deployment: Deployment, config: K8sConnectorConfig): string {
  const name = deployment.metadata?.name ?? ''
  return config.serviceMap?.[name] ?? name
}

// Does a pod belong to this deployment? A Deployment selects its pods by
// `spec.selector.matchLabels` — a pod belongs when its labels are a superset of
// that selector (the same subset match the API server itself uses). An empty or
// absent selector matches nothing rather than everything, so a malformed
// deployment never sweeps in unrelated pods.
function podMatchesSelector(pod: Pod, selector: Record<string, string> | undefined): boolean {
  if (!selector || Object.keys(selector).length === 0) return false
  const labels = pod.metadata?.labels ?? {}
  return Object.entries(selector).every(([k, v]) => labels[k] === v)
}

function podsForDeployment(deployment: Deployment, pods: Pod[]): Pod[] {
  const selector = deployment.spec?.selector?.matchLabels
  return pods.filter((p) => podMatchesSelector(p, selector))
}

// The ClusterIP join (ADR-248). A client span that dials a Service by its virtual
// IP names the callee only as that IP. A Service selects pods by label, so the
// workload behind an IP is the one deployment whose pods (or, with none running,
// whose own selector) the Service's selector covers. A Service that covers more
// than one deployment, has no selector, or is headless names no single workload
// and contributes nothing: an address is recorded only where it is unambiguous.
function serviceIps(service: Service): string[] {
  const spec = service.spec
  const ips = spec?.clusterIPs && spec.clusterIPs.length > 0 ? spec.clusterIPs : spec?.clusterIP ? [spec.clusterIP] : []
  return ips.filter((ip) => ip.length > 0 && ip !== 'None')
}

function serviceSelects(deployment: Deployment, pods: Pod[], selector: Record<string, string>): boolean {
  if (podsForDeployment(deployment, pods).some((p) => podMatchesSelector(p, selector))) return true
  const own = deployment.spec?.selector?.matchLabels ?? {}
  return Object.entries(selector).every(([k, v]) => own[k] === v)
}

// The deployments a Service's selector covers, by name, sorted. Empty for a
// Service with no selector.
export function workloadsSelectedBy(service: Service, deployments: Deployment[], pods: Pod[]): string[] {
  const selector = service.spec?.selector
  if (!selector || Object.keys(selector).length === 0) return []
  const names = deployments
    .filter((d) => serviceSelects(d, pods, selector))
    .map((d) => d.metadata?.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
  return [...new Set(names)].sort()
}

// deployment name → the ClusterIPs that reach only it. A Service covering more
// than one workload joins no address here; serviceSpecSignal flags it on the
// Service's own node (`selectorAmbiguous`).
export function addressesByDeployment(
  deployments: Deployment[],
  pods: Pod[],
  services: Service[],
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const service of services) {
    const ips = serviceIps(service)
    if (ips.length === 0) continue
    const owners = workloadsSelectedBy(service, deployments, pods)
    if (owners.length !== 1) continue
    const name = owners[0]!
    out.set(name, [...(out.get(name) ?? []), ...ips])
  }
  for (const [name, ips] of out) out.set(name, [...new Set(ips)].sort())
  return out
}

// ── live object specs (#1481) ────────────────────────────────────────────────
// The fields that decide whether a caller reaches a pod, stamped on the object's
// InfraNode as OBSERVED `observedSpec` so a change against a healthy snapshot
// shows in the graph diff. The field names are part of the connector contract
// (connectors.md §10); readers key on them.

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * A Service's spec as `observedSpec` on `infra:k8s-service:<name>`: `type`,
 * `internalTrafficPolicy`, `externalTrafficPolicy`, `selector`, `ports`
 * (`name`/`protocol`/`port`/`targetPort`/`nodePort`), and, for a Service with a
 * selector, `selectsWorkloads` (the deployments it covers) and
 * `selectorAmbiguous` (it covers more than one). Null for an unnamed Service.
 */
export function serviceSpecSignal(service: Service, deployments: Deployment[], pods: Pod[]): ObservedSignal | null {
  const name = str(service.metadata?.name)
  if (!name) return null
  const spec = service.spec ?? {}
  const out: Record<string, unknown> = {}
  const type = str(spec.type)
  if (type) out['type'] = type
  const itp = str(spec.internalTrafficPolicy)
  if (itp) out['internalTrafficPolicy'] = itp
  const etp = str(spec.externalTrafficPolicy)
  if (etp) out['externalTrafficPolicy'] = etp
  if (spec.selector && Object.keys(spec.selector).length > 0) {
    out['selector'] = { ...spec.selector }
    const selects = workloadsSelectedBy(service, deployments, pods)
    out['selectsWorkloads'] = selects
    out['selectorAmbiguous'] = selects.length > 1
  }
  if (Array.isArray(spec.ports)) {
    out['ports'] = spec.ports.map((p) => {
      const port: Record<string, unknown> = {}
      const pname = str(p.name)
      if (pname) port['name'] = pname
      const protocol = str(p.protocol)
      if (protocol) port['protocol'] = protocol
      const n = num(p.port)
      if (n !== undefined) port['port'] = n
      const target = num(p.targetPort) ?? str(p.targetPort)
      if (target !== undefined) port['targetPort'] = target
      const nodePort = num(p.nodePort)
      if (nodePort !== undefined) port['nodePort'] = nodePort
      return port
    })
  }
  return objectSpecSignal('k8s-service', name, service.metadata?.namespace, withOperational(out, serviceOperationalSpec(service)))
}

/**
 * A Deployment's pod-template container ports as `observedSpec` on
 * `infra:k8s-deployment:<name>`: `containerPorts`, one entry per declared port
 * (`container`/`name`/`port`/`protocol`). Null for an unnamed Deployment.
 */
export function deploymentSpecSignal(deployment: Deployment): ObservedSignal | null {
  const name = str(deployment.metadata?.name)
  if (!name) return null
  const containerPorts: Array<Record<string, unknown>> = []
  for (const c of deployment.spec?.template?.spec?.containers ?? []) {
    for (const p of c.ports ?? []) {
      const port = num(p.containerPort)
      if (port === undefined) continue
      const entry: Record<string, unknown> = { port }
      const container = str(c.name)
      if (container) entry['container'] = container
      const pname = str(p.name)
      if (pname) entry['name'] = pname
      const protocol = str(p.protocol)
      if (protocol) entry['protocol'] = protocol
      containerPorts.push(entry)
    }
  }
  const spec: Record<string, unknown> = { containerPorts }
  const serviceAccountName = str(deployment.spec?.template?.spec?.serviceAccountName)
  if (serviceAccountName) spec['serviceAccountName'] = serviceAccountName
  return objectSpecSignal(
    'k8s-deployment',
    name,
    deployment.metadata?.namespace,
    withOperational(spec, deploymentOperationalSpec(deployment)),
  )
}

/**
 * A ConfigMap's data keys, each value as a sha256 prefix and never the value, as
 * `observedSpec` on `infra:k8s-configmap:<name>` (ADR-270). Null for an unnamed one.
 */
export function configMapSpecSignal(cm: ConfigMap): ObservedSignal | null {
  const name = str(cm.metadata?.name)
  if (!name) return null
  return objectSpecSignal('k8s-configmap', name, cm.metadata?.namespace, withOperational({}, configMapOperationalSpec(cm)))
}

// The object's normalized operational spec (spec.ts) and its hash, beside the
// fields #1490's readers key on (ADR-270): what the healthy baseline snapshots
// and `GET /graph/changes` diffs.
function withOperational(fields: Record<string, unknown>, operational: Record<string, unknown>): Record<string, unknown> {
  return { ...fields, operational, specHash: specHash(operational) }
}

function objectSpecSignal(
  kind: string,
  name: string,
  namespace: string | undefined,
  spec: Record<string, unknown>,
): ObservedSignal {
  return {
    targetKind: K8S_OBJECT_TARGET_KIND,
    targetName: packK8sObjectName(kind, name),
    callCount: 0,
    errorCount: 0,
    lastObservedIso: nowIso(),
    infraSpec: { ...(namespace ? { namespace } : {}), spec },
  }
}

interface FaultFinding {
  fault: K8sFaultKind
  message: string
  timestamp: string
  attributes: SpanAttributes
  // The pod + container the fault was diagnosed from, for the process-&-config
  // fusion (ADR-237). Set for the pod-level faults (`image-pull`, `crash-loop`)
  // so the poll knows whose log to pull and whose container spec (env/args) to
  // read; absent for the deployment-level faults (`scaled-to-zero`,
  // `no-ready-replicas`), which have no single faulted pod. Never serialized —
  // only `attributes` reaches the signal.
  pod?: Pod
  container?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

// A fetched process-log tail keyed by `(podName, container)` — the output of the
// poll's log fetch (index.ts), threaded into the map so a faulted finding can
// fuse its process log in. Keyed through `podLogKey` so the fetch side and the
// merge side agree on the key regardless of container name presence.
export type K8sPodLogs = Map<string, string>

export function podLogKey(podName: string, container?: string): string {
  return container ? `${podName}\u0000${container}` : podName
}

// Scan a deployment's pods for the first container whose state names an
// image-pull failure or a crashloop — the two pod-level faults. Returns the
// concrete finding (image / restart count / last-terminated line) or null.
function podLevelFault(deployment: Deployment, pods: Pod[]): FaultFinding | null {
  const name = deployment.metadata?.name ?? ''
  const owned = podsForDeployment(deployment, pods)
  let crash: { cs: ContainerStatus; pod: Pod } | null = null

  for (const pod of owned) {
    for (const cs of pod.status?.containerStatuses ?? []) {
      const reason = cs.state?.waiting?.reason
      if (typeof reason !== 'string') continue
      // Image-pull is the sharpest, most actionable fault — return immediately.
      if (IMAGE_PULL_REASONS.has(reason)) {
        const image = typeof cs.image === 'string' ? cs.image : 'unknown image'
        const attrs: SpanAttributes = { 'k8s.image': image, 'k8s.waitingReason': reason }
        const wm = cs.state?.waiting?.message
        if (typeof wm === 'string' && wm.length > 0) attrs['k8s.waitingMessage'] = wm
        return {
          fault: 'image-pull',
          message: `Deployment ${name} cannot pull image ${image} (${reason})`,
          timestamp: pod.status?.startTime ?? nowIso(),
          attributes: attrs,
          pod,
          ...(typeof cs.name === 'string' && cs.name.length > 0 ? { container: cs.name } : {}),
        }
      }
      // Remember a crashloop but keep scanning in case an image-pull outranks it.
      if (reason === CRASH_LOOP_REASON && !crash) crash = { cs, pod }
    }
  }

  if (crash) {
    const { cs, pod } = crash
    const term = cs.lastState?.terminated
    const termReason = typeof term?.reason === 'string' ? term.reason : undefined
    const termMsg = typeof term?.message === 'string' ? term.message.trim() : undefined
    const restarts = typeof cs.restartCount === 'number' ? cs.restartCount : 0
    const detail = termReason
      ? `last terminated: ${termReason}${termMsg ? ` — ${termMsg}` : ''}${typeof term?.exitCode === 'number' ? ` (exit ${term.exitCode})` : ''}`
      : 'no last-termination detail reported'
    const attrs: SpanAttributes = { 'k8s.waitingReason': CRASH_LOOP_REASON, 'k8s.restartCount': restarts }
    if (termReason) attrs['k8s.terminatedReason'] = termReason
    if (termMsg) attrs['k8s.terminatedMessage'] = termMsg
    if (typeof term?.exitCode === 'number') attrs['k8s.exitCode'] = term.exitCode
    if (typeof cs.image === 'string') attrs['k8s.image'] = cs.image
    return {
      fault: 'crash-loop',
      message: `Deployment ${name} is crashlooping (restarts: ${restarts}); ${detail}`,
      timestamp: term?.finishedAt ?? pod.status?.startTime ?? nowIso(),
      attributes: attrs,
      pod,
      ...(typeof cs.name === 'string' && cs.name.length > 0 ? { container: cs.name } : {}),
    }
  }
  return null
}

// The pod spec container a fault was diagnosed from — the env/args source for
// process-&-config fusion (ADR-237). Match by the faulted container's name,
// falling back to the sole container when the spec names exactly one (a
// single-container pod, the common case), else nothing — never a wrong guess.
function faultedContainer(finding: FaultFinding): Container | undefined {
  const containers = finding.pod?.spec?.containers
  if (!Array.isArray(containers) || containers.length === 0) return undefined
  if (finding.container) {
    const named = containers.find((c) => c.name === finding.container)
    if (named) return named
  }
  return containers.length === 1 ? containers[0] : undefined
}

/**
 * Merge the process-&-config fusion block onto a faulted finding's attributes
 * (ADR-237) — the OBSERVED "why" for a workload that failed before its first
 * span: `k8s.processLog` (the last-terminated stdout tail), `k8s.containerArgs`,
 * and `k8s.containerEnv` (both redacted + bounded by process-context.ts). Only
 * the pod-level faults carry a `pod`, so the deployment-level faults
 * (scaled-to-zero, no-ready-replicas) grow nothing; a healthy workload has no
 * finding at all, so it still mints nothing. Additive to `attributes`, so the
 * fault classification, its message, and the dedupe id are untouched.
 */
function mergeProcessContext(finding: FaultFinding, logs?: K8sPodLogs): void {
  const container = faultedContainer(finding)
  const podName = finding.pod?.metadata?.name
  const log = logs && podName ? logs.get(podLogKey(podName, finding.container)) : undefined
  if (!container && log === undefined) return
  const ctx = buildProcessContext({
    ...(log !== undefined ? { log } : {}),
    ...(container ? { container } : {}),
  })
  if (ctx.processLog !== undefined) finding.attributes['k8s.processLog'] = ctx.processLog
  if (ctx.containerArgs !== undefined) finding.attributes['k8s.containerArgs'] = ctx.containerArgs
  if (ctx.containerEnv !== undefined) finding.attributes['k8s.containerEnv'] = ctx.containerEnv
}

/**
 * The faulted (pod, container) pairs whose process LOG is worth pulling — what
 * the poll fetches, and nothing else (index.ts), so the `pods/log` read stays
 * scoped to a handful of pods and its RBAC stays minimal. Only `crash-loop`
 * contributes: a crashed container has a LAST terminated instance whose stdout
 * (`previous=true`) holds the traceback. An `image-pull` container never started,
 * so there's no process log to read — its env/args still ride (from the pod spec,
 * no extra call), but a log fetch would only 400. Deployment-level faults
 * (scaled-to-zero, no-ready-replicas) and healthy workloads yield nothing.
 */
export function faultedPods(
  deployments: Deployment[],
  pods: Pod[],
  config: K8sConnectorConfig,
): Array<{ podName: string; container?: string }> {
  const out: Array<{ podName: string; container?: string }> = []
  const expectedZero = config.expectedZero ? new Set(config.expectedZero) : undefined
  for (const deployment of deployments) {
    const finding = classifyDeployment(deployment, pods, expectedZero)
    if (!finding || finding.fault !== 'crash-loop') continue
    const podName = finding.pod?.metadata?.name
    if (typeof podName !== 'string' || podName.length === 0) continue
    out.push({ podName, ...(finding.container ? { container: finding.container } : {}) })
  }
  return out
}

// ── why a workload can't get a pod (#1484) ───────────────────────────────────
// A pod that admission rejects never exists, so a quota, a webhook or a missing
// service account shows on the Deployment only as fewer ready replicas. The
// reason sits on the ReplicaSet's `ReplicaFailure` condition and on a Warning
// `FailedCreate` event, in the API server's own words, which usually name the
// object (`exceeded quota: memory-limit-quota`, `admission webhook "…" denied`).
// A pod the scheduler can't place has a `FailedScheduling` event instead.

/** The namespace's ReplicaSets and Events, when the poll read them. */
export interface K8sCreateCauses {
  replicaSets?: ReplicaSet[]
  events?: K8sEvent[]
}

interface Cause {
  reason: string
  message: string
  at?: string
}

function ownedReplicaSets(deployment: Deployment, replicaSets: ReplicaSet[]): ReplicaSet[] {
  const name = deployment.metadata?.name
  return replicaSets.filter((rs) =>
    (rs.metadata?.ownerReferences ?? []).some((o) => o.kind === 'Deployment' && o.name === name),
  )
}

function eventTime(e: K8sEvent): string | undefined {
  return e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp
}

// The latest of several causes, by timestamp; an undated cause loses to a dated one.
function latest(causes: Cause[]): Cause | undefined {
  return [...causes].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))[0]
}

function warningEvents(events: K8sEvent[], reason: string, kind: string, names: Set<string>): Cause[] {
  return events
    .filter(
      (e) =>
        e.type === 'Warning' &&
        e.reason === reason &&
        e.involvedObject?.kind === kind &&
        typeof e.involvedObject.name === 'string' &&
        names.has(e.involvedObject.name) &&
        typeof e.message === 'string' &&
        e.message.length > 0,
    )
    .map((e) => ({ reason, message: e.message!, ...(eventTime(e) ? { at: eventTime(e) } : {}) }))
}

function createFailureCause(deployment: Deployment, causes: K8sCreateCauses): Cause | undefined {
  const owned = ownedReplicaSets(deployment, causes.replicaSets ?? [])
  const found: Cause[] = []
  for (const rs of owned) {
    for (const c of rs.status?.conditions ?? []) {
      if (c.type !== 'ReplicaFailure' || c.status !== 'True') continue
      if (typeof c.message !== 'string' || c.message.length === 0) continue
      found.push({
        reason: c.reason ?? 'FailedCreate',
        message: c.message,
        ...(c.lastTransitionTime ? { at: c.lastTransitionTime } : {}),
      })
    }
  }
  if (found.length > 0) return latest(found)
  const names = new Set(owned.map((rs) => rs.metadata?.name).filter((n): n is string => typeof n === 'string'))
  return latest(warningEvents(causes.events ?? [], 'FailedCreate', 'ReplicaSet', names))
}

function unschedulableCause(deployment: Deployment, pods: Pod[], causes: K8sCreateCauses): Cause | undefined {
  const names = new Set(
    podsForDeployment(deployment, pods)
      .map((p) => p.metadata?.name)
      .filter((n): n is string => typeof n === 'string'),
  )
  return latest(warningEvents(causes.events ?? [], 'FailedScheduling', 'Pod', names))
}

/**
 * The object an API-server refusal names, as `<kind>/<name>`, or undefined when
 * the message names none. Matches the stable message shapes: the quota
 * admission plugin's `exceeded quota: <name>` / `failed quota: <name>`, a
 * webhook's `admission webhook "<name>" denied` / `failed calling webhook
 * "<name>"`, and `serviceaccount "<name>" not found`.
 */
export function blockingObject(message: string): string | undefined {
  const quota = /(?:exceeded|failed) quota: ([a-z0-9][-a-z0-9.]*[a-z0-9]|[a-z0-9])/.exec(message)
  if (quota) return `resourcequota/${quota[1]}`
  const webhook = /(?:admission webhook|failed calling webhook) "([^"]+)"/.exec(message)
  if (webhook) return `webhook/${webhook[1]}`
  const sa = /serviceaccount "([^"]+)" not found/.exec(message)
  if (sa) return `serviceaccount/${sa[1]}`
  return undefined
}

function causeFinding(fault: K8sFaultKind, summary: string, cause: Cause): FaultFinding {
  const attributes: SpanAttributes = { 'k8s.reason': cause.reason, 'k8s.reasonMessage': cause.message }
  const blockedBy = blockingObject(cause.message)
  if (blockedBy) attributes['k8s.blockedBy'] = blockedBy
  return { fault, message: `${summary}: ${cause.message}`, timestamp: cause.at ?? nowIso(), attributes }
}

/**
 * Classify one deployment's health. Returns the fault to mint an incident for,
 * or null when the workload is healthy (fully ready) — so a healthy deployment
 * mints nothing. Order: an explicit `replicas: 0` is scaled-to-zero; a
 * not-fully-ready deployment is diagnosed by its pods (image-pull / crashloop),
 * falling back to an un-classified `no-ready-replicas` when the deployment is
 * down but no pod names a cause.
 */
export function classifyDeployment(
  deployment: Deployment,
  pods: Pod[],
  expectedZero?: ReadonlySet<string>,
  causes?: K8sCreateCauses,
): FaultFinding | null {
  const name = deployment.metadata?.name ?? ''
  const desired = typeof deployment.spec?.replicas === 'number' ? deployment.spec.replicas : 1
  const ready = typeof deployment.status?.readyReplicas === 'number' ? deployment.status.readyReplicas : 0

  if (desired === 0) {
    // A workload intentionally scaled to zero (a demo load-generator, a paused
    // job) is expected, not an outage — mint nothing rather than noise.
    if (expectedZero?.has(name)) return null
    return {
      fault: 'scaled-to-zero',
      message: `Deployment ${name} is scaled to 0 — no running pods (desired 0)`,
      timestamp: nowIso(),
      attributes: { 'k8s.desiredReplicas': 0, 'k8s.readyReplicas': ready },
    }
  }

  // Fully ready → healthy, no incident.
  if (ready >= desired) return null

  const podFault = podLevelFault(deployment, pods)
  if (podFault) {
    podFault.attributes['k8s.desiredReplicas'] = desired
    podFault.attributes['k8s.readyReplicas'] = ready
    return podFault
  }

  // No pod named a cause: read why the workload can't get one — the ReplicaSet's
  // create failure first (quota, webhook, service account), then a pod the
  // scheduler can't place (#1484).
  if (causes) {
    const create = createFailureCause(deployment, causes)
    const sched = create ? undefined : unschedulableCause(deployment, pods, causes)
    const finding = create
      ? causeFinding('create-failed', `Deployment ${name} cannot create pods`, create)
      : sched
        ? causeFinding('unschedulable', `Deployment ${name} has pods the scheduler can't place`, sched)
        : null
    if (finding) {
      finding.attributes['k8s.desiredReplicas'] = desired
      finding.attributes['k8s.readyReplicas'] = ready
      return finding
    }
  }

  // Down, and nothing names a cause (an evicted pod, a read that failed) —
  // honestly report the degraded state without guessing the reason.
  return {
    fault: 'no-ready-replicas',
    message: `Deployment ${name} has no ready replicas (desired ${desired}, ready ${ready})`,
    timestamp: nowIso(),
    attributes: { 'k8s.desiredReplicas': desired, 'k8s.readyReplicas': ready },
  }
}

/**
 * One deployment -> one incident-bearing signal, or null when the workload is
 * healthy (classifyDeployment returned null) or unnamed (no metadata.name to
 * key an id / service on). The incident id is stable per (namespace, deployment,
 * fault) so re-polling the same fault collapses to one incident on read
 * (ingest.ts dedupeIncidents), and a changed fault mints a distinct one.
 */
export function mapDeploymentToSignal(
  deployment: Deployment,
  pods: Pod[],
  config: K8sConnectorConfig,
  logs?: K8sPodLogs,
  causes?: K8sCreateCauses,
): ObservedSignal | null {
  const name = deployment.metadata?.name
  if (typeof name !== 'string' || name.length === 0) return null
  const expectedZero = config.expectedZero ? new Set(config.expectedZero) : undefined
  const finding = classifyDeployment(deployment, pods, expectedZero, causes)
  if (!finding) return null

  // Fuse the OBSERVED "why" (process log + redacted env/args) onto the faulted
  // finding before it becomes the incident (ADR-237). Pod-level faults only.
  mergeProcessContext(finding, logs)

  const serviceName = serviceNameFor(deployment, config)
  const namespace = deployment.metadata?.namespace ?? config.namespace

  // The deploy context goes to the workload node, not the incident (ADR-243): the
  // incident keeps only its identity and the raw messages.
  const { deployContext, rest } = splitDeployContext(finding.fault, finding.attributes)
  const attributes: SpanAttributes = {
    'k8s.namespace': namespace,
    'k8s.deployment': name,
    ...rest,
  }

  return {
    targetKind: K8S_TARGET_KIND,
    targetName: packK8sTargetName({ serviceName, fault: finding.fault }),
    // Incident-only — no edge, so no call/error count to replay.
    callCount: 0,
    errorCount: 0,
    lastObservedIso: finding.timestamp,
    incident: {
      id: `k8s:deploy:${namespace}:${name}:${finding.fault}`,
      timestamp: finding.timestamp,
      service: serviceName,
      errorType: 'k8s-deploy-failure',
      errorMessage: finding.message,
      attributes,
      deployContext,
    },
  }
}

// The finding's attributes that make up the workload's deploy context (ADR-243),
// lifted into the typed block the pipeline fuses onto the node. Everything else
// stays an incident attribute.
function splitDeployContext(
  fault: string,
  attrs: SpanAttributes,
): { deployContext: DeployContext; rest: SpanAttributes } {
  const rest: SpanAttributes = { ...attrs }
  const take = (k: string): unknown => {
    const v = rest[k]
    delete rest[k]
    return v
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
  const int = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined
  const strs = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined
  const waitingReason = str(take('k8s.waitingReason'))
  const image = str(take('k8s.image'))
  const restartCount = int(take('k8s.restartCount'))
  const terminatedReason = str(take('k8s.terminatedReason'))
  const exitCode = int(take('k8s.exitCode'))
  const containerEnv = strs(take('k8s.containerEnv'))
  const containerArgs = strs(take('k8s.containerArgs'))
  const processLog = str(take('k8s.processLog'))
  const deployContext: DeployContext = {
    fault,
    ...(waitingReason ? { waitingReason } : {}),
    ...(image ? { image } : {}),
    ...(restartCount !== undefined ? { restartCount } : {}),
    ...(terminatedReason ? { terminatedReason } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(containerEnv ? { containerEnv } : {}),
    ...(containerArgs ? { containerArgs } : {}),
    ...(processLog ? { processLog } : {}),
  }
  return { deployContext, rest }
}

// The observed deploy state of a workload: the container image its pods are
// actually running (a *running* container is serving that image right now — for a
// stuck rollout that is the OLD image, even though the manifest declares a new
// one), and the count of ready replicas. This is the observed half of the
// declared-vs-observed deploy compare (ADR-225) — recorded for every workload,
// healthy included, so the divergence sees a stuck rollout that fires no incident.
function observedDeployState(
  deployment: Deployment,
  pods: Pod[],
): { image?: string; readyReplicas: number; addresses?: string[] } {
  const readyReplicas =
    typeof deployment.status?.readyReplicas === 'number' ? deployment.status.readyReplicas : 0
  let image: string | undefined
  for (const pod of podsForDeployment(deployment, pods)) {
    for (const cs of pod.status?.containerStatuses ?? []) {
      if (cs.state?.running && typeof cs.image === 'string' && cs.image.length > 0) {
        image = cs.image
        break
      }
    }
    if (image) break
  }
  return image !== undefined ? { image, readyReplicas } : { readyReplicas }
}

/**
 * One deploy-state signal per workload (healthy included), carrying the running
 * image + ready replicas to stamp as OBSERVED on the service node (ADR-225). It
 * mints no edge and no incident — `callCount: 0`, `deployState` set — it exists
 * purely so the declared-vs-observed compare has an observed side even when the
 * workload is up (the stuck-rollout case). Null for an unnamed workload.
 */
export function deployStateSignal(
  deployment: Deployment,
  pods: Pod[],
  config: K8sConnectorConfig,
  // The ClusterIPs that reach this workload (ADR-248), present only when the
  // poll read the Services list — `[]` then means it has none.
  addresses?: string[],
): ObservedSignal | null {
  const name = deployment.metadata?.name
  if (typeof name !== 'string' || name.length === 0) return null
  const serviceName = serviceNameFor(deployment, config)
  return {
    targetKind: K8S_TARGET_KIND,
    targetName: packK8sTargetName({ serviceName, fault: K8S_DEPLOY_STATE }),
    callCount: 0,
    errorCount: 0,
    lastObservedIso: nowIso(),
    deployState: {
      ...observedDeployState(deployment, pods),
      ...(addresses !== undefined ? { addresses } : {}),
    },
  }
}

export function mapWorkloadsToSignals(
  deployments: Deployment[],
  pods: Pod[],
  config: K8sConnectorConfig,
  logs?: K8sPodLogs,
  services?: Service[],
  causes?: K8sCreateCauses,
  configMaps?: ConfigMap[],
): ObservedSignal[] {
  const out: ObservedSignal[] = []
  const addresses = services ? addressesByDeployment(deployments, pods, services) : undefined
  for (const deployment of deployments) {
    // Deploy-state for every workload (the observed side of the divergence)...
    const name = deployment.metadata?.name ?? ''
    const deployState = deployStateSignal(
      deployment,
      pods,
      config,
      addresses ? (addresses.get(name) ?? []) : undefined,
    )
    if (deployState) out.push(deployState)
    // ...plus an incident only when the workload is unhealthy — carrying the
    // process-&-config fusion (ADR-237) when a process log was fetched for it.
    const incident = mapDeploymentToSignal(deployment, pods, config, logs, causes)
    if (incident) out.push(incident)
    // ...and the live spec on the workload's InfraNode (#1481).
    const spec = deploymentSpecSignal(deployment)
    if (spec) out.push(spec)
  }
  // Each Service's live spec, when the poll read them (#1481).
  for (const service of services ?? []) {
    const spec = serviceSpecSignal(service, deployments, pods)
    if (spec) out.push(spec)
  }
  // Each ConfigMap's data keys, when the poll read them (ADR-270).
  for (const cm of configMaps ?? []) {
    const spec = configMapSpecSignal(cm)
    if (spec) out.push(spec)
  }
  return out
}
