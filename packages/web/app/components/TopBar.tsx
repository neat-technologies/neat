'use client'

import { useEffect, useState } from 'react'
import { ChevronDownIcon, SearchIcon } from 'lucide-react'
import { CORE_URL_PUBLIC } from '../../lib/proxy-client'
import { authedFetch } from '../../lib/authed-fetch'
import type { Profile } from '../../lib/resolve-project'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Kbd } from '@/components/ui/kbd'

// web-shell §3 / web-multi-project (ADR-101): the switcher is a per-daemon
// PROFILE switcher. AppShell owns the active profile and passes the discovered
// list (from /api/profiles); the TopBar SURFACES the active project label and
// lets the operator pick a profile in one click (real control, rule 7 / #26).
// Status is the daemon record's `running | stopped` liveness — a `stopped`
// daemon is listed but not selectable (it can't be reached). No `default`
// fallback, no hardcoded names.

interface TopBarProps {
  // null until AppShell's resolution chain lands on a reachable profile (#461).
  project: string | null
  // discovered profiles, one per per-project daemon (ADR-101).
  profiles: Profile[]
  onSelectProfile: (p: Profile) => void
  onOpenPalette: () => void
  pageLabel: string
}

export function TopBar({ project, profiles, onSelectProfile, onOpenPalette, pageLabel }: TopBarProps) {
  const [isLive, setIsLive] = useState(false)

  // health dot for the active profile — idle until resolution (#461).
  useEffect(() => {
    if (!project) {
      setIsLive(false)
      return
    }
    const check = () =>
      authedFetch(`/api/health?project=${encodeURIComponent(project)}`)
        .then((r) => r.json())
        .then((d: { ok: boolean }) => setIsLive(d.ok === true))
        .catch(() => setIsLive(false))
    check()
    const id = setInterval(check, 15_000)
    return () => clearInterval(id)
  }, [project])

  return (
    <header className="topbar">
      <div className="brand" title="NEAT">N</div>

      {/* profile switcher — the active daemon, switchable in one click. */}
      <Popover>
        <PopoverTrigger
          className="project-switch"
          aria-label={`Profile: ${project ?? 'none'} — switch`}
        >
          <span className={`dot${isLive ? ' live' : ''}`} aria-hidden="true" />
          <span className="ps-name">{project ?? 'no project'}</span>
          <ChevronDownIcon className="ps-chev" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1.5" sideOffset={6}>
          <div className="ps-head">Daemons</div>
          {profiles.length === 0 ? (
            <div className="ps-empty">no running daemons</div>
          ) : (
            profiles.map((p) => (
              <button
                key={p.project}
                type="button"
                className={`ps-item${p.project === project ? ' on' : ''}`}
                disabled={p.status === 'stopped'}
                onClick={() => onSelectProfile(p)}
                title={p.status === 'stopped' ? 'daemon is stopped' : p.endpoint}
              >
                <span className={`ps-status ps-${p.status ?? 'running'}`} />
                <span className="ps-item-name">{p.project}</span>
                {p.status === 'stopped' && (
                  <span className="ps-item-tag">stopped</span>
                )}
              </button>
            ))
          )}
        </PopoverContent>
      </Popover>

      <span className="crumb-sep">/</span>
      <span className="crumb-here">{pageLabel}</span>

      <div className="topbar-spacer" />

      {/* ⌘K command palette opener (jedorini command). */}
      <button className="palette-btn" onClick={onOpenPalette} aria-label="Open command palette">
        <SearchIcon className="size-3.5 opacity-60" />
        <span className="palette-hint">find · jump · run</span>
        <Kbd className="palette-kbd">⌘K</Kbd>
      </button>

      <div className="top-actions">
        <span className="daemon-url" title="NEAT daemon URL">{CORE_URL_PUBLIC}</span>
        <button className="top-btn" aria-label={isLive ? 'Core connected' : 'Core offline'}>
          <span className={`dot${isLive ? ' live' : ''}`} />
          {isLive ? 'live' : 'offline'}
        </button>
        {/* account — disabled-with-affordance: hosted auth is not in this redo
            (web-completeness #26). */}
        <button
          className="top-btn"
          disabled
          title="Account — hosted auth lands with the SaaS dashboard"
          aria-label="Account (coming soon)"
          style={{ opacity: 0.4, cursor: 'not-allowed' }}
        >
          <span className="acct-avatar" aria-hidden="true" />
          account
        </button>
      </div>
    </header>
  )
}
