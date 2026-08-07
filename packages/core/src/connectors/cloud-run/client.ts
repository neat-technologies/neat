// Cloud Logging `entries.list` — the fetch half of the Cloud Run connector
// (docs/connectors/cloud-run.md, ADR-165). This file owns the wire shape and
// the HTTP call; mapping a `LogEntry` to an `ObservedSignal` lives in map.ts,
// and target resolution in resolve.ts — the same fetch/map/resolve split every
// other provider module keeps (connectors.md §Authority). Passive and ambient
// only (connectors.md §2): one read-only query, never a mutation, never a
// synthetic request.
//
// Every field name below was confirmed live against Google's own docs rather
// than recalled from training data (ADR-165 §Context, ADR-150/152 discipline):
//   - request/response envelope + endpoint:
//     https://cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list
//   - LogEntry + HttpRequest field names:
//     https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry
//   - cloud_run_revision monitored-resource labels:
//     https://cloud.google.com/logging/docs/api/v2/resource-list
//   - the request log name (run.googleapis.com%2Frequests) + auto-emission:
//     https://cloud.google.com/run/docs/logging

import { bearerAuthHeader, junctionFetch } from '../junction.js'
import type { CloudRunCredentials } from './types.js'

// ── Cloud Logging wire types ─────────────────────────────────────────────

// MonitoredResource (LogEntry.resource). For a Cloud Run request log the type
// is `cloud_run_revision` and `labels` carries service_name / revision_name /
// location / configuration_name / project_id (resource-list docs above). This
// connector reads `service_name`.
export interface MonitoredResource {
  type: string
  labels?: Record<string, string>
}

// HttpRequest (LogEntry.httpRequest), field names confirmed against the
// LogEntry reference page. Every field is optional in the wire type — a request
// log is expected to carry requestMethod/requestUrl/status, but nothing here is
// guaranteed present, so the mapper (map.ts) treats an absent field as an
// honest miss rather than guessing a default.
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
  protocol?: string
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

// The Cloud Run request log's own name (confirmed at cloud.google.com/run/docs/
// logging): `projects/<id>/logs/run.googleapis.com%2Frequests`. The `/` inside
// the log id is URL-encoded `%2F`, and the Logging query-language filter carries
// that encoded form. Pinning the log name is what separates this connector from
// Firebase's broader `cloud_run_revision` sweep — it reads exactly Cloud Run's
// own request record, never an app's stdout/stderr on the same resource.
export function cloudRunRequestLogName(projectId: string): string {
  return `projects/${projectId}/logs/run.googleapis.com%2Frequests`
}

// Cloud Logging query-language operators confirmed against
// https://cloud.google.com/logging/docs/view/logging-query-language:
//   - `logName = "..."` pins the request log
//   - `resource.type = "..."` pins the monitored resource
//   - `httpRequest.requestMethod != ""` requires a request (an httpRequest that
//     actually carries a method), rather than any entry on the resource
//   - `timestamp >= "<RFC3339>"` for the watermark lower bound
// Joined with explicit `AND`.
export function buildCloudRunEntriesFilter(projectId: string, sinceIso: string): string {
  return [
    `logName = "${cloudRunRequestLogName(projectId)}"`,
    `resource.type = "${CLOUD_RUN_RESOURCE_TYPE}"`,
    'httpRequest.requestMethod != ""',
    `timestamp >= "${sinceIso}"`,
  ].join(' AND ')
}

const CLOUD_RUN_RESOURCE_TYPE = 'cloud_run_revision'

// No documented lookback cap surfaced for `entries.list` itself (bounded only
// by the log bucket's retention, typically 30 days on `_Default`) — a
// conservative 24h default for a first poll with no prior high-water mark, the
// same convention Firebase and Supabase keep, never an unbounded first query
// (connectors.md "Poll cadence and backfill").
export const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000

const ENTRIES_LIST_URL = 'https://logging.googleapis.com/v2/entries:list'
const PAGE_SIZE = 1000
// Defensive cap on pagination — entries.list documents no page-count limit, so
// this bounds the loop rather than trusting an unbounded while(true), the same
// way STITCH_MAX_DEPTH bounds trace-stitch BFS elsewhere.
const MAX_PAGES = 20

export async function fetchCloudRunRequestLogEntries(
  creds: CloudRunCredentials,
  sinceIso: string,
  apiUrl: string = ENTRIES_LIST_URL,
): Promise<LogEntry[]> {
  const filter = buildCloudRunEntriesFilter(creds.projectId, sinceIso)
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
      // bucket), the same key Firebase's connector uses.
      { provider: 'cloud-run', accountKey: creds.projectId },
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
