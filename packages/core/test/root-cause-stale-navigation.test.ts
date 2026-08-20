import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode, ErrorEvent } from '@neat.is/types'
import { EdgeType, NodeType, Provenance } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { getRootCause } from '../src/traverse.js'

// ADR-208 — the ±NEAT RCA benchmark bug: on a stale 8-month snapshot every causal
// edge went STALE and lost its error signal, so the failing-CALLS walk found
// nothing to follow and getRootCause named the queried SYMPTOM ("no edges
// traversed, primary-failure") while the real cause sat downstream through a STALE
// chain the graph still held. These fixtures reproduce that shape and pin the fix:
// walk the stale chain and surface a low-confidence, STALE-provenanced cause
// instead of dead-ending on the symptom.

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
function calls(
  g: NeatGraph,
  from: string,
  to: string,
  opts: { count?: number; err?: number; stale?: boolean } = {},
): void {
  const prov = opts.stale ? Provenance.STALE : Provenance.OBSERVED
  // STALE keeps the OBSERVED id (provenance.md): only the provenance attribute
  // changes on the transition, so the wire id stays at the OBSERVED pattern.
  const id = `${EdgeType.CALLS}:OBSERVED:service:${from}->service:${to}`
  g.addEdgeWithKey(id, `service:${from}`, `service:${to}`, {
    id,
    source: `service:${from}`,
    target: `service:${to}`,
    type: EdgeType.CALLS,
    provenance: prov,
    callCount: opts.count ?? 100,
    signal: { spanCount: opts.count ?? 100, errorCount: opts.err ?? 0 },
    lastObserved: '2025-12-16T18:00:00.000Z',
  } as GraphEdge)
}
function incidentOn(service: string): ErrorEvent {
  return {
    id: `inc-${service}`,
    timestamp: '2026-08-16T18:05:00.000Z',
    service,
    affectedNode: `service:${service}`,
    errorMessage: `HTTP 500 surfaced at ${service}`,
    exceptionType: 'UpstreamError',
  } as ErrorEvent
}

// frontend ──▶ checkout ──▶ cart, every hop STALE with no error signal left (the
// snapshot went quiet). The failure surfaced at frontend and checkout (recorded
// incidents) but no edge carries it, so the failing-CALLS walk dead-ends.
function staleSnapshotGraph(): NeatGraph {
  const g = newGraph()
  for (const s of ['frontend', 'checkout', 'cart']) svc(g, s)
  calls(g, 'frontend', 'checkout', { stale: true })
  calls(g, 'checkout', 'cart', { stale: true })
  return g
}

describe('getRootCause — STALE-only upstream navigation (ADR-208)', () => {
  it('walks the stale chain to a low-confidence cause instead of naming the symptom', () => {
    const g = staleSnapshotGraph()
    const incidents = [incidentOn('frontend'), incidentOn('checkout')]
    const res = getRootCause(g, 'service:frontend', undefined, incidents)!
    expect(res).toBeTruthy()

    // The bug: it used to hand back the queried symptom with no edges walked.
    expect(res.rootCauseNode).not.toBe('service:frontend')
    // The stale topology's deepest reachable callee is the surfaced cause.
    expect(res.rootCauseNode).toBe('service:cart')

    // The chain was actually walked — not "direct, no edges traversed".
    expect(res.traversalPath).toEqual(['service:frontend', 'service:checkout', 'service:cart'])
    expect(res.edgeProvenances).toEqual([Provenance.STALE, Provenance.STALE])
    expect(res.edgeProvenances.length).toBe(res.traversalPath.length - 1)

    // Top candidate is the stale-derived cause: STALE provenance, honestly low
    // confidence (the STALE ceiling is 0.3), never a confident verdict.
    const top = res.candidates![0]
    expect(top.node).toBe('service:cart')
    expect(top.classification).toBe('primary-failure')
    expect(top.provenance).toBe(Provenance.STALE)
    expect(top.confidence).toBeGreaterThan(0)
    expect(top.confidence).toBeLessThanOrEqual(0.3)
    expect(res.confidence).toBe(top.confidence)
    expect(top.reason.toLowerCase()).toContain('stale')

    // The symptom is still surfaced, but demoted and labelled a symptom.
    const symptom = res.candidates!.find((c) => c.node === 'service:frontend')!
    expect(symptom.classification).toBe('symptom-only')

    // The fix points at the stale-derived cause and reads as a stale recovery,
    // never the overload "throttle the load" wording.
    expect(res.fixRecommendation).toContain('cart')
    expect(res.fixRecommendation).not.toMatch(/throttle/i)
    expect(res.fixRecommendation).toMatch(/telemetry|instrumentation|live traces/i)
  })

  it('reaches the same stale cause when the agent queries the middle node', () => {
    // The benchmark queried checkout too and got the same dead-end. From checkout
    // the stale chain still runs down to cart.
    const g = staleSnapshotGraph()
    const incidents = [incidentOn('frontend'), incidentOn('checkout')]
    const res = getRootCause(g, 'service:checkout', undefined, incidents)!
    expect(res.rootCauseNode).toBe('service:cart')
    expect(res.traversalPath).toEqual(['service:checkout', 'service:cart'])
    expect(res.candidates![0].provenance).toBe(Provenance.STALE)
  })

  it('escape hatch (NEAT_RCA_NAVIGATION=0) returns the pre-navigation dead-end verbatim', () => {
    const g = staleSnapshotGraph()
    const incidents = [incidentOn('frontend')]
    const legacy = getRootCause(g, 'service:frontend', undefined, incidents, {
      navigation: false,
    })!
    // The pre-navigation single verdict still dead-ends on the symptom — the fix
    // lives in the navigation layer, so opting out is unchanged.
    expect(legacy.rootCauseNode).toBe('service:frontend')
    expect(legacy.traversalPath).toEqual(['service:frontend'])
    expect(legacy.candidates).toBeUndefined()
  })
})

describe('getRootCause — the stale fallback is a fallback, not a replacement (ADR-208)', () => {
  it('leaves a fresh OBSERVED cross-service verdict OBSERVED-preferred', () => {
    // frontend ──▶ checkout fails live (OBSERVED errors); the fresh failing chain
    // still names checkout and must not be overridden by a stale walk.
    const g = newGraph()
    for (const s of ['frontend', 'checkout', 'cart']) svc(g, s)
    calls(g, 'frontend', 'checkout', { err: 5 }) // OBSERVED, failing
    calls(g, 'checkout', 'cart', { err: 0 }) // OBSERVED, clean
    const res = getRootCause(g, 'service:frontend', undefined, [])!
    expect(res.rootCauseNode).toBe('service:checkout')
    expect(res.candidates![0].classification).toBe('primary-failure')
    expect(res.candidates![0].provenance).toBe(Provenance.OBSERVED)
    // No stale demotion happened.
    expect(res.candidates!.every((c) => c.provenance !== Provenance.STALE)).toBe(true)
  })

  it('preserves the seed when a fresher (OBSERVED) hop is reachable, not walking past it', () => {
    // frontend ──▶ checkout is OBSERVED and healthy; only checkout ──▶ cart is
    // STALE. A fresher upstream edge exists, so the stale fallback must not fire —
    // existing behavior (name the queried node) is preserved.
    const g = newGraph()
    for (const s of ['frontend', 'checkout', 'cart']) svc(g, s)
    calls(g, 'frontend', 'checkout', { err: 0 }) // OBSERVED, healthy
    calls(g, 'checkout', 'cart', { stale: true })
    const res = getRootCause(g, 'service:frontend', undefined, [incidentOn('frontend')])!
    expect(res.rootCauseNode).toBe('service:frontend')
    expect(res.candidates!.length).toBe(1)
    expect(res.candidates![0].classification).toBe('primary-failure')
    expect(res.candidates![0].provenance).not.toBe(Provenance.STALE)
  })

  it('leaves a genuinely isolated node primary-failure — no upstream to fabricate', () => {
    // A service with a recorded incident but no outbound causal edge of any
    // provenance. There is nothing to walk, so it stays the named cause.
    const g = newGraph()
    svc(g, 'lonely')
    const res = getRootCause(g, 'service:lonely', undefined, [incidentOn('lonely')])!
    expect(res.rootCauseNode).toBe('service:lonely')
    expect(res.traversalPath).toEqual(['service:lonely'])
    expect(res.candidates!.length).toBe(1)
    expect(res.candidates![0].classification).toBe('primary-failure')
    expect(res.candidates![0].provenance).not.toBe(Provenance.STALE)
  })
})
