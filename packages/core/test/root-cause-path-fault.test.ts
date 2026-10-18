import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import type { ErrorEvent, GraphEdge, GraphNode } from '@neat.is/types'
import { EdgeType, NodeType, Provenance, grpcMethodId } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { classifyNode, getRootCause, nodeContext } from '../src/traverse.js'

// #1481 part 2 / ADR-264 — SREGym internal_traffic_policy_local on astronomy-shop:
// a Service that routes callers nowhere, so their calls time out before reaching a
// handler. get_root_cause(service:frontend) answered "load-generator is the root
// cause: it overloads the failing subgraph … errors reach product-catalog from its
// callers (81), none originate there" and recommended throttling the load
// generator. A callee traffic can't reach emits no errors either. What separates it
// from a drowning node is its own served latency: what does reach it is served fast.

const NOW = Date.parse('2026-10-17T19:10:00.000Z')
const SEEN = '2026-10-17T19:09:50.000Z'

function svc(g: NeatGraph, name: string): void {
  g.addNode(`service:${name}`, { id: `service:${name}`, type: NodeType.ServiceNode, name, language: 'go' } as GraphNode)
}
function calls(g: NeatGraph, from: string, to: string, count: number, errors: number, p95: number): void {
  const id = `CALLS:OBSERVED:${from}->${to}`
  g.addEdgeWithKey(id, from, to, {
    id,
    source: from,
    target: to,
    type: EdgeType.CALLS,
    provenance: Provenance.OBSERVED,
    callCount: count,
    lastObserved: SEEN,
    signal: { spanCount: count, errorCount: errors, latencyMs: { p50: Math.min(p95, 8), p95 } },
  } as GraphEdge)
}
function serves(g: NeatGraph, owner: string, rpcService: string, method: string, count: number, p95: number): void {
  const mid = grpcMethodId(rpcService, method)
  g.addNode(mid, { id: mid, type: NodeType.GrpcMethodNode, name: `${rpcService}/${method}`, rpcService, rpcMethod: method } as unknown as GraphNode)
  const id = `CONTAINS:OBSERVED:${owner}->${mid}`
  g.addEdgeWithKey(id, owner, mid, {
    id,
    source: owner,
    target: mid,
    type: EdgeType.CONTAINS,
    provenance: Provenance.OBSERVED,
    callCount: count,
    lastObserved: SEEN,
    signal: { spanCount: count, errorCount: 0, latencyMs: { p50: Math.min(p95, 2), p95 } },
  } as GraphEdge)
}

// load-generator → frontend-proxy → frontend → product-catalog; frontend's calls to
// product-catalog time out (81 of 300, p95 at the 5 s client deadline).
function bench(productCatalogServedP95: number | undefined): { g: NeatGraph; incidents: ErrorEvent[] } {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  for (const s of ['load-generator', 'frontend-proxy', 'frontend', 'product-catalog']) svc(g, s)
  calls(g, 'service:load-generator', 'service:frontend-proxy', 900, 0, 40)
  calls(g, 'service:frontend-proxy', 'service:frontend', 900, 0, 60)
  calls(g, 'service:frontend', 'service:product-catalog', 300, 81, 5000)
  if (productCatalogServedP95 !== undefined) {
    serves(g, 'service:product-catalog', 'oteldemo.ProductCatalogService', 'GetProduct', 219, productCatalogServedP95)
  }
  const incidents: ErrorEvent[] = Array.from({ length: 5 }, (_, i) => ({
    id: `t${i}:s${i}`,
    timestamp: '2026-10-17T19:09:0' + i + '.000Z',
    service: 'frontend',
    traceId: `t${i}`,
    spanId: `s${i}`,
    errorMessage: '14 UNAVAILABLE: No connection established. Last error: connect ETIMEDOUT',
    affectedNode: 'service:frontend',
  })) as ErrorEvent[]
  return { g, incidents }
}

describe('a callee that callers time out on while it serves fast is not a load victim (ADR-264)', () => {
  it('the bench shape: names product-catalog as unreachable in part, never the traffic source', () => {
    const { g, incidents } = bench(12)
    const ctx = nodeContext(g, 'service:product-catalog', incidents, NOW)
    expect(ctx).toMatchObject({ errorsFromCallers: 81, errorsEmittedHere: 0, latencyP95Ms: 5000, servedLatencyP95Ms: 12 })
    expect(classifyNode(ctx)).toBe('unreachable')

    const res = getRootCause(g, 'service:frontend', undefined, incidents, { now: NOW })!
    expect(res.rootCauseNode).toBe('service:product-catalog')
    expect(res.candidates?.[0]).toMatchObject({ node: 'service:product-catalog', classification: 'unreachable', provenance: Provenance.OBSERVED })
    expect(res.rootCauseReason).toContain('they wait 5000ms at p95, while what reaches product-catalog is served in 12ms')
    expect(res.fixRecommendation).toContain('Check how traffic reaches product-catalog')
    expect(JSON.stringify(res)).not.toContain('load-generator')
    expect(res.fixRecommendation).not.toMatch(/throttle/i)
  })

  it('a node slow in its own handler is still the load victim (control)', () => {
    const { g, incidents } = bench(4800)
    const res = getRootCause(g, 'service:frontend', undefined, incidents, { now: NOW })!
    expect(res.rootCauseNode).toBe('service:load-generator')
    expect(res.candidates?.find((c) => c.node === 'service:product-catalog')?.classification).toBe('symptom-only')
  })

  it('with no served spans to compare, the inbound view decides as before (control)', () => {
    const { g, incidents } = bench(undefined)
    const res = getRootCause(g, 'service:frontend', undefined, incidents, { now: NOW })!
    expect(res.rootCauseNode).toBe('service:load-generator')
  })
})
