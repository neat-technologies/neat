'use client'

import { useEffect, useRef, useState } from 'react'
import { CORE_URL_PUBLIC } from '../../lib/proxy-client'
import { authedFetch } from '../../lib/authed-fetch'

interface Project {
  name: string
  path?: string
  status?: 'active' | 'paused' | 'broken'
}

interface SearchResult {
  node: { id: string; type: string; name?: string }
  score: number
}

interface TopBarProps {
  project: string
  onProjectChange: (name: string) => void
  onNodeSelect: (id: string) => void
  onRelayout: () => void
  onToggleLock: () => void
}

export function TopBar({ project, onProjectChange, onNodeSelect, onRelayout, onToggleLock }: TopBarProps) {
  const [projects, setProjects] = useState<Project[]>([])
  const [isLive, setIsLive] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [showResults, setShowResults] = useState(false)
  const [showSwitcher, setShowSwitcher] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)
  const switcherRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ADR-051 — list projects via GET /projects, used by the switcher (ADR-057 #7).
  useEffect(() => {
    authedFetch('/api/projects')
      .then((r) => (r.ok ? r.json() : []))
      .then((data: Project[] | { projects?: Project[] }) => {
        const list = Array.isArray(data) ? data : Array.isArray(data?.projects) ? data.projects : []
        setProjects(list)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const check = () =>
      authedFetch(`/api/health?project=${encodeURIComponent(project)}`)
        .then((r) => r.json())
        .then((d: { ok: boolean }) => setIsLive(d.ok === true))
        .catch(() => setIsLive(false))
    check()
    const id = setInterval(check, 15_000)
    return () => clearInterval(id)
  }, [project])

  // ADR-057 #5 — search is project-scoped.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!query.trim()) {
      setResults([])
      setShowResults(false)
      return
    }
    debounceRef.current = setTimeout(() => {
      authedFetch(`/api/search?q=${encodeURIComponent(query)}&project=${encodeURIComponent(project)}`)
        .then((r) => r.json())
        .then((d: { results: SearchResult[] }) => {
          if (Array.isArray(d.results)) {
            setResults(d.results.slice(0, 8))
            setShowResults(true)
          }
        })
        .catch(() => {})
    }, 280)
  }, [query, project])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowResults(false)
      }
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setShowSwitcher(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ⌘K / Ctrl+K focuses the search input
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
      // F key focuses search when not in an input
      if (e.key === 'f' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  return (
    <header className="topbar">
      <div className="brand" title="NEAT">N</div>

      {/* ADR-057 #6 — active project always visible. ADR-057 #7 — switcher always reachable. */}
      <div className="crumbs" ref={switcherRef}>
        <button
          className="repo project-switcher"
          aria-label={`Active project: ${project}. Click to switch.`}
          aria-expanded={showSwitcher}
          onClick={() => setShowSwitcher((v) => !v)}
          title="Switch project"
        >
          <span className="project-name">{project}</span>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginLeft: 4, opacity: 0.6 }}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {showSwitcher && (
          <div className="project-menu" role="menu">
            {projects.length === 0 ? (
              <div className="project-menu-empty">no registered projects</div>
            ) : (
              projects.map((p) => (
                <button
                  key={p.name}
                  className={`project-menu-item${p.name === project ? ' active' : ''}`}
                  role="menuitem"
                  onClick={() => {
                    onProjectChange(p.name)
                    setShowSwitcher(false)
                  }}
                >
                  {p.name}
                </button>
              ))
            )}
          </div>
        )}
        <span className="sep">/</span>
        <span className="here">graph view</span>
      </div>

      <div className="topbar-spacer" />

      <div className="top-search" ref={searchRef}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3-3" />
        </svg>
        <input
          ref={inputRef}
          aria-label="Search nodes"
          aria-expanded={showResults}
          placeholder="find · query · @author · #service"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setShowResults(true)}
        />
        {!query && <span className="kbd">⌘K</span>}
        {showResults && results.length > 0 && (
          <div className="search-results" role="listbox">
            {results.map((r) => (
              <div
                key={r.node.id}
                className="search-result-item"
                role="option"
                aria-selected={false}
                onMouseDown={() => {
                  setQuery('')
                  setShowResults(false)
                  onNodeSelect(r.node.id)
                }}
              >
                <span className="sr-name">{r.node.name ?? r.node.id}</span>
                <span className="sr-type">{r.node.type.replace('Node', '').toLowerCase()}</span>
                <span className="sr-score">{r.score.toFixed(2)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="top-actions">
        {/* ADR-058 #5 — daemon URL visible. */}
        <span className="daemon-url" title="NEAT daemon URL">{CORE_URL_PUBLIC}</span>
        <button className="top-btn" aria-label={isLive ? 'Core connected' : 'Core offline'}>
          <span className={`dot${isLive ? ' live' : ''}`} />
          {isLive ? 'Live' : 'Offline'}
        </button>
        {/* ADR-056 — History deferred; explicitly disabled with affordance. */}
        <button className="top-btn" disabled title="History — coming in v0.3.x" aria-label="History (coming soon)" style={{ opacity: 0.4, cursor: 'not-allowed' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
          </svg>
          History
        </button>
        {/* ADR-056 — Share wired: copies the deep-link URL to clipboard. */}
        <button
          className="top-btn"
          title="Copy current view URL"
          aria-label="Share — copy URL"
          onClick={() => {
            if (typeof navigator !== 'undefined' && navigator.clipboard) {
              void navigator.clipboard.writeText(window.location.href)
            }
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" />
            <path d="m8 11 8-4M8 13l8 4" />
          </svg>
          Share
        </button>
        <button className="top-btn" title="Re-run cose layout" onClick={onRelayout}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 8v4l3 2" /><circle cx="12" cy="12" r="9" />
          </svg>
          Layout
        </button>
        <button className="top-btn" title="Toggle node dragging" onClick={onToggleLock}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="5" y="11" width="14" height="9" rx="1.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
          Lock
        </button>
      </div>
    </header>
  )
}
