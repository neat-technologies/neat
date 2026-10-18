import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  extractedEdgeId,
  observedEdgeId,
  type ErrorEvent,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import { incidentLead } from '../src/incident-lead.js'
import type { NeatGraph } from '../src/graph.js'

// Silent cause candidates (ADR-271): a declared node that emits no incident of its
// own but on which the failing victims depend through declared topology, and whose
// expected runtime signal went quiet at onset, is surfaced as a lead candidate.
// Grounded in the SREGym absence subset — blocked traffic (network_policy_block,
// calico_route_reflector_label_drift, node_conntrack_exhaustion, wrong_dns_policy),
// where a dependency the failing services declare goes dark while they pile up
// connection errors, and the precision negatives (a quiet-but-unreached node, a
// live dependency, a chronically-dead one) the gate must keep off the lead.

const T0 = Date.parse('2026-01-01T12:00:00.000Z')
const MIN = 60_000
function at(min: number): string {
  return new Date(T0 + min * MIN).toISOString()
}

let seq = 0
function ev(service: string, node: string, min: number, message = 'connection refused'): ErrorEvent {
  seq += 1
  return {
    id: `e${seq}`,
    timestamp: at(min),
    service,
    traceId: `t${seq}`,
    spanId: `s${seq}`,
    errorMessage: message,
    affectedNode: node,
  } as ErrorEvent
}

function newGraph(): NeatGraph {
  return new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
}
function svc(g: NeatGraph, name: string): void {
  g.addNode(`service:${name}`, {
    id: `service:${name}`,
    type: NodeType.ServiceNode,
    name,
    language: 'go',
  } as GraphNode)
}
function declaredCall(g: NeatGraph, from: string, to: string): void {
  const id = extractedEdgeId(from, to, EdgeType.CALLS)
  g.addEdgeWithKey(id, from, to, {
    id,
    source: from,
    target: to,
    type: EdgeType.CALLS,
    provenance: Provenance.EXTRACTED,
    confidence: 0.9,
  } as GraphEdge)
}
// An observed CALLS edge with a given last-observed time (and no errors, so the
// caller is never mistaken for a traffic source). Used both for a live dependency
// and — with an old `lastObserved` — for one that went quiet.
function observedCall(g: NeatGraph, from: string, to: string, lastObserved: string): void {
  const id = observedEdgeId(from, to, EdgeType.CALLS)
  g.addEdgeWithKey(id, from, to, {
    id,
    source: from,
    target: to,
    type: EdgeType.CALLS,
    provenance: Provenance.OBSERVED,
    lastObserved,
    callCount: 20,
    signal: { spanCount: 20, errorCount: 0 },
  } as GraphEdge)
}

// Every case ends its incidents at minute 26, so the window is a fixed
// [16, 26] (newest-10min .. newest) and these dependency last-observed times read
// the same way across cases: minute 14 is quiet in the window (< 16) but went quiet
// around onset (≥ 6 = from - window), so it leads; minute 2 is chronically dead
// (< 6); minute 20 is still live in the window (≥ 16).
const WENT_QUIET = at(14)
const CHRONIC = at(2)
const LIVE = at(20)

describe('silent cause candidates (ADR-271)', () => {
  it('leads with a declared dependency that went quiet, above the victim that depends on it', () => {
    // network_policy_block shape: frontend declares a call to productcatalog; the
    // edge went dark at onset and frontend piles up connection errors.
    const g = newGraph()
    svc(g, 'frontend')
    svc(g, 'productcatalog')
    declaredCall(g, 'service:frontend', 'service:productcatalog')
    observedCall(g, 'service:frontend', 'service:productcatalog', WENT_QUIET)
    const incidents = [
      ev('frontend', 'service:frontend', 20),
      ev('frontend', 'service:frontend', 23),
      ev('frontend', 'service:frontend', 26),
    ]
    const lead = incidentLead(g, incidents)
    const top = lead.ranked[0]
    expect(top.node).toBe('service:productcatalog')
    expect(top.silent).toBe(true)
    expect(top.dependents).toBe(1)
    expect(top.onset).toBe('new')
    expect(top.count).toBe(0)
    expect(lead.ranked[1]?.node).toBe('service:frontend')
  })

  it('aggregates the in-window volume of every failing victim that depends on it', () => {
    // A shared dependency (cartservice) goes quiet; two services depend on it and
    // fail. Its weight is the sum of their in-window incidents, so it leads both.
    const g = newGraph()
    for (const s of ['frontend', 'checkout', 'cartservice']) svc(g, s)
    declaredCall(g, 'service:frontend', 'service:cartservice')
    declaredCall(g, 'service:checkout', 'service:cartservice')
    observedCall(g, 'service:frontend', 'service:cartservice', WENT_QUIET)
    const incidents = [
      ev('frontend', 'service:frontend', 20),
      ev('frontend', 'service:frontend', 22),
      ev('frontend', 'service:frontend', 26),
      ev('checkout', 'service:checkout', 21),
      ev('checkout', 'service:checkout', 26),
    ]
    const lead = incidentLead(g, incidents)
    expect(lead.ranked[0].node).toBe('service:cartservice')
    expect(lead.ranked[0].dependents).toBe(2)
  })

  it('reaches a silent dependency transitively through declared topology', () => {
    // frontend → checkout → paymentgw (all declared); paymentgw went quiet, frontend
    // fails. The gate reaches paymentgw transitively.
    const g = newGraph()
    for (const s of ['frontend', 'checkout', 'paymentgw']) svc(g, s)
    declaredCall(g, 'service:frontend', 'service:checkout')
    declaredCall(g, 'service:checkout', 'service:paymentgw')
    observedCall(g, 'service:checkout', 'service:paymentgw', WENT_QUIET)
    // checkout stays live so it is not itself silent.
    observedCall(g, 'service:frontend', 'service:checkout', LIVE)
    const incidents = [ev('frontend', 'service:frontend', 22), ev('frontend', 'service:frontend', 26)]
    const lead = incidentLead(g, incidents)
    const silent = lead.ranked.find((r) => r.silent)
    expect(silent?.node).toBe('service:paymentgw')
  })

  it('does not surface a quiet node no failing victim depends on (reachability gate)', () => {
    // A scaled-to-zero batch job that went quiet, but nothing failing declares a
    // path to it — the workload_imbalance "wrong" shape.
    const g = newGraph()
    svc(g, 'frontend')
    svc(g, 'batchjob')
    svc(g, 'cart')
    declaredCall(g, 'service:frontend', 'service:cart') // frontend depends on cart, not batchjob
    observedCall(g, 'service:frontend', 'service:cart', LIVE)
    observedCall(g, 'service:cart', 'service:batchjob', WENT_QUIET) // cart→batchjob quiet, but cart isn't failing
    const incidents = [ev('frontend', 'service:frontend', 26)]
    const lead = incidentLead(g, incidents)
    expect(lead.ranked.some((r) => r.node === 'service:batchjob')).toBe(false)
  })

  it('does not surface a quiet node only a healthy (non-failing) service depends on', () => {
    const g = newGraph()
    for (const s of ['frontend', 'cart', 'cron', 'legacy']) svc(g, s)
    declaredCall(g, 'service:frontend', 'service:cart')
    observedCall(g, 'service:frontend', 'service:cart', LIVE)
    declaredCall(g, 'service:cron', 'service:legacy') // cron (no incidents) depends on silent legacy
    observedCall(g, 'service:cron', 'service:legacy', WENT_QUIET)
    const incidents = [ev('frontend', 'service:frontend', 26)]
    const lead = incidentLead(g, incidents)
    expect(lead.ranked.some((r) => r.node === 'service:legacy')).toBe(false)
  })

  it('does not surface a dependency that is still live in the window', () => {
    const g = newGraph()
    svc(g, 'frontend')
    svc(g, 'productcatalog')
    declaredCall(g, 'service:frontend', 'service:productcatalog')
    observedCall(g, 'service:frontend', 'service:productcatalog', LIVE) // serving in-window
    const incidents = [ev('frontend', 'service:frontend', 26)]
    const lead = incidentLead(g, incidents)
    expect(lead.ranked.some((r) => r.silent)).toBe(false)
  })

  it('does not surface a chronically-dead declared dependency', () => {
    const g = newGraph()
    svc(g, 'frontend')
    svc(g, 'oldservice')
    declaredCall(g, 'service:frontend', 'service:oldservice')
    observedCall(g, 'service:frontend', 'service:oldservice', CHRONIC) // last seen long before onset
    const incidents = [ev('frontend', 'service:frontend', 26)]
    const lead = incidentLead(g, incidents)
    expect(lead.ranked.some((r) => r.node === 'service:oldservice')).toBe(false)
  })

  it('does not surface a never-observed declared dependency (deferred in v1)', () => {
    const g = newGraph()
    svc(g, 'frontend')
    svc(g, 'uninstrumented')
    declaredCall(g, 'service:frontend', 'service:uninstrumented') // declared only, never observed
    const incidents = [ev('frontend', 'service:frontend', 26)]
    const lead = incidentLead(g, incidents)
    expect(lead.ranked.some((r) => r.node === 'service:uninstrumented')).toBe(false)
  })

  it('adds no silent candidate when no graph is supplied', () => {
    const incidents = [ev('frontend', 'service:frontend', 26)]
    const lead = incidentLead(undefined, incidents)
    expect(lead.ranked.every((r) => !r.silent)).toBe(true)
  })
})
