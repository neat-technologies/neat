// PlanetScale REST client — the fetch half of this connector's poll() (ADR-175,
// docs/connectors/planetscale.md). Passive and ambient only (connectors.md §2):
// one read-only query against PlanetScale's own Query Insights surface, never a
// mutation, never a synthetic query to the observed database.
//
// PlanetScale exposes per-fingerprint query telemetry through
//   GET /v1/organizations/{org}/databases/{db}/branches/{branch}/insights
// (planetscale.com/docs/api/reference/list_branch_queries), bounded by a
// `from`/`to` time window and paginated by `page`/`per_page`. Auth is a
// service token in the NON-Bearer `id:token` header form (types.ts,
// planetscale.com/docs/api/reference/service-tokens). The query is always
// bounded by the poll window — never an unbounded full-history read.

import { junctionFetch } from '../junction.js'
import {
  planetscaleAuthHeader,
  type PlanetscaleConnectorConfig,
  type PlanetscaleCredentials,
  type PlanetscaleInsightRow,
  type PlanetscaleInsightsResponse,
} from './types.js'

export const DEFAULT_PLANETSCALE_API_URL = 'https://api.planetscale.com/v1'

// PlanetScale's Insights default `per_page` is 25; 100 keeps a busy branch's
// window bounded in fewer round-trips without over-fetching.
export const DEFAULT_PLANETSCALE_PER_PAGE = 100
// Bounded page-follow per poll — `next_page` could otherwise walk the whole
// window on a busy branch (connectors.md §"Poll cadence and backfill").
export const DEFAULT_PLANETSCALE_MAX_PAGES = 20

// PlanetScale's Insights retention varies and isn't published as a single
// number; 24h is a conservative bounded default for a first poll or a wide
// gap, never an unbounded full-history query regardless.
export const DEFAULT_MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000

function clampPerPage(perPage: number | undefined): number {
  const raw = Math.trunc(perPage ?? DEFAULT_PLANETSCALE_PER_PAGE)
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_PLANETSCALE_PER_PAGE
  return Math.min(raw, DEFAULT_PLANETSCALE_PER_PAGE)
}

// `since` bounded by the provider's max lookback window (connectors.md §"Poll
// cadence and backfill") — a gap wider than the window (a laptop off for a
// week) backfills from `now - maxLookbackMs`, never an unbounded full-history
// replay. An absent or unparseable `since` (no prior poll) gets the same
// treatment as too-old a `since`. Mirrors render/client.ts's own bounding.
export function boundedPlanetscaleStartTime(
  since: string | undefined,
  now: Date,
  maxLookbackMs: number,
): string {
  const floor = new Date(now.getTime() - maxLookbackMs)
  if (!since) return floor.toISOString()
  const sinceMs = new Date(since).getTime()
  if (Number.isNaN(sinceMs)) return floor.toISOString()
  return sinceMs < floor.getTime() ? floor.toISOString() : new Date(sinceMs).toISOString()
}

function insightsUrl(
  config: PlanetscaleConnectorConfig,
  from: string,
  to: string,
  perPage: number,
  page: number,
): URL {
  const base = config.apiUrl ?? DEFAULT_PLANETSCALE_API_URL
  const url = new URL(
    `${base}/organizations/${encodeURIComponent(config.organization)}/databases/${encodeURIComponent(
      config.database,
    )}/branches/${encodeURIComponent(config.branch)}/insights`,
  )
  // Always bounded by the poll window — never an unbounded read.
  url.searchParams.set('from', from)
  url.searchParams.set('to', to)
  url.searchParams.set('per_page', String(perPage))
  url.searchParams.set('page', String(page))
  return url
}

async function fetchInsightsPage(
  config: PlanetscaleConnectorConfig,
  credentials: PlanetscaleCredentials,
  from: string,
  to: string,
  perPage: number,
  page: number,
  fetchImpl?: typeof fetch,
): Promise<PlanetscaleInsightsResponse> {
  const res = await junctionFetch(
    insightsUrl(config, from, to, perPage, page),
    {
      method: 'GET',
      headers: {
        ...planetscaleAuthHeader(credentials.serviceTokenId, credentials.serviceToken),
        Accept: 'application/json',
      },
    },
    { provider: 'planetscale', accountKey: config.database, ...(fetchImpl ? { fetchImpl } : {}) },
  )
  if (!res.ok) {
    throw new Error(`PlanetScale insights request failed: ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as PlanetscaleInsightsResponse
}

/**
 * Fetch the Query Insights rows for `[from, to]`, following PlanetScale's
 * `next_page` pagination up to `maxPages`. A page with no `data` array ends
 * the walk honestly rather than throwing (connectors.md §4). The window is
 * fixed for the whole walk — every page reads the same `from`/`to`, only
 * `page` advances.
 */
export async function fetchPlanetscaleInsights(
  config: PlanetscaleConnectorConfig,
  credentials: PlanetscaleCredentials,
  from: string,
  to: string,
  fetchImpl?: typeof fetch,
): Promise<PlanetscaleInsightRow[]> {
  const perPage = clampPerPage(config.perPage)
  const maxPages = Math.max(1, Math.trunc(config.maxPages ?? DEFAULT_PLANETSCALE_MAX_PAGES))
  const out: PlanetscaleInsightRow[] = []
  let page = 1

  for (let i = 0; i < maxPages; i++) {
    const body = await fetchInsightsPage(config, credentials, from, to, perPage, page, fetchImpl)
    if (Array.isArray(body.data)) out.push(...body.data)
    // `next_page` is null on the last page; a missing/garbage cursor also ends
    // the walk rather than looping forever.
    if (typeof body.next_page !== 'number' || body.next_page <= page) break
    page = body.next_page
  }
  return out
}
