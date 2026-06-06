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

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// The /projects payload carries a status per ADR-051. 'active' is the healthy
// state; 'broken' (dead path) and 'paused' both yield an empty/erroring graph.
interface ProjectEntry { name: string; status?: 'active' | 'paused' | 'broken' }

// web-multi-project §2.3 — pick the project to land on when neither the URL
// nor localStorage named one. Prefer the first *active* project so we never
// open onto a broken/paused one and blank the dashboard (#419). If none are
// active, fall back to the first available project, then to 'default' (§2.4).
export function resolveProjectFromList(list: ProjectEntry[]): string {
  const active = list.find((p) => p?.name && p.status === 'active')
  if (active?.name) return active.name
  const firstNamed = list.find((p) => p?.name)
  if (firstNamed?.name) return firstNamed.name
  return 'default'
}

// ADR-057 #2 — resolution chain. URL → localStorage → first /projects → 'default'.
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
  const [project, setProjectState] = useState<string>(() => {
    return readUrlProject() ?? readStoredProject() ?? 'default'
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

  // ADR-057 #2.3, #2.4 / web-multi-project §2.3 — if neither URL nor
  // localStorage gave us a project, fetch /projects and resolve to the first
  // *active* one (skip broken/paused so we don't open onto an empty graph,
  // #419); fall back to the first available, then to 'default' if empty.
  useEffect(() => {
    if (resolvedRef.current) return
    resolvedRef.current = true
    authedFetch('/api/projects')
      .then((r) => (r.ok ? r.json() : []))
      .then((data: ProjectEntry[] | { projects?: ProjectEntry[] }) => {
        const list = Array.isArray(data) ? data : Array.isArray(data?.projects) ? data.projects : []
        setProject(resolveProjectFromList(list))
      })
      .catch(() => {
        /* registry unreachable — keep 'default' fallback */
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
        setProject(resolveProjectFromList(list))
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
