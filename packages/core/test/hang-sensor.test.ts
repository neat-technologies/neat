import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode, ErrorEvent } from '@neat.is/types'
import { EdgeType, NodeType, Provenance, frontierEdgeId } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { stageHangSurfaces } from '../src/hang-sensor.js'
import { resolveHangHop } from '../src/traverse.js'

// ADR-226 — the hang sensor stages a FRONTIER surface on the unobservable hop of a
// boundary-timeout hang: the edge NEAT reached toward but can't see because its far
// end hung. Route-driven, crossing one observed hop when an infra proxy declares
// nothing (the real Envoy shape). The only hang-specific piece of the feature.

function newGraph(): NeatGraph {
  return new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
}
function svc(g: NeatGraph, name: string): void {
  g.addNode(`service:${name}`, { id: `service:${name}`, type: NodeType.ServiceNode, name, language: 'javascript' } as GraphNode)
}
function observedCall(g: NeatGraph, from: string, to: string, err = 0, count = 20): void {
  const key = `CALLS:OBSERVED:${from}->${to}`
  g.addEdgeWithKey(key, from, to, {
    id: key, source: from, target: to, type: EdgeType.CALLS, provenance: Provenance.OBSERVED,
    callCount: count, signal: { spanCount: count, errorCount: err }, lastObserved: '2026-09-01T12:00:00.000Z',
  } as GraphEdge)
}
function declaredCall(g: NeatGraph, from: string, to: string, pathTemplate?: string): void {
  const key = `CALLS:EXTRACTED:${from}->${to}`
  g.addEdgeWithKey(key, from, to, {
    id: key, source: from, target: to, type: EdgeType.CALLS, provenance: Provenance.EXTRACTED,
    ...(pathTemplate ? { evidence: { file: 'app.ts', pathTemplate } } : {}),
  } as GraphEdge)
}
function timeout504(over: Partial<ErrorEvent>): ErrorEvent {
  return {
    id: 'e1', timestamp: '2026-09-01T12:00:00.000Z', service: 'x', traceId: 't', spanId: 's',
    errorMessage: 'HTTP 504 gateway timeout', httpStatusCode: 504, ...over,
  } as ErrorEvent
}

describe('stageHangSurfaces — the hang sensor (ADR-226)', () => {
  it('stages a FRONTIER surface on the boundary’s own declared hang hop', () => {
    const g = newGraph()
    svc(g, 'proxy'); svc(g, 'frontend'); svc(g, 'recommendation')
    observedCall(g, 'service:proxy', 'service:frontend', 0, 24) // healthy observed → hasOutboundDeps, no erroring downstream
    declaredCall(g, 'service:proxy', 'service:recommendation') // the declared hang hop
    const incidents = [timeout504({ service: 'proxy', affectedNode: 'service:proxy' })]

    const n = stageHangSurfaces(g, incidents)
    expect(n).toBe(1)
    const key = frontierEdgeId('service:proxy', 'service:recommendation', EdgeType.CALLS)
    expect(g.hasEdge(key)).toBe(true)
    expect((g.getEdgeAttributes(key) as GraphEdge).provenance).toBe(Provenance.FRONTIER)
  })

  it('crosses one observed hop to stage the surface behind an infra proxy (the Envoy shape)', () => {
    const g = newGraph()
    svc(g, 'frontend-proxy'); svc(g, 'frontend'); svc(g, 'recommendation')
    observedCall(g, 'service:frontend-proxy', 'service:frontend', 0, 30) // proxy declares nothing; reached frontend
    declaredCall(g, 'service:frontend', 'service:recommendation', '/api/recommendations')
    const incidents = [timeout504({
      service: 'frontend-proxy', affectedNode: 'service:frontend-proxy',
      attributes: { 'http.route': '/api/recommendations' },
    })]

    const n = stageHangSurfaces(g, incidents)
    expect(n).toBe(1)
    // The surface is on the unobservable hop frontend → recommendation, not the boundary.
    expect(g.hasEdge(frontierEdgeId('service:frontend', 'service:recommendation', EdgeType.CALLS))).toBe(true)
  })

  it('stages nothing when the boundary is not a hang (a fast-fail exports an erroring edge)', () => {
    const g = newGraph()
    svc(g, 'gw'); svc(g, 'ad')
    observedCall(g, 'service:gw', 'service:ad', 40, 40) // erroring downstream → observedErroringDownstream, not a hang
    declaredCall(g, 'service:gw', 'service:ad')
    const incidents = [timeout504({ service: 'gw', affectedNode: 'service:gw' })]
    expect(stageHangSurfaces(g, incidents)).toBe(0)
  })

  it('stages nothing when the hop is already OBSERVED (the service is up, not hung)', () => {
    const g = newGraph()
    svc(g, 'proxy'); svc(g, 'frontend'); svc(g, 'recommendation')
    observedCall(g, 'service:proxy', 'service:frontend', 0, 24)
    declaredCall(g, 'service:proxy', 'service:recommendation')
    observedCall(g, 'service:proxy', 'service:recommendation', 0, 5) // the hop is observable
    const incidents = [timeout504({ service: 'proxy', affectedNode: 'service:proxy' })]
    expect(stageHangSurfaces(g, incidents)).toBe(0)
  })

  it('is idempotent — a second sweep does not re-stage an existing surface', () => {
    const g = newGraph()
    svc(g, 'proxy'); svc(g, 'frontend'); svc(g, 'recommendation')
    observedCall(g, 'service:proxy', 'service:frontend', 0, 24)
    declaredCall(g, 'service:proxy', 'service:recommendation')
    const incidents = [timeout504({ service: 'proxy', affectedNode: 'service:proxy' })]
    expect(stageHangSurfaces(g, incidents)).toBe(1)
    expect(stageHangSurfaces(g, incidents)).toBe(0)
  })
})

describe('resolveHangHop — the unobservable hop (ADR-226)', () => {
  it('returns null (honest-coarse) when the observed hop is ambiguous', () => {
    const g = newGraph()
    svc(g, 'frontend-proxy'); svc(g, 'a'); svc(g, 'b'); svc(g, 'reca'); svc(g, 'recb')
    observedCall(g, 'service:frontend-proxy', 'service:a', 0, 10)
    observedCall(g, 'service:frontend-proxy', 'service:b', 0, 10)
    declaredCall(g, 'service:a', 'service:reca')
    declaredCall(g, 'service:b', 'service:recb')
    const incidents = [timeout504({ service: 'frontend-proxy', affectedNode: 'service:frontend-proxy' })]
    expect(resolveHangHop(g, 'service:frontend-proxy', incidents)).toBeNull()
  })
})
