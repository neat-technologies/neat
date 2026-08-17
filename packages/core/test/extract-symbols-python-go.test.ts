import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { GraphEdge, SymbolNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  extractedEdgeId,
  fileId,
  symbolId,
} from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'symbols-polyglot')

// ADR-192 — symbol grain reaches Python and Go. The two fixtures are real
// services (a pyproject.toml Python package, a go.mod Go module) each with one
// source file carrying functions, methods, a constructor, and (Python) a class.
// Every definition becomes a SymbolNode owned by its file through a
// `file ──CONTAINS──▶ symbol` edge, the exact shape ADR-158 mints for JS/TS.
describe('Python symbol extraction (ADR-192)', () => {
  beforeEach(() => resetGraph())

  const SVC = 'orders-py'
  const REL = 'orders.py'
  const sym = (qualname: string) => symbolId(SVC, REL, qualname)

  it('mints a SymbolNode per def / async def / method / __init__ / class', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const expected: [string, SymbolNode['kind']][] = [
      ['create_order', 'function'],
      ['list_orders', 'function'], // async def is the same node type
      ['OrderService', 'class'],
      ['OrderService.__init__', 'constructor'], // __init__ maps to constructor
      ['OrderService.create', 'method'],
      ['OrderService.validate', 'method'], // decorated (@staticmethod) still a method
      ['_compute_total', 'function'],
      ['_fetch_all', 'function'],
    ]

    for (const [qualname, kind] of expected) {
      const node = graph.getNodeAttributes(sym(qualname)) as SymbolNode
      expect(node?.type, `missing symbol ${qualname}`).toBe(NodeType.SymbolNode)
      expect(node.kind, `kind for ${qualname}`).toBe(kind)
      expect(node.qualname).toBe(qualname)
      expect(node.service).toBe(SVC)
      expect(node.relPath).toBe(REL)
      expect(node.discoveredVia).toBe('static')
    }
  })

  it('records the real definition span, and the method span nests inside the class span', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const topLevel = graph.getNodeAttributes(sym('create_order')) as SymbolNode
    expect(topLevel.span.startLine).toBe(4)
    expect(topLevel.span.endLine).toBeGreaterThanOrEqual(topLevel.span.startLine)

    const cls = graph.getNodeAttributes(sym('OrderService')) as SymbolNode
    const create = graph.getNodeAttributes(sym('OrderService.create')) as SymbolNode
    expect(create.span.startLine).toBeGreaterThan(cls.span.startLine)
    expect(create.span.endLine).toBeLessThan(cls.span.endLine)
    expect(create.span.endLine).toBeGreaterThan(create.span.startLine)

    // A def nested inside a method stays a plain function — method-ness comes from
    // direct class-body membership, so no bogus `OrderService._compute_total`.
    expect(graph.hasNode(sym('OrderService._compute_total'))).toBe(false)
  })

  it('owns each symbol through an EXTRACTED file ──CONTAINS──▶ symbol edge carrying file:line evidence', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const fnode = fileId(SVC, REL)
    const containsId = extractedEdgeId(fnode, sym('OrderService.create'), EdgeType.CONTAINS)
    expect(graph.hasEdge(containsId)).toBe(true)
    const contains = graph.getEdgeAttributes(containsId) as GraphEdge
    expect(contains.source).toBe(fnode)
    expect(contains.provenance).toBe(Provenance.EXTRACTED)
    expect(contains.evidence?.file).toBe(REL)
    expect(contains.evidence?.line).toBe(
      (graph.getNodeAttributes(sym('OrderService.create')) as SymbolNode).span.startLine,
    )
  })
})

describe('Go symbol extraction (ADR-192)', () => {
  beforeEach(() => resetGraph())

  const SVC = 'orders-go'
  const REL = 'orders.go'
  const sym = (qualname: string) => symbolId(SVC, REL, qualname)

  it('mints a SymbolNode per func, and reads a method receiver into Receiver.method', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const expected: [string, SymbolNode['kind']][] = [
      ['NewServer', 'function'],
      ['Server.CreateOrder', 'method'], // (s *Server) receiver → Server.CreateOrder
      ['Server.ListOrders', 'method'],
      ['computeTotal', 'function'],
    ]

    for (const [qualname, kind] of expected) {
      const node = graph.getNodeAttributes(sym(qualname)) as SymbolNode
      expect(node?.type, `missing symbol ${qualname}`).toBe(NodeType.SymbolNode)
      expect(node.kind, `kind for ${qualname}`).toBe(kind)
      expect(node.qualname).toBe(qualname)
      expect(node.service).toBe(SVC)
      expect(node.relPath).toBe(REL)
      expect(node.discoveredVia).toBe('static')
    }

    // Go has no class; the struct type is not a symbol in this rung.
    expect(graph.hasNode(sym('Server'))).toBe(false)
  })

  it('records the real definition span for a method', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const create = graph.getNodeAttributes(sym('Server.CreateOrder')) as SymbolNode
    expect(create.span.startLine).toBe(13)
    expect(create.span.endLine).toBeGreaterThan(create.span.startLine)
  })

  it('owns each symbol through an EXTRACTED file ──CONTAINS──▶ symbol edge carrying file:line evidence', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const fnode = fileId(SVC, REL)
    const containsId = extractedEdgeId(fnode, sym('Server.CreateOrder'), EdgeType.CONTAINS)
    expect(graph.hasEdge(containsId)).toBe(true)
    const contains = graph.getEdgeAttributes(containsId) as GraphEdge
    expect(contains.provenance).toBe(Provenance.EXTRACTED)
    expect(contains.evidence?.file).toBe(REL)
    expect(contains.evidence?.line).toBe(13)
  })
})
