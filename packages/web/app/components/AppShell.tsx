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

export function AppShell() {
  // ADR-073 §3 — gate the dashboard behind a bearer; reverse-proxy
  // operators opt out via NEXT_PUBLIC_NEAT_AUTH_PROXY=true.
  useAuthGate()
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [graphData, setGraphData] = useState<GraphData | null>(null)
  // ADR-096 §5 — this daemon serves one project, so the dashboard shows that
  // one project. We don't read a project from the URL or localStorage and we
  // never let the user switch: viewing another project means another daemon
  // with its own dashboard. The name is resolved once from the daemon's own
  // /projects (which returns its single project). null means "not resolved
  // yet"; every data-fetching consumer gates on it so nothing fires a request
  // before the name lands (#461).
  const [project, setProjectState] = useState<string | null>(null)
  const [debugOpen, setDebugOpen] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cyRef = useRef<any>(null)
  const resolvedRef = useRef(false)

  // ADR-096 §5 / #419 — ask the daemon which project it serves and pin to it.
  // resolveProjectFromList prefers the active entry and resolves a single
  // registered project to itself (never to a made-up 'default', #461). An
  // empty or unreachable list leaves project null and the shell shows its
  // no-project state rather than firing doomed requests.
  function resolveOnce(): void {
    if (resolvedRef.current) return
    resolvedRef.current = true
    authedFetch('/api/projects')
      .then((r) => (r.ok ? r.json() : []))
      .then((data: ProjectEntry[] | { projects?: ProjectEntry[] }) => {
        const list = Array.isArray(data) ? data : Array.isArray(data?.projects) ? data.projects : []
        setProjectState(resolveProjectFromList(list))
      })
      .catch(() => {
        /* daemon unreachable — stay unresolved, nothing to fetch against */
      })
  }

  useEffect(() => {
    resolveOnce()
  }, [])

  // Called by GraphCanvas when the graph fetch returns 404 — the daemon's
  // project changed name under us (re-init). Re-resolve against /projects so
  // the dashboard recovers instead of staying permanently broken.
  function handleProjectNotFound(): void {
    resolvedRef.current = false
    resolveOnce()
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
