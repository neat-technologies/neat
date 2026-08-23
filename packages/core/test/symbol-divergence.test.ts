import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import { computeDivergences } from '../src/divergences.js'
import {
  EdgeType,
  NodeType,
  Provenance,
  databaseId,
  fileId,
  symbolId,
  type ErrorEvent,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'

// ADR-215 — symbol/field-grain divergence. An OBSERVED incident whose error
// content names a field / attribute / method / column the runtime object does
// not have, fused with the EXTRACTED code location that declares the access,
// surfaced through get_divergences at the exact file:line.
//
// The products_list case from the live PRAXIS ±NEAT bench: `recommendation`
// reads `cat_response.products_list`, but the `ListProductsResponse` proto has
// field `products`, so runtime raises AttributeError on every call. The edge the
// code declares (recommendation → productcatalog) IS made and observed, so there
// is no missing edge — the disagreement lives only in the incident, fused to the
// declaring `code.filepath`/`code.lineno`. The edge detectors can't see it; this
// one can.

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

// An OBSERVED-only CONNECTS_TO onto a real database — a headline `missing-extracted`
// edge divergence, so we can prove the edge-grain result is unchanged by the
// symbol-grain pass.
function addObservedOnlyDbEdge(g: NeatGraph): string {
  const db = databaseId('cache-host')
  g.addNode(db, {
    id: db,
    type: NodeType.DatabaseNode,
    name: 'cache-host',
    engine: 'redis',
    engineVersion: 'unknown',
    compatibleDrivers: [],
    host: 'cache-host',
    discoveredVia: 'otel',
  } as GraphNode)
  const edgeId = `${EdgeType.CONNECTS_TO}:OBSERVED:service:${SERVICE}->${db}`
  g.addEdgeWithKey(edgeId, `service:${SERVICE}`, db, {
    id: edgeId,
    source: `service:${SERVICE}`,
    target: db,
    type: EdgeType.CONNECTS_TO,
    provenance: Provenance.OBSERVED,
    lastObserved: new Date().toISOString(),
  } as GraphEdge)
  return db
}

function incident(msg: string, node: string, line?: number, errorType = 'AttributeError'): ErrorEvent {
  return {
    id: `${Math.random().toString(36).slice(2)}:s1`,
    timestamp: new Date().toISOString(),
    service: SERVICE,
    traceId: 't1',
    spanId: 's1',
    errorType,
    errorMessage: msg,
    attributes: {
      'code.filepath': REL,
      ...(line !== undefined ? { 'code.lineno': line } : {}),
    },
    affectedNode: node,
  }
}

describe('symbol/field-grain divergence (ADR-215)', () => {
  it('surfaces a "no attribute X" incident as observed-symbol-mismatch at the declaring file:line', () => {
    const g = graphWithCode()
    const incidents: ErrorEvent[] = [
      incident("'ListProductsResponse' object has no attribute 'products_list'", SYM, 82),
    ]
    const sym = computeDivergences(g, { incidents }).divergences.filter(
      (d) => d.type === 'observed-symbol-mismatch',
    )
    expect(sym).toHaveLength(1)
    const d = sym[0]!
    if (d.type !== 'observed-symbol-mismatch') throw new Error('type narrow')
    expect(d.mismatchKind).toBe('missing-attribute')
    expect(d.symbol).toBe('products_list')
    // source == target == the exact declaring symbol node (finest grain).
    expect(d.source).toBe(SYM)
    expect(d.target).toBe(SYM)
    expect(d.location).toBe(`${REL}:82`)
    // Provenance is the INFERRED stitch between the OBSERVED error and the
    // EXTRACTED location; confidence is the ~0.6 INFERRED grade.
    expect(d.provenance).toBe(Provenance.INFERRED)
    expect(d.confidence).toBeCloseTo(0.6)
    expect(d.errorMessage).toContain('products_list')
    // It points at the code, not an edge — reason names the member + location.
    expect(d.reason).toContain('products_list')
    expect(d.reason).toContain(`${REL}:82`)
  })

  it('contributes nothing without incidents, and leaves edge divergences unchanged', () => {
    const g = graphWithCode()
    const db = addObservedOnlyDbEdge(g)

    const withoutIncidents = computeDivergences(g).divergences
    // No symbol mismatch without incidents.
    expect(withoutIncidents.some((d) => d.type === 'observed-symbol-mismatch')).toBe(false)
    // The edge divergence is present.
    expect(
      withoutIncidents.some((d) => d.type === 'missing-extracted' && d.target === db),
    ).toBe(true)

    // Passing incidents ADDS the symbol mismatch and leaves the edge set byte-identical.
    const incidents: ErrorEvent[] = [
      incident("'ListProductsResponse' object has no attribute 'products_list'", SYM, 82),
    ]
    const withIncidents = computeDivergences(g, { incidents }).divergences
    const edgeBefore = withoutIncidents.filter((d) => d.type !== 'observed-symbol-mismatch')
    const edgeAfter = withIncidents.filter((d) => d.type !== 'observed-symbol-mismatch')
    expect(edgeAfter).toEqual(edgeBefore)
    expect(withIncidents.some((d) => d.type === 'observed-symbol-mismatch')).toBe(true)
  })

  it('ignores incidents that are not field/attribute/method/column mismatches', () => {
    const g = graphWithCode()
    const incidents: ErrorEvent[] = [
      incident('read ETIMEDOUT: upstream timed out after 30000ms', SYM, 40, 'TimeoutError'),
      incident('500 Internal Server Error on GET /recommend', FILE, undefined, 'HTTPError'),
    ]
    const { divergences } = computeDivergences(g, { incidents })
    expect(divergences.some((d) => d.type === 'observed-symbol-mismatch')).toBe(false)
  })

  it('classifies mismatches by generic error semantics, not by language (agnostic, ADR-158 §6)', () => {
    const g = graphWithCode()
    const incidents: ErrorEvent[] = [
      // Ruby NoMethodError shape.
      incident("undefined method `total_amount' for #<Order>", SYM, 12, 'NoMethodError'),
      // SQL column shape.
      incident('no such column: user.middle_name', FILE, 5, 'OperationalError'),
      // Protobuf/struct field shape.
      incident('message Order has no field named discount_code', SYM, 30, 'ValueError'),
    ]
    const found = computeDivergences(g, { incidents }).divergences.filter(
      (d) => d.type === 'observed-symbol-mismatch',
    )
    const byKind = new Map(
      found.map((d) => [d.type === 'observed-symbol-mismatch' ? d.mismatchKind : '', d]),
    )
    expect([...byKind.keys()].sort()).toEqual(
      ['missing-column', 'missing-field', 'undefined-method'].sort(),
    )
    const method = byKind.get('undefined-method')
    expect(method && method.type === 'observed-symbol-mismatch' ? method.symbol : undefined).toBe(
      'total_amount',
    )
    const column = byKind.get('missing-column')
    expect(column && column.type === 'observed-symbol-mismatch' ? column.symbol : undefined).toBe(
      'user.middle_name',
    )
  })

  it('collapses repeated incidents of the same mismatch into one finding carrying the count', () => {
    const g = graphWithCode()
    const msg = "'ListProductsResponse' object has no attribute 'products_list'"
    const incidents: ErrorEvent[] = [
      incident(msg, SYM, 82),
      incident(msg, SYM, 82),
      incident(msg, SYM, 82),
    ]
    const sym = computeDivergences(g, { incidents }).divergences.filter(
      (d) => d.type === 'observed-symbol-mismatch',
    )
    expect(sym).toHaveLength(1)
    const d = sym[0]!
    if (d.type === 'observed-symbol-mismatch') {
      expect(d.incidentCount).toBe(3)
      expect(d.reason).toContain('3 recorded incidents')
    }
  })

  it('falls back to the owning service when the incident did not localize to a code node', () => {
    const g = graphWithCode()
    // affectedNode is the service (not a symbol/file node), but a code.filepath is
    // present — the finding still points at the declaring file:line, scoped to the
    // service node.
    const incidents: ErrorEvent[] = [
      incident("'Resp' object has no attribute 'items_list'", `service:${SERVICE}`, 51),
    ]
    const sym = computeDivergences(g, { incidents }).divergences.filter(
      (d) => d.type === 'observed-symbol-mismatch',
    )
    expect(sym).toHaveLength(1)
    const d = sym[0]!
    if (d.type !== 'observed-symbol-mismatch') throw new Error('type narrow')
    expect(d.source).toBe(`service:${SERVICE}`)
    expect(d.location).toBe(`${REL}:51`)
    expect(d.symbol).toBe('items_list')
  })

  it('honours the type filter and node scoping', () => {
    const g = graphWithCode()
    const db = addObservedOnlyDbEdge(g)
    const incidents: ErrorEvent[] = [
      incident("'ListProductsResponse' object has no attribute 'products_list'", SYM, 82),
    ]
    // type filter to just the new kind drops the edge divergence.
    const onlySymbol = computeDivergences(g, {
      incidents,
      type: new Set(['observed-symbol-mismatch'] as const),
    }).divergences
    expect(onlySymbol.every((d) => d.type === 'observed-symbol-mismatch')).toBe(true)
    expect(onlySymbol.some((d) => d.target === db)).toBe(false)

    // node scoping to the symbol node keeps only the symbol mismatch.
    const scoped = computeDivergences(g, { incidents, node: SYM }).divergences
    expect(scoped.length).toBeGreaterThan(0)
    expect(scoped.every((d) => d.source === SYM || d.target === SYM)).toBe(true)
  })
})
