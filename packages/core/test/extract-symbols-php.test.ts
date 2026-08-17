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

// ADR-195 — symbol grain reaches PHP, the fourth language on the same walker
// pattern ADR-192 built for Python and Go and ADR-193 extended to Ruby. The
// fixture is a real composer.json service with one source file carrying a
// namespaced top-level function, a class with a `__construct` constructor / an
// instance method / a static method, a trait, an interface, and a second
// `namespace X;` whose class proves the ambient-namespace threading. Every
// definition becomes a SymbolNode owned by its file through a
// `file ──CONTAINS──▶ symbol` edge, the exact shape ADR-158 mints for JS/TS. PHP
// writes namespaces with `\` and static members with `::`; the qualname joins the
// nesting with a plain `.` so it reduces under ingest's `terminalName`
// (last-`.` split) to the bare method name.
describe('PHP symbol extraction (ADR-195)', () => {
  beforeEach(() => resetGraph())

  const SVC = 'quote-php'
  const REL = 'quote.php'
  const sym = (qualname: string) => symbolId(SVC, REL, qualname)

  it('mints a SymbolNode per function / method / __construct / class / trait / interface', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const expected: [string, SymbolNode['kind']][] = [
      ['App.Quote.format_money', 'function'], // namespaced top-level function
      ['App.Quote.QuoteService', 'class'],
      ['App.Quote.QuoteService.__construct', 'constructor'], // __construct → constructor
      ['App.Quote.QuoteService.calculate', 'method'],
      ['App.Quote.QuoteService.default_rate', 'method'], // static method
      ['App.Quote.Loggable', 'class'], // trait mints as a class-kind node
      ['App.Quote.Loggable.log', 'method'],
      ['App.Quote.Priceable', 'class'], // interface mints as a class-kind node
      ['App.Quote.Priceable.price', 'method'], // abstract method, no body — still a symbol
      ['App.Other.Widget', 'class'], // second `namespace X;` → ambient namespace threads
      ['App.Other.Widget.build', 'method'],
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

    // The `\` namespace separator and `::` member separator are normalized to `.`,
    // so a backslash-form id is never minted.
    expect(graph.hasNode(sym('App\\Quote\\QuoteService'))).toBe(false)
    expect(graph.hasNode(sym('App\\Quote\\QuoteService::calculate'))).toBe(false)
  })

  it('records the real definition span, nests methods inside their class, and threads the ambient namespace', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const fn = graph.getNodeAttributes(sym('App.Quote.format_money')) as SymbolNode
    expect(fn.span.startLine).toBe(6)
    expect(fn.span.endLine).toBeGreaterThanOrEqual(fn.span.startLine)

    const cls = graph.getNodeAttributes(sym('App.Quote.QuoteService')) as SymbolNode
    const ctor = graph.getNodeAttributes(sym('App.Quote.QuoteService.__construct')) as SymbolNode
    const calc = graph.getNodeAttributes(sym('App.Quote.QuoteService.calculate')) as SymbolNode
    // Each method's span sits inside the class's.
    expect(ctor.span.startLine).toBeGreaterThan(cls.span.startLine)
    expect(calc.span.endLine).toBeLessThan(cls.span.endLine)
    expect(calc.span.endLine).toBeGreaterThan(calc.span.startLine)

    // The second `namespace App\Other;` is a semicolon form with no body — its
    // ambient namespace still reaches the class that follows it, so Widget lands
    // under App.Other, never App.Quote.
    expect(graph.hasNode(sym('App.Quote.Widget'))).toBe(false)
    const widget = graph.getNodeAttributes(sym('App.Other.Widget')) as SymbolNode
    expect(widget.span.startLine).toBeGreaterThan(cls.span.endLine)
  })

  it('owns each symbol through an EXTRACTED file ──CONTAINS──▶ symbol edge carrying file:line evidence', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const fnode = fileId(SVC, REL)
    const containsId = extractedEdgeId(fnode, sym('App.Quote.QuoteService.calculate'), EdgeType.CONTAINS)
    expect(graph.hasEdge(containsId)).toBe(true)
    const contains = graph.getEdgeAttributes(containsId) as GraphEdge
    expect(contains.source).toBe(fnode)
    expect(contains.provenance).toBe(Provenance.EXTRACTED)
    expect(contains.evidence?.file).toBe(REL)
    expect(contains.evidence?.line).toBe(
      (graph.getNodeAttributes(sym('App.Quote.QuoteService.calculate')) as SymbolNode).span.startLine,
    )
  })
})
