import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode, ErrorEvent } from '@neat.is/types'
import { EdgeType, NodeType, Provenance } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { getRootCause } from '../src/traverse.js'

// #1075 — get_root_cause blamed load-generator on faults where the alerting node
// fails because of its OWN outbound dependency (a datastore CONNECTS_TO auth
// failure, or a self-DNS misconfig). The victim → load-origin move (ADR-189)
// reads only the seed's inbound saturation and never looked downstream, so it
// unconditionally overrode the real cause. These fixtures reproduce both live
// shapes and pin that the guard keeps the load-origin verdict for genuine
// overloads while letting the real outbound dependency win otherwise.

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
function infra(g: NeatGraph, id: string, name: string): void {
  g.addNode(id, {
    id,
    type: NodeType.InfraNode,
    name,
    provider: 'self-hosted',
  } as GraphNode)
}
function edge(
  g: NeatGraph,
  type: EdgeType,
  from: string,
  to: string,
  opts: { count?: number; err?: number; stale?: boolean; p95?: number } = {},
): void {
  const prov = opts.stale ? Provenance.STALE : Provenance.OBSERVED
  const signal: GraphEdge['signal'] = {
    spanCount: opts.count ?? 1,
    errorCount: opts.err ?? 0,
    ...(opts.p95 !== undefined ? { latencyMs: { p50: opts.p95 / 2, p95: opts.p95 } } : {}),
  }
  const key = `${type}:${prov}:${from}->${to}`
  g.addEdgeWithKey(key, from, to, {
    id: key,
    source: from,
    target: to,
    type,
    provenance: prov,
    callCount: opts.count ?? 1,
    signal,
    lastObserved: '2026-08-20T18:00:00.000Z',
  } as GraphEdge)
}

describe('getRootCause — outbound-dependency guard on the victim move (#1075)', () => {
  it('a datastore CONNECTS_TO failure wins over the load origin, even when the caller is inbound-saturated', () => {
    // load-generator ──▶ frontend ──▶ cart, and cart ──CONNECTS_TO──▶ valkey-cart.
    // cart's inbound is saturated with errors, so isVictimSeed reads it as a load
    // victim — but cart actually fails because its datastore connection is failing
    // (the CONNECTS_TO edge carries errors), which is the real root cause.
    const g = newGraph()
    for (const s of ['load-generator', 'frontend', 'cart']) svc(g, s)
    infra(g, 'infra:datastore:valkey-cart', 'valkey-cart')
    edge(g, EdgeType.CALLS, 'service:load-generator', 'service:frontend', { count: 1000, err: 0 })
    edge(g, EdgeType.CALLS, 'service:frontend', 'service:cart', { count: 1000, err: 5, p95: 28000 })
    // The real cause: cart cannot reach its datastore. A failing CONNECTS_TO edge,
    // not a CALLS one — the exact edge type isFailingCallEdge cannot see.
    edge(g, EdgeType.CONNECTS_TO, 'service:cart', 'infra:datastore:valkey-cart', {
      count: 800,
      err: 800,
    })

    const incidents: ErrorEvent[] = [
      {
        id: 'inc-cart',
        timestamp: '2026-08-20T18:05:00.000Z',
        service: 'cart',
        affectedNode: 'service:cart',
        errorType: 'FailedPrecondition',
        errorMessage: "Wasn't able to connect to the cart data store",
      } as ErrorEvent,
    ]

    const res = getRootCause(g, 'service:cart', undefined, incidents)!
    expect(res).toBeTruthy()
    // The bug: this returned service:load-generator with a "throttle the load" fix.
    expect(res.rootCauseNode).not.toBe('service:load-generator')
    // The real cause is cart's own failing datastore dependency; the seed stays.
    expect(res.rootCauseNode).toBe('service:cart')
    // And it never hands back the overload throttle recommendation.
    expect(res.fixRecommendation ?? '').not.toMatch(/throttle|overload/i)
    // load-generator, if it appears at all, is not named the primary cause.
    const loadGen = res.candidates?.find((c) => c.node === 'service:load-generator')
    expect(loadGen?.classification).not.toBe('primary-failure')
  })

  it('a self-DNS failure localized by incident text wins over the load origin (no failing outbound edge)', () => {
    // load-generator ──▶ frontend, frontend saturated with inbound errors. frontend
    // has no failing outbound EDGE — its own DNS policy means calls never resolve,
    // so the failure lives in the incident text ("Name resolution failed"), not on
    // an edge. The guard's incident-content fallback must still catch it.
    const g = newGraph()
    for (const s of ['load-generator', 'frontend']) svc(g, s)
    edge(g, EdgeType.CALLS, 'service:load-generator', 'service:frontend', {
      count: 1000,
      err: 6,
      p95: 15000,
    })

    const incidents: ErrorEvent[] = [
      {
        id: 'inc-frontend',
        timestamp: '2026-08-20T18:05:00.000Z',
        service: 'frontend',
        affectedNode: 'service:frontend',
        errorType: 'UNAVAILABLE',
        errorMessage: 'UNAVAILABLE: Name resolution failed for target',
      } as ErrorEvent,
    ]

    const res = getRootCause(g, 'service:frontend', undefined, incidents)!
    expect(res).toBeTruthy()
    expect(res.rootCauseNode).not.toBe('service:load-generator')
    expect(res.rootCauseNode).toBe('service:frontend')
    expect(res.fixRecommendation ?? '').not.toMatch(/throttle|overload/i)
  })

  it('still promotes the load origin for a genuine overload — a starved victim with no downstream fault', () => {
    // The regression guard: load-generator ──▶ frontend ──▶ cart, cart starved to
    // STALE/saturated by the load with NO failing outbound of its own. This is the
    // real overload the ADR-189 move exists to catch, and it must keep working.
    const g = newGraph()
    for (const s of ['load-generator', 'frontend', 'cart']) svc(g, s)
    edge(g, EdgeType.CALLS, 'service:load-generator', 'service:frontend', { count: 1000, err: 0 })
    edge(g, EdgeType.CALLS, 'service:frontend', 'service:cart', {
      count: 1000,
      err: 8,
      stale: true,
      p95: 4000,
    })

    const res = getRootCause(g, 'service:frontend')!
    expect(res.rootCauseNode).toBe('service:load-generator')
    const cart = res.candidates!.find((c) => c.node === 'service:cart')!
    expect(cart.classification).toBe('symptom-only')
  })
})
