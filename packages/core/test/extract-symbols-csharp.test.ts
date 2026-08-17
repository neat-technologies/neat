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

// ADR-196 — symbol grain reaches C#/.NET, the fifth language on the same walker
// pattern ADR-192 built for Python and Go and ADR-193/ADR-195 extended to Ruby and
// PHP. The fixture is a real `.csproj` service with two source files: `cart.cs`
// uses a block `namespace Cart.Services { … }` carrying a class with a constructor /
// an instance method / a static method, an interface, a struct, and a positional
// record; `checkout.cs` uses a C# 10 file-scoped `namespace Cart.Checkout;` with a
// class and a nested type. Every definition becomes a SymbolNode owned by its file
// through a `file ──CONTAINS──▶ symbol` edge, the exact shape ADR-158 mints for
// JS/TS. C# already writes namespaces and members with `.`, so the qualname joins
// the nesting with a plain `.` and reduces under ingest's `terminalName` (last-`.`
// split) to the bare method name.
describe('C# symbol extraction (ADR-196)', () => {
  beforeEach(() => resetGraph())

  const SVC = 'cart'
  const CART = 'cart.cs'
  const CHECKOUT = 'checkout.cs'
  const sym = (relPath: string, qualname: string) => symbolId(SVC, relPath, qualname)

  it('mints a SymbolNode per method / constructor / class / interface / struct / record', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const expected: [string, string, SymbolNode['kind']][] = [
      [CART, 'Cart.Services.CartService', 'class'],
      [CART, 'Cart.Services.CartService.CartService', 'constructor'], // ctor name = type name
      [CART, 'Cart.Services.CartService.AddItem', 'method'],
      [CART, 'Cart.Services.CartService.DefaultRate', 'method'], // static method
      [CART, 'Cart.Services.ICartRepo', 'class'], // interface mints as a class-kind node
      [CART, 'Cart.Services.ICartRepo.Save', 'method'], // abstract method, no body — still a symbol
      [CART, 'Cart.Services.Money', 'class'], // struct mints as a class-kind node
      [CART, 'Cart.Services.Item', 'class'], // positional record mints as a class-kind node
      [CHECKOUT, 'Cart.Checkout.CheckoutService', 'class'], // file-scoped `namespace X;` threads
      [CHECKOUT, 'Cart.Checkout.CheckoutService.Total', 'method'],
      [CHECKOUT, 'Cart.Checkout.CheckoutService.Receipt', 'class'], // nested type
      [CHECKOUT, 'Cart.Checkout.CheckoutService.Receipt.Render', 'method'],
    ]

    for (const [relPath, qualname, kind] of expected) {
      const node = graph.getNodeAttributes(sym(relPath, qualname)) as SymbolNode
      expect(node?.type, `missing symbol ${qualname}`).toBe(NodeType.SymbolNode)
      expect(node.kind, `kind for ${qualname}`).toBe(kind)
      expect(node.qualname).toBe(qualname)
      expect(node.service).toBe(SVC)
      expect(node.relPath).toBe(relPath)
      expect(node.discoveredVia).toBe('static')
    }

    // The file-scoped namespace threads onto the class that follows it, so
    // CheckoutService lands under Cart.Checkout, never Cart.Services.
    expect(graph.hasNode(sym(CHECKOUT, 'Cart.Services.CheckoutService'))).toBe(false)
    // A nested type reads its parent type into the qualname, never the bare name.
    expect(graph.hasNode(sym(CHECKOUT, 'Cart.Checkout.Receipt'))).toBe(false)
  })

  it('records the real definition span and nests members inside their type', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const cls = graph.getNodeAttributes(sym(CART, 'Cart.Services.CartService')) as SymbolNode
    expect(cls.span.startLine).toBe(5)

    const ctor = graph.getNodeAttributes(
      sym(CART, 'Cart.Services.CartService.CartService'),
    ) as SymbolNode
    const add = graph.getNodeAttributes(sym(CART, 'Cart.Services.CartService.AddItem')) as SymbolNode
    expect(add.span.startLine).toBe(14)
    expect(add.span.endLine).toBe(18)
    // Each member's span sits inside the class's.
    expect(ctor.span.startLine).toBeGreaterThan(cls.span.startLine)
    expect(add.span.endLine).toBeLessThan(cls.span.endLine)

    // The nested Receipt type sits wholly inside CheckoutService.
    const outer = graph.getNodeAttributes(
      sym(CHECKOUT, 'Cart.Checkout.CheckoutService'),
    ) as SymbolNode
    const inner = graph.getNodeAttributes(
      sym(CHECKOUT, 'Cart.Checkout.CheckoutService.Receipt'),
    ) as SymbolNode
    expect(inner.span.startLine).toBeGreaterThan(outer.span.startLine)
    expect(inner.span.endLine).toBeLessThan(outer.span.endLine)
  })

  it('owns each symbol through an EXTRACTED file ──CONTAINS──▶ symbol edge carrying file:line evidence', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const fnode = fileId(SVC, CART)
    const sid = sym(CART, 'Cart.Services.CartService.AddItem')
    const containsId = extractedEdgeId(fnode, sid, EdgeType.CONTAINS)
    expect(graph.hasEdge(containsId)).toBe(true)
    const contains = graph.getEdgeAttributes(containsId) as GraphEdge
    expect(contains.source).toBe(fnode)
    expect(contains.provenance).toBe(Provenance.EXTRACTED)
    expect(contains.evidence?.file).toBe(CART)
    expect(contains.evidence?.line).toBe(
      (graph.getNodeAttributes(sid) as SymbolNode).span.startLine,
    )
  })
})

// ADR-196 — the nested layout, where the `.csproj` and its `.cs` sit in a `src/`
// subdirectory of the service root (the otel-demo `cart` shape) rather than flat
// beside each other (the `cart-csharp` fixture / accounting shape). The broadened
// discovery looks in the `src/` child, so scanning the service root directly still
// mints the service anchored on `src/` and grains its source into SymbolNodes — the
// same climb the flat layout makes.
describe('C# symbol extraction, nested src/ layout (ADR-196)', () => {
  beforeEach(() => resetGraph())

  const ROOT = path.resolve(FIXTURES, 'checkout-csharp')
  const SVC = 'checkout'
  const FILE = 'checkout.cs'
  const sym = (qualname: string) => symbolId(SVC, FILE, qualname)

  it('discovers the src/-nested service and grains its source into SymbolNodes', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, ROOT)

    const expected: [string, SymbolNode['kind']][] = [
      ['Checkout.Services.CheckoutService', 'class'],
      ['Checkout.Services.CheckoutService.CheckoutService', 'constructor'],
      ['Checkout.Services.CheckoutService.Total', 'method'],
    ]
    for (const [qualname, kind] of expected) {
      const node = graph.getNodeAttributes(sym(qualname)) as SymbolNode
      expect(node?.type, `missing symbol ${qualname}`).toBe(NodeType.SymbolNode)
      expect(node.kind, `kind for ${qualname}`).toBe(kind)
      expect(node.service).toBe(SVC)
      expect(node.relPath).toBe(FILE)
      expect(node.discoveredVia).toBe('static')
    }
  })
})
