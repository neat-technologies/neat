import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  type ErrorEvent,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { askGraph, classifyIntent } from '../src/ask.js'

// A small fused graph: checkout calls payments (declared + observed), checkout
// connects to the orders database, and orders-db has a dependent (payments) so
// its blast radius is non-empty. Enough to exercise every route the ask router
// composes.
function makeGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  const node = (n: GraphNode): void => {
    g.addNode(n.id, n)
  }
  node({ id: 'service:checkout', type: NodeType.ServiceNode, name: 'checkout', language: 'javascript' })
  node({ id: 'service:payments', type: NodeType.ServiceNode, name: 'payments', language: 'javascript' })
  node({
    id: 'database:orders-db',
    type: NodeType.DatabaseNode,
    name: 'orders',
    engine: 'postgresql',
    engineVersion: '15',
  })

  const edge = (e: GraphEdge): void => {
    g.addEdgeWithKey(e.id, e.source, e.target, e)
  }
  edge({
    id: 'CALLS:extracted:checkout->payments',
    source: 'service:checkout',
    target: 'service:payments',
    type: EdgeType.CALLS,
    provenance: Provenance.EXTRACTED,
  })
  edge({
    id: 'CALLS:observed:checkout->payments',
    source: 'service:checkout',
    target: 'service:payments',
    type: EdgeType.CALLS,
    provenance: Provenance.OBSERVED,
    callCount: 240,
  })
  edge({
    id: 'CONNECTS_TO:extracted:checkout->orders-db',
    source: 'service:checkout',
    target: 'database:orders-db',
    type: EdgeType.CONNECTS_TO,
    provenance: Provenance.EXTRACTED,
  })
  edge({
    id: 'CONNECTS_TO:observed:payments->orders-db',
    source: 'service:payments',
    target: 'database:orders-db',
    type: EdgeType.CONNECTS_TO,
    provenance: Provenance.OBSERVED,
    callCount: 90,
  })
  return g
}

function incident(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    id: 'evt-1',
    timestamp: '2026-08-17T10:00:00.000Z',
    service: 'checkout',
    traceId: 'trace-1',
    spanId: 'span-1',
    errorMessage: 'TypeError: cannot read property total of undefined',
    affectedNode: 'service:checkout',
    ...overrides,
  }
}

describe('ask — intent classification', () => {
  it('routes a why/failing question to root-cause', () => {
    expect(classifyIntent('why is checkout failing?')).toBe('root-cause')
    expect(classifyIntent("what's the root cause of the 500s")).toBe('root-cause')
  })
  it('routes a "what breaks if" question to blast-radius', () => {
    expect(classifyIntent('what breaks if I change the orders db?')).toBe('blast-radius')
    expect(classifyIntent('what are the downstream dependents of checkout')).toBe('blast-radius')
  })
  it('routes a dependency question to dependencies', () => {
    expect(classifyIntent('what does checkout depend on')).toBe('dependencies')
  })
  it('routes a divergence question to divergence', () => {
    expect(classifyIntent('is anything weird between code and production')).toBe('divergence')
  })
  it('falls back to overview for a plain "what is" question', () => {
    expect(classifyIntent('what is the payments service')).toBe('overview')
  })
})

describe('ask — entity resolution and provenance-tagged context', () => {
  it('resolves the named entity to the right node and tags every fact with provenance', async () => {
    const g = makeGraph()
    const result = await askGraph(g, 'what does checkout depend on?')

    // The question's word "checkout" resolves to the checkout service.
    expect(result.primaryNode).toBe('service:checkout')
    expect(result.matched[0]?.nodeId).toBe('service:checkout')
    expect(result.intent).toBe('dependencies')

    // The composed answer carries provenance-tagged facts — the dependency edges
    // and the runtime edge, each with its own provenance.
    const allFacts = result.sections.flatMap((s) => s.facts)
    expect(allFacts.length).toBeGreaterThan(0)
    expect(allFacts.some((f) => f.provenance === Provenance.OBSERVED)).toBe(true)
    // The aggregate provenance list is populated (never a bare, untagged answer).
    expect(result.provenance).toContain(Provenance.OBSERVED)

    // A runtime dependency section confirms what checkout actually calls (OBSERVED).
    const observed = result.sections.find((s) => s.heading.includes('OBSERVED'))
    expect(observed).toBeDefined()
    expect(observed!.facts.some((f) => f.text.includes('service:payments'))).toBe(true)
  })

  it('resolves a database named in the question and answers about it', async () => {
    const g = makeGraph()
    const result = await askGraph(g, 'what depends on the orders db')
    expect(result.primaryNode).toBe('database:orders-db')
    expect(result.intent).toBe('blast-radius')
    // orders-db has dependents (checkout, payments) — the blast radius is non-empty.
    const blast = result.sections.find((s) => s.heading.startsWith('Blast radius'))
    expect(blast).toBeDefined()
    expect(blast!.facts.length).toBeGreaterThan(0)
  })

  it('returns an honest empty answer when nothing resolves', async () => {
    const g = makeGraph()
    const result = await askGraph(g, 'how is the weather today')
    expect(result.primaryNode).toBeUndefined()
    expect(result.matched).toEqual([])
    expect(result.sections).toEqual([])
    expect(result.answer.toLowerCase()).toContain('resolved to a node')
  })
})

describe('ask — root-cause-shaped questions lead with the navigation', () => {
  it('leads the answer with get_root_cause navigation for a "why is X failing" question', async () => {
    const g = makeGraph()
    const incidents = [incident()]
    const result = await askGraph(g, 'why is checkout failing?', { incidents })

    expect(result.intent).toBe('root-cause')
    expect(result.primaryNode).toBe('service:checkout')

    // The FIRST section is the root-cause navigation, and its first fact is the
    // root cause itself — not a dependency dump.
    const lead = result.sections[0]
    expect(lead).toBeDefined()
    expect(lead!.heading).toBe('Root cause (navigation)')
    expect(lead!.facts[0]?.text.startsWith('Root cause:')).toBe(true)
    // The root-cause fact is provenance-tagged and confidence-scored (ADR-189/190).
    expect(lead!.facts[0]?.provenance).toBeDefined()
    expect(typeof lead!.facts[0]?.confidence).toBe('number')
    // The compact answer names the finding, and the incident is surfaced too.
    expect(result.answer.toLowerCase()).toContain('root cause')
    expect(result.sections.some((s) => s.heading.includes('incidents'))).toBe(true)
  })

  it('answers a root-cause question about a healthy node without inventing a cause', async () => {
    const g = makeGraph()
    // No incidents, no failing edges → getRootCause finds nothing to attribute.
    const result = await askGraph(g, 'why is payments failing?')
    expect(result.intent).toBe('root-cause')
    expect(result.primaryNode).toBe('service:payments')
    // No fabricated root-cause section; the answer is honest about it.
    expect(result.sections.some((s) => s.heading === 'Root cause (navigation)')).toBe(false)
  })
})
