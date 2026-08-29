import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import type { ErrorEvent, GraphEdge, GraphNode, IncidentCard } from '@neat.is/types'
import { Provenance } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { buildIncidentCard } from '../src/goodybag.js'
import { MonitorEmitter, formatIncidentLine, incidentJson } from '../src/monitor.js'

// The incident card (ADR-221) — the assembler's own guarantees are the thing
// under test: zero fabrication (a missing locus stays null), the incident-kind
// mapping, and honest degradation when the affected node isn't in the graph.
// The composed queries (root cause, blast radius, policies, divergence) have
// their own suites; here they run over minimal graphs and simply must not throw.

function graphWithNode(id: string, attrs: Record<string, unknown>): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  g.addNode(id, { id, ...attrs } as unknown as GraphNode)
  return g
}

const NODE = 'symbol:api/auth.ts#validateSession'

function baseEvent(over: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    id: 't1:s1',
    timestamp: '2026-08-29T14:03:11.482Z',
    service: 'api',
    traceId: 't1',
    spanId: 's1',
    errorMessage: 'TypeError: cannot read id of null',
    exceptionType: 'TypeError',
    affectedNode: NODE,
    attributes: { 'code.filepath': 'api/auth.ts', 'code.lineno': 42 },
    ...over,
  }
}

describe('buildIncidentCard — locus', () => {
  const graph = graphWithNode(NODE, { type: 'symbol', name: 'validateSession', service: 'api' })

  it('recovers the locus from code.filepath / code.lineno', () => {
    const card = buildIncidentCard(graph, baseEvent(), [baseEvent()], [])
    expect(card.locus).not.toBeNull()
    expect(card.locus?.file).toBe('api/auth.ts')
    expect(card.locus?.lineStart).toBe(42)
    expect(card.locus?.symbol).toBe('validateSession')
    expect(card.locus?.provenance).toBe(Provenance.OBSERVED)
    expect(card.headline).toContain('api/auth.ts')
    expect(card.id).toBe('t1:s1')
    expect(card.at).toBe('2026-08-29T14:03:11.482Z')
  })

  it('leaves locus null when the incident carries no code attributes — never fabricated', () => {
    const ev = baseEvent({ attributes: undefined })
    const card = buildIncidentCard(graph, ev, [ev], [])
    expect(card.locus).toBeNull()
  })
})

describe('buildIncidentCard — incident kind', () => {
  const graph = graphWithNode(NODE, { type: 'symbol', name: 'validateSession', service: 'api' })

  it('maps a gRPC failure to status-error', () => {
    const ev = baseEvent({ errorType: 'grpc-failure', exceptionType: undefined, attributes: undefined })
    expect(buildIncidentCard(graph, ev, [ev], []).incidentKind).toBe('status-error')
  })

  it('maps a coalesced http-failure burst to 4xx-burst', () => {
    const ev = baseEvent({
      errorType: 'http-failure',
      exceptionType: undefined,
      httpStatusCode: 404,
      incidentCount: 5,
      firstTimestamp: '2026-08-29T14:03:00.000Z',
      lastTimestamp: '2026-08-29T14:03:08.000Z',
      attributes: undefined,
    })
    const card = buildIncidentCard(graph, ev, [ev], [])
    expect(card.incidentKind).toBe('4xx-burst')
    expect(card.count).toBe(5)
    expect(card.window).toEqual({
      first: '2026-08-29T14:03:00.000Z',
      last: '2026-08-29T14:03:08.000Z',
    })
  })

  it('maps a single http-failure to 5xx and an exception span to exception', () => {
    const fivexx = baseEvent({
      errorType: 'http-failure',
      exceptionType: undefined,
      httpStatusCode: 500,
      incidentCount: 1,
      attributes: undefined,
    })
    expect(buildIncidentCard(graph, fivexx, [fivexx], []).incidentKind).toBe('5xx')
    const exc = baseEvent({ attributes: undefined })
    expect(buildIncidentCard(graph, exc, [exc], []).incidentKind).toBe('exception')
  })
})

describe('buildIncidentCard — honest degradation', () => {
  it('ships a card with no root cause / blast radius when the affected node is not in the graph', () => {
    // Empty graph — the incident is attributed to a node the graph does not carry.
    const graph: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    const card = buildIncidentCard(graph, baseEvent(), [baseEvent()], [])
    expect(card.rootCause).toBeNull()
    expect(card.blastRadius).toBeUndefined()
    expect(card.policies).toBeUndefined()
    // The locus still comes through — it reads the incident record, not the graph.
    expect(card.locus?.file).toBe('api/auth.ts')
  })
})

describe('monitor: incident → line', () => {
  const card: IncidentCard = {
    kind: 'incident',
    id: 't1:s1',
    at: '2026-08-29T14:03:11.482Z',
    incidentKind: 'exception',
    service: 'api',
    affectedNode: NODE,
    message: 'TypeError: cannot read id of null',
    exceptionType: 'TypeError',
    locus: {
      file: 'api/auth.ts',
      lineStart: 42,
      symbol: 'validateSession',
      service: 'api',
      provenance: Provenance.OBSERVED,
    },
    rootCause: {
      node: NODE,
      classification: 'primary-failure',
      reason: 'session lookup returns null',
      confidence: 0.71,
      fix: 'guard the null session',
      chain: [
        { node: NODE, grain: 'symbol', provenance: Provenance.OBSERVED },
        { node: 'table:supabase.users', grain: 'table', provenance: Provenance.INFERRED },
      ],
    },
    headline: 'validateSession api/auth.ts:42 (api) raised TypeError → incident on ' + NODE,
  }

  it('renders one greppable ✖ incident line with the provenance mix', () => {
    const line = formatIncidentLine(card)
    expect(line).toContain('✖ incident [exception]')
    expect(line).toContain(card.headline)
    expect(line).toContain('primary-failure 0.71')
    expect(line).toContain('[OBSERVED·INFERRED]')
  })

  it('emits an incident once, keyed on the incident id', () => {
    const lines: string[] = []
    const emitter = new MonitorEmitter({ json: false, write: (l) => lines.push(l) })
    expect(emitter.emitIncident(card)).toBe(true)
    expect(emitter.emitIncident(card)).toBe(false)
    expect(lines).toHaveLength(1)
  })

  it('emits the full card as one JSON object under --json', () => {
    const lines: string[] = []
    const emitter = new MonitorEmitter({ json: true, write: (l) => lines.push(l) })
    emitter.emitIncident(card)
    const parsed = JSON.parse(lines[0]!.trim()) as IncidentCard
    expect(parsed.kind).toBe('incident')
    expect(parsed.rootCause?.chain).toHaveLength(2)
    expect(incidentJson(card)).toBe(JSON.stringify(card))
  })
})
