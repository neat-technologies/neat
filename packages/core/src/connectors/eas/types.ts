// EAS build-failure connector — provider-specific types (ADR-185,
// docs/plans/eas-build-connector-plan.md). The first incident-emitting
// connector (connectors.md §10): it pulls `ERRORED` Expo/EAS builds from the
// Expo GraphQL API and mints one build-failure incident per build, not an
// OBSERVED edge.
//
// The Expo GraphQL API is undocumented and unversioned — every field below is
// reconstructed from `expo/eas-cli`'s generated schema, and treated as the top
// drift risk: the query is pinned (client.ts) and a shape error fails loud
// rather than dropping builds silently (connectors.md §10, ADR-150/152).

// ── credentials ──────────────────────────────────────────────────────────

// `ConnectorContext.credentials` is opaque at the shared-scaffold layer
// (connectors/types.ts). The EAS credential is a single robot-user `EXPO_TOKEN`
// carried into `Authorization: Bearer` and nowhere else (connector-config.md
// §7.1, connectors.md §6) — a robot user, not a personal token, is the
// least-privilege grant for a server connector.
export interface EasCredentials {
  token: string
}

export function readEasCredentials(raw: Record<string, unknown>): EasCredentials {
  const token = raw['token']
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('eas connector: credentials.token (EXPO_TOKEN) must be a non-empty string')
  }
  return { token }
}

// ── config ─────────────────────────────────────────────────────────────────

/**
 * Config resolved once at connector setup (connector-config.md §7.1) — never
 * re-derived from a build response at poll time.
 */
export interface EasConnectorConfig {
  // The Expo app's `projectId` (a UUID) — the id `app.byId(appId:)` keys on.
  // Not a secret (it names the app), so it rides in `options`, not `credential`.
  appId: string
  // The NEAT manifest service the app's repo maps to, so a build incident fuses
  // onto that service's extracted nodes (resolve.ts). Omitted, the connector
  // anchors to the app id honestly and stays coarse (a native-phase failure then
  // drops, since there's no extracted service to land on).
  serviceName?: string
  // Expo GraphQL endpoint. Defaults to the public one; overridable for tests.
  apiUrl?: string
  // Pagination page size and a defensive page cap (offset-based, newest-first).
  pageSize?: number
  maxPages?: number
  // Cap on the log slice stored in an incident. Xcode logs can reach ~10MB and
  // the signed URLs are time-limited, so the connector fetches on poll and keeps
  // a bounded tail (the failure reason is near the end of a build log).
  maxLogBytes?: number
  // Bounded lookback for a first poll (no prior `since`) or a gap wider than the
  // window — never an unbounded full-history replay (connectors.md §Poll cadence
  // and backfill).
  maxLookbackMs?: number
}

// ── the build shape (the subset this connector reads) ────────────────────────

// `Build.error` — `buildPhase` is a strict enum (the reliable structured
// classifier); `errorCode` is free-text (a hint only, never a strict switch);
// `message`/`docsUrl` are the human-facing failure text.
export interface EasBuildError {
  buildPhase?: string | null
  errorCode?: string | null
  message?: string | null
  docsUrl?: string | null
}

// One `Build`. Every field is optional in the wire type — the query pins them,
// but nothing here is trusted present, so the mapper treats an absent field as an
// honest miss rather than guessing (connectors.md §4).
export interface EasBuild {
  id: string
  status?: string | null
  platform?: string | null
  buildProfile?: string | null
  gitCommitHash?: string | null
  gitCommitMessage?: string | null
  gitRef?: string | null
  isGitWorkingTreeDirty?: boolean | null
  createdAt?: string | null
  completedAt?: string | null
  error?: EasBuildError | null
  logFileUrls?: string[] | null
  // Populated by client.ts after fetch-and-cap; not part of the wire query.
  logsText?: string
}

// ── build-status + phase classification (the honesty of the feature) ────────

// The one build status this connector mints for: a build that ran and failed.
// CANCELED (aborted) and FINISHED (success) and the in-flight states are skipped.
export const EAS_STATUS_ERRORED = 'ERRORED'

// Build phases whose failure is NOT a repo bug — the builder infra, credentials,
// cache restore, archive upload. An incident here would turn an EAS outage into a
// false repo divergence (connectors.md §10), so map.ts mints nothing for them.
// This is a conservative EXCLUSION set: excluding is safe (never a false
// incident), so when a phase clearly names infra it's dropped.
export const TRANSIENT_BUILD_PHASES = new Set<string>([
  'SPIN_UP_BUILDER',
  'PREPARE_CREDENTIALS',
  'RESTORE_CACHE',
  'UPLOAD_APPLICATION_ARCHIVE',
])

// `buildPhase` is the stable classifier, but the free-text `errorCode` is still
// usable as an additional EXCLUSION signal — never to attribute, only to filter
// out an EAS-internal failure the phase enum didn't already name. Conservative on
// purpose: a match drops the build, it never mints one.
const INTERNAL_ERROR_CODE = /INTERNAL_SERVER_ERROR|EAS_BUILD_.*INTERNAL|_INTERNAL_ERROR|UNKNOWN_ERROR/i

// Whether a failure is transient/infra and must mint nothing (connectors.md §10,
// guardrail 1). Switches on the stable `buildPhase` enum plus the conservative
// `errorCode` heuristic; when in doubt (an unrecognized phase) it is NOT
// transient — the app-node + log fallback in resolve.ts handles it honestly.
export function isTransientFailure(err: EasBuildError | null | undefined): boolean {
  if (!err) return false
  const phase = typeof err.buildPhase === 'string' ? err.buildPhase : undefined
  if (phase) {
    if (TRANSIENT_BUILD_PHASES.has(phase)) return true
    if (/^SPIN_UP|_CREDENTIALS$|^RESTORE_CACHE/i.test(phase)) return true
  }
  const code = typeof err.errorCode === 'string' ? err.errorCode : undefined
  if (code && INTERNAL_ERROR_CODE.test(code)) return true
  return false
}

// The provider-vocabulary identity a signal carries through the shared pipeline,
// packed into `ObservedSignal.targetName` and unpacked only by this connector's
// own resolveTarget (resolve.ts), never surfaced to the graph. `\x00` separates
// the fields: it can't appear in a NEAT service name or a build-phase enum token.
const FIELD_SEP = '\x00'

export const EAS_TARGET_KIND = 'eas-build'

export interface EasTargetIdentity {
  serviceName: string
  // The build phase, or '' when the failure carried no phase (a native/unknown
  // failure → the app-node fallback in resolve.ts).
  phase: string
}

export function packEasTargetName(identity: EasTargetIdentity): string {
  return [identity.serviceName, identity.phase].join(FIELD_SEP)
}

export function parseEasTargetName(targetName: string): EasTargetIdentity | null {
  const sep = targetName.indexOf(FIELD_SEP)
  if (sep === -1) return null
  const serviceName = targetName.slice(0, sep)
  const phase = targetName.slice(sep + 1)
  if (!serviceName) return null
  return { serviceName, phase }
}
