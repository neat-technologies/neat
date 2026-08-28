import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import { computeDivergences } from '../src/divergences.js'
import {
  EdgeType,
  NodeType,
  Provenance,
  extractedEdgeId,
  observedEdgeId,
  fileId,
  symbolId,
  type EdgeSignal,
  type ErrorEvent,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'

// ADR-220 — behavioral-failure divergence (`observed-failing`). A dependency the
// code declares AND production observes, but whose calls predominantly fail. The
// edge is present (so it is neither missing-observed nor missing-extracted) and
// the access is fine (so it is not observed-symbol-mismatch), yet the declared
// intent "this dependency works" diverges from the observed reality "it fails."
//
// Two loci: the edge locus (a declared+observed edge whose observed error rate is
// over the threshold — the frontend→ad 84/84-errors shape) and the incident locus
// (a declared external call whose recorded incident carries a transport/5xx
// failure — the recommendation→wrong-host ECONNREFUSED / neo4j DEADLINE_EXCEEDED
// shape, fused to the declaring file:line).

const CALLER = 'frontend'
const CALLEE = 'ad'

// A declared (EXTRACTED) + observed (OBSERVED) CALLS edge between two services.
// The observed edge carries the given signal; the declared edge makes it a
// declared-vs-observed pair the edge detectors themselves leave alone.
function graphWithDeclaredObservedEdge(signal: EdgeSignal): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  for (const name of [CALLER, CALLEE]) {
    g.addNode(`service:${name}`, {
      id: `service:${name}`,
      type: NodeType.ServiceNode,
      name,
      language: 'javascript',
    } as GraphNode)
  }
  const src = `service:${CALLER}`
  const dst = `service:${CALLEE}`
  const extId = extractedEdgeId(src, dst, EdgeType.CALLS)
  g.addEdgeWithKey(extId, src, dst, {
    id: extId,
    source: src,
    target: dst,
    type: EdgeType.CALLS,
    provenance: Provenance.EXTRACTED,
    confidence: 0.9,
  } as GraphEdge)
  const obsId = observedEdgeId(src, dst, EdgeType.CALLS)
  g.addEdgeWithKey(obsId, src, dst, {
    id: obsId,
    source: src,
    target: dst,
    type: EdgeType.CALLS,
    provenance: Provenance.OBSERVED,
    lastObserved: new Date().toISOString(),
    callCount: signal.spanCount,
    signal,
  } as GraphEdge)
  return g
}

const SERVICE = 'recommendation'
const REL = 'src/recommendation_server.py'
const FILE = fileId(SERVICE, REL)
const SYM = symbolId(SERVICE, REL, 'list_recommendations')

function graphWithCode(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  g.addNode(`service:${SERVICE}`, {
    id: `service:${SERVICE}`,
    type: NodeType.ServiceNode,
    name: SERVICE,
    language: 'python',
  } as GraphNode)
  g.addNode(FILE, {
    id: FILE,
    type: NodeType.FileNode,
    service: SERVICE,
    path: REL,
    language: 'python',
  } as GraphNode)
  g.addNode(SYM, {
    id: SYM,
    type: NodeType.SymbolNode,
    kind: 'function',
    qualname: 'list_recommendations',
    span: { startLine: 70, endLine: 95 },
    service: SERVICE,
    relPath: REL,
  } as GraphNode)
  return g
}

function incident(
  msg: string,
  node: string,
  opts: { line?: number; errorType?: string; httpStatusCode?: number; timestamp?: string } = {},
): ErrorEvent {
  return {
    id: `${Math.random().toString(36).slice(2)}:s1`,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    service: SERVICE,
    traceId: 't1',
    spanId: 's1',
    ...(opts.errorType ? { errorType: opts.errorType } : {}),
    errorMessage: msg,
    attributes: {
      'code.filepath': REL,
      ...(opts.line !== undefined ? { 'code.lineno': opts.line } : {}),
    },
    affectedNode: node,
    ...(opts.httpStatusCode !== undefined ? { httpStatusCode: opts.httpStatusCode } : {}),
  }
}

describe('behavioral-failure divergence — edge locus (ADR-220)', () => {
  it('flags a declared+observed edge whose observed calls are all errors', () => {
    // The frontend→ad 84/84-errors shape.
    const g = graphWithDeclaredObservedEdge({ spanCount: 84, errorCount: 84 })
    const failing = computeDivergences(g).divergences.filter((d) => d.type === 'observed-failing')
    expect(failing).toHaveLength(1)
    const d = failing[0]!
    if (d.type !== 'observed-failing') throw new Error('type narrow')
    expect(d.failureKind).toBe('error-rate')
    expect(d.source).toBe(`service:${CALLER}`)
    expect(d.target).toBe(`service:${CALLEE}`)
    expect(d.edgeType).toBe(EdgeType.CALLS)
    expect(d.spanCount).toBe(84)
    expect(d.errorCount).toBe(84)
    expect(d.errorRate).toBeCloseTo(1)
    // A cross-layer join: INFERRED, ~0.6, ranked below the definitive divergences.
    expect(d.provenance).toBe(Provenance.INFERRED)
    expect(d.confidence).toBeCloseTo(0.6)
    expect(d.reason).toContain('predominantly failing')
    // The declared+observed edge is NOT a missing-* finding — only observed-failing.
    const all = computeDivergences(g).divergences
    expect(all.some((x) => x.type === 'missing-observed' || x.type === 'missing-extracted')).toBe(
      false,
    )
  })

  it('flags a majority-failing edge (over the 50% threshold), carrying the evidence', () => {
    const g = graphWithDeclaredObservedEdge({ spanCount: 20, errorCount: 15 })
    const failing = computeDivergences(g).divergences.filter((d) => d.type === 'observed-failing')
    expect(failing).toHaveLength(1)
    const d = failing[0]!
    if (d.type !== 'observed-failing') throw new Error('type narrow')
    expect(d.errorRate).toBeCloseTo(0.75)
    expect(d.reason).toContain('15/20')
  })

  it('does NOT flag a healthy declared+observed edge (low error rate) — no false positive', () => {
    // 2% errors — a working dependency, an SLO/alerting concern, not a divergence.
    const g = graphWithDeclaredObservedEdge({ spanCount: 100, errorCount: 2 })
    const failing = computeDivergences(g).divergences.filter((d) => d.type === 'observed-failing')
    expect(failing).toHaveLength(0)
  })

  it('does NOT flag a high error rate under the minimum span floor (a blip, not a pattern)', () => {
    // 1/1 errors is 100% but a single sample — below MIN_SPANS, so not surfaced.
    const g = graphWithDeclaredObservedEdge({ spanCount: 1, errorCount: 1 })
    const failing = computeDivergences(g).divergences.filter((d) => d.type === 'observed-failing')
    expect(failing).toHaveLength(0)
  })

  it('does NOT flag an observed-only failing edge (that is already missing-extracted)', () => {
    // Only the OBSERVED edge, no EXTRACTED twin — there is no declared intent to
    // diverge against, and it is already the headline missing-extracted finding.
    const g = graphWithDeclaredObservedEdge({ spanCount: 50, errorCount: 50 })
    const src = `service:${CALLER}`
    const dst = `service:${CALLEE}`
    g.dropEdge(extractedEdgeId(src, dst, EdgeType.CALLS))
    const divs = computeDivergences(g).divergences
    expect(divs.some((d) => d.type === 'observed-failing')).toBe(false)
    expect(divs.some((d) => d.type === 'missing-extracted')).toBe(true)
  })
})

describe('behavioral-failure divergence — incident locus (ADR-220)', () => {
  it('surfaces an ECONNREFUSED incident as observed-failing at the declaring file:line', () => {
    const g = graphWithCode()
    const incidents: ErrorEvent[] = [
      incident('connect ECONNREFUSED 10.0.0.9:7687', SYM, {
        line: 88,
        errorType: 'Error',
      }),
    ]
    const failing = computeDivergences(g, { incidents }).divergences.filter(
      (d) => d.type === 'observed-failing',
    )
    expect(failing).toHaveLength(1)
    const d = failing[0]!
    if (d.type !== 'observed-failing') throw new Error('type narrow')
    expect(d.failureKind).toBe('connection-refused')
    expect(d.source).toBe(SYM)
    expect(d.target).toBe(SYM)
    expect(d.location).toBe(`${REL}:88`)
    expect(d.provenance).toBe(Provenance.INFERRED)
    expect(d.confidence).toBeCloseTo(0.6)
    expect(d.errorMessage).toContain('ECONNREFUSED')
  })

  it('surfaces a DEADLINE_EXCEEDED incident as observed-failing', () => {
    const g = graphWithCode()
    const incidents: ErrorEvent[] = [
      incident('DEADLINE_EXCEEDED: Deadline expired before operation could complete', SYM, {
        line: 91,
        errorType: 'StatusCode.DEADLINE_EXCEEDED',
      }),
    ]
    const failing = computeDivergences(g, { incidents }).divergences.filter(
      (d) => d.type === 'observed-failing',
    )
    expect(failing).toHaveLength(1)
    const d = failing[0]!
    if (d.type !== 'observed-failing') throw new Error('type narrow')
    expect(d.failureKind).toBe('deadline-exceeded')
    expect(d.location).toBe(`${REL}:91`)
  })

  it('classifies a 5xx incident off the structured status code, not a message substring', () => {
    const g = graphWithCode()
    const incidents: ErrorEvent[] = [
      // The message mentions "500ms" — must NOT be read as a 5xx; the status code
      // is the signal.
      incident('upstream took 500ms and returned an error', SYM, {
        line: 44,
        httpStatusCode: 503,
      }),
    ]
    const failing = computeDivergences(g, { incidents }).divergences.filter(
      (d) => d.type === 'observed-failing',
    )
    expect(failing).toHaveLength(1)
    const d = failing[0]!
    if (d.type !== 'observed-failing') throw new Error('type narrow')
    expect(d.failureKind).toBe('server-error')
    expect(d.httpStatusCode).toBe(503)
  })

  it('collapses repeated incidents of one failure family into a single finding with the count', () => {
    const g = graphWithCode()
    const incidents: ErrorEvent[] = [
      incident('connect ECONNREFUSED 10.0.0.9:7687', SYM, { line: 88, timestamp: '2026-08-01T00:00:00.000Z' }),
      incident('connect ECONNREFUSED 10.0.0.9:7687', SYM, { line: 88, timestamp: '2026-08-01T00:01:00.000Z' }),
      incident('connect ECONNREFUSED 10.0.0.9:7687', SYM, { line: 88, timestamp: '2026-08-01T00:02:00.000Z' }),
    ]
    const failing = computeDivergences(g, { incidents }).divergences.filter(
      (d) => d.type === 'observed-failing',
    )
    expect(failing).toHaveLength(1)
    const d = failing[0]!
    if (d.type === 'observed-failing') {
      expect(d.incidentCount).toBe(3)
      expect(d.reason).toContain('3 recorded incidents')
    }
  })

  it('ignores incidents that are not behavioral failures (4xx, member mismatch, benign)', () => {
    const g = graphWithCode()
    const incidents: ErrorEvent[] = [
      // A 4xx is a client-side concern, not a declared-dependency failure.
      incident('bad request', SYM, { line: 10, httpStatusCode: 404 }),
      // A member mismatch is the ADR-215 detector's business, not this one.
      incident("'ListProductsResponse' object has no attribute 'products_list'", SYM, {
        line: 12,
        errorType: 'AttributeError',
      }),
    ]
    const failing = computeDivergences(g, { incidents }).divergences.filter(
      (d) => d.type === 'observed-failing',
    )
    expect(failing).toHaveLength(0)
  })

  it('contributes nothing without incidents, and leaves the edge-grain result unchanged', () => {
    // A healthy declared+observed edge plus code nodes — no failing edge, no
    // incidents => no observed-failing, and the other kinds are untouched.
    const g = graphWithDeclaredObservedEdge({ spanCount: 30, errorCount: 0 })
    const before = computeDivergences(g).divergences
    expect(before.some((d) => d.type === 'observed-failing')).toBe(false)

    // Adding an unrelated failure incident adds only the observed-failing finding.
    const incidents: ErrorEvent[] = [
      incident('connect ECONNREFUSED host:5432', `service:${CALLER}`, { line: 5 }),
    ]
    const after = computeDivergences(g, { incidents }).divergences
    const nonFailingBefore = before.filter((d) => d.type !== 'observed-failing')
    const nonFailingAfter = after.filter((d) => d.type !== 'observed-failing')
    expect(nonFailingAfter).toEqual(nonFailingBefore)
    expect(after.some((d) => d.type === 'observed-failing')).toBe(true)
  })

  it('honours the type filter and node scoping', () => {
    const g = graphWithCode()
    const incidents: ErrorEvent[] = [
      incident('connect ECONNREFUSED 10.0.0.9:7687', SYM, { line: 88 }),
    ]
    const only = computeDivergences(g, {
      incidents,
      type: new Set(['observed-failing'] as const),
    }).divergences
    expect(only.length).toBeGreaterThan(0)
    expect(only.every((d) => d.type === 'observed-failing')).toBe(true)

    const scoped = computeDivergences(g, { incidents, node: SYM }).divergences
    expect(scoped.every((d) => d.source === SYM || d.target === SYM)).toBe(true)
  })
})
