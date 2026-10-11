import pg from 'pg'
import { dbJunction } from '../junction.js'
import type { NeonStatementRow } from './types.js'

const { Client } = pg

export const DEFAULT_NEON_STATEMENT_LIMIT = 500

// `\y` is the word boundary in Postgres regex. `\b` there is a backspace, so a `\b` filter matches nothing
// (on a live Neon project: 0 of 97 statements with `\b`, 81 with `\y`).
//
// pg_stat_statements is cluster-wide, and on Neon most of it isn't the app: on the same live project 61 of 81
// statements (~9.8k calls) were Neon's own `cloud_admin` monitoring in the `postgres` database, which read as
// calls to "tables" like pg_stat_activity. So only statements in the database this credential connects to
// count, minus this role's own polling and Neon's managed roles.
export const NEON_MANAGED_ROLES = ['cloud_admin', 'neon_service', 'neon_auth'] as const
export const NEON_STATEMENTS_QUERY = `
  select queryid::text, query, calls
  from pg_stat_statements
  where query ~* '^\\s*(select|insert|update|delete)\\y'
    and dbid = (select oid from pg_database where datname = current_database())
    and userid <> (select oid from pg_roles where rolname = current_user)
    and userid not in (
      select oid from pg_roles where rolname in (${NEON_MANAGED_ROLES.map((r) => `'${r}'`).join(', ')})
    )
  order by calls desc
  limit $1
`

export interface NeonPgClientLike {
  connect(): Promise<void>
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>
  end(): Promise<void>
}

export async function fetchNeonStatements(
  connectionString: string,
  projectId: string,
  limit: number = DEFAULT_NEON_STATEMENT_LIMIT,
  clientFactory: (connectionString: string) => NeonPgClientLike = (value) =>
    new Client({ connectionString: value }),
): Promise<NeonStatementRow[]> {
  return dbJunction(
    async () => {
      const client = clientFactory(connectionString)
      await client.connect()
      try {
        await client.query('SET default_transaction_read_only = on')
        const result = await client.query<NeonStatementRow>(NEON_STATEMENTS_QUERY, [
          Math.max(1, Math.trunc(limit) || DEFAULT_NEON_STATEMENT_LIMIT),
        ])
        return result.rows
      } finally {
        await client.end()
      }
    },
    { provider: 'neon', accountKey: projectId },
  )
}
