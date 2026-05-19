'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { authedFetch } from '../../lib/authed-fetch'

interface RailProps {
  project: string
}

export function Rail({ project }: RailProps) {
  const [blastBadge, setBlastBadge] = useState(0)
  const [incidentBadge, setIncidentBadge] = useState(0)

  // ADR-057 #3 — re-fetch on project change.
  useEffect(() => {
    const proj = `?project=${encodeURIComponent(project)}`
    authedFetch(`/api/policies/violations${proj}`)
      .then((r) => r.json())
      .then((d: { violations: unknown[] }) => {
        if (Array.isArray(d.violations)) {
          setBlastBadge(Math.min(d.violations.length, 9))
        }
      })
      .catch(() => {})

    authedFetch(`/api/incidents?limit=1&project=${encodeURIComponent(project)}`)
      .then((r) => r.json())
      .then((d: { total: number }) => {
        if (typeof d.total === 'number') setIncidentBadge(Math.min(d.total, 9))
      })
      .catch(() => {})
  }, [project])

  // ADR-056 — Find is wired: dispatches a custom event TopBar's search input listens for.
  // ADR-056 — Layers / NeatScript / Time travel / Diff / Comments / Agents / Settings
  // are deferred features; rendered with `disabled` + tooltip affordance so the user
  // perceives them as unavailable, not broken.
  function focusFind(): void {
    const input = document.querySelector<HTMLInputElement>('.top-search input')
    input?.focus()
  }

  function disabledTip(label: string): string {
    return `${label} — coming in v0.3.x`
  }

  return (
    <nav className="rail">
      <div className="rail-group">
        <button className="rail-btn active" aria-label="Graph view" title="Graph view">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" />
            <circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" />
            <path d="M8 6h8M6 8v8M18 8v8M8 18h8" />
          </svg>
          <span className="rail-tip">Graph<span className="k">G</span></span>
        </button>
        <button className="rail-btn" aria-label="Layers (coming soon)" disabled title={disabledTip('Layers')} style={{ opacity: 0.35, cursor: 'not-allowed' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M4 7h16M4 12h10M4 17h16" />
          </svg>
          <span className="rail-tip">Layers<span className="k">L</span></span>
        </button>
        <button className="rail-btn" aria-label="Find node" onClick={focusFind} title="Find — focus search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="11" cy="11" r="6" /><path d="m20 20-4-4" />
          </svg>
          <span className="rail-tip">Find<span className="k">F</span></span>
        </button>
      </div>

      <div className="rail-group">
        <button className="rail-btn" aria-label="NeatScript editor (coming soon)" disabled title={disabledTip('NeatScript')} style={{ opacity: 0.35, cursor: 'not-allowed' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />
          </svg>
          <span className="rail-tip">NeatScript<span className="k">N</span></span>
        </button>
        <button className="rail-btn" aria-label="Time travel (coming soon)" disabled title={disabledTip('Time travel')} style={{ opacity: 0.35, cursor: 'not-allowed' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
          </svg>
          <span className="rail-tip">Time travel<span className="k">T</span></span>
        </button>
        <button className="rail-btn" aria-label="Blast radius (coming soon)" disabled title={disabledTip('Blast radius')} style={{ opacity: 0.35, cursor: 'not-allowed' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="7" />
            <path d="M12 3v2M12 19v2M3 12h2M19 12h2" />
          </svg>
          <span className="rail-tip">Blast radius<span className="k">B</span></span>
          {blastBadge > 0 && <span className="badge">{blastBadge}</span>}
        </button>
        <button className="rail-btn" aria-label="Graph diff (coming soon)" disabled title={disabledTip('Diff')} style={{ opacity: 0.35, cursor: 'not-allowed' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M8 4 4 8l4 4M16 12l4 4-4 4M14 4l-4 16" />
          </svg>
          <span className="rail-tip">Diff<span className="k">D</span></span>
        </button>
      </div>

      <div className="rail-group">
        <button className="rail-btn" aria-label="Comments (coming soon)" disabled title={disabledTip('Comments')} style={{ opacity: 0.35, cursor: 'not-allowed' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M4 6c0-1 1-2 2-2h12c1 0 2 1 2 2v9c0 1-1 2-2 2h-7l-4 4v-4H6c-1 0-2-1-2-2z" />
          </svg>
          <span className="rail-tip">Comments<span className="k">C</span></span>
        </button>
        <Link href="/incidents" className="rail-btn" aria-label="Incidents log" style={{ textDecoration: 'none' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M12 9v4M12 17h.01" /><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          </svg>
          <span className="rail-tip">Incidents</span>
          {incidentBadge > 0 && <span className="badge">{incidentBadge}</span>}
        </Link>
        <button className="rail-btn" aria-label="Agents (coming soon)" disabled title={disabledTip('Agents')} style={{ opacity: 0.35, cursor: 'not-allowed' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M12 3v3M12 18v3M5 12H2M22 12h-3M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span className="rail-tip">Agents<span className="k">A</span></span>
        </button>
      </div>

      <div className="rail-spacer" />

      <div className="rail-group" style={{ borderTop: '1px solid var(--rule)' }}>
        <button className="rail-btn" aria-label="Settings (coming soon)" disabled title={disabledTip('Settings')} style={{ opacity: 0.35, cursor: 'not-allowed' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="3" />
            <path d="M19 12a7 7 0 0 1-.4 2.3l2 1.5-2 3.4-2.3-1a7 7 0 0 1-4 2.3l-.4 2.5h-4l-.4-2.5a7 7 0 0 1-4-2.3l-2.3 1-2-3.4 2-1.5A7 7 0 0 1 5 12a7 7 0 0 1 .4-2.3l-2-1.5 2-3.4 2.3 1a7 7 0 0 1 4-2.3L12 1h4l.4 2.5a7 7 0 0 1 4 2.3l2.3-1 2 3.4-2 1.5" />
          </svg>
          <span className="rail-tip">Settings</span>
        </button>
      </div>
    </nav>
  )
}
