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
import { StubPage } from './StubPage'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { GraphNode, GraphEdge } from '@neat.is/types'
import { resolveProjectFromList, type ProjectEntry } from '../../lib/resolve-project'
import { ALL_NAV, type NavId } from '../../lib/nav'

// Re-exported for tests and existing imports (the selector lives in
// lib/resolve-project.ts so IncidentsClient can share it — #461).
export { resolveProjectFromList } from '../../lib/resolve-project'

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// ---------------------------------------------------------------------------
// AppShell — the multi-page SaaS shell (web-shell / IA ADR).
//
// web-multi-project (#27 / ADR-057, ADR-062) compliance:
//   - AppShell OWNS project state via useState<string | null> (null while
//     unresolved). No `default` fallback (#461). No hardcoded names.
//   - Resolution chain: URL ?project= → localStorage → first ACTIVE from
//     /projects → null. Steps 1-2 run synchronously in the lazy initializer
//     (the shell is client-only via dynamic({ ssr: false }) in page.tsx);
//     step 3 runs in an effect when 1-2 produced nothing.
//   - setProject writes URL + localStorage and re-fetches every consumer via
//     useEffect([project]).
//
// Spine framing: the fused Graph is the primary page; Divergences is a peer
// query, not the marquee.
// ---------------------------------------------------------------------------

const LAST_PROJECT_KEY = 'neat:lastProject'

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
  // steps 1-2 of the resolution chain run synchronously here.
  const [project, setProjectState] = useState<string | null>(() => readInitialProject())
  const [activePage, setActivePage] = useState<NavId>('graph')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [debugOpen, setDebugOpen] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cyRef = useRef<any>(null)
  const resolvedRef = useRef(false)

  // setProject — writes URL + localStorage (web-multi-project rules 3, 4, 7).
  const setProject = useCallback((name: string) => {
    setProjectState(name)
    try {
      window.localStorage.setItem(LAST_PROJECT_KEY, name)
      const url = new URL(window.location.href)
      url.searchParams.set('project', name)
      window.history.replaceState(null, '', url.toString())
    } catch {
      /* ignore — state still updates */
    }
  }, [])

  // step 3 — async resolution from /projects, only when 1-2 produced nothing.
  useEffect(() => {
    if (project || resolvedRef.current) return
    resolvedRef.current = true
    authedFetch('/api/projects')
      .then((r) => (r.ok ? r.json() : []))
      .then((data: ProjectEntry[] | { projects?: ProjectEntry[] }) => {
        const list = Array.isArray(data)
          ? data
          : Array.isArray(data?.projects)
            ? data.projects
            : []
        const resolved = resolveProjectFromList(list)
        if (resolved) setProject(resolved)
      })
      .catch(() => {
        /* daemon unreachable — stay unresolved, nothing to fetch against */
      })
  }, [])

  // GraphCanvas 404 → the daemon's project changed under us; re-resolve.
  function handleProjectNotFound(): void {
    resolvedRef.current = false
    setProjectState(null)
  }

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
              onSetProject={setProject}
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
                  />
                </div>
              ) : activePage === 'policies' ? (
                <PoliciesPage
                  project={project}
                  onNodeSelect={setSelectedNodeId}
                  onNavigateGraph={() => setActivePage('graph')}
                />
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
