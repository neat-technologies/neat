import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { getObservedDependencies } from '../src/traverse.js'

// Issue #578. The call-site processor lands OBSERVED CALLS on the FileNode that
// made the call, not on the owning ServiceNode — so a service-level query has to
// reach one hop through CONTAINS to surface the real runtime dependency, and it
// has to tell "no outbound deps" apart from "never observed."

function node(id: string, attrs: Omit<GraphNode, 'id'>): GraphNode {
  return { ...attrs, id } as GraphNode
}

function newGraph(): NeatGraph {
  return new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
}

function addNode(g: NeatGraph, n: GraphNode): void {
  g.addNode(n.id, n)
}

function addEdge(g: NeatGraph, e: GraphEdge): void {
  g.addEdgeWithKey(e.id, e.source, e.target, e)
}

// A file-first harvest graph: harvest-api owns a file that calls harvest-ledger
// at runtime; harvest-ledger is a pure receiver.
function harvestGraph(): NeatGraph {
  const g = newGraph()
  addNode(g, node('service:harvest-api', { type: NodeType.ServiceNode, name: 'harvest-api', language: 'javascript' }))
  addNode(g, node('service:harvest-ledger', { type: NodeType.ServiceNode, name: 'harvest-ledger', language: 'javascript' }))
  addNode(g, node('file:harvest-api:src/pay.ts', { type: NodeType.FileNode, service: 'harvest-api', path: 'src/pay.ts', language: 'javascript' }))

  // service ──CONTAINS──▶ file, OBSERVED structural ownership.
  addEdge(g, {
    id: 'CONTAINS:OBSERVED:service:harvest-api->file:harvest-api:src/pay.ts',
    source: 'service:harvest-api',
    target: 'file:harvest-api:src/pay.ts',
    type: EdgeType.CONTAINS,
    provenance: Provenance.OBSERVED,
  })
  // The real runtime dependency lives on the file, one hop from the service.
  addEdge(g, {
    id: 'CALLS:OBSERVED:file:harvest-api:src/pay.ts->service:harvest-ledger',
    source: 'file:harvest-api:src/pay.ts',
    target: 'service:harvest-ledger',
    type: EdgeType.CALLS,
    provenance: Provenance.OBSERVED,
    signal: { spanCount: 44, errorCount: 0 },
  })
  return g
}

describe('getObservedDependencies', () => {
  it('surfaces a service dependency that lives on an owned file (issue #578 H)', () => {
    const g = harvestGraph()
    const res = getObservedDependencies(g, 'service:harvest-api')
    // The CONTAINS edge is not a runtime dependency; the file's CALLS is.
    expect(res.dependencies).toHaveLength(1)
    const dep = res.dependencies[0]!
    expect(dep.target).toBe('service:harvest-ledger')
    expect(dep.type).toBe(EdgeType.CALLS)
    expect(dep.source).toBe('file:harvest-api:src/pay.ts')
    expect(res.observed).toBe(true)
  })

  it('reads a pure receiver as observed, not OTel-down (issue #578 I)', () => {
    const g = harvestGraph()
    const res = getObservedDependencies(g, 'service:harvest-ledger')
    // It calls nothing downstream, but it is hit at runtime.
    expect(res.dependencies).toHaveLength(0)
    expect(res.observed).toBe(true)
    expect(res.inboundObservedCount).toBe(1)
    expect(res.hasExtractedOutbound).toBe(false)
    // Node-level inbound block (ADR-190): volume sums the inbound edges' counts
    // (spanCount 44 here, since the edge carries no callCount), labeled lifetime.
    expect(res.inboundVolume).toBe(44)
    expect(res.window).toBe('lifetime')
  })

  it('surfaces the node-level inbound block with raw recency (ADR-190)', () => {
    const g = harvestGraph()
    // A second, more-recent inbound caller carrying callCount + lastObserved.
    addNode(g, node('service:harvest-web', { type: NodeType.ServiceNode, name: 'harvest-web', language: 'javascript' }))
    addEdge(g, {
      id: 'CALLS:OBSERVED:service:harvest-web->service:harvest-ledger',
      source: 'service:harvest-web',
      target: 'service:harvest-ledger',
      type: EdgeType.CALLS,
      provenance: Provenance.OBSERVED,
      callCount: 10,
      lastObserved: '2026-08-16T18:00:00.000Z',
      signal: { spanCount: 10, errorCount: 0 },
    })
    const res = getObservedDependencies(g, 'service:harvest-ledger')
    // Two inbound edges: pay.ts CALLS (44) + harvest-web (10) = 54.
    expect(res.inboundVolume).toBe(54)
    expect(res.window).toBe('lifetime')
    // Recency is the most-recent inbound observation, raw ISO — consumer formats.
    expect(res.inboundLastObserved).toBe('2026-08-16T18:00:00.000Z')
  })

  it('flags a genuinely unobserved node with static deps as the OTel-down case', () => {
    const g = harvestGraph()
    addNode(g, node('service:lonely', { type: NodeType.ServiceNode, name: 'lonely', language: 'javascript' }))
    addEdge(g, {
      id: 'CALLS:service:lonely->service:harvest-ledger',
      source: 'service:lonely',
      target: 'service:harvest-ledger',
      type: EdgeType.CALLS,
      provenance: Provenance.EXTRACTED,
    })
    const res = getObservedDependencies(g, 'service:lonely')
    expect(res.dependencies).toHaveLength(0)
    expect(res.observed).toBe(false)
    expect(res.hasExtractedOutbound).toBe(true)
  })

  it('returns an empty, unobserved result for a missing node', () => {
    const g = harvestGraph()
    const res = getObservedDependencies(g, 'service:ghost')
    expect(res.dependencies).toHaveLength(0)
    expect(res.observed).toBe(false)
    expect(res.inboundObservedCount).toBe(0)
  })
})
