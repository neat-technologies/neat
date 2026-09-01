// Kubernetes deploy-state connector — provider-specific types (ADR-224, #1124).
// The second incident-emitting connector (connectors.md §10) after EAS (ADR-185):
// it pulls read-only cluster state and mints an OBSERVED incident on a service
// node when a workload is down for a *deployment* reason — a bad image, zero
// replicas, a crashloop — a fault a dead pod emits no span for, so the graph is
// otherwise blind to it. One `poll()` reads Deployments + Pods in one namespace;
// the shared pipeline (connectors/index.ts) writes each unhealthy workload's
// incident to the same ledger OTLP-derived incidents land in.
//
// Every field name below is a stable part of the Kubernetes API (apps/v1
// Deployment, core/v1 Pod), confirmed against the API reference rather than
// recalled (ADR-150/152 discipline). Nothing here is trusted present — a partial
// object drops honestly rather than throwing (connectors.md §4).

// ── credentials ──────────────────────────────────────────────────────────────

// `ConnectorContext.credentials` is opaque at the shared-scaffold layer
// (connectors/types.ts). The k8s credential carries the secret-bearing auth: a
// bearer token (an in-cluster / hosted service-account token) OR a kubeconfig
// (path or inline YAML, the "same access kubectl has" local path). Non-secret
// transport config (the API-server URL, the CA, the namespace, the service map)
// rides in `options` (K8sConnectorConfig), never here — the token flows into
// `Authorization: Bearer` and nowhere else (connectors.md §6, connector-config.md
// §7). Read-only RBAC only: get/list on deployments + pods.
export interface K8sCredentials {
  // A service-account bearer token. Paired with `options.apiServerUrl`.
  token?: string
  // A kubeconfig: an absolute path, or the YAML itself. Its current-context
  // supplies the server, CA, and auth (a token, or a client cert/key — kind's
  // default). When set it takes precedence over `token`.
  kubeconfig?: string
}

export function readK8sCredentials(raw: Record<string, unknown>): K8sCredentials {
  const token = typeof raw['token'] === 'string' && raw['token'].length > 0 ? (raw['token'] as string) : undefined
  const kubeconfig =
    typeof raw['kubeconfig'] === 'string' && raw['kubeconfig'].length > 0 ? (raw['kubeconfig'] as string) : undefined
  if (!token && !kubeconfig) {
    throw new Error('kubernetes connector: credentials must carry a token or a kubeconfig')
  }
  const out: K8sCredentials = {}
  if (token) out.token = token
  if (kubeconfig) out.kubeconfig = kubeconfig
  return out
}

// ── config ─────────────────────────────────────────────────────────────────

/**
 * Non-secret config resolved once at connector setup (connector-config.md §7) —
 * never re-derived from an API response at poll time.
 */
export interface K8sConnectorConfig {
  // The namespace to read. One namespace per connector entry, so RBAC stays
  // scoped and a multi-tenant cluster maps to one connector per tenant namespace.
  namespace: string
  // The API-server base URL (`https://host:6443`). Required with the token
  // credential; supplied by the kubeconfig otherwise.
  apiServerUrl?: string
  // The cluster CA certificate (PEM) to verify the API server's TLS. Supplied by
  // the kubeconfig otherwise; absent means the system trust store (a public cert).
  caCert?: string
  // Skip TLS verification — a dogfood escape hatch for a self-signed local
  // cluster with no CA to hand. Opt-in, never a default; a hosted deployment
  // supplies the CA instead.
  insecureSkipTlsVerify?: boolean
  // Deployment name -> NEAT manifest service name, for when a workload's name /
  // `app` label doesn't equal the OTel `service.name` the extractor keyed on
  // (resolved once, never guessed — the same map cloud-run/eas keep). An unmapped
  // workload falls back to its own name/label and stays honest.
  serviceMap?: Record<string, string>
  // Deployment names that are *intentionally* scaled to zero — a demo
  // load-generator, a manually-paused job, a cron-style workload. A
  // `scaled-to-zero` fault on one of these is expected, not an outage, so it
  // mints no incident (the noise the live run surfaced). Only suppresses the
  // scaled-to-zero classification; a real image-pull / crashloop on one of these
  // still reports.
  expectedZero?: string[]
  // API base override for tests (a stub k8s API); production uses apiServerUrl /
  // the kubeconfig server.
  apiUrl?: string
}

// ── the workload shapes (the subset this connector reads) ────────────────────

export interface OwnerReference {
  kind?: string
  name?: string
}

export interface ObjectMeta {
  name?: string
  namespace?: string
  labels?: Record<string, string>
  ownerReferences?: OwnerReference[]
  creationTimestamp?: string
}

export interface LabelSelector {
  matchLabels?: Record<string, string>
}

export interface DeploymentSpec {
  // Desired replica count. Absent defaults to 1 (the API default); `0` is the
  // explicit scaled-to-zero signal.
  replicas?: number
  selector?: LabelSelector
}

export interface DeploymentStatus {
  replicas?: number
  readyReplicas?: number
  availableReplicas?: number
  unavailableReplicas?: number
}

export interface Deployment {
  metadata?: ObjectMeta
  spec?: DeploymentSpec
  status?: DeploymentStatus
}

export interface ContainerStateWaiting {
  reason?: string
  message?: string
}

export interface ContainerStateTerminated {
  reason?: string
  message?: string
  exitCode?: number
  finishedAt?: string
}

export interface ContainerState {
  waiting?: ContainerStateWaiting
  terminated?: ContainerStateTerminated
  running?: { startedAt?: string }
}

export interface ContainerStatus {
  name?: string
  image?: string
  ready?: boolean
  restartCount?: number
  state?: ContainerState
  lastState?: ContainerState
}

export interface PodStatus {
  phase?: string
  containerStatuses?: ContainerStatus[]
  startTime?: string
  reason?: string
}

export interface Pod {
  metadata?: ObjectMeta
  status?: PodStatus
}

export interface K8sList<T> {
  items?: T[]
}

// ── fault classification (the honesty of the feature) ────────────────────────

// The deployment-fault vocabulary — stable strings that key the incident's
// dedupe id and name its kind on the card. Each is a fault a dead pod can't emit
// a span for, which is exactly why the connector exists (#1124).
export type K8sFaultKind = 'image-pull' | 'crash-loop' | 'scaled-to-zero' | 'no-ready-replicas'

// Container `waiting.reason` values that mean the image can't be pulled. These
// are the stable kubelet reason strings (image-pull backoff / hard failure).
export const IMAGE_PULL_REASONS = new Set<string>(['ImagePullBackOff', 'ErrImagePull', 'InvalidImageName'])
export const CRASH_LOOP_REASON = 'CrashLoopBackOff'

// The provider-vocabulary identity a signal carries through the shared pipeline,
// packed into `ObservedSignal.targetName` and unpacked only by this connector's
// own resolveTarget (resolve.ts), never surfaced to the graph. `\x00` separates
// the fields: it can't appear in a NEAT service name or a fault-kind token.
const FIELD_SEP = '\x00'

export const K8S_TARGET_KIND = 'k8s-workload'

// A deploy-state signal's marker in place of a fault (ADR-225). Not a fault — it
// carries the running image/ready-replicas for a workload (healthy included) so
// the declared-vs-observed deploy compare has an observed side. resolve.ts keys
// only on the service name, so this marker never needs its own resolution.
export const K8S_DEPLOY_STATE = 'deploy-state'

export interface K8sTargetIdentity {
  serviceName: string
  fault: K8sFaultKind | typeof K8S_DEPLOY_STATE
}

export function packK8sTargetName(identity: K8sTargetIdentity): string {
  return [identity.serviceName, identity.fault].join(FIELD_SEP)
}

export function parseK8sTargetName(targetName: string): K8sTargetIdentity | null {
  const sep = targetName.indexOf(FIELD_SEP)
  if (sep === -1) return null
  const serviceName = targetName.slice(0, sep)
  const fault = targetName.slice(sep + 1)
  if (!serviceName || !fault) return null
  return { serviceName, fault: fault as K8sFaultKind | typeof K8S_DEPLOY_STATE }
}
