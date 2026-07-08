import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { GraphNode, GraphEdge } from '@neat.is/types'
import type { GraphData } from '../app/components/AppShell'
import { Inspector } from '../app/components/Inspector'

// web-shell §6 — blast-radius and dependencies are node-scoped Inspector actions
// (never nav pages). They run on demand against the daemon and list the traced
// set; each row selects that node, and "highlight on graph" focuses the set.
const nodes: GraphNode[] = [
  { id: 'service:a', type: 'ServiceNode', name: 'a', language: 'ts' } as GraphNode,
  { id: 'file:a:x.ts', type: 'FileNode', service: 'a', path: 'src/x.ts', language: 'ts' } as GraphNode,
  { id: 'database:d', type: 'DatabaseNode', name: 'orders-db', engine: 'pg', engineVersion: '15', compatibleDrivers: [] } as GraphNode,
]
const edges: GraphEdge[] = [
  { id: 'c1', source: 'service:a', target: 'file:a:x.ts', type: 'CONTAINS', provenance: 'EXTRACTED' } as GraphEdge,
  { id: 'call1', source: 'file:a:x.ts', target: 'database:d', type: 'CALLS', provenance: 'OBSERVED', confidence: 0.91, evidence: { file: 'src/x.ts', line: 128 } } as GraphEdge,
]
const graphData: GraphData = { nodes, edges }

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('/api/graph/blast-radius/')) {
        return json({ origin: 'file:a:x.ts', affectedNodes: [{ nodeId: 'database:d', distance: 2, edgeProvenance: 'OBSERVED', path: ['file:a:x.ts', 'x', 'database:d'], confidence: 0.8 }], totalAffected: 1 })
      }
      const m = url.match(/\/api\/graph\/node\/([^?]+)/)
      if (m) {
        const node = nodes.find((n) => n.id === decodeURIComponent(m[1]))
        return json({ node })
      }
      return json({ rootCauseNode: null })
    }),
  )
}

beforeEach(() => stubFetch())
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Inspector Impact — node-scoped blast radius (web-shell §6)', () => {
  it('runs blast radius on demand and lists the affected set with a graph-highlight action', async () => {
    const onNodeSelect = vi.fn()
    const onFocusNodes = vi.fn()
    render(
      <Inspector
        project="default"
        selectedNodeId="file:a:x.ts"
        graphData={graphData}
        onNodeSelect={onNodeSelect}
        onFocusNodes={onFocusNodes}
      />,
    )

    // the actions are offered but nothing runs until asked (they're actions).
    const blastBtn = await screen.findByRole('button', { name: /Blast radius/i })
    fireEvent.click(blastBtn)

    // the affected node appears and is selectable.
    const affected = await screen.findByRole('button', { name: 'database:d' })
    fireEvent.click(affected)
    expect(onNodeSelect).toHaveBeenCalledWith('database:d')

    // highlight-on-graph focuses the traced set on the canvas.
    const highlight = screen.getByRole('button', { name: /highlight on graph/i })
    fireEvent.click(highlight)
    expect(onFocusNodes).toHaveBeenCalledWith(['database:d'])
  })

  it('offers both node-scoped actions without navigating to a page', () => {
    render(
      <Inspector
        project="default"
        selectedNodeId="file:a:x.ts"
        graphData={graphData}
        onNodeSelect={vi.fn()}
      />,
    )
    return waitFor(() => {
      expect(screen.getByRole('button', { name: /Blast radius/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Dependencies/i })).toBeInTheDocument()
    })
  })
})
