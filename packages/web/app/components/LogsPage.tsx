'use client'

import { useEffect, useState } from 'react'
import type { LogEntry, LogSource } from '@neat.is/types'
import { authedFetch } from '../../lib/authed-fetch'
import { Badge } from '@/components/ui/badge'

// ---------------------------------------------------------------------------
// Logs page (logs.md, ADR-132) — the frontend leg of the one unified logs
// surface. Native OTLP logs and connector-sourced OCloud records, merged into
// one bounded per-project, per-source ring buffer on the daemon, read through
// GET /logs — the same endpoint and query params (source/service/limit/since)
// MCP's get_logs and the CLI's `neat logs` read (logs.md §6). The source
// filter re-queries the endpoint rather than filtering client-side, so this
// page never claims to hold more than the daemon actually returned.
// ---------------------------------------------------------------------------

interface LogsPageProps {
  project: string | null
  onNodeSelect: (id: string) => void
  onNavigateGraph: () => void
}

interface LogsResponse {
  count: number
  total: number
  logs: LogEntry[]
}

// The locked source enum (LogSourceSchema) — fixed chips, not a discovered
// set, since a source with zero entries this session still exists.
const SOURCES: LogSource[] = ['native', 'supabase', 'railway', 'firebase', 'cloudflare', 'vercel']

const SOURCE_LABEL: Record<LogSource, string> = {
  native: 'Native',
  supabase: 'Supabase',
  railway: 'Railway',
  firebase: 'Firebase',
  cloudflare: 'Cloudflare',
  vercel: 'Vercel',
}

const SEVERITY_VARIANT: Record<string, 'destructive' | 'outline' | 'secondary'> = {
  error: 'destructive',
  warn: 'outline',
  warning: 'outline',
  info: 'secondary',
  debug: 'secondary',
}

function formatTs(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString() + ' ' + d.toTimeString().slice(0, 8)
  } catch {
    return iso
  }
}

export function LogsPage({ project, onNodeSelect, onNavigateGraph }: LogsPageProps) {
  const [data, setData] = useState<LogsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeSource, setActiveSource] = useState<LogSource | 'all'>('all')

  // Re-queries GET /logs on every source change (logs.md §6 — the filter sets
  // the same `source` param the endpoint reads, it does not filter a
  // client-held list). Idle until a project resolves (#461).
  useEffect(() => {
    if (!project) {
      setData(null)
      return
    }
    setError(null)
    const qs = new URLSearchParams({ project })
    if (activeSource !== 'all') qs.set('source', activeSource)
    authedFetch(`/api/logs?${qs.toString()}`)
      .then((r) => r.json())
      .then((d: LogsResponse) => setData({ count: d.count ?? 0, total: d.total ?? 0, logs: Array.isArray(d.logs) ? d.logs : [] }))
      .catch(() => setError('could not load logs'))
  }, [project, activeSource])

  const logs = data?.logs ?? []

  return (
    <div className="page-scroll">
      <header className="page-head">
        <h1 className="page-title">Logs</h1>
        <p className="page-sub">
          Native OTLP logs and connector-sourced records (Supabase, Railway,
          Firebase, Cloudflare, Vercel), merged into one filterable surface.
        </p>
      </header>

      <section className="page-section">
        <div className="page-section-head">
          <h2>Recent entries</h2>
          <Badge variant="secondary" className="ml-2">live · read-only</Badge>
          {data && logs.length > 0 && <span className="page-count">{data.total} total</span>}
        </div>

        <div className="filter-chips" role="group" aria-label="Filter by log source">
          <button
            type="button"
            className={`chip${activeSource === 'all' ? ' on' : ''}`}
            onClick={() => setActiveSource('all')}
          >
            all
          </button>
          {SOURCES.map((s) => (
            <button
              key={s}
              type="button"
              className={`chip${activeSource === s ? ' on' : ''}`}
              onClick={() => setActiveSource(s)}
            >
              {SOURCE_LABEL[s]}
            </button>
          ))}
        </div>

        {error && <div className="page-empty">{error}</div>}

        {!error && data === null && <div className="page-empty">loading logs…</div>}

        {!error && data !== null && logs.length === 0 && (
          <div className="page-empty">
            No log entries{activeSource === 'all' ? '' : ` from ${SOURCE_LABEL[activeSource]}`} yet.
          </div>
        )}

        {!error && logs.length > 0 && (
          <table className="page-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Source</th>
                <th>Service</th>
                <th>Severity</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td className="td-mono">{formatTs(log.timestamp)}</td>
                  <td className="td-mono">{SOURCE_LABEL[log.source] ?? log.source}</td>
                  <td className="td-mono">
                    {log.nodeId ? (
                      <button
                        className="td-link"
                        onClick={() => {
                          onNodeSelect(log.nodeId as string)
                          onNavigateGraph()
                        }}
                        title="Focus this node on the graph"
                      >
                        {log.serviceName ?? log.nodeId}
                      </button>
                    ) : (
                      log.serviceName ?? '—'
                    )}
                  </td>
                  <td>
                    {log.severity ? (
                      <Badge variant={SEVERITY_VARIANT[log.severity] ?? 'outline'}>{log.severity}</Badge>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="td-msg">{log.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
