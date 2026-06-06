import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { GraphNode, GraphEdge } from '@neat.is/types'
import type { GraphData } from '../app/components/AppShell'
import { Inspector } from '../app/components/Inspector'

// file-first sample: service:a CONTAINS file:a/x; file:a/x CALLS database:d
const nodes: GraphNode[] = [
  { id: 'service:a', type: 'ServiceNode', name: 'a', language: 'ts' } as GraphNode,
  { id: 'file:a:x.ts', type: 'FileNode', service: 'a', path: 'src/x.ts', language: 'ts' } as GraphNode,
  { id: 'database:d', type: 'DatabaseNode', name: 'orders-db', engine: 'pg', engineVersion: '15', compatibleDrivers: [] } as GraphNode,
]
const edges: GraphEdge[] = [
  { id: 'c1', source: 'service:a', target: 'file:a:x.ts', type: 'CONTAINS', provenance: 'EXTRACTED' } as GraphEdge,
  { id: 'call1', source: 'file:a:x.ts', target: 'database:d', type: 'CONNECTS_TO', provenance: 'OBSERVED', confidence: 0.91, evidence: { file: 'src/x.ts', line: 128 } } as GraphEdge,
]
const graphData: GraphData = { nodes, edges }

function stubNodeFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const m = url.match(/\/api\/graph\/node\/([^?]+)/)
      if (m) {
        const id = decodeURIComponent(m[1])
        const node = nodes.find((n) => n.id === id)
        return new Response(JSON.stringify({ node }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // root-cause + anything else: empty
      return new Response(JSON.stringify({ rootCauseNode: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  )
}

beforeEach(() => stubNodeFetch())
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Inspector file-grained detail (#397, file-awareness §1/§2)', () => {
  it('a FileNode shows its path, owning service, and the calls originating from it with file:line evidence', async () => {
    render(
      <Inspector
        project="default"
        selectedNodeId="file:a:x.ts"
        graphData={graphData}
        onNodeSelect={vi.fn()}
      />,
    )

    // path is the title surface
    await waitFor(() => expect(screen.getByText('x.ts')).toBeInTheDocument())
    // owning service is named and clickable
    expect(screen.getByText('Owning service')).toBeInTheDocument()
    expect(screen.getByText('a')).toBeInTheDocument()
    // calls-from-file block with the target and its file:line evidence
    expect(screen.getByText(/Calls from this file/i)).toBeInTheDocument()
    expect(screen.getByText('orders-db')).toBeInTheDocument()
    expect(screen.getByText('src/x.ts:128')).toBeInTheDocument()
  })

  it('clicking the owning service selects it (no expand — services are not canvas nodes)', async () => {
    const onNodeSelect = vi.fn()
    render(
      <Inspector
        project="default"
        selectedNodeId="file:a:x.ts"
        graphData={graphData}
        onNodeSelect={onNodeSelect}
      />,
    )
    const svcBtn = await screen.findByTitle("Open this service's files")
    fireEvent.click(svcBtn)
    expect(onNodeSelect).toHaveBeenCalledWith('service:a')
  })

  it('a service shows the files it CONTAINS; clicking a file selects it', async () => {
    const onNodeSelect = vi.fn()
    render(
      <Inspector
        project="default"
        selectedNodeId="service:a"
        graphData={graphData}
        onNodeSelect={onNodeSelect}
      />,
    )
    await waitFor(() => expect(screen.getByText(/^Files$/i)).toBeInTheDocument())
    const fileRow = screen.getByText('src/x.ts')
    fireEvent.click(fileRow)
    expect(onNodeSelect).toHaveBeenCalledWith('file:a:x.ts')
  })
})
