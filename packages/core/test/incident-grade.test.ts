import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import type { ErrorEvent, GraphEdge, GraphNode, IncidentCard, Policy } from '@neat.is/types'
import { IncidentCardSchema, IncidentEventPayloadSchema, NodeType, Provenance } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { buildIncidentCard, gradeIncidentCard, GRADE_PRIORS_VERSION } from '../src/goodybag.js'
import { formatIncidentLine } from '../src/monitor.js'

// The incident grade (ADR-238): G = Γ·C from the card's own fields. Each factor
// is checked against its definition in neat-sniper's architecture, the gates and
// bands at their boundaries, and a factor the card can't support must be null
// with a reason and leave the weighted mean.

const NODE = 'symbol:api/auth.ts#validateSession'
type Card = Omit<IncidentCard, 'grade'>

function card(over: Partial<Card> = {}): Card {
  return {
    kind: 'incident',
    id: 't1:s1',
    at: '2026-08-29T14:03:11.482Z',
    incidentKind: 'exception',
    service: 'api',
    affectedNode: NODE,
    message: 'TypeError: cannot read id of null',
    exceptionType: 'TypeError',
    locus: { file: 'api/auth.ts', lineStart: 42, symbol: 'validateSession', service: 'api', provenance: Provenance.OBSERVED },
    rootCause: {
      node: NODE,
      classification: 'primary-failure',
      reason: 'session lookup returns null',
      confidence: 0.71,
      fix: null,
      chain: [
        { node: NODE, grain: 'symbol', provenance: Provenance.OBSERVED },
        { node: 'table:supabase.users', grain: 'table', provenance: Provenance.INFERRED },
      ],
    },
    headline: 'SYMBOL validateSession at LINE 42 in auth.ts (SERVICE api) raised TypeError',
    ...over,
  }
}

describe('gradeIncidentCard: the worked example', () => {
  it('computes G, C and every factor from the card, naming the fields it read', () => {
    const g = gradeIncidentCard(card())
    expect(g.gamma).toBe(1)
    expect(g.factors.evidence).toMatchObject({ value: 0.4, weight: 3, evidence: ['rootCause.chain[].provenance'] })
    expect(g.factors.locus).toMatchObject({ value: 1, weight: 2 })
    expect(g.factors.tests).toMatchObject({ value: null, weight: 2 })
    expect(g.factors.tests.reason).toMatch(/test-file classification/)
    expect(g.factors.reach).toMatchObject({ value: null, weight: 1.5, reason: 'no blast radius on the card' })
    expect(g.factors.kind).toMatchObject({ value: 1, weight: 1.5 })
    expect(g.factors.chain).toMatchObject({ value: 1, weight: 1 })
    expect(g.factors.recur.value).toBeCloseTo(Math.log(2) / Math.log(11), 4)
    expect(g.factors.recur.reason).toMatch(/one recorded occurrence/)
    expect(g.factors.div).toMatchObject({ value: 0.7, weight: 1 })
    // (3·0.4 + 2·1 + 1.5·1 + 1·1 + 1·0.2891 + 1·0.7) / (3 + 2 + 1.5 + 1 + 1 + 1); tests and reach drop out.
    const expected = (3 * 0.4 + 2 + 1.5 + 1 + Math.log(2) / Math.log(11) + 0.7) / 9.5
    expect(g.C).toBeCloseTo(expected, 4)
    expect(g.G).toBe(g.C)
    expect(g.band).toBe('diagnose-only')
    expect(g.urgency.value).toBeNull()
    expect(g.urgency.reason).toMatch(/last OBSERVED/)
    expect(g.priorsVersion).toBe(GRADE_PRIORS_VERSION)
    for (const f of Object.values(g.factors)) expect(Array.isArray(f.evidence)).toBe(true)
  })
})

describe('gradeIncidentCard: Γ, the hard gates', () => {
  it('a symptom-only cause zeroes G and puts it out, while C stays readable', () => {
    const rc = card().rootCause!
    const g = gradeIncidentCard(card({ rootCause: { ...rc, classification: 'symptom-only' } }))
    expect(g.gates.notSymptomOnly.passed).toBe(false)
    expect(g.gamma).toBe(0)
    expect(g.G).toBe(0)
    expect(g.C).toBeGreaterThan(0)
    expect(g.band).toBe('out')
  })

  it('a blocking policy fails the policy gate; a log or alert policy does not', () => {
    const blocked = gradeIncidentCard(card({ policies: [{ policyName: 'p', severity: 'critical', onViolation: 'block' }] }))
    expect(blocked.gates.policyNotBlock).toEqual({ passed: false, evidence: ['policies[].onViolation'] })
    expect(blocked.band).toBe('out')
    const alert = gradeIncidentCard(card({ policies: [{ policyName: 'p', severity: 'warning', onViolation: 'alert' }] }))
    expect(alert.gates.policyNotBlock.passed).toBe(true)
  })

  it('no locus fails the locus gate and leaves f_locus null rather than guessing', () => {
    const g = gradeIncidentCard(card({ locus: null }))
    expect(g.gates.locusResolves.passed).toBe(false)
    expect(g.factors.locus.value).toBeNull()
    expect(g.gamma).toBe(0)
    expect(g.band).toBe('out')
  })
})

describe('gradeIncidentCard: each factor', () => {
  it('f_evidence is the weakest carrying hop', () => {
    const rc = card().rootCause!
    const hops = (...p: string[]) => p.map((provenance, i) => ({ node: `n${i}`, grain: 'symbol', provenance })) as typeof rc.chain
    expect(gradeIncidentCard(card({ rootCause: { ...rc, chain: hops('OBSERVED', 'EXTRACTED') } })).factors.evidence.value).toBe(0.8)
    expect(gradeIncidentCard(card({ rootCause: { ...rc, chain: hops('OBSERVED', 'FRONTIER') } })).factors.evidence.value).toBe(0.3)
    expect(gradeIncidentCard(card({ rootCause: { ...rc, chain: hops('STALE', 'OBSERVED') } })).factors.evidence.value).toBe(0.2)
    // Only hops marked as carrying the signal count when any are marked.
    const marked = [
      { node: 'a', grain: 'symbol', provenance: Provenance.OBSERVED, carriesSignal: true },
      { node: 'b', grain: 'table', provenance: Provenance.STALE, carriesSignal: false },
    ]
    expect(gradeIncidentCard(card({ rootCause: { ...rc, chain: marked } })).factors.evidence.value).toBe(1)
    const none = gradeIncidentCard(card({ rootCause: null }))
    expect(none.factors.evidence).toMatchObject({ value: null, reason: 'no root-cause chain on the card' })
    expect(none.factors.chain).toMatchObject({ value: null, reason: 'no root cause on the card' })
  })

  it('f_locus is 1.0 at symbol grain and 0.6 at file grain', () => {
    expect(gradeIncidentCard(card({ locus: { file: 'api/auth.ts', provenance: Provenance.OBSERVED } })).factors.locus.value).toBe(0.6)
  })

  it('f_reach falls with the blast radius against its prior bound', () => {
    const br = (totalAffected: number) => ({ totalAffected, nearest: [{ node: 'x', distance: 1, provenance: Provenance.OBSERVED }] })
    expect(gradeIncidentCard(card({ blastRadius: br(10) })).factors.reach.value).toBe(0.8)
    expect(gradeIncidentCard(card({ blastRadius: br(50) })).factors.reach.value).toBe(0)
    expect(gradeIncidentCard(card({ blastRadius: br(80) })).factors.reach.value).toBe(0)
  })

  it('f_kind follows the failure class, and a timeout reads as one whatever its kind', () => {
    const kind = (over: Partial<Card>) => gradeIncidentCard(card(over)).factors.kind.value
    expect(kind({ incidentKind: 'exception' })).toBe(1)
    expect(kind({ incidentKind: '5xx', exceptionType: undefined, message: 'HTTP 503' })).toBe(0.7)
    expect(kind({ incidentKind: 'status-error', exceptionType: undefined, message: 'UNAVAILABLE' })).toBe(0.7)
    expect(kind({ incidentKind: 'connector', exceptionType: undefined, message: 'poll failed' })).toBe(0.6)
    expect(kind({ incidentKind: '4xx-burst', exceptionType: undefined, message: '429 x40' })).toBe(0.4)
    expect(kind({ incidentKind: 'status-error', exceptionType: undefined, message: 'DEADLINE_EXCEEDED' })).toBe(0.3)
    expect(kind({ incidentKind: 'exception', exceptionType: 'TimeoutError' })).toBe(0.3)
  })

  it('f_chain shortens with distance from cause to symptom', () => {
    const rc = card().rootCause!
    const chainOf = (n: number) => Array.from({ length: n }, (_, i) => ({ node: `n${i}`, grain: 'symbol', provenance: Provenance.OBSERVED }))
    expect(gradeIncidentCard(card({ rootCause: { ...rc, chain: chainOf(1) } })).factors.chain.value).toBe(1)
    expect(gradeIncidentCard(card({ rootCause: { ...rc, chain: chainOf(4) } })).factors.chain.value).toBeCloseTo(0.6667, 4)
    expect(gradeIncidentCard(card({ rootCause: { ...rc, chain: chainOf(6) } })).factors.chain.value).toBe(0.5)
  })

  it('f_recur saturates at ten occurrences', () => {
    expect(gradeIncidentCard(card({ count: 10 })).factors.recur.value).toBe(1)
    expect(gradeIncidentCard(card({ count: 40 })).factors.recur.value).toBe(1)
    expect(gradeIncidentCard(card({ count: 3 })).factors.recur.value).toBeCloseTo(Math.log(4) / Math.log(11), 4)
  })

  it('f_div is 1.0 with a divergence on the card and 0.7 without', () => {
    expect(gradeIncidentCard(card({ divergence: [{ type: 'missing-observed', summary: 'a → b' }] })).factors.div.value).toBe(1)
  })
})

describe('gradeIncidentCard: bands', () => {
  const strong = (over: Partial<Card> = {}) =>
    card({
      count: 10,
      blastRadius: { totalAffected: 10, nearest: [{ node: 'x', distance: 1, provenance: Provenance.OBSERVED }] },
      divergence: [{ type: 'missing-observed', summary: 'a → b' }],
      rootCause: { ...card().rootCause!, chain: [{ node: NODE, grain: 'symbol', provenance: Provenance.OBSERVED }] },
      ...over,
    })

  it('≥ 0.75 is a full run', () => {
    const g = gradeIncidentCard(strong())
    // (3 + 2 + 1.5·0.8 + 1.5 + 1 + 1 + 1) / 11, with f_tests out.
    expect(g.C).toBeCloseTo(10.7 / 11, 4)
    expect(g.band).toBe('full')
  })

  it('0.5 to 0.75 is diagnose-only, and below 0.5 is out', () => {
    expect(gradeIncidentCard(card()).band).toBe('diagnose-only')
    const weak = gradeIncidentCard(
      card({
        incidentKind: '4xx-burst',
        exceptionType: undefined,
        message: '429 x2',
        locus: { file: 'api/auth.ts', provenance: Provenance.INFERRED },
        blastRadius: { totalAffected: 49, nearest: [{ node: 'x', distance: 1, provenance: Provenance.STALE }] },
        rootCause: { ...card().rootCause!, chain: Array.from({ length: 6 }, (_, i) => ({ node: `n${i}`, grain: 'service', provenance: Provenance.STALE })) },
      }),
    )
    expect(weak.G).toBeLessThan(0.5)
    expect(weak.band).toBe('out')
  })
})

describe('the grade rides on the card, not on the trigger', () => {
  function graphWithNode(id: string, attrs: Record<string, unknown>): NeatGraph {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode(id, { id, ...attrs } as unknown as GraphNode)
    return g
  }
  const ev: ErrorEvent = {
    id: 't1:s1',
    timestamp: '2026-08-29T14:03:11.482Z',
    service: 'api',
    traceId: 't1',
    spanId: 's1',
    errorMessage: 'TypeError: cannot read id of null',
    exceptionType: 'TypeError',
    affectedNode: NODE,
    attributes: { 'code.filepath': 'api/auth.ts', 'code.lineno': 42 },
  }

  it('buildIncidentCard attaches a grade that parses with the card', () => {
    const graph = graphWithNode(NODE, { type: 'symbol', name: 'validateSession', service: 'api' })
    const built = buildIncidentCard(graph, ev, [ev], [])
    expect(IncidentCardSchema.parse(built).grade).toBeDefined()
    const { grade, ...rest } = built
    expect(grade).toEqual(gradeIncidentCard(rest))
  })

  it("carries each governing policy's resolved onViolation, which the policy gate reads", () => {
    const graph = graphWithNode(NODE, { type: NodeType.SymbolNode, name: 'validateSession', service: 'api' })
    const policy = {
      id: 'symbols-owned',
      name: 'symbols-owned',
      severity: 'critical',
      onViolation: 'block',
      rule: { type: 'ownership', nodeType: NodeType.SymbolNode, field: 'owner' },
    } as unknown as Policy
    const built = buildIncidentCard(graph, ev, [ev], [policy])
    expect(built.policies).toEqual([expect.objectContaining({ policyName: 'symbols-owned', onViolation: 'block' })])
    expect(built.grade?.gates.policyNotBlock.passed).toBe(false)
    expect(built.grade?.band).toBe('out')
  })

  it('shows on the monitor line', () => {
    const c = { ...card(), grade: gradeIncidentCard(card()) }
    expect(formatIncidentLine(c)).toMatch(/· grade 0\.70 diagnose-only$/)
  })

  it('stays out of the lean SSE trigger', () => {
    expect(Object.keys(IncidentEventPayloadSchema.shape).sort()).toEqual(
      ['affectedNode', 'at', 'incidentId', 'incidentKind', 'service'],
    )
  })
})
