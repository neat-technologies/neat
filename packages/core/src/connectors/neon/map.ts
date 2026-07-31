import { tableFromSqlStatement } from '../../otel.js'
import type { ObservedSignal } from '../types.js'
import { NEON_SQL_TABLE_TARGET_KIND, type NeonStatementRow } from './types.js'

export interface NeonStatementBaseline {
  calls: number
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
    if (!table) continue
    signals.push({
      targetKind: NEON_SQL_TABLE_TARGET_KIND,
      targetName: table,
      callCount: calls - prior.calls,
      errorCount: 0,
      lastObservedIso: observedAtIso,
    })
  }

  for (const queryid of previous.keys()) {
    if (!seen.has(queryid)) previous.delete(queryid)
  }
  return signals
}
