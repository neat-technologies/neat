import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  extractedEdgeId,
  observedEdgeId,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import { computeDivergences } from '../src/divergences.js'
import type { NeatGraph } from '../src/graph.js'

// STALE-at-onset divergence (ADR-271): a declared dependency edge whose observed
// twin was once live and has gone quiet. A STALE twin keeps its OBSERVED-format id,
// so it lands in the bucket's `observed` slot — the never-observed `missing-observed`
// branch does not fire for it, and `observed-failing` ignores it (not live OBSERVED).
// So "declared, was running, stopped" was falling through every divergence. This
// variant reports it as a `missing-observed` carrying the `stale` twin, which keeps
// the `lastObserved` time so a reader tells "went quiet" from "never ran".

const SRC = 'service:frontend'
const DST = 'service:productcatalog'
const LAST_OBSERVED = '2026-01-01T11:50:00.000Z'

function build(twin: 'none' | 'live' | 'stale'): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  for (const name of ['frontend', 'productcatalog']) {
    g.addNode(`service:${name}`, {
      id: `service:${name}`,
      type: NodeType.ServiceNode,
      name,
      language: 'go',
    } as GraphNode)
  }
  const extId = extractedEdgeId(SRC, DST, EdgeType.CALLS)
  g.addEdgeWithKey(extId, SRC, DST, {
    id: extId,
    source: SRC,
    target: DST,
    type: EdgeType.CALLS,
    provenance: Provenance.EXTRACTED,
    confidence: 0.9,
  } as GraphEdge)
  if (twin !== 'none') {
    const obsId = observedEdgeId(SRC, DST, EdgeType.CALLS)
    g.addEdgeWithKey(obsId, SRC, DST, {
      id: obsId,
      source: SRC,
      target: DST,
      type: EdgeType.CALLS,
      provenance: twin === 'stale' ? Provenance.STALE : Provenance.OBSERVED,
      lastObserved: LAST_OBSERVED,
      callCount: 20,
      signal: { spanCount: 20, errorCount: 0 },
    } as GraphEdge)
  }
  return g
}

function missingObserved(g: NeatGraph) {
  return computeDivergences(g).divergences.filter(
    (d) => d.type === 'missing-observed' && d.source === SRC && d.target === DST,
  )
}

describe('STALE-at-onset divergence (ADR-271)', () => {
  it('reports a declared edge whose observed twin went quiet, carrying the stale twin', () => {
    const mo = missingObserved(build('stale'))
    expect(mo).toHaveLength(1)
    const d = mo[0] as { stale?: GraphEdge; extracted?: GraphEdge; reason: string }
    expect(d.stale).toBeDefined()
    expect(d.stale?.lastObserved).toBe(LAST_OBSERVED)
    expect(d.extracted).toBeDefined()
    expect(d.reason).toMatch(/gone quiet/i)
    expect(d.reason).toContain(LAST_OBSERVED)
  })

  it('does not fire on a declared edge with a live observed twin (fully fused)', () => {
    expect(missingObserved(build('live'))).toHaveLength(0)
  })

  it('still reports never-observed as a plain missing-observed, with no stale twin', () => {
    const mo = missingObserved(build('none'))
    expect(mo).toHaveLength(1)
    const d = mo[0] as { stale?: GraphEdge; reason: string }
    expect(d.stale).toBeUndefined()
    expect(d.reason).toMatch(/no production traffic/i)
  })

  it('the went-quiet finding keeps the declared edge’s confidence (not dampened)', () => {
    const d = missingObserved(build('stale'))[0]
    expect(d.confidence).toBeGreaterThan(0.1)
  })
})
