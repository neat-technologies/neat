'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { authedFetch } from '../../lib/authed-fetch'
import { useAuthGate } from '../../lib/use-auth-gate'
import { resolveProjectFromList, type ProjectEntry } from '../../lib/resolve-project'

interface Incident {
  nodeId: string
  timestamp: string
  type: string
  message: string
  stacktrace?: string
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

  // ADR-057 #2 — read project from URL (deep-linkable) or localStorage,
  // matching AppShell's resolution chain. The lazy initializer reads
  // window.* synchronously; safe because the page mounts client-only via
  // dynamic({ ssr: false }) per ADR-062 §4 (2026-05-11 amendment). The
  // typeof window guard stays as belt-and-suspenders — if someone later
  // removes the dynamic wrapper, this degrades to a flicker, not a crash.
  // null means unresolved (#461) — the incidents fetch gates on it instead
  // of asking the daemon about a project named 'default' that can't exist.
  const [project, setProject] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    const fromUrl = new URLSearchParams(window.location.search).get('project')
    if (fromUrl) return fromUrl
    try {
      const stored = window.localStorage.getItem('neat:lastProject')
      if (stored) return stored
    } catch { /* noop */ }
    return null
  })

  // ADR-057 #2.3 / #461 — neither URL nor localStorage named a project
  // (deep link in a fresh session); resolve against /projects the same way
  // AppShell does. An empty registry leaves project null and the page shows
  // its no-project state.
  useEffect(() => {
    if (project) return
    authedFetch('/api/projects')
      .then((r) => (r.ok ? r.json() : []))
      .then((data: ProjectEntry[] | { projects?: ProjectEntry[] }) => {
        const list = Array.isArray(data) ? data : Array.isArray(data?.projects) ? data.projects : []
        const resolved = resolveProjectFromList(list)
        if (resolved) setProject(resolved)
        else setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [project])

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
                const rowKey = `${i}-${evt.nodeId}`
                const isOpen = openRow === rowKey
                return (
                  <>
                    <tr
                      key={rowKey}
                      style={{ cursor: evt.stacktrace ? 'pointer' : undefined }}
                      onClick={() => evt.stacktrace && setOpenRow(isOpen ? null : rowKey)}
                      title={evt.stacktrace ? (isOpen ? 'Collapse stacktrace' : 'Expand stacktrace') : undefined}
                    >
                      <td className="td-node">
                        <Link href={`/?node=${encodeURIComponent(evt.nodeId)}&project=${encodeURIComponent(project ?? '')}`} className="incidents-node-link">
                          {evt.nodeId}
                        </Link>
                      </td>
                      <td className="td-time">{formatTs(evt.timestamp)}</td>
                      <td className="td-type">{evt.type}</td>
                      <td className="td-msg">
                        {evt.message}
                        {evt.stacktrace && (
                          <span className="stack-toggle">{isOpen ? ' ▲' : ' ▼'}</span>
                        )}
                      </td>
                    </tr>
                    {isOpen && evt.stacktrace && (
                      <tr key={`${rowKey}-stack`}>
                        <td colSpan={4} className="td-stacktrace">
                          <pre className="stacktrace-pre">{evt.stacktrace}</pre>
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
