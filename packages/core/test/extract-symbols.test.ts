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
const FIXTURES = path.resolve(__dirname, 'fixtures', 'symbols')

// ADR-158 Phase 1 — static symbol nodes under files. The fixture is a real
// service file with a top-level function, an arrow-const function, and a class
// with a constructor and a method. Each definition becomes a SymbolNode owned by
// its file through a `file ──CONTAINS──▶ symbol` edge.
describe('static symbol extraction (ADR-158)', () => {
  beforeEach(() => resetGraph())

  const REL = 'src/orders.ts'
  const sym = (qualname: string) => symbolId('sym-svc', REL, qualname)

  it('mints a SymbolNode per function / method / constructor / class definition', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const createOrder = graph.getNodeAttributes(sym('createOrder')) as SymbolNode
    expect(createOrder.type).toBe(NodeType.SymbolNode)
    expect(createOrder.kind).toBe('function')
    expect(createOrder.qualname).toBe('createOrder')
    expect(createOrder.service).toBe('sym-svc')
    expect(createOrder.relPath).toBe(REL)
    expect(createOrder.discoveredVia).toBe('static')

    // Arrow-const function form: `export const listOrders = async () => {}`.
    const listOrders = graph.getNodeAttributes(sym('listOrders')) as SymbolNode
    expect(listOrders.kind).toBe('function')

    const cls = graph.getNodeAttributes(sym('OrderService')) as SymbolNode
    expect(cls.kind).toBe('class')

    const ctor = graph.getNodeAttributes(sym('OrderService.constructor')) as SymbolNode
    expect(ctor.kind).toBe('constructor')

    const create = graph.getNodeAttributes(sym('OrderService.create')) as SymbolNode
    expect(create.kind).toBe('method')
  })

  it('records the definition span with startLine <= endLine, and the method span nests inside the class span', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const cls = graph.getNodeAttributes(sym('OrderService')) as SymbolNode
    const create = graph.getNodeAttributes(sym('OrderService.create')) as SymbolNode

    expect(cls.span.startLine).toBeGreaterThan(0)
    expect(cls.span.endLine).toBeGreaterThanOrEqual(cls.span.startLine)

    // The method definition is strictly inside the class definition.
    expect(create.span.startLine).toBeGreaterThan(cls.span.startLine)
    expect(create.span.endLine).toBeLessThan(cls.span.endLine)
    expect(create.span.endLine).toBeGreaterThan(create.span.startLine)

    // The `return this.db.save(...)` line an observed span points at is inside
    // the method's span.
    const callLine = 24
    expect(callLine).toBeGreaterThanOrEqual(create.span.startLine)
    expect(callLine).toBeLessThanOrEqual(create.span.endLine)
  })

  it('extracts heavily type-annotated TypeScript — generics, typed signatures, typed arrow-const, a generic class (the TS grammar, not JS)', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const TREL = 'src/typed.ts'
    const tsym = (qualname: string) => symbolId('sym-svc', TREL, qualname)

    // Every one of these is swallowed by the tree-sitter-javascript grammar's
    // error recovery on TS type syntax; all must be present via the TS grammar.
    const expected = [
      ['mapValues', 'function'],
      ['clamp', 'function'],
      ['fetchJson', 'function'],
      ['Box', 'class'],
      ['Box.constructor', 'constructor'],
      ['Box.get', 'method'],
    ] as const

    for (const [qualname, kind] of expected) {
      expect(graph.hasNode(tsym(qualname)), `missing symbol ${qualname}`).toBe(true)
      expect((graph.getNodeAttributes(tsym(qualname)) as SymbolNode).kind).toBe(kind)
    }

    // No keyword/garbage symbol from a mis-parse (the JS grammar emitted a
    // spurious `method "if"` on real TS; the TS grammar must not).
    const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'return'])
    graph.forEachNode((_id, a) => {
      if ((a as SymbolNode).type === NodeType.SymbolNode) {
        expect(keywords.has((a as SymbolNode).qualname)).toBe(false)
      }
    })
  })

  it('owns each symbol through an EXTRACTED file ──CONTAINS──▶ symbol edge carrying file:line evidence', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const fnode = fileId('sym-svc', REL)
    const containsId = extractedEdgeId(fnode, sym('OrderService.create'), EdgeType.CONTAINS)
    expect(graph.hasEdge(containsId)).toBe(true)
    const contains = graph.getEdgeAttributes(containsId) as GraphEdge
    expect(contains.source).toBe(fnode)
    expect(contains.type).toBe(EdgeType.CONTAINS)
    expect(contains.provenance).toBe(Provenance.EXTRACTED)
    expect(contains.evidence?.file).toBe(REL)
    expect(contains.evidence?.line).toBeGreaterThan(0)
  })
})
