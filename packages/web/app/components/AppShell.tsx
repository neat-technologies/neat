'use client'

import { useEffect, useRef, useState } from 'react'
import { authedFetch } from '../../lib/authed-fetch'
import { useAuthGate } from '../../lib/use-auth-gate'
import { TopBar } from './TopBar'
import { Rail } from './Rail'
import { GraphCanvas } from './GraphCanvas'
import { Inspector } from './Inspector'
import { StatusBar } from './StatusBar'
import { DebugPanel } from './DebugPanel'
import { Toaster } from './Toaster'
import type { GraphNode, GraphEdge } from '@neat.is/types'
import { resolveProjectFromList, type ProjectEntry } from '../../lib/resolve-project'

// Re-exported for tests and existing imports; the selector moved to
// lib/resolve-project.ts so IncidentsClient can share it without pulling in
// the whole shell (#461).
export { resolveProjectFromList } from '../../lib/resolve-project'

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// ADR-057 #2 — resolution chain. URL → localStorage → first /projects.
function readUrlProject(): string | null {
  if (typeof window === 'undefined') return null
  const v = new URLSearchParams(window.location.search).get('project')
  return v && v.length > 0 ? v : null
}

function readStoredProject(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const v = window.localStorage.getItem('neat:lastProject')
    return v && v.length > 0 ? v : null
  } catch {
    return null
  }
}

export function AppShell() {
  // ADR-073 §3 — gate the dashboard behind a bearer; reverse-proxy
  // operators opt out via NEXT_PUBLIC_NEAT_AUTH_PROXY=true.
  useAuthGate()
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [graphData, setGraphData] = useState<GraphData | null>(null)
  // ADR-057 #2 — start with URL or localStorage (synchronous), then resolve
  // against /projects on mount if neither was set. Safe because AppShell
  // mounts client-only via dynamic({ ssr: false }) in app/page.tsx (ADR-062).
  // null means "not resolved yet" (or "registry is empty") — every
  // data-fetching consumer gates on it, so nothing fires a doomed
  // project=default request while resolution is in flight (#461).
  const [project, setProjectState] = useState<string | null>(() => {
    return readUrlProject() ?? readStoredProject()
  })
  const [debugOpen, setDebugOpen] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cyRef = useRef<any>(null)
  const resolvedRef = useRef(readUrlProject() !== null || readStoredProject() !== null)

  // ADR-057 #1, #4 — single source of truth + URL sync.
  function setProject(name: string): void {
    setProjectState(name)
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem('neat:lastProject', name)
    } catch {
      /* ignore quota errors */
    }
    const url = new URL(window.location.href)
    url.searchParams.set('project', name)
    window.history.replaceState({}, '', url)
  }

  // ADR-057 #2.3 / web-multi-project §2.3 — if neither URL nor localStorage
  // gave us a project, fetch /projects and resolve to the first *active* one
  // (skip broken/paused so we don't open onto an empty graph, #419); fall
  // back to the first available. If the registry is empty or unreachable,
  // project stays null and the shell shows its no-project state instead of
  // firing requests that can only 404 (#461).
  useEffect(() => {
    if (resolvedRef.current) return
    resolvedRef.current = true
    authedFetch('/api/projects')
      .then((r) => (r.ok ? r.json() : []))
      .then((data: ProjectEntry[] | { projects?: ProjectEntry[] }) => {
        const list = Array.isArray(data) ? data : Array.isArray(data?.projects) ? data.projects : []
        const resolved = resolveProjectFromList(list)
        if (resolved) setProject(resolved)
      })
      .catch(() => {
        /* registry unreachable — stay unresolved, nothing to fetch against */
      })
  }, [])

  // Called by GraphCanvas when the graph fetch returns 404. Clears the stale
  // localStorage entry and re-resolves to the first active project so the
  // dashboard doesn't stay permanently broken (web-multi-project §2).
  function handleProjectNotFound(): void {
    try { window.localStorage.removeItem('neat:lastProject') } catch { /* ignore */ }
    resolvedRef.current = false
    authedFetch('/api/projects')
      .then((r) => (r.ok ? r.json() : []))
      .then((data: ProjectEntry[] | { projects?: ProjectEntry[] }) => {
        const list = Array.isArray(data) ? data : Array.isArray(data?.projects) ? data.projects : []
        const resolved = resolveProjectFromList(list)
        // A null resolution clears the stale name so the consumers stop
        // re-requesting a project the daemon already said doesn't exist.
        if (resolved) setProject(resolved)
        else setProjectState(null)
      })
      .catch(() => { /* registry unreachable — nothing to recover to */ })
  }

  // Pre-select a node from the URL ?node= query param (e.g. from incidents back-link)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const nodeId = params.get('node')
    if (nodeId) setSelectedNodeId(nodeId)
  }, [])

  // ADR-058 #4 — Ctrl+Shift+D / Cmd+Shift+D toggles the debug panel.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault()
        setDebugOpen((v) => !v)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  return (
    <div className="app">
      <TopBar
        project={project}
        onProjectChange={setProject}
        onNodeSelect={setSelectedNodeId}
        onRelayout={() => cyRef.current?.layout({ name: 'cose', animate: true, randomize: false, idealEdgeLength: 90, nodeRepulsion: 9000, edgeElasticity: 80, gravity: 0.4, numIter: 1200 }).run()}
        onToggleLock={() => { if (cyRef.current) cyRef.current.autoungrabify(!cyRef.current.autoungrabify()) }}
      />
      <Rail project={project} />
      <GraphCanvas
        project={project}
        selectedNodeId={selectedNodeId}
        onNodeSelect={setSelectedNodeId}
        onGraphLoaded={setGraphData}
        onCyReady={(cy) => { cyRef.current = cy }}
        onProjectNotFound={handleProjectNotFound}
      />
      <Inspector
        project={project}
        selectedNodeId={selectedNodeId}
        graphData={graphData}
        onNodeSelect={setSelectedNodeId}
      />
      <StatusBar project={project} graphData={graphData} />
      <Toaster />
      {debugOpen && <DebugPanel project={project} onClose={() => setDebugOpen(false)} />}
    </div>
  )
}
