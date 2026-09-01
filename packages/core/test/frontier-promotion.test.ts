import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode } from '@neat.is/types'
import { EdgeType, NodeType, Provenance, frontierEdgeId, observedEdgeId } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { promoteFrontierEdges } from '../src/ingest.js'

// ADR-226 — a FRONTIER surface graduates to OBSERVED by PROMOTION: when its real
// twin (an OBSERVED edge over the same hop) arrives, NEAT can finally see the hop
// it had only reached toward, so the placeholder is dropped and the settled
// OBSERVED edge stands. The edge-level twin of promoteFrontierNodes (ADR-044).

function newGraph(): NeatGraph {
  return new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
}
function svc(g: NeatGraph, name: string): void {
  g.addNode(`service:${name}`, {
    id: `service:${name}`,
    type: NodeType.ServiceNode,
    name,
    language: 'javascript',
  } as GraphNode)
}
function frontier(g: NeatGraph, from: string, to: string): string {
  const key = frontierEdgeId(from, to, EdgeType.CALLS)
  g.addEdgeWithKey(key, from, to, {
    id: key,
    source: from,
    target: to,
    type: EdgeType.CALLS,
    provenance: Provenance.FRONTIER,
  } as GraphEdge)
  return key
}
function observed(g: NeatGraph, from: string, to: string): string {
  const key = observedEdgeId(from, to, EdgeType.CALLS)
  g.addEdgeWithKey(key, from, to, {
    id: key,
    source: from,
    target: to,
    type: EdgeType.CALLS,
    provenance: Provenance.OBSERVED,
    callCount: 5,
    signal: { spanCount: 5, errorCount: 0 },
    lastObserved: '2026-09-01T12:00:00.000Z',
  } as GraphEdge)
  return key
}

describe('promoteFrontierEdges — graduation on twin arrival (ADR-226)', () => {
  it('a FRONTIER surface whose OBSERVED twin has arrived graduates (dropped; OBSERVED stands)', () => {
    const g = newGraph()
    svc(g, 'frontend')
    svc(g, 'recommendation')
    const fKey = frontier(g, 'service:frontend', 'service:recommendation')
    const oKey = observed(g, 'service:frontend', 'service:recommendation')

    const n = promoteFrontierEdges(g)
    expect(n).toBe(1)
    expect(g.hasEdge(fKey)).toBe(false) // the placeholder graduated
    expect(g.hasEdge(oKey)).toBe(true) // the settled OBSERVED edge stands
  })

  it('a FRONTIER surface with no twin yet stays staged (still hanging)', () => {
    const g = newGraph()
    svc(g, 'frontend')
    svc(g, 'recommendation')
    const fKey = frontier(g, 'service:frontend', 'service:recommendation')

    const n = promoteFrontierEdges(g)
    expect(n).toBe(0)
    expect(g.hasEdge(fKey)).toBe(true)
  })

  it('graduates only the surfaces whose twin exists', () => {
    const g = newGraph()
    svc(g, 'a')
    svc(g, 'recovered')
    svc(g, 'still-hung')
    const graduated = frontier(g, 'service:a', 'service:recovered')
    const staged = frontier(g, 'service:a', 'service:still-hung')
    observed(g, 'service:a', 'service:recovered')

    const n = promoteFrontierEdges(g)
    expect(n).toBe(1)
    expect(g.hasEdge(graduated)).toBe(false)
    expect(g.hasEdge(staged)).toBe(true)
  })

  it('is idempotent — a second sweep with nothing new promotes nothing', () => {
    const g = newGraph()
    svc(g, 'a')
    svc(g, 'b')
    frontier(g, 'service:a', 'service:b')
    observed(g, 'service:a', 'service:b')
    expect(promoteFrontierEdges(g)).toBe(1)
    expect(promoteFrontierEdges(g)).toBe(0)
  })
})
