// The Supabase connector (docs/connectors/supabase.md, ADR-124) — the
// connectors plane's first provider. poll() pulls both surfaces
// supabase.md §Surfaces used specifies: the Management API's edge_logs query
// (client.ts, mapped by map.ts's mapEdgeLogRowsToSignals) always, and a
// direct pg_stat_statements read (postgres-client.ts, mapped by map.ts's
// diffPgStatStatementsToSignals) only when `ctx.credentials.postgresConnectionString`
// is present — its absence is how the hosted profile's documented
// "log-surface-only" first cut (supabase.md §Scope) falls out of this same
// poll() with no profile-conditional branch (connectors.md §3). Target
// resolution — preferring the table/RPC InfraNode a future extractor cut
// will mint, falling back to the project-level InfraNode the current
// extractor already does — lives in resolve.ts. Everything downstream of
// resolution (minting the OBSERVED edge) is the shared connectors/index.ts
// pipeline; this module never touches the graph directly (ADR-030).

import type { NeatGraph } from '../../graph.js'
import type { ResolveConnectorTarget } from '../index.js'
import type { ConnectorContext, ObservedConnector, ObservedSignal } from '../types.js'
import { boundedSupabaseLogWindow, fetchSupabaseEdgeLogs } from './client.js'
import { diffPgStatStatementsToSignals, mapEdgeLogRowsToSignals, type StatementBaseline } from './map.js'
import { fetchPgStatStatements, DEFAULT_STATEMENT_LIMIT } from './postgres-client.js'
import { createSupabaseResolveTarget } from './resolve.js'
import { readSupabaseCredentials, type SupabaseConnectorConfig } from './types.js'

export type {
  PgStatStatementsRow,
  SupabaseConnectorConfig,
  SupabaseCredentials,
  SupabaseEdgeLogRow,
  SupabaseLogsAllResponse,
} from './types.js'
export { readSupabaseCredentials, SUPABASE_RPC_TARGET_KIND, SUPABASE_TABLE_TARGET_KIND } from './types.js'
export {
  boundedSupabaseLogWindow,
  DEFAULT_LOG_LIMIT,
  DEFAULT_SUPABASE_MANAGEMENT_API_URL,
  fetchSupabaseEdgeLogs,
  SUPABASE_LOG_QUERY_MAX_WINDOW_MS,
} from './client.js'
export { DEFAULT_STATEMENT_LIMIT, fetchPgStatStatements } from './postgres-client.js'
export {
  diffPgStatStatementsToSignals,
  mapEdgeLogRowsToSignals,
  tableNameFromQueryText,
  targetFromRestPath,
  type StatementBaseline,
} from './map.js'
export { createSupabaseResolveTarget } from './resolve.js'

// supabase.md's own "24h window" governs `boundedSupabaseLogWindow` — this is
// only the connector-level default passed in when a caller doesn't override
// `config.maxLookbackMs`; the window is hard-capped at
// SUPABASE_LOG_QUERY_MAX_WINDOW_MS regardless (client.ts).
const DEFAULT_MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000

export interface SupabaseConnectorDeps {
  fetchPgStatStatements?: typeof fetchPgStatStatements
  onPostgresSurfaceError?: (err: unknown, summary: string) => void
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | undefined)?.code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

export function describeSupabasePostgresSurfaceFailure(projectRef: string, err: unknown): string {
  const code = errorCode(err)
  let reason: string
  switch (code) {
    case '42501':
      reason = 'permission denied; grant pg_read_all_stats to the configured Postgres role'
      break
    case '42P01':
    case '42704':
      reason = 'pg_stat_statements is not enabled or visible to the configured Postgres role'
      break
    case '28P01':
    case '28000':
      reason = 'Postgres credential rejected'
      break
    case '3D000':
      reason = 'database not found'
      break
    default: {
      const name = err instanceof Error && err.name ? err.name : 'Error'
      reason = code ? `${name} ${code}` : name
    }
  }
  return (
    `supabase connector: pg_stat_statements surface unavailable for project ${projectRef} ` +
    `(${reason}); continuing with Management API log surface.`
  )
}

export class SupabaseConnector implements ObservedConnector {
  readonly provider = 'supabase'

  // pg_stat_statements.calls is cumulative, not per-window (map.ts's
  // diffPgStatStatementsToSignals doc comment) — this Map carries the
  // previous poll's counts across ticks, the same way
  // `startConnectorPollLoop` (connectors/index.ts) carries `since` across
  // ticks for every connector. Lives on the instance, not `ConnectorContext`,
  // because `ConnectorContext` is rebuilt fresh per tick (connectors/index.ts's
  // `{ ...ctx, since }`) while this connector object is the one thing every
  // tick shares.
  private readonly statementBaselines = new Map<string, StatementBaseline>()

  // `deps.fetchPgStatStatements` defaults to the real Postgres-backed
  // implementation; tests override it to exercise the "both surfaces
  // combine" and "surface 2 only runs when a connection string is present"
  // behavior without a live database — the same dependency-injection seam
  // `fetchImpl` gives cloudflare/client.ts's tests for `fetch`.
  constructor(
    private readonly config: SupabaseConnectorConfig,
    private readonly deps: SupabaseConnectorDeps = {},
  ) {}

  async poll(ctx: ConnectorContext): Promise<ObservedSignal[]> {
    const creds = readSupabaseCredentials(ctx.credentials)
    const now = new Date()
    const maxLookbackMs = this.config.maxLookbackMs ?? DEFAULT_MAX_LOOKBACK_MS
    const { startIso, endIso } = boundedSupabaseLogWindow(ctx.since, now, maxLookbackMs)

    const logRows = await fetchSupabaseEdgeLogs(this.config, creds.managementToken, startIso, endIso)
    const signals: ObservedSignal[] = mapEdgeLogRowsToSignals(logRows)

    // Surface 2 only runs when a Postgres connection string is present —
    // supabase.md §Scope's local-profile-only-for-now split, expressed
    // entirely through what `ctx.credentials` carries rather than a
    // profile-conditional branch in this method (connectors.md §3).
    if (creds.postgresConnectionString) {
      const fetchStatements = this.deps.fetchPgStatStatements ?? fetchPgStatStatements
      try {
        const statementRows = await fetchStatements(
          creds.postgresConnectionString,
          this.config.statementLimit ?? DEFAULT_STATEMENT_LIMIT,
          this.config.apiProjectRef,
        )
        signals.push(...diffPgStatStatementsToSignals(statementRows, this.statementBaselines, now.toISOString()))
      } catch (err) {
        const summary = describeSupabasePostgresSurfaceFailure(this.config.apiProjectRef, err)
        if (this.deps.onPostgresSurfaceError) this.deps.onPostgresSurfaceError(err, summary)
        else console.warn(summary)
      }
    }

    return signals
  }
}

/**
 * Wires up a ready-to-register Supabase connector: the `ObservedConnector`
 * plus the `resolveTarget` callback `runConnectorPoll` /
 * `startConnectorPollLoop` (connectors/index.ts) need alongside it. Built
 * together because `resolveTarget` closes over `graph` — the shared
 * scaffold's `ResolveConnectorTarget` signature (index.ts) never receives it
 * directly — the same pairing `createFirebaseConnector` uses.
 */
export function createSupabaseConnector(
  graph: NeatGraph,
  config: SupabaseConnectorConfig,
  deps: SupabaseConnectorDeps = {},
): { connector: ObservedConnector; resolveTarget: ResolveConnectorTarget } {
  return {
    connector: new SupabaseConnector(config, deps),
    resolveTarget: createSupabaseResolveTarget(graph, config),
  }
}
