// pg_stat_statements direct-Postgres client (docs/connectors/supabase.md
// §Surfaces used #2). Read-only, ambient — a single SELECT against a system
// view Postgres already maintains; this connector never writes to the
// database it polls (connectors.md §2).
//
// Uses `pg` (node-postgres) — already a real dependency elsewhere in this
// workspace (demo/service-b, e2e/capture/app) rather than a new client
// library choice. `import pg from 'pg'` (default import, then destructure)
// rather than `import { Client } from 'pg'`: `pg`'s CJS build doesn't
// consistently expose static named exports across the major versions this
// workspace already carries (demo/service-b pins 7.4.0; e2e/capture/app pins
// ^8.12.0), so the default-import-then-destructure form node-postgres's own
// docs recommend for ESM/TypeScript consumers is the version-safe one.

import pg from 'pg'
import type { PgStatStatementsRow } from './types.js'

const { Client } = pg

// Defensive cap, not a documented Postgres limit — see types.ts's
// `statementLimit` doc comment for why (pg_stat_statements.max, default 5000
// distinct statements on a busy project).
export const DEFAULT_STATEMENT_LIMIT = 500

// Only ever SELECTs from pg_stat_statements, ordered by call volume so the
// busiest statements are never starved by the LIMIT. The `query ~* '^\s*select'`
// filter narrows to read statements — the shape supabase-js's `.from()`/`.rpc()`
// calls over PostgREST actually issue — rather than every INSERT/UPDATE/DDL
// statement pg_stat_statements also tracks, which this connector's read-call-
// count signal (supabase.md §Surfaces — "call count / total time") has no use
// for.
const STATEMENTS_QUERY = `
  select queryid, query, calls, total_exec_time, rows
  from pg_stat_statements
  where query ~* '^\\s*select\\b'
  order by calls desc
  limit $1
`

// The minimal surface this module needs off a `pg.Client` — narrowed so tests
// can inject a fake implementation (no real database) the same way
// cloudflare/client.ts's `fetchImpl` parameter injects a fake `fetch`
// (dependency injection, not a production mock — connectors.md §5 bars mocks
// on the runtime poll path itself, not on this seam).
export interface PgClientLike {
  connect(): Promise<void>
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>
  end(): Promise<void>
}

/**
 * Opens one short-lived connection per poll, runs the read, closes it. Poll
 * cadence is at most once a minute (DEFAULT_POLL_INTERVAL_MS,
 * connectors/index.ts) against a single query — a pool would add lifecycle
 * complexity (idle-connection reaping, exhaustion under a misconfigured
 * interval) for no real benefit at this call rate.
 *
 * `SET default_transaction_read_only = on` is a session-level, defense-in-
 * depth guard on top of whatever grant the connection string's role already
 * holds — belt-and-suspenders for the "never writes on the read path" rule
 * (connectors.md §2), not a substitute for the role itself being scoped
 * read-only (supabase.md §Scope's `pg_read_all_stats`-holding role).
 *
 * `clientFactory` defaults to a real `pg.Client`; tests override it with a
 * fake `PgClientLike` to exercise the query/session-guard behavior without a
 * live Postgres connection.
 */
export async function fetchPgStatStatements(
  connectionString: string,
  limit: number = DEFAULT_STATEMENT_LIMIT,
  clientFactory: (connectionString: string) => PgClientLike = (cs) => new Client({ connectionString: cs }),
): Promise<PgStatStatementsRow[]> {
  const client = clientFactory(connectionString)
  await client.connect()
  try {
    await client.query('SET default_transaction_read_only = on')
    const result = await client.query<PgStatStatementsRow>(STATEMENTS_QUERY, [limit])
    return result.rows
  } finally {
    await client.end()
  }
}
