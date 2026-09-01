import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode, ErrorEvent, NodeContext } from '@neat.is/types'
import { EdgeType, NodeType, Provenance, frontierEdgeId } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { getRootCause, nodeContext, classifyNode } from '../src/traverse.js'

// #1114 — on a hang the culprit's span never exports, so NEAT sees only the
// boundary 504 and (before this) named that gateway primary-failure at 0.6. A
// boundary timeout is the observable shadow of an unobservable downstream: a
// symptom. The load-bearing guard is `observedErroringDownstream` — a fast-fail
// (scaled-to-0 UNAVAILABLE, ECONNREFUSED, scenario 32) exports an erroring edge,
// so it must KEEP its primary-failure walk to the real culprit.

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
function observedCall(g: NeatGraph, from: string, to: string, err = 0, count = 10): void {
  const key = `CALLS:OBSERVED:${from}->${to}`
  g.addEdgeWithKey(key, from, to, {
    id: key,
    source: from,
    target: to,
    type: EdgeType.CALLS,
    provenance: Provenance.OBSERVED,
    callCount: count,
    signal: { spanCount: count, errorCount: err },
    lastObserved: '2026-08-20T18:00:00.000Z',
  } as GraphEdge)
}
function declaredCall(g: NeatGraph, from: string, to: string, pathTemplate?: string): void {
  const key = `CALLS:EXTRACTED:${from}->${to}`
  g.addEdgeWithKey(key, from, to, {
    id: key,
    source: from,
    target: to,
    type: EdgeType.CALLS,
    provenance: Provenance.EXTRACTED,
    ...(pathTemplate ? { evidence: { pathTemplate } } : {}),
  } as GraphEdge)
}
// Stage a FRONTIER surface the way the hang sensor (ADR-226) would, so the reader
// has a surface to read back as its proposal.
function stageFrontier(g: NeatGraph, from: string, to: string): void {
  const key = frontierEdgeId(from, to, EdgeType.CALLS)
  g.addEdgeWithKey(key, from, to, {
    id: key,
    source: from,
    target: to,
    type: EdgeType.CALLS,
    provenance: Provenance.FRONTIER,
  } as GraphEdge)
}
function incident(over: Partial<ErrorEvent>): ErrorEvent {
  return {
    id: 'e1',
    timestamp: '2026-08-20T18:00:00.000Z',
    service: 'x',
    traceId: 't',
    spanId: 's',
    errorMessage: 'err',
    affectedNode: 'service:x',
    ...over,
  } as ErrorEvent
}
const baseCtx: NodeContext = {
  errorsEmittedHere: 1,
  errorsFromCallers: 0,
  callCount: 0,
  outboundVolume: 5,
  stale: false,
}

describe('classifyNode — boundary timeout (#1114)', () => {
  it('boundary timeout with no observed erroring downstream → symptom-only', () => {
    expect(
      classifyNode({ ...baseCtx, boundaryTimeout: true, hasOutboundDeps: true, observedErroringDownstream: false }),
    ).toBe('symptom-only')
  })
  it('observed erroring downstream (fast-fail, scenario 32 guard) → stays primary-failure', () => {
    expect(
      classifyNode({ ...baseCtx, boundaryTimeout: true, hasOutboundDeps: true, observedErroringDownstream: true }),
    ).toBe('primary-failure')
  })
  it('own error not timeout-class (401 shape) → stays primary-failure', () => {
    expect(
      classifyNode({ ...baseCtx, boundaryTimeout: false, hasOutboundDeps: true, observedErroringDownstream: false }),
    ).toBe('primary-failure')
  })
  it('no downstream to blame (a leaf timing out on its own) → stays primary-failure', () => {
    expect(
      classifyNode({ ...baseCtx, boundaryTimeout: true, hasOutboundDeps: false, observedErroringDownstream: false }),
    ).toBe('primary-failure')
  })
  it('a caller is erroring into it → stays primary-failure', () => {
    expect(
      classifyNode({ ...baseCtx, errorsFromCallers: 3, boundaryTimeout: true, hasOutboundDeps: true, observedErroringDownstream: false }),
    ).toBe('primary-failure')
  })
})

describe('nodeContext — boundary-timeout signals (#1114)', () => {
  it('reads a 504 incident as boundaryTimeout with a healthy observed outbound', () => {
    const g = newGraph()
    svc(g, 'proxy')
    svc(g, 'frontend')
    observedCall(g, 'service:proxy', 'service:frontend', 0, 24)
    const ctx = nodeContext(g, 'service:proxy', [
      incident({ service: 'proxy', affectedNode: 'service:proxy', httpStatusCode: 504, errorMessage: 'HTTP 504 gateway timeout' }),
    ])
    expect(ctx.boundaryTimeout).toBe(true)
    expect(ctx.hasOutboundDeps).toBe(true)
    expect(ctx.observedErroringDownstream).toBe(false)
    expect(classifyNode(ctx)).toBe('symptom-only')
  })
  it('observedErroringDownstream is true on an erroring outbound (the fast-fail guard holds)', () => {
    const g = newGraph()
    svc(g, 'gw')
    svc(g, 'ad')
    observedCall(g, 'service:gw', 'service:ad', 50, 50)
    const ctx = nodeContext(g, 'service:gw', [
      incident({ service: 'gw', affectedNode: 'service:gw', httpStatusCode: 504 }),
    ])
    expect(ctx.observedErroringDownstream).toBe(true)
    expect(classifyNode(ctx)).toBe('primary-failure')
  })
  it('a non-timeout 5xx (503 unavailable) does not read as a boundary timeout', () => {
    const g = newGraph()
    svc(g, 'svc-a')
    svc(g, 'b')
    observedCall(g, 'service:svc-a', 'service:b', 0, 5)
    const ctx = nodeContext(g, 'service:svc-a', [
      incident({ service: 'svc-a', affectedNode: 'service:svc-a', httpStatusCode: 503, errorMessage: 'service unavailable' }),
    ])
    expect(ctx.boundaryTimeout).toBe(false)
  })
})

describe('getRootCause — boundary-timeout verdict (#1114 / ADR-226)', () => {
  it('an infra boundary timing out is symptom-only, honest-coarse when no FRONTIER surface is staged', () => {
    const g = newGraph()
    svc(g, 'frontend-proxy')
    svc(g, 'frontend')
    svc(g, 'recommendation')
    observedCall(g, 'service:frontend-proxy', 'service:frontend', 0, 24) // healthy observed
    declaredCall(g, 'service:frontend', 'service:recommendation') // a declared path exists, but no surface is staged
    const res = getRootCause(g, 'service:frontend-proxy', undefined, [
      incident({ service: 'frontend-proxy', affectedNode: 'service:frontend-proxy', httpStatusCode: 504, errorMessage: 'HTTP 504 gateway timeout' }),
    ])!
    // The settled verdict is the boundary as symptom; no surface → no proposal.
    expect(res.rootCauseNode).toBe('service:frontend-proxy')
    expect(res.candidates![0].node).toBe('service:frontend-proxy')
    expect(res.candidates![0].classification).toBe('symptom-only')
    expect(res.candidates!.some((c) => c.provenance === Provenance.FRONTIER)).toBe(false)
  })

  it('reads the staged FRONTIER surface as the proposal, ranked below the settled symptom', () => {
    const g = newGraph()
    svc(g, 'proxy')
    svc(g, 'frontend')
    svc(g, 'recommendation')
    observedCall(g, 'service:proxy', 'service:frontend', 0, 10) // healthy observed (has outbound + no erroring downstream)
    declaredCall(g, 'service:proxy', 'service:recommendation') // the declared hang hop
    stageFrontier(g, 'service:proxy', 'service:recommendation') // the sensor has staged the surface
    const res = getRootCause(g, 'service:proxy', undefined, [
      incident({ service: 'proxy', affectedNode: 'service:proxy', httpStatusCode: 504, errorMessage: 'HTTP 504 gateway timeout' }),
    ])!
    // The settled verdict leads: the boundary is the symptom and the rootCauseNode.
    expect(res.rootCauseNode).toBe('service:proxy')
    expect(res.candidates![0].node).toBe('service:proxy')
    expect(res.candidates![0].classification).toBe('symptom-only')
    // The staged surface is read back as a FRONTIER proposal, ranked below.
    const frontier = res.candidates!.find((c) => c.provenance === Provenance.FRONTIER)!
    expect(frontier).toBeDefined()
    expect(frontier.node).toBe('service:recommendation')
    expect(frontier.confidence).toBeLessThanOrEqual(0.2)
    // Never INFERRED — that provenance means only a settled stitch.
    expect(res.candidates!.some((c) => c.provenance === Provenance.INFERRED)).toBe(false)
  })
})
