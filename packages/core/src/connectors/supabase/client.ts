// Management API log-query client (docs/connectors/supabase.md §Surfaces
// used #1). Read-only, ambient — this issues one query per poll tick against
// telemetry Supabase already collects for every Cloud project (edge_logs),
// never a synthetic request against the project itself (connectors.md §2).
//
// GET https://api.supabase.com/v1/projects/{ref}/analytics/endpoints/logs.all
// — confirmed live against api.supabase.com/api/v1-json (operationId
// `v1-get-project-logs-all`) during this connector's build: a GET request
// with `sql` / `iso_timestamp_start` / `iso_timestamp_end` as query-string
// parameters, not a POST with a JSON body. The endpoint is marked
// `deprecated: true` in that spec but remains the documented, currently
// reachable surface — see types.ts's header comment for the full citation
// list and the open dialect question this connector's SQL still needs
// live-project confirmation against.

import type {
  SupabaseConnectorConfig,
  SupabaseEdgeLogRow,
  SupabaseLogsAllResponse,
} from './types.js'

export const DEFAULT_SUPABASE_MANAGEMENT_API_URL = 'https://api.supabase.com'

// supabase.com/docs/guides/telemetry/logs's "LIMIT and result row limitations"
// section: "The Logs Explorer has a maximum of 1000 rows per run."
export const DEFAULT_LOG_LIMIT = 1000

// The OpenAPI description for this endpoint: "The timestamp range must be no
// more than 24 hours and is rounded to the nearest minute. If the range is
// more than 24 hours, a validation error will be thrown." A hard provider
// ceiling, not merely a connector default — bounds `boundedSupabaseLogWindow`
// below regardless of `config.maxLookbackMs`.
export const SUPABASE_LOG_QUERY_MAX_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * `since` bounded by the provider's max lookback window (docs/contracts/
 * connectors.md §"Poll cadence and backfill") — a gap wider than the window
 * (a laptop off for a week) backfills from `now - window`, never an
 * unbounded full-history replay. `truncated` is true whenever the effective
 * start got clipped to the window floor rather than reflecting `since`
 * verbatim, so callers can log the gap being lossily capped rather than
 * silently swallowing it.
 */
export function boundedSupabaseLogWindow(
  since: string | undefined,
  now: Date,
  maxLookbackMs: number,
): { startIso: string; endIso: string; truncated: boolean } {
  const window = Math.min(maxLookbackMs, SUPABASE_LOG_QUERY_MAX_WINDOW_MS)
  const floor = new Date(now.getTime() - window)
  const endIso = now.toISOString()
  if (!since) return { startIso: floor.toISOString(), endIso, truncated: false }
  const sinceMs = new Date(since).getTime()
  if (Number.isNaN(sinceMs)) return { startIso: floor.toISOString(), endIso, truncated: false }
  if (sinceMs < floor.getTime()) return { startIso: floor.toISOString(), endIso, truncated: true }
  return { startIso: new Date(sinceMs).toISOString(), endIso, truncated: false }
}

// The flat projection this connector needs out of edge_logs's nested
// metadata.request/metadata.response arrays — field names confirmed against
// worked examples on supabase.com/docs/guides/telemetry/logs,
// .../advanced-log-filtering, and
// .../troubleshooting/discovering-and-interpreting-api-errors-in-the-logs-7xREI9
// (all fetched during this build). `regexp_contains(request.path, ...)`
// narrows to the PostgREST surface (`/rest/v1/...`) this connector's fusion
// targets — Auth/Storage/Realtime/Functions traffic on the same project is
// out of scope (supabase.md §Out of scope) and excluded here rather than
// fetched and dropped client-side. `FORMAT_TIMESTAMP` renders a strict
// ISO8601 UTC string so map.ts never has to guess a timezone.
function buildEdgeLogsQuery(limit: number): string {
  const safeLimit = Math.max(1, Math.trunc(limit) || DEFAULT_LOG_LIMIT)
  return [
    'select',
    "  format_timestamp('%Y-%m-%dT%H:%M:%E6SZ', timestamp) as timestamp,",
    '  request.method as method,',
    '  request.path as path,',
    '  response.status_code as status_code',
    'from edge_logs',
    'cross join unnest(metadata) as metadata',
    'cross join unnest(metadata.request) as request',
    'cross join unnest(metadata.response) as response',
    "where regexp_contains(request.path, '^/rest/v1/')",
    'order by timestamp asc',
    `limit ${safeLimit}`,
  ].join('\n')
}

export async function fetchSupabaseEdgeLogs(
  config: SupabaseConnectorConfig,
  token: string,
  startIso: string,
  endIso: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SupabaseEdgeLogRow[]> {
  const baseUrl = config.managementApiUrl ?? DEFAULT_SUPABASE_MANAGEMENT_API_URL
  const url = new URL(`${baseUrl}/v1/projects/${config.apiProjectRef}/analytics/endpoints/logs.all`)
  url.searchParams.set('sql', buildEdgeLogsQuery(config.logLimit ?? DEFAULT_LOG_LIMIT))
  url.searchParams.set('iso_timestamp_start', startIso)
  url.searchParams.set('iso_timestamp_end', endIso)

  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    throw new Error(`supabase connector: logs.all request failed (${res.status} ${res.statusText})`)
  }
  const body = (await res.json()) as SupabaseLogsAllResponse
  if (body.error) {
    const message = typeof body.error === 'string' ? body.error : body.error.message
    throw new Error(`supabase connector: logs.all returned an error (${message})`)
  }
  return body.result ?? []
}
