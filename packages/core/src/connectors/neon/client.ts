import pg from 'pg'
import { dbJunction } from '../junction.js'
import type { NeonStatementRow } from './types.js'

const { Client } = pg

export const DEFAULT_NEON_STATEMENT_LIMIT = 500

const NEON_STATEMENTS_QUERY = `
  select queryid::text, query, calls
  from pg_stat_statements
  where query ~* '^\\s*(select|insert|update|delete)\\b'
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
