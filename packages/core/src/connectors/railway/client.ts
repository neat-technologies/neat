// Railway GraphQL client — the fetch half of this connector's poll() (ADR-127,
// docs/connectors/railway.md). Passive and ambient only (docs/contracts/
// connectors.md §2): two read-only queries, never a mutation, never a
// synthetic request to keep the connection warm.

import { junctionFetch } from '../junction.js'
import type { RailwayConnectorConfig, RailwayHttpLogEntry, RailwayNetworkFlowLogEntry } from './types.js'

export const DEFAULT_RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2'

// docs/connectors/railway.md §"Out of scope for this cut" flags the
// neighbouring plan-tier question the same way: Railway's docs don't publish
// a retention/lookback window for httpLogs/networkFlowLogs as of this
// writing. 24h is a conservative default pending a live project confirming
// the real cap — never an unbounded full-history query regardless
// (docs/contracts/connectors.md §"Poll cadence and backfill").
export const DEFAULT_MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000
export const DEFAULT_LOG_LIMIT = 1000

interface RailwayGraphQLError {
  message: string
}

interface RailwayGraphQLResponse<T> {
  data?: T
  errors?: RailwayGraphQLError[]
}

// A Project-Access-Token is the credential ADR-127 scopes this connector to
// (docs/connectors/railway.md §Scope) — both local and hosted profiles carry
// it the same way (docs/contracts/connectors.md §3). Read from
// `ConnectorContext.credentials` at poll time, never logged, never written
// into a node/edge (contract §6).
export function readRailwayToken(credentials: Record<string, unknown>): string {
  const token = credentials.token
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(
      'Railway connector requires ctx.credentials.token (a Project-Access-Token or account Bearer token)',
    )
  }
  return token
}

// Confirmed live against backboard.railway.com/graphql/v2 (2026-07-08):
// `Authorization: Bearer <token>` authenticates at the HTTP gateway (a
// trivial `{ __typename }` probe returns 200) but is not authorized for
// httpLogs/networkFlowLogs/deployments — those reject it with a "Not
// Authorized" GraphQL error regardless of query shape. A Project-Access-Token
// needs Railway's dedicated header instead; this was the needs-endpoint-
// testing question docs/connectors/railway.md's client.ts comment flagged.
function projectAccessTokenHeader(token: string): { 'Project-Access-Token': string } {
  return { 'Project-Access-Token': token }
}

// `accountKey` is Railway's environmentId (ADR-131's per-`(provider,
// accountKey)` rate-limit bucket) — a Project-Access-Token is minted per
// environment, not per account (docs/connectors/railway.md §Scope), so the
// environment is the closest thing this connector's config carries to "one
// customer's account" for this provider.
async function railwayGraphQL<T>(
  apiUrl: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  accountKey: string,
  fetchImpl?: typeof fetch,
): Promise<T> {
  const res = await junctionFetch(
    apiUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...projectAccessTokenHeader(token),
      },
      body: JSON.stringify({ query, variables }),
    },
    { provider: 'railway', accountKey, ...(fetchImpl ? { fetchImpl } : {}) },
  )
  if (!res.ok) {
    throw new Error(`Railway GraphQL request failed: ${res.status} ${res.statusText}`)
  }
  const body = (await res.json()) as RailwayGraphQLResponse<T>
  if (body.errors && body.errors.length > 0) {
    throw new Error(`Railway GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`)
  }
  if (!body.data) throw new Error('Railway GraphQL response carried no data')
  return body.data
}

// Live-confirmed against backboard.railway.com/graphql/v2 (2026-07-08) via
// schema introspection — httpLogs is scoped by `deploymentId`, not
// `environmentId`/`serviceId` as originally assumed; startDate/endDate/limit
// are valid but optional. `HttpLog`'s own field names matched the original
// guess exactly (docs.railway.com/cli/logs's attribute list was accurate),
// so only the query's arguments changed, not the row shape below.
const HTTP_LOGS_QUERY = `
  query HttpLogs($deploymentId: String!, $startDate: String, $endDate: String, $limit: Int) {
    httpLogs(deploymentId: $deploymentId, startDate: $startDate, endDate: $endDate, limit: $limit) {
      timestamp
      method
      path
      httpStatus
      totalDuration
      requestId
      deploymentId
      edgeRegion
    }
  }
`

// Live-confirmed: networkFlowLogs takes no startDate/endDate/limit at all —
// only environmentId (required) + serviceId (optional); its only windowing
// is cursor pagination (afterDate/afterLimit/anchorDate/beforeDate/
// beforeLimit) this connector doesn't exercise yet. `NetworkFlowLog` has no
// `timestamp` field either — aliased here from its real field `captureStart`
// so the rest of the connector keeps reading `entry.timestamp` unchanged.
const NETWORK_FLOW_LOGS_QUERY = `
  query NetworkFlowLogs($environmentId: String!, $serviceId: String) {
    networkFlowLogs(environmentId: $environmentId, serviceId: $serviceId) {
      timestamp: captureStart
      peerServiceId
      peerKind
      direction
      byteCount
      packetCount
      dropCause
    }
  }
`

// httpLogs needs a deploymentId, which is minted fresh on every redeploy —
// unlike the serviceId→name mapping (docs/connectors/railway.md §Fusion,
// "resolved once, never guessed"), a deploymentId can't be resolved once at
// connector-setup time without going stale the next time the service
// redeploys. Resolved fresh each poll from the stable (environmentId,
// serviceId) pair instead. Picks the newest SUCCESS deployment; falls back to
// the newest of any status if none has succeeded yet, so a service between
// its first (failed) deploy and its first success still has an id to poll
// against (httpLogs simply comes back empty for it until a real deploy lands).
const DEPLOYMENTS_QUERY = `
  query LatestDeployment($environmentId: String!, $serviceId: String!) {
    deployments(input: { environmentId: $environmentId, serviceId: $serviceId }, first: 5) {
      edges { node { id status createdAt } }
    }
  }
`

interface RailwayDeploymentNode {
  id: string
  status: string
  createdAt: string
}

export async function resolveLatestRailwayDeploymentId(
  config: RailwayConnectorConfig,
  token: string,
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  const data = await railwayGraphQL<{ deployments: { edges: { node: RailwayDeploymentNode }[] } }>(
    config.apiUrl ?? DEFAULT_RAILWAY_API_URL,
    token,
    DEPLOYMENTS_QUERY,
    { environmentId: config.environmentId, serviceId: config.serviceId },
    config.environmentId,
    fetchImpl,
  )
  const nodes = data.deployments.edges.map((e) => e.node)
  const newestFirst = [...nodes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const success = newestFirst.find((n) => n.status === 'SUCCESS')
  return (success ?? newestFirst[0])?.id ?? null
}

export async function fetchRailwayHttpLogs(
  config: RailwayConnectorConfig,
  token: string,
  deploymentId: string,
  startDate: string,
  endDate: string,
): Promise<RailwayHttpLogEntry[]> {
  const data = await railwayGraphQL<{ httpLogs: RailwayHttpLogEntry[] }>(
    config.apiUrl ?? DEFAULT_RAILWAY_API_URL,
    token,
    HTTP_LOGS_QUERY,
    { deploymentId, startDate, endDate, limit: config.limit ?? DEFAULT_LOG_LIMIT },
    config.environmentId,
  )
  return data.httpLogs
}

export async function fetchRailwayNetworkFlowLogs(
  config: RailwayConnectorConfig,
  token: string,
): Promise<RailwayNetworkFlowLogEntry[]> {
  const data = await railwayGraphQL<{ networkFlowLogs: RailwayNetworkFlowLogEntry[] }>(
    config.apiUrl ?? DEFAULT_RAILWAY_API_URL,
    token,
    NETWORK_FLOW_LOGS_QUERY,
    { environmentId: config.environmentId, serviceId: config.serviceId },
    config.environmentId,
  )
  return data.networkFlowLogs
}

// `since` bounded by the provider's max lookback window (docs/contracts/
// connectors.md §"Poll cadence and backfill") — a gap wider than the window
// (a laptop off for a week) backfills from `now - maxLookbackMs`, never an
// unbounded full-history replay. An absent or unparseable `since` (no prior
// poll) gets the same treatment as too-old a `since`.
export function boundedRailwayStartDate(since: string | undefined, now: Date, maxLookbackMs: number): string {
  const floor = new Date(now.getTime() - maxLookbackMs)
  if (!since) return floor.toISOString()
  const sinceMs = new Date(since).getTime()
  if (Number.isNaN(sinceMs)) return floor.toISOString()
  return sinceMs < floor.getTime() ? floor.toISOString() : new Date(sinceMs).toISOString()
}
