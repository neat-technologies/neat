// PlanetScale Query Insights → ObservedSignal[] (ADR-175,
// docs/connectors/planetscale.md §Fusion). This is the whole mapping layer,
// and it is deliberately small: PlanetScale already did the two hard parts the
// pg_stat_statements path (Neon/Supabase) has to do by hand.
//
//   - No FROM-clause regex. `tables` is already the parsed table set. One
//     signal per table name — a multi-table query genuinely touched each, so
//     it fans out. `qualified_tables` is the keyspace-qualified fallback when
//     `tables` is bare.
//   - No cumulative-delta bookkeeping. `query_count` is windowed to the poll
//     interval, so it IS the count for this tick — read directly, no baseline,
//     no reset detection.
//
// Table grain only (ADR-175): `normalized_sql` is carried in the raw row for
// diagnostics but never parsed for columns — Insights aggregates per
// fingerprint, so there is no honest column or row grain to emit.
//
// Like Neon (connectors.md §7's bounded exception), an Insights row is an
// aggregate counter snapshot, not an individual invocation record, so this
// layer emits only the counter ObservedSignal and no LogEntry — turning a
// windowed fingerprint aggregate into a per-event log line would fabricate
// events that never individually existed.

import type { ObservedSignal } from '../types.js'
import { PLANETSCALE_SQL_TABLE_TARGET_KIND, type PlanetscaleInsightRow } from './types.js'

// The table set for one row: prefer the bare `tables`, fall back to the
// keyspace-qualified names when `tables` is absent or empty. Filters to
// non-empty strings so a garbage entry never becomes a signal.
function tablesFor(row: PlanetscaleInsightRow): string[] {
  const bare = Array.isArray(row.tables) ? row.tables.filter((t) => typeof t === 'string' && t.length > 0) : []
  if (bare.length > 0) return bare
  return Array.isArray(row.qualified_tables)
    ? row.qualified_tables.filter((t) => typeof t === 'string' && t.length > 0)
    : []
}

/**
 * Map one page-set of Insights rows to signals. `observedAtIso` is the poll's
 * own `to` time, used only as the fallback event time when a row's own
 * `last_run_at` is absent — the provider's event time is preferred whenever it
 * carries one (README.md §Poll cadence and backfill).
 */
export function mapInsightsToSignals(
  rows: PlanetscaleInsightRow[],
  observedAtIso: string,
): ObservedSignal[] {
  const signals: ObservedSignal[] = []
  if (!Array.isArray(rows)) return signals

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue

    const callCount = Number(row.query_count)
    // A non-finite or non-positive count is not an observation — drop it
    // rather than minting a phantom zero-call edge (connectors.md §4).
    if (!Number.isFinite(callCount) || callCount < 1) continue

    const rawErrors = Number(row.error_count)
    const errorCount = Number.isFinite(rawErrors) && rawErrors > 0 ? Math.trunc(rawErrors) : 0

    // The provider's own last-run time is the observation instant; fall back
    // to the poll's `to` only when the row carries none.
    const lastObservedIso =
      typeof row.last_run_at === 'string' && row.last_run_at.length > 0 ? row.last_run_at : observedAtIso

    for (const table of tablesFor(row)) {
      signals.push({
        targetKind: PLANETSCALE_SQL_TABLE_TARGET_KIND,
        targetName: table,
        callCount: Math.trunc(callCount),
        errorCount,
        lastObservedIso,
      })
    }
  }

  return signals
}
