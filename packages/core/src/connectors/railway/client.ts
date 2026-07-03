// Railway GraphQL client — the fetch half of this connector's poll() (ADR-127,
// docs/connectors/railway.md). Passive and ambient only (docs/contracts/
// connectors.md §2): two read-only queries, never a mutation, never a
// synthetic request to keep the connection warm.

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

async function railwayGraphQL<T>(
  apiUrl: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // docs.railway.com/integrations/api/graphql-overview confirms
      // `Authorization: Bearer <token>` for an account/workspace token;
      // Railway also documents a dedicated `Project-Access-Token: <token>`
      // header for the project-scoped token ADR-127 targets specifically.
      // This connector sends the Bearer form — needs-endpoint-testing
      // whether a live Project-Access-Token requires the dedicated header
      // instead once this poller runs against a real project.
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  })
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

// See types.ts's "raw provider response shapes" header — the query shape
// below is the closest documented approximation, flagged
// needs-endpoint-testing, not a live-confirmed schema.
const HTTP_LOGS_QUERY = `
  query HttpLogs(
    $environmentId: String!
    $serviceId: String!
    $startDate: String!
    $endDate: String!
    $limit: Int
  ) {
    httpLogs(
      environmentId: $environmentId
      serviceId: $serviceId
      startDate: $startDate
      endDate: $endDate
      limit: $limit
    ) {
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

const NETWORK_FLOW_LOGS_QUERY = `
  query NetworkFlowLogs(
    $environmentId: String!
    $serviceId: String!
    $startDate: String!
    $endDate: String!
    $limit: Int
  ) {
    networkFlowLogs(
      environmentId: $environmentId
      serviceId: $serviceId
      startDate: $startDate
      endDate: $endDate
      limit: $limit
    ) {
      timestamp
      peerServiceId
      peerKind
      direction
      byteCount
      packetCount
      dropCause
    }
  }
`

export async function fetchRailwayHttpLogs(
  config: RailwayConnectorConfig,
  token: string,
  startDate: string,
  endDate: string,
): Promise<RailwayHttpLogEntry[]> {
  const data = await railwayGraphQL<{ httpLogs: RailwayHttpLogEntry[] }>(
    config.apiUrl ?? DEFAULT_RAILWAY_API_URL,
    token,
    HTTP_LOGS_QUERY,
    {
      environmentId: config.environmentId,
      serviceId: config.serviceId,
      startDate,
      endDate,
      limit: config.limit ?? DEFAULT_LOG_LIMIT,
    },
  )
  return data.httpLogs
}

export async function fetchRailwayNetworkFlowLogs(
  config: RailwayConnectorConfig,
  token: string,
  startDate: string,
  endDate: string,
): Promise<RailwayNetworkFlowLogEntry[]> {
  const data = await railwayGraphQL<{ networkFlowLogs: RailwayNetworkFlowLogEntry[] }>(
    config.apiUrl ?? DEFAULT_RAILWAY_API_URL,
    token,
    NETWORK_FLOW_LOGS_QUERY,
    {
      environmentId: config.environmentId,
      serviceId: config.serviceId,
      startDate,
      endDate,
      limit: config.limit ?? DEFAULT_LOG_LIMIT,
    },
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
