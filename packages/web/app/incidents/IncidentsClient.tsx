'use client'

import { Fragment, useEffect, useState } from 'react'
import Link from 'next/link'
import { authedFetch } from '../../lib/authed-fetch'
import { useAuthGate } from '../../lib/use-auth-gate'
import { resolveProfile, asProfileList, type Profile } from '../../lib/resolve-project'
import { setActiveProfile, readInitialProfileName } from '../../lib/active-profile'

// Mirrors the canonical ErrorEvent shape from @neat.is/types — the daemon's
// /api/incidents envelope (ADR-061) carries these fields, not the
// nodeId/type/message trio this table once assumed (#474).
interface Incident {
  id: string
  timestamp: string
  service: string
  errorType?: string
  errorMessage: string
  exceptionType?: string
  exceptionStacktrace?: string
  affectedNode: string
}

interface IncidentsResponse {
  count: number
  total: number
  events: Incident[]
}

function formatTs(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString() + ' ' + d.toTimeString().slice(0, 8)
  } catch {
    return iso
  }
}

export function IncidentsClient() {
  // ADR-073 §3 — same bearer gate AppShell uses.
  useAuthGate()
  const [data, setData] = useState<IncidentsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openRow, setOpenRow] = useState<string | null>(null)

  const toggleRow = (rowKey: string) => setOpenRow((prev) => (prev === rowKey ? null : rowKey))

  // ADR-101 — resolve the active profile the same way AppShell does so a cold
  // deep-link to /incidents lands on the same daemon: URL → localStorage →
  // daemon discovery (reachability-confirmed) → null (#419, #461). The project
  // NAME is the profile's label; the incidents fetch gates on it. An empty
  // discovery leaves project null and the page shows its no-project state.
  const [project, setProject] = useState<string | null>(null)

  useEffect(() => {
    const isReachable = async (p: Profile): Promise<boolean> => {
      try {
        const r = await authedFetch(`/api/health?project=${encodeURIComponent(p.project)}`, {
          cache: 'no-store',
        })
        return r.ok
      } catch {
        return false
      }
    }
    authedFetch('/api/profiles')
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => resolveProfile(asProfileList(data), isReachable, readInitialProfileName()))
      .then((resolved) => {
        if (resolved) {
          setActiveProfile(resolved)
          setProject(resolved.project)
        } else setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  // ADR-057 #3 — re-fetch when project changes; idle until resolution (#461).
  useEffect(() => {
    if (!project) return
    setLoading(true)
    authedFetch(`/api/incidents?limit=100&project=${encodeURIComponent(project)}`)
      .then((r) => r.json())
      .then((d: IncidentsResponse) => {
        setData(d)
        setLoading(false)
      })
      .catch((e: Error) => {
        setError(e.message)
        setLoading(false)
      })
  }, [project])

  return (
    <div style={{ background: 'var(--bg)', minHeight: '100vh' }}>
      <header className="topbar">
        <div className="brand" title="NEAT">N</div>
        <div className="crumbs">
          <Link href="/" className="incidents-nav-link">graph view</Link>
          <span className="sep">/</span>
          <span className="here">incidents</span>
        </div>
      </header>

      <div className="incidents-page" style={{ marginTop: 44 }}>
        <h1>Incidents</h1>
        <div className="subtitle">
          {data ? `${data.total} total events — showing ${data.events.length}` : loading ? 'loading…' : '—'}
        </div>

        {loading && (
          <div className="incidents-empty">loading…</div>
        )}

        {!loading && !error && !data && (
          <div className="incidents-empty">no project registered</div>
        )}

        {error && (
          <div className="incidents-empty" style={{ color: '#e87a7a' }}>
            failed to load: {error}
          </div>
        )}

        {!loading && !error && data && data.events.length === 0 && (
          <div className="incidents-empty">no incidents recorded</div>
        )}

        {!loading && !error && data && data.events.length > 0 && (
          <table className="incidents-table">
            <thead>
              <tr>
                <th>Node</th>
                <th>Time</th>
                <th>Type</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((evt, i) => {
                const rowKey = `${i}-${evt.id}`
                const isOpen = openRow === rowKey
                return (
                  <Fragment key={rowKey}>
                    <tr
                      style={{ cursor: evt.exceptionStacktrace ? 'pointer' : undefined }}
                      onClick={() => evt.exceptionStacktrace && toggleRow(rowKey)}
                    >
                      <td className="td-node">
                        <Link href={`/?node=${encodeURIComponent(evt.affectedNode)}`} className="incidents-node-link">
                          {evt.affectedNode}
                        </Link>
                      </td>
                      <td className="td-time">{formatTs(evt.timestamp)}</td>
                      <td className="td-type">{evt.errorType ?? evt.exceptionType ?? '—'}</td>
                      <td className="td-msg">
                        {evt.errorMessage}
                        {evt.exceptionStacktrace && (
                          <button
                            type="button"
                            className="stack-toggle"
                            aria-expanded={isOpen}
                            aria-label={isOpen ? 'Collapse stacktrace' : 'Expand stacktrace'}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleRow(rowKey)
                            }}
                          >
                            {isOpen ? ' ▲' : ' ▼'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {isOpen && evt.exceptionStacktrace && (
                      <tr>
                        <td colSpan={4} className="td-stacktrace">
                          <pre className="stacktrace-pre">{evt.exceptionStacktrace}</pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
