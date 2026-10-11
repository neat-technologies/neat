import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import { computeDivergences } from '../src/divergences.js'
import { EdgeType, NodeType, Provenance, frontierId, type GraphEdge, type GraphNode } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'

// A FrontierNode is an unresolved span peer, a staged proposal rather than an
// extracted peer. Static extraction never declares one, so an OBSERVED edge onto
// it has no EXTRACTED twin to miss (divergence-query.md §5d, #981).
describe('FrontierNode missing-extracted exclusion (#981)', () => {
  it('does not flag an OBSERVED-only CALLS onto a FrontierNode as missing-extracted', () => {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:service-a', {
      id: 'service:service-a',
      type: NodeType.ServiceNode,
      name: 'service-a',
      language: 'javascript',
    })
    const peer = frontierId('api.unknown-vendor.example')
    g.addNode(peer, { id: peer, type: NodeType.FrontierNode, name: 'api.unknown-vendor.example', host: 'api.unknown-vendor.example' })
    const edgeId = `${EdgeType.CALLS}:OBSERVED:service:service-a->${peer}`
    g.addEdgeWithKey(edgeId, 'service:service-a', peer, {
      id: edgeId,
      source: 'service:service-a',
      target: peer,
      type: EdgeType.CALLS,
      provenance: Provenance.OBSERVED,
      lastObserved: new Date().toISOString(),
    })

    const { divergences } = computeDivergences(g)
    expect(divergences.filter((d) => d.type === 'missing-extracted' && d.target === peer)).toHaveLength(0)
  })
})
