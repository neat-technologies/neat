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
  serviceId,
  symbolId,
} from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'symbols-polyglot')

// ADR-201 — symbol grain reaches Rust, the eighth language on the walker pattern
// ADR-192 built for Python and Go, and the last OpenTelemetry-Demo language before
// C++. The fixture is a Cargo crate (`Cargo.toml` with `[package] name = "shipping"`)
// with two source files: `shipping.rs` declares `mod quote { … }` carrying a struct, a
// trait (an abstract method signature + a default method), an inherent `impl` with two
// associated functions, an enum, and a nested `mod internal` with a free function, plus
// a top-level free function outside the module; `tracker.rs` declares a file-scope
// struct with an `impl` and a top-level function. Every definition becomes a SymbolNode
// owned by its file through a `file ──CONTAINS──▶ symbol` edge, the exact shape ADR-158
// mints for JS/TS. Rust addresses items with `::`, and the walker keeps that native
// form: a module's items read `module::item`, an impl's methods read
// `module::Type::method` keyed on the impl's target type, and a nested module threads
// `outer::inner::item`. A `mod` scopes the qualname but is not itself a symbol.
describe('Rust symbol extraction (ADR-201)', () => {
  beforeEach(() => resetGraph())

  const SVC = 'shipping'
  const SHIPPING = 'shipping.rs'
  const TRACKER = 'tracker.rs'
  const sym = (relPath: string, qualname: string) => symbolId(SVC, relPath, qualname)

  it('mints a SymbolNode per free fn / impl method / trait method / struct / enum / trait, keyed by the Rust `::` path', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const expected: [string, string, SymbolNode['kind']][] = [
      [SHIPPING, 'quote::Quote', 'class'], // struct mints as a class-kind node
      [SHIPPING, 'quote::Priced', 'class'], // trait mints as a class-kind node
      [SHIPPING, 'quote::Priced::price', 'method'], // abstract trait method (signature, no body) — still a symbol
      [SHIPPING, 'quote::Priced::is_free', 'method'], // default trait method
      [SHIPPING, 'quote::Quote::new', 'method'], // associated fn in an impl — a method, no constructor kind in Rust
      [SHIPPING, 'quote::Quote::price', 'method'], // impl method, keyed on the impl's target type
      [SHIPPING, 'quote::Carrier', 'class'], // enum mints as a class-kind node
      [SHIPPING, 'quote::internal::surcharge', 'function'], // nested-module free fn threads outer::inner
      [SHIPPING, 'ship_order', 'function'], // top-level fn, no module prefix
      [TRACKER, 'Tracker', 'class'], // file-scope struct, no module prefix
      [TRACKER, 'Tracker::new', 'method'],
      [TRACKER, 'Tracker::record', 'method'],
      [TRACKER, 'record_shipment', 'function'],
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

    // A `mod` scopes the qualname but is not itself a symbol.
    expect(graph.hasNode(sym(SHIPPING, 'quote'))).toBe(false)
    expect(graph.hasNode(sym(SHIPPING, 'quote::internal'))).toBe(false)
    // The module prefix is always applied inside a module — never the bare type name.
    expect(graph.hasNode(sym(SHIPPING, 'Quote'))).toBe(false)
    // The qualname keeps Rust's `::` separator, so the dotted form is never minted.
    expect(graph.hasNode(sym(SHIPPING, 'quote.Quote.price'))).toBe(false)
    // An impl block is not a symbol, and a struct's fields are not symbols.
    expect(graph.hasNode(sym(SHIPPING, 'quote::Quote::cost'))).toBe(false)
    // A file-scope type carries no module prefix, so the impl method reads Tracker::new.
    expect(graph.hasNode(sym(TRACKER, 'quote::Tracker'))).toBe(false)
  })

  it('records the real definition span, with an impl method living apart from its struct', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // The struct and its impl are separate items in Rust, so the method's span sits
    // below the struct's rather than inside it (unlike a Java/Kotlin class body).
    const struct = graph.getNodeAttributes(sym(SHIPPING, 'quote::Quote')) as SymbolNode
    expect(struct.span.startLine).toBe(4)
    expect(struct.span.endLine).toBe(6)

    const price = graph.getNodeAttributes(sym(SHIPPING, 'quote::Quote::price')) as SymbolNode
    expect(price.span.startLine).toBe(20)
    expect(price.span.endLine).toBe(23)
    expect(price.span.startLine).toBeGreaterThan(struct.span.endLine)

    // A trait's methods, by contrast, do live inside the trait body.
    const trait = graph.getNodeAttributes(sym(SHIPPING, 'quote::Priced')) as SymbolNode
    const sig = graph.getNodeAttributes(sym(SHIPPING, 'quote::Priced::price')) as SymbolNode
    expect(sig.span.startLine).toBeGreaterThan(trait.span.startLine)
    expect(sig.span.endLine).toBeLessThan(trait.span.endLine)
  })

  it('owns each symbol through an EXTRACTED file ──CONTAINS──▶ symbol edge carrying file:line evidence', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const fnode = fileId(SVC, SHIPPING)
    const sid = sym(SHIPPING, 'quote::Quote::price')
    const containsId = extractedEdgeId(fnode, sid, EdgeType.CONTAINS)
    expect(graph.hasEdge(containsId)).toBe(true)
    const contains = graph.getEdgeAttributes(containsId) as GraphEdge
    expect(contains.source).toBe(fnode)
    expect(contains.provenance).toBe(Provenance.EXTRACTED)
    expect(contains.evidence?.file).toBe(SHIPPING)
    expect(contains.evidence?.line).toBe(
      (graph.getNodeAttributes(sid) as SymbolNode).span.startLine,
    )
  })

  it('discovers the fixture as a rust service named after the Cargo `[package] name`', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const svc = graph.getNodeAttributes(serviceId(SVC))
    expect(svc?.type).toBe(NodeType.ServiceNode)
    expect((svc as { language?: string }).language).toBe('rust')
  })
})
