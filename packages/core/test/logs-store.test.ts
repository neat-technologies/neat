import { describe, it, expect, beforeEach } from 'vitest'
import type { LogEntry } from '@neat.is/types'
import {
  appendLogEntry,
  queryLogEntries,
  resetLogsStore,
  LOGS_STORE_MAX_ENTRIES,
} from '../src/logs-store.js'

// Every fixture timestamp is relative to `Date.now()` at test-run time — the
// store's age-based eviction (24h) is judged against the real wall clock, so
// hardcoded absolute dates would silently start failing once the calendar
// moves far enough past them.
function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

function entry(overrides: Partial<LogEntry> & { id: string }): LogEntry {
  return {
    projectName: 'default',
    source: 'native',
    timestamp: iso(0),
    message: 'hello',
    ...overrides,
  }
}

describe('logs-store', () => {
  beforeEach(() => {
    resetLogsStore()
  })

  it('appends and returns entries newest-first', () => {
    appendLogEntry(entry({ id: '1', message: 'first', timestamp: iso(-2000) }))
    appendLogEntry(entry({ id: '2', message: 'second', timestamp: iso(-1000) }))
    const result = queryLogEntries({ projectName: 'default' })
    expect(result.map((e) => e.id)).toEqual(['2', '1'])
  })

  it("keeps projects isolated — querying one project never returns another project's entries", () => {
    appendLogEntry(entry({ id: 'a', projectName: 'alpha' }))
    appendLogEntry(entry({ id: 'b', projectName: 'beta' }))
    expect(queryLogEntries({ projectName: 'alpha' }).map((e) => e.id)).toEqual(['a'])
    expect(queryLogEntries({ projectName: 'beta' }).map((e) => e.id)).toEqual(['b'])
  })

  it("a burst from one source never evicts another source's entries for the same project", () => {
    // Fill the railway buffer past its count cap — each entry a millisecond
    // apart, all well within the 24h age window.
    const burst = LOGS_STORE_MAX_ENTRIES + 50
    for (let i = 0; i < burst; i++) {
      appendLogEntry(
        entry({
          id: `railway-${i}`,
          source: 'railway',
          timestamp: iso(-1000 * (burst - i)),
        }),
      )
    }
    // One quiet supabase entry, appended once.
    appendLogEntry(entry({ id: 'supabase-1', source: 'supabase', message: 'quiet' }))

    const railwayEntries = queryLogEntries({ projectName: 'default', source: ['railway'] })
    const supabaseEntries = queryLogEntries({ projectName: 'default', source: ['supabase'] })

    // railway's buffer is capped at the count bound...
    expect(railwayEntries.length).toBe(LOGS_STORE_MAX_ENTRIES)
    // ...but the noisy railway burst didn't touch supabase's own buffer.
    expect(supabaseEntries.map((e) => e.id)).toEqual(['supabase-1'])
  })

  it('evicts entries older than the 24h age cap', () => {
    appendLogEntry(entry({ id: 'stale', timestamp: iso(-25 * 60 * 60 * 1000) }))
    appendLogEntry(entry({ id: 'recent', timestamp: iso(0) }))
    const result = queryLogEntries({ projectName: 'default' })
    expect(result.map((e) => e.id)).toEqual(['recent'])
  })

  it('filters by source (repeatable) — omitting it merges every source', () => {
    appendLogEntry(entry({ id: 'n1', source: 'native' }))
    appendLogEntry(entry({ id: 's1', source: 'supabase' }))
    appendLogEntry(entry({ id: 'r1', source: 'railway' }))

    const onlyNative = queryLogEntries({ projectName: 'default', source: ['native'] })
    expect(onlyNative.map((e) => e.id)).toEqual(['n1'])

    const nativeAndSupabase = queryLogEntries({
      projectName: 'default',
      source: ['native', 'supabase'],
    })
    expect(nativeAndSupabase.map((e) => e.id).sort()).toEqual(['n1', 's1'])

    const all = queryLogEntries({ projectName: 'default' })
    expect(all.map((e) => e.id).sort()).toEqual(['n1', 'r1', 's1'])
  })

  it('filters by service', () => {
    appendLogEntry(entry({ id: 'a', serviceName: 'checkout' }))
    appendLogEntry(entry({ id: 'b', serviceName: 'billing' }))
    appendLogEntry(entry({ id: 'c' }))
    const result = queryLogEntries({ projectName: 'default', service: 'checkout' })
    expect(result.map((e) => e.id)).toEqual(['a'])
  })

  it("filters by since (inclusive lower bound on the entry's own timestamp)", () => {
    const baseTime = Date.now()
    const atOffset = (offsetMs: number): string => new Date(baseTime + offsetMs).toISOString()
    appendLogEntry(entry({ id: 'old', timestamp: atOffset(-3000) }))
    appendLogEntry(entry({ id: 'boundary', timestamp: atOffset(-2000) }))
    appendLogEntry(entry({ id: 'new', timestamp: atOffset(-1000) }))
    const result = queryLogEntries({ projectName: 'default', since: atOffset(-2000) })
    expect(result.map((e) => e.id).sort()).toEqual(['boundary', 'new'])
  })

  it('applies limit last, after sorting newest-first', () => {
    appendLogEntry(entry({ id: '1', timestamp: iso(-3000) }))
    appendLogEntry(entry({ id: '2', timestamp: iso(-2000) }))
    appendLogEntry(entry({ id: '3', timestamp: iso(-1000) }))
    const result = queryLogEntries({ projectName: 'default', limit: 2 })
    expect(result.map((e) => e.id)).toEqual(['3', '2'])
  })

  it('returns an empty array for a project with no entries', () => {
    expect(queryLogEntries({ projectName: 'nope' })).toEqual([])
  })
})
