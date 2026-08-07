// Render REST client — the fetch half of this connector's poll() (ADR-166,
// docs/connectors/render.md). Passive and ambient only (docs/contracts/
// connectors.md §2): one read-only query against Render's own request-log
// surface, never a mutation, never a synthetic request to the observed app.
//
// Render exposes its edge-layer HTTP request logs through `GET /v1/logs`
// (api-docs.render.com/reference/list-logs), filterable to `type=request` and
// scoped by `ownerId` + `resource`. Auth is a Bearer API key
// (render.com/docs/api). This is the pull path chosen for Render because its
// push surfaces don't reach NEAT's OTLP ingest: log streams forward RFC5424
// syslog (render.com/docs/log-streams), and metrics streams forward OTLP
// *metrics*, not traces (render.com/docs/metrics-streams) — neither is a
// trace-drain the daemon's `/v1/traces` receiver accepts, so a Vercel-style
// drain (ADR-146) has nothing to point at. See ADR-166 for the full argument.

import { bearerAuthHeader, junctionFetch } from '../junction.js'
import type { RenderConnectorConfig, RenderLogEntry, RenderLogsResponse } from './types.js'

export const DEFAULT_RENDER_API_URL = 'https://api.render.com/v1'

// Render caps `limit` at 100 rows per page (api-docs.render.com/reference/
// list-logs); a poll follows `hasMore`/`nextStartTime`/`nextEndTime` up to
// DEFAULT_RENDER_MAX_PAGES so a busy service's window stays bounded per tick.
export const DEFAULT_RENDER_LOG_LIMIT = 100
export const RENDER_MAX_LOG_LIMIT = 100
export const DEFAULT_RENDER_MAX_PAGES = 20

// Render's request-log retention varies by plan and isn't published as a single
// number; 24h is a conservative bounded default for a first poll or a wide gap,
// never an unbounded full-history query regardless (docs/contracts/
// connectors.md §"Poll cadence and backfill").
export const DEFAULT_MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000

function clampLimit(limit: number | undefined): number {
  const raw = Math.trunc(limit ?? DEFAULT_RENDER_LOG_LIMIT)
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_RENDER_LOG_LIMIT
  return Math.min(raw, RENDER_MAX_LOG_LIMIT)
}

// `since` bounded by the provider's max lookback window (docs/contracts/
// connectors.md §"Poll cadence and backfill") — a gap wider than the window
// (a laptop off for a week) backfills from `now - maxLookbackMs`, never an
// unbounded full-history replay. An absent or unparseable `since` (no prior
// poll) gets the same treatment as too-old a `since`.
export function boundedRenderStartTime(since: string | undefined, now: Date, maxLookbackMs: number): string {
  const floor = new Date(now.getTime() - maxLookbackMs)
  if (!since) return floor.toISOString()
  const sinceMs = new Date(since).getTime()
  if (Number.isNaN(sinceMs)) return floor.toISOString()
  return sinceMs < floor.getTime() ? floor.toISOString() : new Date(sinceMs).toISOString()
}

async function fetchRenderLogPage(
  config: RenderConnectorConfig,
  token: string,
  startTime: string,
  endTime: string,
  limit: number,
  fetchImpl?: typeof fetch,
): Promise<RenderLogsResponse> {
  const url = new URL(`${config.apiUrl ?? DEFAULT_RENDER_API_URL}/logs`)
  url.searchParams.set('ownerId', config.ownerId)
  url.searchParams.set('resource', config.resourceId)
  // Only the edge-layer HTTP request logs — the surface that carries method /
  // path / statusCode and fuses onto a RouteNode. App/build logs are free-text
  // stdout with no structured route to bind to (render.com/docs/logging).
  url.searchParams.set('type', 'request')
  url.searchParams.set('startTime', startTime)
  url.searchParams.set('endTime', endTime)
  // Newest-first, matching Render's own default; pagination walks backward
  // through the window via the cursors below.
  url.searchParams.set('direction', 'backward')
  url.searchParams.set('limit', String(limit))

  const res = await junctionFetch(
    url,
    { method: 'GET', headers: { ...bearerAuthHeader(token) } },
    { provider: 'render', accountKey: config.ownerId, ...(fetchImpl ? { fetchImpl } : {}) },
  )
  if (!res.ok) {
    throw new Error(`Render logs request failed: ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as RenderLogsResponse
}

/**
 * Fetch the request logs in [startTime, endTime], following Render's
 * timestamp-cursor pagination up to `maxPages`. Render returns
 * `hasMore` + `nextStartTime`/`nextEndTime` and expects those passed back as
 * the next query's `startTime`/`endTime` (api-docs.render.com/reference/
 * list-logs). A malformed page (no `logs` array) ends the walk honestly
 * rather than throwing.
 */
export async function fetchRenderRequestLogs(
  config: RenderConnectorConfig,
  token: string,
  startTime: string,
  endTime: string,
  fetchImpl?: typeof fetch,
): Promise<RenderLogEntry[]> {
  const limit = clampLimit(config.limit)
  const maxPages = Math.max(1, Math.trunc(config.maxPages ?? DEFAULT_RENDER_MAX_PAGES))
  const out: RenderLogEntry[] = []
  let pageStart = startTime
  let pageEnd = endTime

  for (let page = 0; page < maxPages; page++) {
    const body = await fetchRenderLogPage(config, token, pageStart, pageEnd, limit, fetchImpl)
    if (Array.isArray(body.logs)) out.push(...body.logs)
    if (!body.hasMore || !body.nextStartTime || !body.nextEndTime) break
    pageStart = body.nextStartTime
    pageEnd = body.nextEndTime
  }
  return out
}
