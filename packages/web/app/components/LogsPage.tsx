'use client'

import { useEffect, useState } from 'react'
import type { LogEntry, LogSource } from '@neat.is/types'
import { authedFetch } from '../../lib/authed-fetch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

// ---------------------------------------------------------------------------
// Logs page (docs/contracts/logs.md, ADR-132).
//
// One unified feed — native OTel logs and every OCloud connector
// (Supabase/Railway/Firebase/Cloudflare/Vercel) — read through the single
// REST surface, GET /logs (proxied here at /api/logs). The source filter
// sets the exact same `source` query param MCP's get_logs and the CLI's
// `neat logs` use (contract §6) — no separate filter vocabulary invented for
// the frontend.
//
// Follows the Policies page's shape: an AppShell-embedded list/table view
// fed the resolved `project` as a prop (the shell owns profile resolution),
// styled with the shared `.page-*` list/table chrome (globals.css — "generic
// list/table page chrome (Policies + stubs)").
// ---------------------------------------------------------------------------

interface LogsPageProps {
  project: string | null
}

interface LogsResponse {
  count: number
  total: number
  logs: LogEntry[]
}

const SOURCE_FILTERS: { id: LogSource; label: string }[] = [
  { id: 'native', label: 'Native' },
  { id: 'supabase', label: 'Supabase' },
  { id: 'railway', label: 'Railway' },
  { id: 'firebase', label: 'Firebase' },
  { id: 'cloudflare', label: 'Cloudflare' },
  { id: 'vercel', label: 'Vercel' },
]

const SEVERITY_VARIANT: Record<string, 'destructive' | 'outline' | 'secondary' | 'ghost'> = {
  error: 'destructive',
  warn: 'outline',
  warning: 'outline',
  info: 'secondary',
  debug: 'ghost',
}

const LOGS_LIMIT = 200

function formatTs(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString() + ' ' + d.toTimeString().slice(0, 8)
  } catch {
    return iso
  }
}

export function LogsPage({ project }: LogsPageProps) {
  // Repeatable `source` — the same multi-value semantics the REST endpoint,
  // MCP, and the CLI share (docs/contracts/logs.md §6). Empty = no filter =
  // "All".
  const [sources, setSources] = useState<LogSource[]>([])
  const [data, setData] = useState<LogsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Idle until a project resolves (#461) — mirrors PoliciesPage/IncidentsClient.
  useEffect(() => {
    if (!project) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ project, limit: String(LOGS_LIMIT) })
    for (const s of sources) params.append('source', s)
    authedFetch(`/api/logs?${params.toString()}`)
      .then((r) => r.json())
      .then((d: LogsResponse) => {
        setData(d)
        setLoading(false)
      })
      .catch(() => {
        setError('could not load logs')
        setLoading(false)
      })
  }, [project, sources])

  function toggleSource(id: LogSource): void {
    setSources((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]))
  }

  return (
    <div className="page-scroll">
      <header className="page-head">
        <h1 className="page-title">Logs</h1>
        <p className="page-sub">
          The native OTel logs receiver and every connected connector, merged into one
          feed. Filtering by source sets the same query param MCP&apos;s <code>get_logs</code>{' '}
          and the CLI&apos;s <code>neat logs</code> use.
        </p>
      </header>

      <section className="page-section">
        <div className="page-section-head">
          <h2>Source</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={sources.length === 0 ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={sources.length === 0}
            onClick={() => setSources([])}
          >
            All
          </Button>
          {SOURCE_FILTERS.map((f) => (
            <Button
              key={f.id}
              variant={sources.includes(f.id) ? 'secondary' : 'outline'}
              size="sm"
              aria-pressed={sources.includes(f.id)}
              onClick={() => toggleSource(f.id)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </section>

      <section className="page-section">
        <div className="page-section-head">
          <h2>
            {data
              ? `${data.total} total — showing ${data.logs.length}`
              : loading
                ? 'loading'
                : 'recent logs'}
          </h2>
        </div>

        {loading && <div className="page-empty">loading logs…</div>}

        {!loading && !error && !project && (
          <div className="page-empty">no project registered</div>
        )}

        {error && (
          <div className="page-empty" style={{ color: 'var(--destructive)' }}>
            failed to load: {error}
          </div>
        )}

        {!loading && !error && project && data && data.logs.length === 0 && (
          <div className="page-empty">
            no logs recorded{sources.length > 0 ? ' for the selected source' : ''}
          </div>
        )}

        {!loading && !error && data && data.logs.length > 0 && (
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
              {data.logs.map((log) => (
                <tr key={log.id}>
                  <td className="td-mono">{formatTs(log.timestamp)}</td>
                  <td className="td-mono">{log.source}</td>
                  <td className="td-mono">{log.serviceName ?? '—'}</td>
                  <td>
                    {log.severity ? (
                      <Badge variant={SEVERITY_VARIANT[log.severity] ?? 'outline'}>
                        {log.severity}
                      </Badge>
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
