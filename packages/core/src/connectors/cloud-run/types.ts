// Cloud Run connector — provider-specific types (docs/connectors/cloud-run.md,
// ADR-165). Sixth connectors-plane pull provider, following the
// hosting-platform pattern ADR-127 (Railway) established and ADR-128 (Firebase)
// already applies to `cloud_run_revision` request logs.
//
// Cloud Run names nothing in application code: the signal comes entirely from
// Google's own request-logging pipeline (Cloud Logging), so fusion binds onto
// the RouteNode `extract/routes.ts` already builds — the same node an OBSERVED
// server span would fuse onto if the app were OTel-instrumented.

// ── credentials ────────────────────────────────────────────────────────────

// `ConnectorContext.credentials` is opaque at the shared-scaffold layer
// (connectors/types.ts) — this is the Cloud-Run-specific shape it must carry.
// `projectId` is not a secret (it names the GCP project); `accessToken` is a
// short-lived OAuth token scoped to `roles/logging.viewer`, minted from a
// service-account key or ADC. `poll()` only ever consumes an already-minted
// token, never performing its own auth handshake — the same way Firebase's
// connector consumes an already-minted `accessToken` and Railway's an
// already-minted `Project-Access-Token` (docs/connectors/cloud-run.md
// §Credential + least privilege, connectors.md §3).
export interface CloudRunCredentials {
  projectId: string
  accessToken: string
}

export function readCloudRunCredentials(raw: Record<string, unknown>): CloudRunCredentials {
  const projectId = raw['projectId']
  const accessToken = raw['accessToken']
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new Error('cloud-run connector: credentials.projectId must be a non-empty string')
  }
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('cloud-run connector: credentials.accessToken must be a non-empty string')
  }
  return { projectId, accessToken }
}

// ── config ─────────────────────────────────────────────────────────────────

/**
 * Config resolved once at connector setup (docs/connectors/cloud-run.md
 * §Fusion, "resolved once, never guessed") — never re-derived from a Cloud
 * Logging response at poll time.
 */
export interface CloudRunConnectorConfig {
  // GCP `service_name` (resource.labels.service_name) -> the NEAT manifest
  // service name that resolves `serviceId(name)` (packages/types/src/identity.ts).
  // A Cloud Run service name need not match `package.json#name`, so the mapping
  // is supplied once at setup, never inferred from a log record. An unmapped
  // service still produces honest service-grained edges (resolve.ts tier 2),
  // so this is optional — a connector added before the map is filled stays
  // coarse rather than silent.
  serviceMap?: Record<string, string>
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
// never inspects this string itself). Cloud Run has exactly one monitored
// resource type for request logs, so this is a single constant rather than a
// set the way Firebase carries three.
export const CLOUD_RUN_TARGET_KIND = 'cloud_run_revision'

// The (service_name, method, path) identity a signal carries through the shared
// pipeline, packed into ObservedSignal.targetName (a plain string field) and
// unpacked only by this connector's own resolveTarget (resolve.ts), never
// surfaced to the graph. `\x00` is the separator: it cannot appear in an HTTP
// method token, a GCP service name, or a URL path.
const FIELD_SEP = '\x00'

export interface CloudRunTargetIdentity {
  serviceName: string
  method: string
  path: string
}

export function packCloudRunTargetName(identity: CloudRunTargetIdentity): string {
  return [identity.serviceName, identity.method, identity.path].join(FIELD_SEP)
}

export function parseCloudRunTargetName(targetName: string): CloudRunTargetIdentity | null {
  // Split on the first two separators only — a path (always the last field)
  // carries no separator in practice, but splitting non-greedily keeps this
  // correct even if it ever did.
  const firstSep = targetName.indexOf(FIELD_SEP)
  if (firstSep === -1) return null
  const serviceName = targetName.slice(0, firstSep)
  const rest = targetName.slice(firstSep + 1)
  const secondSep = rest.indexOf(FIELD_SEP)
  if (secondSep === -1) return null
  const method = rest.slice(0, secondSep)
  const path = rest.slice(secondSep + 1)
  if (!serviceName || !method || !path) return null
  return { serviceName, method, path }
}
