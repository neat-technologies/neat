// Cloud Logging `entries.list` — the fetch half of the GCP HTTP(S) Load
// Balancer connector (docs/connectors/gcp-lb.md, ADR-218). This file owns the
// wire shape and the HTTP call; mapping a `LogEntry` to an `ObservedSignal`
// lives in map.ts, and target resolution in resolve.ts — the same
// fetch/map/resolve split every other provider module keeps (connectors.md
// §Authority). Passive and ambient only (connectors.md §2): one read-only
// query, never a mutation, never a synthetic request.
//
// This is the same Cloud Logging surface the Cloud Run connector (ADR-165)
// reads; only the log name and monitored-resource type differ. Every field name
// below was confirmed live against Google's own docs rather than recalled from
// training data (ADR-218 §Context, ADR-150/152 discipline):
//   - request/response envelope + endpoint:
//     https://cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list
//   - LogEntry + HttpRequest field names:
//     https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry
//   - http_load_balancer monitored-resource labels:
//     https://cloud.google.com/logging/docs/api/v2/resource-list
//   - the external ALB request log (logName ".../logs/requests", resource type
//     http_load_balancer, and httpRequest.protocol NOT populated for it):
//     https://cloud.google.com/load-balancing/docs/https/https-logging-monitoring

import { bearerAuthHeader, junctionFetch } from '../junction.js'
import type { GcpLbCredentials } from './types.js'

// ── Cloud Logging wire types ─────────────────────────────────────────────

// MonitoredResource (LogEntry.resource). For an external HTTP(S) Load Balancer
// request log the type is `http_load_balancer` and `labels` carries
// backend_service_name / forwarding_rule_name / target_proxy_name / url_map_name
// / zone / project_id (resource-list docs above). This connector reads
// `backend_service_name` — the backend the LB routed the request to, the fusion
// key onto a NEAT service.
export interface MonitoredResource {
  type: string
  labels?: Record<string, string>
}

// HttpRequest (LogEntry.httpRequest), field names confirmed against the
// LogEntry reference page. Every field is optional in the wire type — a request
// log is expected to carry requestMethod/requestUrl/status, but nothing here is
// guaranteed present, so the mapper (map.ts) treats an absent field as an honest
// miss rather than guessing a default. `protocol` is documented as NOT populated
// for `resource.type = "http_load_balancer"`, so it is deliberately absent from
// the fields this connector reads.
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
}

// LogEntry, the subset this connector reads. `timestamp` is the request's own
// event time (a string RFC3339/Timestamp field) — used as
// `ObservedSignal.lastObservedIso`, never `receiveTimestamp` (ingest time),
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

// The external HTTP(S) Load Balancer request log's own name (confirmed at
// cloud.google.com/load-balancing/docs/https/https-logging-monitoring):
// `projects/<id>/logs/requests`. Unlike Cloud Run's `run.googleapis.com%2Frequests`,
// the LB log id is a plain `requests` with no `/` to URL-encode. Pinning the log
// name + the `http_load_balancer` resource type is what scopes this connector to
// exactly the LB's own request record.
export function gcpLbRequestLogName(projectId: string): string {
  return `projects/${projectId}/logs/requests`
}

// Cloud Logging query-language operators confirmed against
// https://cloud.google.com/logging/docs/view/logging-query-language:
//   - `logName = "..."` pins the request log
//   - `resource.type = "..."` pins the monitored resource (the external ALB)
//   - `httpRequest.requestMethod != ""` requires a request (an httpRequest that
//     actually carries a method), rather than any entry on the resource
//   - `timestamp >= "<RFC3339>"` for the watermark lower bound
// Joined with explicit `AND`.
export function buildGcpLbEntriesFilter(projectId: string, sinceIso: string): string {
  return [
    `logName = "${gcpLbRequestLogName(projectId)}"`,
    `resource.type = "${GCP_LB_RESOURCE_TYPE}"`,
    'httpRequest.requestMethod != ""',
    `timestamp >= "${sinceIso}"`,
  ].join(' AND ')
}

const GCP_LB_RESOURCE_TYPE = 'http_load_balancer'

// No documented lookback cap surfaced for `entries.list` itself (bounded only
// by the log bucket's retention, typically 30 days on `_Default`) — a
// conservative 24h default for a first poll with no prior high-water mark, the
// same convention Cloud Run, Firebase, and Supabase keep, never an unbounded
// first query (connectors.md "Poll cadence and backfill").
export const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000

const ENTRIES_LIST_URL = 'https://logging.googleapis.com/v2/entries:list'
const PAGE_SIZE = 1000
// Defensive cap on pagination — entries.list documents no page-count limit, so
// this bounds the loop rather than trusting an unbounded while(true), the same
// way Cloud Run's client and STITCH_MAX_DEPTH bound their loops elsewhere.
const MAX_PAGES = 20

export async function fetchGcpLbRequestLogEntries(
  creds: GcpLbCredentials,
  sinceIso: string,
  apiUrl: string = ENTRIES_LIST_URL,
): Promise<LogEntry[]> {
  const filter = buildGcpLbEntriesFilter(creds.projectId, sinceIso)
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
      apiUrl,
      {
        method: 'POST',
        headers: {
          ...bearerAuthHeader(creds.accessToken),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      // accountKey: the GCP project id — one customer's Cloud Logging quota is
      // scoped per GCP project (ADR-131's per-(provider, accountKey) rate-limit
      // bucket), the same key Cloud Run's and Firebase's connectors use.
      { provider: 'gcp-lb', accountKey: creds.projectId },
    )
    if (!res.ok) {
      throw new Error(`Cloud Logging entries.list failed: ${res.status} ${res.statusText}`)
    }
    const json = (await res.json()) as EntriesListResponse
    // A well-formed page carries an array (absent when the window is empty); a
    // shape drift handing back a non-array `entries` drops honestly rather than
    // throwing on `push(...nonIterable)` (connectors.md §4).
    if (Array.isArray(json.entries)) out.push(...json.entries)
    if (!json.nextPageToken) break
    pageToken = json.nextPageToken
  }
  return out
}
