import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode, ErrorEvent } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  fileId,
  serviceId,
  symbolId,
  extractedEdgeId,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { getRootCause, nodeContext, classifyNode } from '../src/traverse.js'

// ADR-191 — an in-process throw localizes to the SYMBOL, so get_root_cause names
// the function at whatever grain it's asked. The ingest side (incidentAffectedNode
// → symbol) is covered in ingest-symbol-grain.test.ts; here the incident already
// carries a symbol affectedNode and we assert the navigation reads it.

const SVC = 'shop'
const REL = 'src/orders.ts'
const SYM = symbolId(SVC, REL, 'createOrder')
const FILE = fileId(SVC, REL)
const SVCID = serviceId(SVC)

function graphWithSymbol(): NeatGraph {
  const g = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  g.addNode(SVCID, { id: SVCID, type: NodeType.ServiceNode, name: SVC, language: 'typescript' } as GraphNode)
  g.addNode(FILE, { id: FILE, type: NodeType.FileNode, service: SVC, path: REL, language: 'typescript' } as GraphNode)
  g.addNode(SYM, {
    id: SYM,
    type: NodeType.SymbolNode,
    kind: 'function',
    qualname: 'createOrder',
    span: { startLine: 10, endLine: 30 },
    service: SVC,
    relPath: REL,
    discoveredVia: 'static',
  } as GraphNode)
  const sc = extractedEdgeId(SVCID, FILE, EdgeType.CONTAINS)
  g.addEdgeWithKey(sc, SVCID, FILE, { id: sc, source: SVCID, target: FILE, type: EdgeType.CONTAINS, provenance: Provenance.EXTRACTED } as GraphEdge)
  const fc = extractedEdgeId(FILE, SYM, EdgeType.CONTAINS)
  g.addEdgeWithKey(fc, FILE, SYM, { id: fc, source: FILE, target: SYM, type: EdgeType.CONTAINS, provenance: Provenance.EXTRACTED } as GraphEdge)
  return g
}

// The incident an in-process throw at createOrder produces once ingest localizes
// it to the symbol (ADR-191).
const incident: ErrorEvent = {
  id: 'trace-1:span-1',
  timestamp: '2026-08-16T22:00:00.000Z',
  service: SVC,
  affectedNode: SYM,
  errorMessage: "TypeError: Cannot read properties of undefined (reading 'id')",
  exceptionType: 'TypeError',
  attributes: { 'code.filepath': REL, 'code.lineno': 18, 'code.function': 'createOrder' },
} as ErrorEvent

describe('symbol-grain navigation (ADR-191)', () => {
  it('names the SYMBOL as the primary failure when queried at the symbol', () => {
    const g = graphWithSymbol()
    const res = getRootCause(g, SYM, undefined, [incident])!
    expect(res).toBeTruthy()
    expect(res.rootCauseNode).toBe(SYM)
    expect(res.candidates![0].node).toBe(SYM)
    expect(res.candidates![0].classification).toBe('primary-failure')
  })

  it('descends to the symbol from a coarser query (file / service)', () => {
    const g = graphWithSymbol()
    const fromFile = getRootCause(g, FILE, undefined, [incident])!
    expect(fromFile.rootCauseNode).toBe(SYM)
    const fromService = getRootCause(g, SVCID, undefined, [incident])!
    expect(fromService.rootCauseNode).toBe(SYM)
  })

  it('classifies the throwing symbol primary-failure via its own emitted error', () => {
    const g = graphWithSymbol()
    const ctx = nodeContext(g, SYM, [incident])
    expect(ctx.errorsEmittedHere).toBeGreaterThan(0)
    expect(ctx.errorsFromCallers).toBe(0)
    expect(classifyNode(ctx)).toBe('primary-failure')
  })

  it('does not regress: a service query with no symbol incident returns null cleanly', () => {
    const g = graphWithSymbol()
    // Healthy service, no incidents.
    expect(getRootCause(g, SVCID, undefined, [])).toBeNull()
  })
})
