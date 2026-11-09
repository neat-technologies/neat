import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import { EdgeType, NodeType, Provenance, type GraphEdge, type GraphNode } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { computeDivergences } from '../src/divergences.js'

// #1528 — the result carries how many OBSERVED edges it had to compare against.

function graph(observed: number): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  for (const s of ['a', 'b', 'c']) g.addNode(`service:${s}`, { id: `service:${s}`, type: NodeType.ServiceNode, name: s, language: 'ts' } as GraphNode)
  const add = (src: string, tgt: string, provenance: string) => {
    const id = `CALLS:${provenance}:${src}->${tgt}`
    g.addEdgeWithKey(id, src, tgt, { id, source: src, target: tgt, type: EdgeType.CALLS, provenance, confidence: 0.85 } as GraphEdge)
  }
  add('service:a', 'service:b', Provenance.EXTRACTED)
  if (observed > 0) add('service:a', 'service:c', Provenance.OBSERVED)
  return g
}

describe('DivergenceResult.observedEdges (#1528)', () => {
  it('is 0 when NEAT has seen no telemetry, and counts OBSERVED edges otherwise', () => {
    const none = computeDivergences(graph(0))
    expect(none.observedEdges).toBe(0)
    expect(none.divergences.some((d) => d.type === 'missing-observed')).toBe(true)
    expect(computeDivergences(graph(1)).observedEdges).toBe(1)
  })
})
