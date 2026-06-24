'use client'

import { useEffect, useState } from 'react'
import { ChevronDownIcon, SearchIcon } from 'lucide-react'
import { CORE_URL_PUBLIC } from '../../lib/proxy-client'
import { authedFetch } from '../../lib/authed-fetch'
import type { ProjectEntry } from '../../lib/resolve-project'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Kbd } from '@/components/ui/kbd'

// web-multi-project (#27 / ADR-057, ADR-062): AppShell owns project state; the
// TopBar SURFACES the active project and the switcher (rule 6 + 7). The
// switcher is a real control (rule 7): clicking an entry calls setProject,
// which writes URL + localStorage and re-fetches every consumer. No `default`
// fallback, no hardcoded names (rule 8). The hosted product is multi-project,
// so this is the SaaS switcher the spec calls for.

interface TopBarProps {
  // null until AppShell's resolution chain lands on a real project (#461).
  project: string | null
  onSetProject: (name: string) => void
  onOpenPalette: () => void
  pageLabel: string
}

export function TopBar({ project, onSetProject, onOpenPalette, pageLabel }: TopBarProps) {
  const [isLive, setIsLive] = useState(false)
  const [projects, setProjects] = useState<ProjectEntry[]>([])

  // health dot for the active project — idle until resolution (#461).
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

  // the switcher's option list (GET /projects per ADR-051).
  useEffect(() => {
    authedFetch('/api/projects')
      .then((r) => (r.ok ? r.json() : []))
      .then((d: ProjectEntry[] | { projects?: ProjectEntry[] }) => {
        const list = Array.isArray(d) ? d : Array.isArray(d?.projects) ? d.projects : []
        setProjects(list)
      })
      .catch(() => setProjects([]))
  }, [project])

  return (
    <header className="topbar">
      <div className="brand" title="NEAT">N</div>

      {/* project switcher — the active codebase, switchable in one click. */}
      <Popover>
        <PopoverTrigger
          className="project-switch"
          aria-label={`Project: ${project ?? 'none'} — switch`}
        >
          <span className={`dot${isLive ? ' live' : ''}`} aria-hidden="true" />
          <span className="ps-name">{project ?? 'no project'}</span>
          <ChevronDownIcon className="ps-chev" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1.5" sideOffset={6}>
          <div className="ps-head">Projects</div>
          {projects.length === 0 ? (
            <div className="ps-empty">no registered projects</div>
          ) : (
            projects.map((p) => (
              <button
                key={p.name}
                type="button"
                className={`ps-item${p.name === project ? ' on' : ''}`}
                disabled={p.status === 'broken'}
                onClick={() => onSetProject(p.name)}
                title={p.status === 'broken' ? 'project path is unreachable' : p.name}
              >
                <span className={`ps-status ps-${p.status ?? 'active'}`} />
                <span className="ps-item-name">{p.name}</span>
                {p.status && p.status !== 'active' && (
                  <span className="ps-item-tag">{p.status}</span>
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
