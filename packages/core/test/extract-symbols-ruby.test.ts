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

// ADR-193 — symbol grain reaches Ruby, the third language on the same walker
// pattern ADR-192 built for Python and Go. The fixture is a real Gemfile service
// with one source file carrying top-level defs, an instance method, a `initialize`
// constructor, a `def self.` singleton (class) method, a module-nested class, and a
// `::` scope-resolution class name. Every definition becomes a SymbolNode owned by
// its file through a `file ──CONTAINS──▶ symbol` edge, the exact shape ADR-158
// mints for JS/TS. Ruby writes methods with `#` and namespaces with `::`; the
// qualname joins the nesting with a plain `.` so it reduces under ingest's
// `terminalName` (last-`.` split) to the bare method name.
describe('Ruby symbol extraction (ADR-193)', () => {
  beforeEach(() => resetGraph())

  const SVC = 'orders-rb'
  const REL = 'orders.rb'
  const sym = (qualname: string) => symbolId(SVC, REL, qualname)

  it('mints a SymbolNode per def / method / initialize / singleton_method / class / module', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const expected: [string, SymbolNode['kind']][] = [
      ['create_order', 'function'], // top-level def
      ['list_orders', 'function'],
      ['OrderService', 'class'],
      ['OrderService.initialize', 'constructor'], // initialize maps to constructor
      ['OrderService.create', 'method'],
      ['OrderService.validate', 'method'], // `def self.validate` singleton → class method
      ['Shop', 'class'], // module mints as a class-kind namespace
      ['Shop.Mailer', 'class'], // class nested in a module → Module.Class
      ['Shop.Mailer.deliver', 'method'],
      ['Billing.Invoice', 'class'], // `class Billing::Invoice` → `::` normalized to `.`
      ['Billing.Invoice.render', 'method'],
      ['compute_total', 'function'],
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

    // The `::` scope-resolution class name is normalized to a dotted qualname, so a
    // literal `Billing::Invoice` id is never minted.
    expect(graph.hasNode(sym('Billing::Invoice'))).toBe(false)
  })

  it('records the real definition span, and nests methods inside their class and module', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const topLevel = graph.getNodeAttributes(sym('create_order')) as SymbolNode
    expect(topLevel.span.startLine).toBe(3)
    expect(topLevel.span.endLine).toBeGreaterThanOrEqual(topLevel.span.startLine)

    const cls = graph.getNodeAttributes(sym('OrderService')) as SymbolNode
    const create = graph.getNodeAttributes(sym('OrderService.create')) as SymbolNode
    expect(create.span.startLine).toBeGreaterThan(cls.span.startLine)
    expect(create.span.endLine).toBeLessThan(cls.span.endLine)
    expect(create.span.endLine).toBeGreaterThan(create.span.startLine)

    // Module → class → method nesting: each span brackets the next.
    const mod = graph.getNodeAttributes(sym('Shop')) as SymbolNode
    const mailer = graph.getNodeAttributes(sym('Shop.Mailer')) as SymbolNode
    const deliver = graph.getNodeAttributes(sym('Shop.Mailer.deliver')) as SymbolNode
    expect(mailer.span.startLine).toBeGreaterThan(mod.span.startLine)
    expect(mailer.span.endLine).toBeLessThanOrEqual(mod.span.endLine)
    expect(deliver.span.startLine).toBeGreaterThan(mailer.span.startLine)
    expect(deliver.span.endLine).toBeLessThan(mailer.span.endLine)
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
