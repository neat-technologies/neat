// Deployment + Pod state -> ObservedSignal mapping (ADR-224, connectors.md §10).
// One incident-bearing signal per *unhealthy* workload — a bad image, zero
// replicas, a crashloop — carrying the concrete cause the shared pipeline writes
// as an OBSERVED incident on the service node (not an edge). A healthy workload
// mints nothing in v1: the bench value is the incidents, the faults a dead pod
// emits no span for (#1124). The EAS mapper turns a build failure into an
// incident signal; this turns a deployment fault into one — same interface,
// same terminal write.

import type { ObservedSignal } from '../types.js'
import type { SpanAttributes } from '@neat.is/types'
import type {
  ContainerStatus,
  Deployment,
  K8sConnectorConfig,
  K8sFaultKind,
  Pod,
} from './types.js'
import {
  CRASH_LOOP_REASON,
  IMAGE_PULL_REASONS,
  K8S_TARGET_KIND,
  packK8sTargetName,
} from './types.js'

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

interface FaultFinding {
  fault: K8sFaultKind
  message: string
  timestamp: string
  attributes: SpanAttributes
}

function nowIso(): string {
  return new Date().toISOString()
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
    }
  }
  return null
}

/**
 * Classify one deployment's health. Returns the fault to mint an incident for,
 * or null when the workload is healthy (fully ready) — so a healthy deployment
 * mints nothing. Order: an explicit `replicas: 0` is scaled-to-zero; a
 * not-fully-ready deployment is diagnosed by its pods (image-pull / crashloop),
 * falling back to an un-classified `no-ready-replicas` when the deployment is
 * down but no pod names a cause.
 */
export function classifyDeployment(deployment: Deployment, pods: Pod[]): FaultFinding | null {
  const name = deployment.metadata?.name ?? ''
  const desired = typeof deployment.spec?.replicas === 'number' ? deployment.spec.replicas : 1
  const ready = typeof deployment.status?.readyReplicas === 'number' ? deployment.status.readyReplicas : 0

  if (desired === 0) {
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

  // Down, but no pod named a cause (pending scheduling, quota, an evicted pod) —
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
): ObservedSignal | null {
  const name = deployment.metadata?.name
  if (typeof name !== 'string' || name.length === 0) return null
  const finding = classifyDeployment(deployment, pods)
  if (!finding) return null

  const serviceName = serviceNameFor(deployment, config)
  const namespace = deployment.metadata?.namespace ?? config.namespace

  const attributes: SpanAttributes = {
    'k8s.namespace': namespace,
    'k8s.deployment': name,
    'k8s.fault': finding.fault,
    ...finding.attributes,
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
    },
  }
}

export function mapWorkloadsToSignals(
  deployments: Deployment[],
  pods: Pod[],
  config: K8sConnectorConfig,
): ObservedSignal[] {
  const out: ObservedSignal[] = []
  for (const deployment of deployments) {
    const signal = mapDeploymentToSignal(deployment, pods, config)
    if (signal) out.push(signal)
  }
  return out
}
