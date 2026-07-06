// Maps both Supabase surfaces to ObservedSignal[] (docs/connectors/
// supabase.md §Fusion, ADR-124). Two independent producers feed the same
// signal vocabulary (SUPABASE_TABLE_TARGET_KIND / SUPABASE_RPC_TARGET_KIND):
//
//   1. edge_logs rows (client.ts) — the request path names the table/RPC
//      directly (`/rest/v1/<table>` / `/rest/v1/rpc/<fn>`), so this mapping
//      is a straight parse, aggregated per (kind, name) the same bucketing
//      shape railway/connector.ts uses for httpLogs.
//   2. pg_stat_statements rows (postgres-client.ts) — carries no table
//      column at all (postgresql.org/docs/current/pgstatstatements.html: "the
//      view provides no table-level identification columns"), only raw query
//      text, and its counters are lifetime cumulative, not per-poll-window —
//      so this mapping both extracts a table name from a recognized
//      PostgREST-shaped query and diffs against the previous poll's counts to
//      turn a cumulative total into this window's delta.

import type { LogEntry } from '@neat.is/types'
import type { ObservedSignal } from '../types.js'
import { SUPABASE_RPC_TARGET_KIND, SUPABASE_TABLE_TARGET_KIND, type PgStatStatementsRow, type SupabaseEdgeLogRow } from './types.js'

// ── Surface 1: edge_logs → ObservedSignal[] ─────────────────────────────────

// `/rest/v1/rpc/<fn>` must be checked before the bare table pattern — every
// RPC path is also a `/rest/v1/...` path, so checking table-shape first would
// misclassify every RPC call as a table named `rpc`.
const REST_RPC_PATH_RE = /^\/rest\/v1\/rpc\/([^/?]+)/
const REST_TABLE_PATH_RE = /^\/rest\/v1\/([^/?]+)/

interface RestTarget {
  targetKind: typeof SUPABASE_TABLE_TARGET_KIND | typeof SUPABASE_RPC_TARGET_KIND
  name: string
}

// Exported for direct testing of the path-parsing rule supabase.md §Fusion
// specifies verbatim ("`/rest/v1/orders` → table `orders`, `/rest/v1/rpc/
// get_totals` → RPC `get_totals`"). Returns null for anything else this
// connector's edge_logs query shouldn't even have returned (its own `where
// regexp_contains(path, '^/rest/v1/')` filter already narrows to this
// prefix) but is checked again here rather than trusting the query alone —
// the same "never trust the filter alone" discipline firebase/map.ts states
// for its own resource-type check.
export function targetFromRestPath(path: string): RestTarget | null {
  const rpcMatch = REST_RPC_PATH_RE.exec(path)
  if (rpcMatch) return { targetKind: SUPABASE_RPC_TARGET_KIND, name: rpcMatch[1]! }
  const tableMatch = REST_TABLE_PATH_RE.exec(path)
  if (tableMatch) return { targetKind: SUPABASE_TABLE_TARGET_KIND, name: tableMatch[1]! }
  return null
}

// 5xx is the unambiguous failure threshold, the same convention firebase/
// map.ts and cloudflare/map.ts already use for their own status-code signals
// (a bare 4xx is often correct PostgREST behavior — a RLS-denied read, a
// not-found row — not necessarily a service defect).
const ERROR_STATUS_THRESHOLD = 500

interface Bucket {
  targetKind: RestTarget['targetKind']
  targetName: string
  callCount: number
  errorCount: number
  lastObservedIso: string
}

export function mapEdgeLogRowsToSignals(rows: SupabaseEdgeLogRow[]): ObservedSignal[] {
  const buckets = new Map<string, Bucket>()

  for (const row of rows) {
    const target = targetFromRestPath(row.path)
    // Not a `/rest/v1/...` PostgREST path — Auth/Storage/Realtime/Functions
    // traffic on the same project, out of scope for this cut (supabase.md
    // §Out of scope). Dropped honestly, never forced through as a guessed
    // table/RPC name.
    if (!target) continue

    const key = `${target.targetKind}:${target.name}`
    const isError = row.status_code >= ERROR_STATUS_THRESHOLD
    const existing = buckets.get(key)
    if (existing) {
      existing.callCount += 1
      if (isError) existing.errorCount += 1
      if (row.timestamp > existing.lastObservedIso) existing.lastObservedIso = row.timestamp
    } else {
      buckets.set(key, {
        targetKind: target.targetKind,
        targetName: target.name,
        callCount: 1,
        errorCount: isError ? 1 : 0,
        lastObservedIso: row.timestamp,
      })
    }
  }

  return [...buckets.values()].map((b) => ({
    targetKind: b.targetKind,
    targetName: b.targetName,
    callCount: b.callCount,
    errorCount: b.errorCount,
    lastObservedIso: b.lastObservedIso,
  }))
}

// ── Surface 2: pg_stat_statements → ObservedSignal[] ────────────────────────

// PostgREST always issues a fully schema-qualified, double-quoted-identifier
// query per request (`... FROM "public"."orders" ...`, or bare `"orders"`
// without a schema qualifier depending on search_path) — a recognizable,
// mechanical shape, the same "framework-aware, not a bare guess" discipline
// extract/calls/supabase.ts itself applies to a JS call site, just applied to
// generated SQL text here instead. A query whose FROM target doesn't match
// this shape (a user-defined Postgres function's own internal query, a
// migration, an ORM issuing something else entirely) is dropped honestly —
// pg_stat_statements carries no table column to fall back on
// (postgresql.org/docs/current/pgstatstatements.html), so guessing past a
// parse miss here would fabricate a target, not infer one.
const FROM_TABLE_RE = /\bfrom\s+"?(?:[a-z_][a-z0-9_]*"?\.)?"?([a-z_][a-z0-9_]*)"?/i
const SYSTEM_SCHEMA_PREFIXES = ['pg_', 'information_schema']

export function tableNameFromQueryText(query: string): string | null {
  const match = FROM_TABLE_RE.exec(query)
  if (!match) return null
  const name = match[1]!
  const lower = name.toLowerCase()
  if (SYSTEM_SCHEMA_PREFIXES.some((prefix) => lower.startsWith(prefix))) return null
  return name
}

export interface StatementBaseline {
  calls: number
}

/**
 * `pg_stat_statements.calls` is a lifetime cumulative counter, not a per-poll
 * count — replaying it verbatim every tick would re-mint the statement's
 * entire history as "this window's calls" on every single poll, ballooning
 * without bound. This diffs each row's `calls` against the previous poll's
 * value for the same `queryid`, carried in `previous` (owned by the
 * connector instance across ticks — see index.ts) and mutated in place:
 *
 * - A `queryid` seen for the first time only establishes a baseline this
 *   tick — no signal, since there is no "since last poll" value yet to
 *   subtract from (never replay a statement's full lifetime history as if it
 *   were one window's activity, the same bounded-lookback discipline every
 *   other connector applies to its own `since` watermark).
 * - A `queryid` whose `calls` decreased since the last poll (a Postgres
 *   restart, an explicit `pg_stat_statements_reset()`) is treated as a fresh
 *   baseline the same way — a negative delta is never fabricated into a
 *   signal.
 * - A `queryid` that drops out of this poll's rows entirely (evicted past
 *   `pg_stat_statements.max`, or simply out-ranked by busier statements past
 *   `statementLimit`) has its baseline removed, so a later reappearance
 *   starts fresh rather than diffing against stale state.
 *
 * `errorCount` is always 0 — pg_stat_statements carries no failure signal for
 * a statement (no distinction between a successful and a failed execution in
 * its own columns), so this is never fabricated.
 *
 * `lastObservedIso` uses the poll tick's own wall-clock time, not a
 * provider-supplied event time — unlike every other signal in this codebase.
 * pg_stat_statements has no per-row timestamp at all (it's a cumulative
 * counter snapshot, not an event log), so there is no provider event time to
 * read; the poll tick is the closest honest proxy for "this activity was
 * observed as of this counter snapshot," the same tick-start-time convention
 * `startConnectorPollLoop` (connectors/index.ts) already uses for its own
 * `since` bookkeeping.
 */
export function diffPgStatStatementsToSignals(
  rows: PgStatStatementsRow[],
  previous: Map<string, StatementBaseline>,
  nowIso: string,
): ObservedSignal[] {
  const signals: ObservedSignal[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    seen.add(row.queryid)
    const calls = Number(row.calls)
    const prior = previous.get(row.queryid)
    previous.set(row.queryid, { calls })

    if (!prior || calls < prior.calls) continue // fresh baseline this tick, no signal
    const delta = calls - prior.calls
    if (delta <= 0) continue

    const table = tableNameFromQueryText(row.query)
    if (!table) continue // can't honestly attribute a table — dropped, never guessed

    signals.push({
      targetKind: SUPABASE_TABLE_TARGET_KIND,
      targetName: table,
      callCount: delta,
      errorCount: 0,
      lastObservedIso: nowIso,
    })
  }

  for (const queryid of [...previous.keys()]) {
    if (!seen.has(queryid)) previous.delete(queryid)
  }

  return signals
}

// ── edge_logs / pg_stat_statements → LogEntry[] (docs/contracts/logs.md,
// connectors.md §7, ADR-132) ────────────────────────────────────────────────
//
// Additive alongside the two ObservedSignal mappers above, one LogEntry per
// raw row rather than aggregated/diffed. edge_logs rows outside the
// `/rest/v1/...` PostgREST shape (Auth/Storage/Realtime/Functions traffic)
// are still logged here even though mapEdgeLogRowsToSignals drops them as
// out of scope for fusion — a real request this project's Supabase project
// served either way. pg_stat_statements rows are logged every poll tick,
// independent of diffPgStatStatementsToSignals's baseline/delta state — the
// "first sighting, no signal yet" case that diffing drops is still a real
// counter snapshot worth retaining.

function edgeLogSeverity(status: number): string {
  if (status >= ERROR_STATUS_THRESHOLD) return 'error'
  if (status >= 400) return 'warn'
  return 'info'
}

export function mapEdgeLogRowsToLogEntries(
  rows: SupabaseEdgeLogRow[],
  projectName: string,
  serviceName: string,
): LogEntry[] {
  return rows.map((row, i) => ({
    id: `supabase-edge-${row.timestamp}-${i}`,
    projectName,
    source: 'supabase',
    serviceName,
    timestamp: row.timestamp,
    severity: edgeLogSeverity(row.status_code),
    message: `${row.method} ${row.path} → ${row.status_code}`,
    attributes: { method: row.method, path: row.path, statusCode: row.status_code },
  }))
}

// Table attribution reuses tableNameFromQueryText — never a second parse.
// Timestamp is the poll tick's own wall-clock time, matching
// diffPgStatStatementsToSignals's own lastObservedIso convention for this
// surface (pg_stat_statements carries no per-row event time of its own).
export function mapPgStatStatementsToLogEntries(
  rows: PgStatStatementsRow[],
  projectName: string,
  serviceName: string,
  nowIso: string,
): LogEntry[] {
  return rows.map((row) => {
    const table = tableNameFromQueryText(row.query)
    const calls = Number(row.calls)
    const avgMs = calls > 0 ? row.total_exec_time / calls : 0
    return {
      id: `supabase-pgstat-${row.queryid}-${nowIso}`,
      projectName,
      source: 'supabase',
      serviceName,
      timestamp: nowIso,
      severity: 'info',
      message: `${table ?? 'unattributed query'}: ${calls} calls, avg ${avgMs.toFixed(2)}ms`,
      attributes: {
        queryid: row.queryid,
        ...(table ? { table } : {}),
        calls,
        totalExecTimeMs: row.total_exec_time,
        rows: row.rows,
      },
    }
  })
}
