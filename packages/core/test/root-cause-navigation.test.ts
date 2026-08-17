import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode, ErrorEvent } from '@neat.is/types'
import { EdgeType, NodeType, Provenance } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import {
  getRootCause,
  expandNode,
  relate,
  nodeContext,
  classifyNode,
} from '../src/traverse.js'

// ADR-189 — the overload bug the release exists to fix: a downstream walk names
// `shipping`, a service starved to STALE by an overload, when the real cause is
// the load origin upstream and unreachable by a downstream-only walk. These
// fixtures reproduce that shape synthetically and pin the navigation.

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
  opts: { count?: number; err?: number; stale?: boolean; p95?: number } = {},
): void {
  const prov = opts.stale ? Provenance.STALE : Provenance.OBSERVED
  const signal: GraphEdge['signal'] = {
    spanCount: opts.count ?? 1,
    errorCount: opts.err ?? 0,
    ...(opts.p95 !== undefined ? { latencyMs: { p50: opts.p95 / 2, p95: opts.p95 } } : {}),
  }
  g.addEdgeWithKey(`${EdgeType.CALLS}:${prov}:service:${from}->service:${to}`, `service:${from}`, `service:${to}`, {
    id: `${EdgeType.CALLS}:${prov}:service:${from}->service:${to}`,
    source: `service:${from}`,
    target: `service:${to}`,
    type: EdgeType.CALLS,
    provenance: prov,
    callCount: opts.count ?? 1,
    signal,
    lastObserved: '2026-08-16T18:00:00.000Z',
  } as GraphEdge)
}

// load-generator ──▶ frontend ──▶ checkout ──▶ shipping (STALE, starved).
// The failing CALLS chain from frontend runs down to shipping; the load origin
// (load-generator) is a pure source upstream, reachable only by walking up.
function overloadGraph(): NeatGraph {
  const g = newGraph()
  for (const s of ['load-generator', 'frontend', 'checkout', 'shipping']) svc(g, s)
  calls(g, 'load-generator', 'frontend', { count: 1000, err: 0 })
  calls(g, 'frontend', 'checkout', { count: 1000, err: 8 })
  // shipping's inbound is STALE with errors — it went quiet under the overload.
  calls(g, 'checkout', 'shipping', { count: 1000, err: 8, stale: true, p95: 4000 })
  return g
}

describe('getRootCause — two-way navigation (ADR-189)', () => {
  it('classifies the starved victim symptom-only and walks up to the load origin', () => {
    const g = overloadGraph()
    const res = getRootCause(g, 'service:frontend')!
    expect(res).toBeTruthy()
    // The whole point of the release: never hand back "root cause is shipping."
    expect(res.rootCauseNode).not.toBe('service:shipping')
    expect(res.rootCauseNode).toBe('service:load-generator')

    const shipping = res.candidates!.find((c) => c.node === 'service:shipping')!
    expect(shipping.classification).toBe('symptom-only')

    expect(res.candidates![0].node).toBe('service:load-generator')
    expect(res.candidates![0].classification).toBe('primary-failure')
    // traversalPath ends at the named cause (get-root-cause.md invariant).
    expect(res.traversalPath[res.traversalPath.length - 1]).toBe('service:load-generator')
    expect(res.edgeProvenances.length).toBe(res.traversalPath.length - 1)
  })

  it('deprecation escape hatch returns the pre-navigation single verdict verbatim', () => {
    const g = overloadGraph()
    const legacy = getRootCause(g, 'service:frontend', undefined, undefined, { navigation: false })!
    // The old downstream-only walk still names shipping — proving no regression
    // for a consumer that opts out for the deprecation cycle.
    expect(legacy.rootCauseNode).toBe('service:shipping')
    expect(legacy.candidates).toBeUndefined()
  })

  it('leaves a genuine in-process culprit as the primary cause (no false demotion)', () => {
    // frontend2 ──▶ orders (OBSERVED, live) throws its own exception. Not stale,
    // not saturated — the failure originates here, so it stays the verdict.
    const g = newGraph()
    svc(g, 'frontend2')
    svc(g, 'orders')
    calls(g, 'frontend2', 'orders', { count: 200, err: 5 })
    const incidents: ErrorEvent[] = [
      {
        id: 'inc-1',
        timestamp: '2026-08-16T18:05:00.000Z',
        service: 'orders',
        affectedNode: 'service:orders',
        errorMessage: 'TypeError: cannot read property id of undefined',
        exceptionType: 'TypeError',
      } as ErrorEvent,
    ]
    const res = getRootCause(g, 'service:frontend2', undefined, incidents)!
    expect(res.rootCauseNode).toBe('service:orders')
    expect(res.candidates![0].node).toBe('service:orders')
    expect(res.candidates![0].classification).toBe('primary-failure')
  })
})

describe('nodeContext + classifyNode (ADR-189)', () => {
  it('separates errors emitted here from errors arriving, and reads staleness', () => {
    const g = overloadGraph()
    const ctx = nodeContext(g, 'service:shipping')
    expect(ctx.errorsFromCallers).toBe(8)
    expect(ctx.errorsEmittedHere).toBe(0)
    expect(ctx.stale).toBe(true)
    expect(ctx.latencyP95Ms).toBe(4000)
    expect(classifyNode(ctx)).toBe('symptom-only')
  })

  it('a pure source with no failure signal classifies unrelated', () => {
    const g = overloadGraph()
    const ctx = nodeContext(g, 'service:load-generator')
    expect(ctx.errorsFromCallers).toBe(0)
    expect(ctx.outboundVolume).toBe(1000)
    expect(classifyNode(ctx)).toBe('unrelated')
  })
})

describe('expandNode (ADR-189)', () => {
  it('walks down to callees and up to callers with per-node classification', () => {
    const g = overloadGraph()
    const down = expandNode(g, 'service:frontend', 'down')
    expect(down.direction).toBe('down')
    expect(down.neighbours.map((n) => n.node)).toContain('service:checkout')

    const up = expandNode(g, 'service:frontend', 'up')
    expect(up.neighbours.map((n) => n.node)).toContain('service:load-generator')
  })
})

describe('relate (ADR-189)', () => {
  it('confirms a directed, signal-carrying cause→symptom link', () => {
    const g = overloadGraph()
    const r = relate(g, 'service:checkout', 'service:shipping')
    expect(r.related).toBe(true)
    expect(r.direction).toBe('a->b')
    expect(r.paths[0]!.carriesSignal).toBe(true)
  })

  it('labels the direction when the second node is upstream', () => {
    const g = overloadGraph()
    const r = relate(g, 'service:shipping', 'service:load-generator')
    expect(r.related).toBe(true)
    expect(r.direction).toBe('b->a')
  })

  it('returns the honest "no path within N hops" for an unreachable pair', () => {
    const g = overloadGraph()
    svc(g, 'island')
    const r = relate(g, 'service:frontend', 'service:island')
    expect(r.related).toBe(false)
    expect(r.direction).toBeNull()
    expect(r.note).toMatch(/no path within \d+ hops/)
  })
})

// #1010 — the correct verdict has to persuade a consuming agent, not just be right.
// A promoted load origin that ships at a flat 0.30 with a volume-only reason reads
// as a weak heuristic and gets overridden. These pin the two presentation fixes:
// the confidence tracks the strength of the separated evidence, and the reason
// carries the causal relation.
describe('getRootCause — the promoted origin has to persuade (#1010)', () => {
  it('grades the confidence to the separated evidence, well above the old 0.30 floor', () => {
    const g = overloadGraph() // clean cause/symptom split + STALE victim + saturation + volume
    const res = getRootCause(g, 'service:frontend')!
    const cause = res.candidates![0]
    expect(cause.node).toBe('service:load-generator')
    expect(cause.classification).toBe('primary-failure')
    // Strong, separated evidence should not read as a weak heuristic.
    expect(cause.confidence).toBeGreaterThan(0.6)
    // The legacy verdict confidence tracks the top candidate.
    expect(res.confidence).toBe(cause.confidence)
    // Still honest — a multi-signal OBSERVED inference never claims certainty.
    expect(cause.confidence).toBeLessThan(1)
  })

  it('calibrates the confidence to the evidence — saturation lifts it over a stale-only shape', () => {
    const strong = getRootCause(overloadGraph(), 'service:frontend')!

    // Same overload, but the victim is STALE without a saturating latency signal —
    // one fewer corroborating signal, so a lower (still non-floor) confidence.
    const milder = newGraph()
    for (const s of ['load-generator', 'frontend', 'checkout', 'shipping']) svc(milder, s)
    calls(milder, 'load-generator', 'frontend', { count: 1000, err: 0 })
    calls(milder, 'frontend', 'checkout', { count: 1000, err: 8 })
    calls(milder, 'checkout', 'shipping', { count: 1000, err: 8, stale: true }) // no p95
    const milderRes = getRootCause(milder, 'service:frontend')!

    expect(milderRes.candidates![0].node).toBe('service:load-generator')
    expect(strong.confidence).toBeGreaterThan(milderRes.confidence)
    expect(milderRes.confidence).toBeGreaterThan(0.3)
  })

  it('leads the rootCauseReason with the causal relation, not just the call volume', () => {
    const res = getRootCause(overloadGraph(), 'service:frontend')!
    const reason = res.rootCauseReason
    // Names the upstream cause and that it overloads/drives the failing subgraph.
    expect(reason).toMatch(/root cause/i)
    expect(reason).toContain('load-generator')
    expect(reason).toMatch(/overload|driv/i)
    // Names the downstream failing node as a symptom/victim, not the fault.
    expect(reason).toContain('shipping')
    expect(reason).toMatch(/symptom|victim/i)
    expect(reason).toMatch(/none originate|not the fault|from its callers/i)
  })
})
