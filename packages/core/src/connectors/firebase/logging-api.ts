// Cloud Logging `entries.list` — the raw fetch half of the Firebase connector
// (docs/connectors/firebase.md, ADR-128). This file owns exactly the wire
// shape and the HTTP call; mapping a `LogEntry` to an `ObservedSignal` lives
// in map.ts, and target resolution lives in resolve.ts — the same
// fetch/map/resolve split every other provider module keeps (connectors.md
// §Authority).
//
// Every field name below was confirmed live against Google's own docs rather
// than recalled from training data (per this connector's build instructions):
//   - request/response envelope + endpoint:
//     https://cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list
//   - LogEntry + HttpRequest field names:
//     https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry
//   - monitored-resource labels for cloud_function / cloud_run_revision /
//     firebase_domain:
//     https://cloud.google.com/logging/docs/api/v2/resource-list
// Anything not directly confirmed by those pages is called out inline as
// unconfirmed rather than asserted as fact.

import { bearerAuthHeader, junctionFetch } from '../junction.js'

// ── credentials ──────────────────────────────────────────────────────────

// `ConnectorContext.credentials` is opaque at the shared-scaffold layer
// (types.ts) — this is the Firebase-specific shape it must carry. Per
// docs/connectors/firebase.md §Surfaces used, both the local and hosted
// profile use the same narrow grant (`roles/monitoring.viewer`,
// `roles/logging.viewer`, `roles/cloudfunctions.viewer`,
// `roles/firebasehosting.viewer`) — there's no Fork-A-style split here the
// way Supabase's `pg_stat_statements` gap forced. Minting `accessToken` (a
// service-account or ADC-derived OAuth token scoped to those roles) is a
// profile-specific broker/config concern (connectors.md §3) outside this
// connector's job — `poll()` only ever consumes an already-minted token, the
// same way Railway's connector consumes an already-minted
// `Project-Access-Token` rather than performing its own auth handshake.
export interface FirebaseCredentials {
  projectId: string
  accessToken: string
}

export function readFirebaseCredentials(raw: Record<string, unknown>): FirebaseCredentials {
  const projectId = raw['projectId']
  const accessToken = raw['accessToken']
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new Error('firebase connector: credentials.projectId must be a non-empty string')
  }
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('firebase connector: credentials.accessToken must be a non-empty string')
  }
  return { projectId, accessToken }
}

// ── Cloud Logging wire types ─────────────────────────────────────────────

// The three monitored-resource types this connector polls (firebase.md
// §Surfaces used). 2nd-gen Cloud Functions can surface under either
// `cloud_function` or `cloud_run_revision` depending on how Google's own
// logging pipeline attributes the request — both are polled so neither shape
// is missed.
export type FirebaseResourceType = 'cloud_function' | 'cloud_run_revision' | 'firebase_domain'

const RESOURCE_TYPES: readonly FirebaseResourceType[] = [
  'cloud_function',
  'cloud_run_revision',
  'firebase_domain',
]

export function isFirebaseResourceType(value: string): value is FirebaseResourceType {
  return (RESOURCE_TYPES as readonly string[]).includes(value)
}

// MonitoredResource (LogEntry.resource). `labels` carries the resource-type-
// specific identity fields confirmed at
// https://cloud.google.com/logging/docs/api/v2/resource-list:
//   cloud_function:      project_id, function_name, region
//   cloud_run_revision:  project_id, service_name, revision_name, location,
//                        configuration_name
//   firebase_domain:     project_id, site_name, domain_name
export interface MonitoredResource {
  type: string
  labels?: Record<string, string>
}

// HttpRequest (LogEntry.httpRequest), field names confirmed against the
// LogEntry reference page above. Every field is optional in the wire type —
// a structured request log is expected to carry requestMethod/requestUrl/
// status, but nothing here is guaranteed present, so the mapper (map.ts)
// treats an absent field as an honest miss rather than guessing a default.
export interface HttpRequest {
  requestMethod?: string
  requestUrl?: string
  requestSize?: string
  status?: number
  responseSize?: string
  userAgent?: string
  remoteIp?: string
  serverIp?: string
  referer?: string
  latency?: string
  cacheLookup?: boolean
  cacheHit?: boolean
  cacheValidatedWithOriginServer?: boolean
  cacheFillBytes?: string
  protocol?: string
}

// LogEntry, the subset of fields this connector reads. `timestamp` is the
// provider's own event time (confirmed string/Timestamp-format field) — used
// as `ObservedSignal.lastObservedIso`, never `receiveTimestamp` (ingest-time),
// matching the "provider's own event time, never poll-arrival time" rule
// (connectors/README.md §Poll cadence and backfill).
export interface LogEntry {
  logName?: string
  resource?: MonitoredResource
  timestamp?: string
  receiveTimestamp?: string
  severity?: string
  insertId?: string
  httpRequest?: HttpRequest
}

export interface EntriesListRequest {
  resourceNames: string[]
  filter?: string
  orderBy?: string
  pageSize?: number
  pageToken?: string
}

export interface EntriesListResponse {
  entries?: LogEntry[]
  nextPageToken?: string
}

// ── filter construction ──────────────────────────────────────────────────

// Cloud Logging query-language operators confirmed against
// https://cloud.google.com/logging/docs/view/logging-query-language:
//   - `resource.type = ("a" OR "b")` for a multi-value match
//   - `httpRequest:*` as the field-exists test
//   - `timestamp >= "<RFC3339>"` for a lower bound
// Joined with explicit `AND` rather than relying on the query language's
// documented (but not directly re-confirmed here) implicit-AND-per-line
// behaviour.
export function buildEntriesFilter(sinceIso: string): string {
  return [
    'resource.type = ("cloud_function" OR "cloud_run_revision" OR "firebase_domain")',
    'httpRequest:*',
    `timestamp >= "${sinceIso}"`,
  ].join(' AND ')
}

// No documented lookback cap surfaced for `entries.list` itself (bounded only
// by the log bucket's own retention, typically 30 days on the `_Default`
// bucket) — mirrors docs/connectors/supabase.md's "capped at 24h lookback"
// convention for a local-profile poll with no prior high-water mark, the
// closest documented analog in this codebase, rather than inventing an
// unbounded first query.
export const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000

const ENTRIES_LIST_URL = 'https://logging.googleapis.com/v2/entries:list'
const PAGE_SIZE = 1000
// Defensive cap on pagination — entries.list documents no page-count limit,
// so this bounds the loop the same way STITCH_MAX_DEPTH bounds trace-stitch
// BFS elsewhere in ingest.ts, rather than trusting an unbounded while(true).
const MAX_PAGES = 20

export async function fetchHttpRequestLogEntries(
  creds: FirebaseCredentials,
  sinceIso: string,
): Promise<LogEntry[]> {
  const filter = buildEntriesFilter(sinceIso)
  const out: LogEntry[] = []
  let pageToken: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const body: EntriesListRequest = {
      resourceNames: [`projects/${creds.projectId}`],
      filter,
      orderBy: 'timestamp asc',
      pageSize: PAGE_SIZE,
      ...(pageToken ? { pageToken } : {}),
    }
    const res = await junctionFetch(
      ENTRIES_LIST_URL,
      {
        method: 'POST',
        headers: {
          ...bearerAuthHeader(creds.accessToken),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      // accountKey: the GCP project id (ADR-131's own worked example for
      // Firebase) — one customer's Cloud Logging quota is scoped per GCP
      // project, not per Firebase site/function.
      { provider: 'firebase', accountKey: creds.projectId },
    )
    if (!res.ok) {
      throw new Error(`Cloud Logging entries.list failed: ${res.status} ${res.statusText}`)
    }
    const json = (await res.json()) as EntriesListResponse
    out.push(...(json.entries ?? []))
    if (!json.nextPageToken) break
    pageToken = json.nextPageToken
  }
  return out
}
