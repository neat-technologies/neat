import { columnsFromSqlStatement, tableFromSqlStatement } from '../../otel.js'
import type { ObservedSignal } from '../types.js'
import { NEON_SQL_TABLE_TARGET_KIND, type NeonStatementRow } from './types.js'

export interface NeonStatementBaseline {
  calls: number
}

/**
 * A statement against Postgres's own catalogs, not an app table. Drivers issue these under the app's role
 * (asyncpg's type introspection reads `pg_catalog.pg_type` on every new connection), and the shared parser
 * strips the schema, so without this they'd surface as OBSERVED calls to a "pg_type" table. `pg_`-prefixed
 * names are reserved for system catalogs by convention, and `information_schema` is the SQL-standard one.
 */
export function readsSystemCatalog(query: string, table: string): boolean {
  if (/^pg_/i.test(table)) return true
  return /\b(?:from|into|update)\s+"?(?:pg_catalog|information_schema)"?\s*\./i.test(query)
}

export function diffNeonStatementsToSignals(
  rows: NeonStatementRow[],
  previous: Map<string, NeonStatementBaseline>,
  observedAtIso: string,
): ObservedSignal[] {
  const signals: ObservedSignal[] = []
  const seen = new Set<string>()
  if (!Array.isArray(rows)) return signals

  for (const row of rows) {
    if (
      !row ||
      typeof row !== 'object' ||
      typeof row.queryid !== 'string' ||
      typeof row.query !== 'string'
    ) {
      continue
    }
    const calls = Number(row.calls)
    if (!Number.isFinite(calls)) continue

    seen.add(row.queryid)
    const prior = previous.get(row.queryid)
    previous.set(row.queryid, { calls })
    if (!prior || calls <= prior.calls) continue

    const table = tableFromSqlStatement(row.query)
    if (!table || readsSystemCatalog(row.query, table)) continue
    // ADR-157 — the same query text names the columns it touched; carry them so
    // the shared pipeline merges them onto the `sql-table` node as OBSERVED
    // column attributes. Empty for a shape the parser degrades on.
    const columns = columnsFromSqlStatement(row.query)
    signals.push({
      targetKind: NEON_SQL_TABLE_TARGET_KIND,
      targetName: table,
      callCount: calls - prior.calls,
      errorCount: 0,
      lastObservedIso: observedAtIso,
      ...(columns.length > 0 ? { columns } : {}),
    })
  }

  for (const queryid of previous.keys()) {
    if (!seen.has(queryid)) previous.delete(queryid)
  }
  return signals
}
