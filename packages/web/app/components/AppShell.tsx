'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { authedFetch } from '../../lib/authed-fetch'
import { useAuthGate } from '../../lib/use-auth-gate'
import { PageSidebar } from './PageSidebar'
import { TopBar } from './TopBar'
import { GraphCanvas } from './GraphCanvas'
import { Inspector } from './Inspector'
import { StatusBar } from './StatusBar'
import { DebugPanel } from './DebugPanel'
import { Toaster } from './Toaster'
import { CommandPalette } from './CommandPalette'
import { PoliciesPage } from './PoliciesPage'
import { DivergencesPage } from './DivergencesPage'
import { ConnectorsPage } from './ConnectorsPage'
import { LogsPage } from './LogsPage'
import { FindPage } from './FindPage'
import { SettingsPage } from './SettingsPage'
import { StubPage } from './StubPage'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { GraphNode, GraphEdge } from '@neat.is/types'
import { resolveProfile, asProfileList, type Profile } from '../../lib/resolve-project'
import { setActiveProfile } from '../../lib/active-profile'
import { ALL_NAV, type NavId } from '../../lib/nav'

// Re-exported for tests and existing imports (the selector lives in
// lib/resolve-project.ts so IncidentsClient can share it — #461).
export { resolveProfile, asProfileList, type Profile } from '../../lib/resolve-project'

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// ---------------------------------------------------------------------------
// AppShell — the multi-page SaaS shell (web-shell / IA ADR).
//
// web-multi-project (#27 / ADR-057, ADR-062, ADR-101) compliance:
//   - AppShell OWNS the active PROFILE state via useState<Profile | null> (null
//     while unresolved). The project NAME is the profile's label; it is what we
//     thread to consumers (the API routes key the daemon endpoint off it). No
//     `default` fallback (#461). No hardcoded names.
//   - Resolution chain (ADR-101): URL ?project= → localStorage → daemon
//     discovery (/api/profiles, reachability-confirmed) → null. The name hint
//     reads synchronously (the shell is client-only via dynamic({ ssr: false })
//     in page.tsx); the discovery + reachability step runs in an effect.
//   - A stale `running` / unreachable profile is shown in the switcher but
//     never auto-selected, so we never cold-open onto a dead endpoint (#419).
//   - selectProfile writes URL + localStorage (the label) and re-fetches every
//     consumer via useEffect([project]).
//
// Spine framing: the fused Graph is the primary page; Divergences is a peer
// query, not the marquee.
// ---------------------------------------------------------------------------

const LAST_PROJECT_KEY = 'neat:lastProject'

// web-multi-project §2.4 — the URL/localStorage keys stay project NAMES (the
// profile's label). Read synchronously as a hint; resolution confirms it
// against discovery + reachability.
function readInitialProject(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const url = new URLSearchParams(window.location.search).get('project')
    if (url) return url
    const stored = window.localStorage.getItem(LAST_PROJECT_KEY)
    if (stored) return stored
  } catch {
    /* private mode — fall through to async resolution */
  }
  return null
}

export function AppShell() {
  // ADR-073 §3 — gate the dashboard behind a bearer.
  useAuthGate()

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [graphData, setGraphData] = useState<GraphData | null>(null)
  // AppShell owns the active profile (ADR-101). `project` (the label) is what
  // the consumers receive — the daemon endpoint resolves from it server-side.
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const project = profile?.project ?? null
  const [activePage, setActivePage] = useState<NavId>('graph')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [debugOpen, setDebugOpen] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cyRef = useRef<any>(null)
  const resolvedRef = useRef(false)

  // Keep the active-profile module in sync — the auth seam (authed-fetch,
  // use-auth-gate) reads the active profile's bearer from there.
  useEffect(() => {
    setActiveProfile(profile)
  }, [profile])

  // Reachability probe (web-multi-project §2.3) — the discovery file is a hint,
  // so confirm the daemon answers before auto-selecting (#419). Routes through
  // /api/health, which resolves the label → endpoint and probes the daemon.
  const isReachable = useCallback(async (p: Profile): Promise<boolean> => {
    try {
      const r = await authedFetch(`/api/health?project=${encodeURIComponent(p.project)}`, {
        cache: 'no-store',
      })
      return r.ok
    } catch {
      return false
    }
  }, [])

  // selectProfile — sets the active profile and writes its label to URL +
  // localStorage (web-multi-project rules 3, 4, 7; §2.4 keeps the key a name).
  const selectProfile = useCallback((p: Profile) => {
    setProfile(p)
    try {
      window.localStorage.setItem(LAST_PROJECT_KEY, p.project)
      const url = new URL(window.location.href)
      url.searchParams.set('project', p.project)
      window.history.replaceState(null, '', url.toString())
    } catch {
      /* ignore — state still updates */
    }
  }, [])

  // Load the switcher's profile list once — the daemon-discovery enumerator
  // (ADR-101, was GET /projects).
  useEffect(() => {
    authedFetch('/api/profiles')
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setProfiles(asProfileList(data)))
      .catch(() => setProfiles([]))
  }, [])

  // step 3 — auto-resolve once profiles arrive and nothing is selected yet.
  // resolveProfile confirms reachability and honors the URL/localStorage name
  // hint, falling back to the first running+reachable profile (#419, #461).
  useEffect(() => {
    if (profile || resolvedRef.current || profiles.length === 0) return
    resolvedRef.current = true
    void resolveProfile(profiles, isReachable, readInitialProject()).then((resolved) => {
      if (resolved) selectProfile(resolved)
      else resolvedRef.current = false
    })
  }, [profiles, profile, isReachable, selectProfile])

  // GraphCanvas 404 → the daemon's project changed under us; re-resolve.
  function handleProjectNotFound(): void {
    resolvedRef.current = false
    setProfile(null)
  }

  // Highlight a BFS set on the canvas — the focus half of the Inspector's
  // node-scoped blast-radius / dependency actions (web-shell §6: these focus the
  // canvas, they do not navigate to a page). Dims everything outside the set and
  // fits to it, using the cy instance GraphCanvas handed up via onCyReady.
  const focusNodes = useCallback((ids: string[]) => {
    const cy = cyRef.current
    if (!cy || ids.length === 0) return
    setActivePage('graph')
    cy.elements().removeClass('hl dim')
    let set = cy.collection()
    for (const id of ids) {
      const el = cy.getElementById(id)
      if (el && el.nonempty()) set = set.union(el)
    }
    if (set.empty()) return
    // include the edges internal to the set so the traced sub-graph reads as one.
    const withEdges = set.union(set.edgesWith(set))
    cy.elements().not(withEdges).addClass('dim')
    withEdges.addClass('hl')
    cy.animate({ fit: { eles: set, padding: 90 } }, { duration: 320 })
  }, [])

  // pre-select a node from the URL ?node= query (e.g. incidents back-link).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const nodeId = params.get('node')
    if (nodeId) {
      setSelectedNodeId(nodeId)
      setActivePage('graph')
    }
  }, [])

  // ⌘K opens the palette; Ctrl/Cmd+Shift+D toggles the debug panel.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K') && !e.shiftKey) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault()
        setDebugOpen((v) => !v)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const pageLabel = ALL_NAV.find((n) => n.id === activePage)?.label.toLowerCase() ?? 'graph'

  return (
    <TooltipProvider delay={120}>
      <SidebarProvider defaultOpen>
        <div className="shell">
          <PageSidebar active={activePage} onNavigate={setActivePage} />
          <div className="shell-main">
            <TopBar
              project={project}
              profiles={profiles}
              onSelectProfile={selectProfile}
              onOpenPalette={() => setPaletteOpen(true)}
              pageLabel={pageLabel}
            />

            <div className="shell-body">
              {activePage === 'graph' ? (
                <div className="graph-layout">
                  <GraphCanvas
                    project={project}
                    selectedNodeId={selectedNodeId}
                    onNodeSelect={setSelectedNodeId}
                    onGraphLoaded={setGraphData}
                    onCyReady={(cy) => {
                      cyRef.current = cy
                    }}
                    onProjectNotFound={handleProjectNotFound}
                  />
                  <Inspector
                    project={project}
                    selectedNodeId={selectedNodeId}
                    graphData={graphData}
                    onNodeSelect={setSelectedNodeId}
                    onFocusNodes={focusNodes}
                  />
                </div>
              ) : activePage === 'policies' ? (
                <PoliciesPage
                  project={project}
                  onNodeSelect={setSelectedNodeId}
                  onNavigateGraph={() => setActivePage('graph')}
                />
              ) : activePage === 'divergences' ? (
                <DivergencesPage
                  project={project}
                  onNodeSelect={setSelectedNodeId}
                  onNavigateGraph={() => setActivePage('graph')}
                />
              ) : activePage === 'connectors' ? (
                <ConnectorsPage project={project} />
              ) : activePage === 'logs' ? (
                <LogsPage
                  project={project}
                  onNodeSelect={setSelectedNodeId}
                  onNavigateGraph={() => setActivePage('graph')}
                />
              ) : activePage === 'find' ? (
                <FindPage
                  project={project}
                  onNodeSelect={setSelectedNodeId}
                  onNavigateGraph={() => setActivePage('graph')}
                />
              ) : activePage === 'settings' ? (
                <SettingsPage project={project} profiles={profiles} onSelectProfile={selectProfile} />
              ) : (
                <StubPage id={activePage} />
              )}
            </div>

            <StatusBar project={project} graphData={graphData} />
          </div>

          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            project={project}
            onNavigate={setActivePage}
            onNodeSelect={setSelectedNodeId}
          />
          <Toaster />
          {debugOpen && <DebugPanel project={project} onClose={() => setDebugOpen(false)} />}
        </div>
      </SidebarProvider>
    </TooltipProvider>
  )
}
