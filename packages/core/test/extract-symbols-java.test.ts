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

// ADR-197 — symbol grain reaches Java, the sixth language on the same walker pattern
// ADR-192 built for Python and Go and ADR-193/ADR-195/ADR-196 extended to Ruby, PHP,
// and C#. The fixture is a real Gradle service with two source files:
// `CartService.java` declares `package com.example.cart;` carrying a class with a
// constructor / an instance method / a static method, an interface, an enum, and a
// record; `Checkout.java` declares a second package `com.example.checkout;` with a
// class and a nested type. Every definition becomes a SymbolNode owned by its file
// through a `file ──CONTAINS──▶ symbol` edge, the exact shape ADR-158 mints for
// JS/TS. Java writes packages and members with `.`, so the qualname joins the file's
// package and the type nesting with a plain `.` and reduces under ingest's
// `terminalName` (last-`.` split) to the bare method name.
describe('Java symbol extraction (ADR-197)', () => {
  beforeEach(() => resetGraph())

  const SVC = 'cart-java'
  const CART = 'CartService.java'
  const CHECKOUT = 'Checkout.java'
  const sym = (relPath: string, qualname: string) => symbolId(SVC, relPath, qualname)

  it('mints a SymbolNode per method / constructor / class / interface / enum / record', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const expected: [string, string, SymbolNode['kind']][] = [
      [CART, 'com.example.cart.CartService', 'class'],
      [CART, 'com.example.cart.CartService.CartService', 'constructor'], // ctor name = type name
      [CART, 'com.example.cart.CartService.addItem', 'method'],
      [CART, 'com.example.cart.CartService.defaultRate', 'method'], // static method
      [CART, 'com.example.cart.ICartRepo', 'class'], // interface mints as a class-kind node
      [CART, 'com.example.cart.ICartRepo.save', 'method'], // abstract method, no body — still a symbol
      [CART, 'com.example.cart.Status', 'class'], // enum mints as a class-kind node
      [CART, 'com.example.cart.Item', 'class'], // record mints as a class-kind node
      [CHECKOUT, 'com.example.checkout.CheckoutService', 'class'], // second file's package threads
      [CHECKOUT, 'com.example.checkout.CheckoutService.total', 'method'],
      [CHECKOUT, 'com.example.checkout.CheckoutService.Receipt', 'class'], // nested type
      [CHECKOUT, 'com.example.checkout.CheckoutService.Receipt.render', 'method'],
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

    // Each file's own `package` prefixes its types, so CheckoutService lands under
    // com.example.checkout, never com.example.cart.
    expect(graph.hasNode(sym(CHECKOUT, 'com.example.cart.CheckoutService'))).toBe(false)
    // The package prefix is always applied — never the bare type name.
    expect(graph.hasNode(sym(CART, 'CartService'))).toBe(false)
    // A nested type reads its parent type into the qualname, never the bare name.
    expect(graph.hasNode(sym(CHECKOUT, 'com.example.checkout.Receipt'))).toBe(false)
  })

  it('records the real definition span and nests members inside their type', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const cls = graph.getNodeAttributes(sym(CART, 'com.example.cart.CartService')) as SymbolNode
    expect(cls.span.startLine).toBe(5)

    const ctor = graph.getNodeAttributes(
      sym(CART, 'com.example.cart.CartService.CartService'),
    ) as SymbolNode
    const add = graph.getNodeAttributes(
      sym(CART, 'com.example.cart.CartService.addItem'),
    ) as SymbolNode
    expect(add.span.startLine).toBe(12)
    expect(add.span.endLine).toBe(15)
    // Each member's span sits inside the class's.
    expect(ctor.span.startLine).toBeGreaterThan(cls.span.startLine)
    expect(add.span.endLine).toBeLessThan(cls.span.endLine)

    // The nested Receipt type sits wholly inside CheckoutService.
    const outer = graph.getNodeAttributes(
      sym(CHECKOUT, 'com.example.checkout.CheckoutService'),
    ) as SymbolNode
    const inner = graph.getNodeAttributes(
      sym(CHECKOUT, 'com.example.checkout.CheckoutService.Receipt'),
    ) as SymbolNode
    expect(inner.span.startLine).toBeGreaterThan(outer.span.startLine)
    expect(inner.span.endLine).toBeLessThan(outer.span.endLine)
  })

  it('owns each symbol through an EXTRACTED file ──CONTAINS──▶ symbol edge carrying file:line evidence', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const fnode = fileId(SVC, CART)
    const sid = sym(CART, 'com.example.cart.CartService.addItem')
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
