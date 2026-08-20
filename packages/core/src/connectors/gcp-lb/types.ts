// GCP HTTP(S) Load Balancer connector — provider-specific types
// (docs/connectors/gcp-lb.md, ADR-208). Eleventh connectors-plane pull provider,
// the second GCP request-log surface after Cloud Run (ADR-165) and the direct
// sibling of it: both pull Cloud Logging's `entries.list` and fuse onto the
// RouteNode `extract/routes.ts` already builds.
//
// An external Application Load Balancer names nothing in application code: the
// signal comes entirely from Google's own load-balancing request-logging
// pipeline (Cloud Logging), so fusion binds onto the RouteNode — the same node
// an OBSERVED server span would fuse onto if the backend app were OTel-
// instrumented. Where Cloud Run keys its signal on the GCP `service_name`, the
// LB keys on the log's `backend_service_name` label (the backend the LB routed
// to) — the fusion vocabulary this file packs and the resolve step unpacks.

// ── credentials ────────────────────────────────────────────────────────────

// `ConnectorContext.credentials` is opaque at the shared-scaffold layer
// (connectors/types.ts) — this is the GCP-LB-specific shape it must carry.
// `projectId` is not a secret (it names the GCP project); `accessToken` is a
// short-lived OAuth token scoped to `roles/logging.viewer`, minted from a
// service-account key or ADC. `poll()` only ever consumes an already-minted
// token, never performing its own auth handshake — identical to Cloud Run's and
// Firebase's connectors (docs/connectors/gcp-lb.md §Credential + least
// privilege, connectors.md §3).
export interface GcpLbCredentials {
  projectId: string
  accessToken: string
}

export function readGcpLbCredentials(raw: Record<string, unknown>): GcpLbCredentials {
  const projectId = raw['projectId']
  const accessToken = raw['accessToken']
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new Error('gcp-lb connector: credentials.projectId must be a non-empty string')
  }
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('gcp-lb connector: credentials.accessToken must be a non-empty string')
  }
  return { projectId, accessToken }
}

// ── config ─────────────────────────────────────────────────────────────────

/**
 * Config resolved once at connector setup (docs/connectors/gcp-lb.md §Fusion,
 * "resolved once, never guessed") — never re-derived from a Cloud Logging
 * response at poll time.
 */
export interface GcpLbConnectorConfig {
  // GCP `backend_service_name` (resource.labels.backend_service_name) -> the
  // NEAT manifest service name that resolves `serviceId(name)`
  // (packages/types/src/identity.ts). A backend service name (the GCE/GKE/NEG
  // backend the LB fronts) need not match `package.json#name`, so the mapping
  // is supplied once at setup, never inferred from a log record. An unmapped
  // backend still produces honest backend-grained edges (resolve.ts tier 2),
  // so this is optional — a connector added before the map is filled stays
  // coarse rather than silent.
  backendServiceMap?: Record<string, string>
  // Bounded lookback cap in ms for a first poll (no prior `since`) or a gap
  // wider than this window. Overridable; defaults to 24h
  // (connectors.md "Poll cadence and backfill").
  maxLookbackMs?: number
  // Cloud Logging API base. Defaults to the public endpoint; overridable for
  // tests and any proxy in front of it.
  apiUrl?: string
}

// ── target identity (the provider's own vocabulary) ─────────────────────────

// A signal's `targetKind` for this provider (connectors/types.ts's
// ObservedSignal doc: "the provider's own vocabulary" — the shared pipeline
// never inspects this string itself). An external HTTP(S) Load Balancer writes
// exactly one monitored resource type for request logs.
export const GCP_LB_TARGET_KIND = 'http_load_balancer'

// The (backend_service_name, method, path) identity a signal carries through
// the shared pipeline, packed into ObservedSignal.targetName (a plain string
// field) and unpacked only by this connector's own resolveTarget (resolve.ts),
// never surfaced to the graph. `\x00` is the separator: it cannot appear in an
// HTTP method token, a GCP backend-service name, or a URL path.
const FIELD_SEP = '\x00'

export interface GcpLbTargetIdentity {
  backendServiceName: string
  method: string
  path: string
}

export function packGcpLbTargetName(identity: GcpLbTargetIdentity): string {
  return [identity.backendServiceName, identity.method, identity.path].join(FIELD_SEP)
}

export function parseGcpLbTargetName(targetName: string): GcpLbTargetIdentity | null {
  // Split on the first two separators only — a path (always the last field)
  // carries no separator in practice, but splitting non-greedily keeps this
  // correct even if it ever did.
  const firstSep = targetName.indexOf(FIELD_SEP)
  if (firstSep === -1) return null
  const backendServiceName = targetName.slice(0, firstSep)
  const rest = targetName.slice(firstSep + 1)
  const secondSep = rest.indexOf(FIELD_SEP)
  if (secondSep === -1) return null
  const method = rest.slice(0, secondSep)
  const path = rest.slice(secondSep + 1)
  if (!backendServiceName || !method || !path) return null
  return { backendServiceName, method, path }
}
