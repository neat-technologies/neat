import type { LogEntry } from '@neat.is/types'

// Bounded per-(projectName, source) ring buffer for LogEntry records
// (docs/contracts/logs.md Rule 4, ADR-132). Fully in-memory, no
// persistence — a daemon restart loses the buffer, the same trade-off NEAT
// already accepts for the live graph between snapshots. Every pair owns its
// own array, so a burst from one source can never evict another pair's
// entries.

// Default cap: the last 1,000 entries, and nothing older than 24h — both
// bounds apply independently (see `prune` below), whichever trips first for
// a given entry.
export const LOGS_STORE_MAX_ENTRIES = 1000
export const LOGS_STORE_MAX_AGE_MS = 24 * 60 * 60 * 1000

// GET /logs query-param defaults. Exported so the REST route (api.ts) and
// any future direct caller (MCP's get_logs) share one definition of "sane
// max" rather than each picking their own number.
export const LOGS_QUERY_DEFAULT_LIMIT = 100
export const LOGS_QUERY_MAX_LIMIT = 1000

const buffers = new Map<string, LogEntry[]>()

// Separator chosen so an ordinary project name or source string can't
// collide two distinct (projectName, source) pairs onto the same key —
// neither a NEAT project name nor a `source` value (logs.md Rule 1's fixed
// set, extended one string per future connector) is expected to contain it.
const KEY_SEP = '::'

function bufferKey(projectName: string, source: string): string {
  return `${projectName}${KEY_SEP}${source}`
}

function sourcesForProject(projectName: string): string[] {
  const prefix = `${projectName}${KEY_SEP}`
  const sources: string[] = []
  for (const key of buffers.keys()) {
    if (key.startsWith(prefix)) sources.push(key.slice(prefix.length))
  }
  return sources
}

// Drops entries older than the age cap, then trims to the count cap. Both
// run every append so a buffer never grows past 1,000 elements even
// mid-burst, and a slow, quiet source still ages its old entries out even
// though it never fills the count cap.
function prune(entries: LogEntry[], now: number): LogEntry[] {
  const cutoff = now - LOGS_STORE_MAX_AGE_MS
  let pruned = entries.filter((e) => {
    const t = Date.parse(e.timestamp)
    // A timestamp that fails to parse can't be judged stale — fail open
    // rather than silently dropping a malformed-but-real entry.
    return Number.isNaN(t) || t >= cutoff
  })
  if (pruned.length > LOGS_STORE_MAX_ENTRIES) {
    pruned = pruned.slice(pruned.length - LOGS_STORE_MAX_ENTRIES)
  }
  return pruned
}

export function appendLogEntry(entry: LogEntry): void {
  const key = bufferKey(entry.projectName, entry.source)
  const existing = buffers.get(key) ?? []
  existing.push(entry)
  buffers.set(key, prune(existing, Date.now()))
}

export interface QueryLogEntriesOptions {
  projectName: string
  // Repeatable per logs.md §5 — when omitted, every source this project has
  // ever written an entry under is included.
  source?: string[]
  service?: string
  limit?: number
  // ISO8601 lower bound, inclusive, matched against each entry's own
  // `timestamp` (not append time).
  since?: string
}

// Newest-first, merged across every matching source bucket for the
// project, then service/since filtered. `limit` is applied last so a
// direct caller (a future MCP get_logs, or a test) can ask for a bounded
// slice without redoing the REST layer's separate total/count bookkeeping;
// the REST route itself calls this once unlimited (for `total`) and slices
// the result itself so `total` reflects the filtered-but-unlimited size.
export function queryLogEntries(opts: QueryLogEntriesOptions): LogEntry[] {
  const { projectName, source, service, since, limit } = opts
  const sources = source && source.length > 0 ? source : sourcesForProject(projectName)

  let merged: LogEntry[] = []
  for (const src of sources) {
    const buf = buffers.get(bufferKey(projectName, src))
    if (buf) merged = merged.concat(buf)
  }

  if (service) {
    merged = merged.filter((e) => e.serviceName === service)
  }

  if (since) {
    const sinceMs = Date.parse(since)
    if (!Number.isNaN(sinceMs)) {
      merged = merged.filter((e) => {
        const t = Date.parse(e.timestamp)
        return Number.isNaN(t) || t >= sinceMs
      })
    }
  }

  merged.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))

  if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0) {
    return merged.slice(0, limit)
  }
  return merged
}

// Test seam. The store is a module-level singleton with no persistence —
// tests that append fixture entries need a way back to empty between
// cases, the same shape `resetGraph()` gives the in-memory graph.
export function resetLogsStore(): void {
  buffers.clear()
}
