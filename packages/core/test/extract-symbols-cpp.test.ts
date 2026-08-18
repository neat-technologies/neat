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

// ADR-202 — symbol grain reaches C++, the last OpenTelemetry-Demo language on the
// walker pattern ADR-192 built for Python and Go. The fixture is the otel-demo
// `currency` shape: a `CMakeLists.txt` with `project(currency)`, a `currency.cpp`
// carrying a class whose constructor and one method are defined OUT OF LINE
// (`CurrencyService::CurrencyService`, `CurrencyService::convert`) plus one inline
// method, a template function, and a free function; and a `money.hpp` header (proving
// `.hpp` extraction) with a class whose constructor and methods are inline and a
// struct. C++ addresses members with `::`, and the walker keeps that native form the
// way the Rust walker does — a namespace's items read `ns::item`, a class's methods
// read `ns::Class::method`, an out-of-line definition keys onto the class named in its
// `Class::` prefix. A `namespace` scopes the qualname but is not itself a symbol.
describe('C++ symbol extraction (ADR-202)', () => {
  beforeEach(() => resetGraph())

  const SVC = 'currency'
  const CURRENCY = 'currency.cpp'
  const MONEY = 'money.hpp'
  const sym = (relPath: string, qualname: string) => symbolId(SVC, relPath, qualname)

  it('mints a SymbolNode per free fn / method / constructor / class / struct, keyed by the C++ `::` path', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const expected: [string, string, SymbolNode['kind']][] = [
      // currency.cpp — a class, an inline method, an out-of-line constructor, an
      // out-of-line method, a template function, and a free function.
      [CURRENCY, 'currency::CurrencyService', 'class'],
      [CURRENCY, 'currency::CurrencyService::supports', 'method'], // inline method
      [CURRENCY, 'currency::CurrencyService::CurrencyService', 'constructor'], // out-of-line ctor
      [CURRENCY, 'currency::CurrencyService::convert', 'method'], // out-of-line method
      [CURRENCY, 'currency::clamp_non_negative', 'function'], // template free fn
      [CURRENCY, 'currency::round_rate', 'function'], // free fn
      // money.hpp — a header parses too; struct mints as a class-kind node.
      [MONEY, 'currency::Money', 'class'],
      [MONEY, 'currency::Money::Money', 'constructor'], // inline ctor, name == class
      [MONEY, 'currency::Money::units', 'method'],
      [MONEY, 'currency::Money::code', 'method'], // returns const std::string& — reference return
      [MONEY, 'currency::Rate', 'class'], // struct mints as a class-kind node
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

    // A `namespace` scopes the qualname but is not itself a symbol.
    expect(graph.hasNode(sym(CURRENCY, 'currency'))).toBe(false)
    // The qualname keeps C++'s `::` separator, so the dotted form is never minted.
    expect(graph.hasNode(sym(CURRENCY, 'currency.CurrencyService.convert'))).toBe(false)
    // The namespace prefix is always applied — never the bare class or member name.
    expect(graph.hasNode(sym(CURRENCY, 'CurrencyService'))).toBe(false)
    expect(graph.hasNode(sym(CURRENCY, 'convert'))).toBe(false)
    // A declaration-only member in the class body (`Money convert(...) const;`) is not
    // a definition, so the out-of-line definition is the ONLY `convert` node — no twin.
    const convertNodes: SymbolNode[] = []
    graph.forEachNode((_id, a) => {
      const n = a as SymbolNode
      if (
        n.type === NodeType.SymbolNode &&
        n.service === SVC &&
        n.qualname === 'currency::CurrencyService::convert'
      ) {
        convertNodes.push(n)
      }
    })
    expect(convertNodes).toHaveLength(1)
    // A struct's fields are not symbols.
    expect(graph.hasNode(sym(MONEY, 'currency::Rate::factor'))).toBe(false)
  })

  it('records the real definition span, with an out-of-line method living apart from its class', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // The class body and the out-of-line method definition are separate, so the
    // method's span sits below the class's rather than inside it — the same shape the
    // Rust impl method takes, unlike a Java/Kotlin class body.
    const cls = graph.getNodeAttributes(sym(CURRENCY, 'currency::CurrencyService')) as SymbolNode
    expect(cls.span.startLine).toBe(7)
    expect(cls.span.endLine).toBe(17)

    const convert = graph.getNodeAttributes(
      sym(CURRENCY, 'currency::CurrencyService::convert'),
    ) as SymbolNode
    expect(convert.span.startLine).toBe(21)
    expect(convert.span.endLine).toBe(25)
    expect(convert.span.startLine).toBeGreaterThan(cls.span.endLine)

    // An inline method, by contrast, lives inside the class body.
    const supports = graph.getNodeAttributes(
      sym(CURRENCY, 'currency::CurrencyService::supports'),
    ) as SymbolNode
    expect(supports.span.startLine).toBeGreaterThan(cls.span.startLine)
    expect(supports.span.endLine).toBeLessThan(cls.span.endLine)
  })

  it('owns each symbol through an EXTRACTED file ──CONTAINS──▶ symbol edge carrying file:line evidence', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const fnode = fileId(SVC, CURRENCY)
    const sid = sym(CURRENCY, 'currency::CurrencyService::convert')
    const containsId = extractedEdgeId(fnode, sid, EdgeType.CONTAINS)
    expect(graph.hasEdge(containsId)).toBe(true)
    const contains = graph.getEdgeAttributes(containsId) as GraphEdge
    expect(contains.source).toBe(fnode)
    expect(contains.provenance).toBe(Provenance.EXTRACTED)
    expect(contains.evidence?.file).toBe(CURRENCY)
    expect(contains.evidence?.line).toBe(
      (graph.getNodeAttributes(sid) as SymbolNode).span.startLine,
    )
  })

  it('discovers the fixture as a cpp service named after the CMake project()', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const svc = graph.getNodeAttributes(serviceId(SVC))
    expect(svc?.type).toBe(NodeType.ServiceNode)
    expect((svc as { language?: string }).language).toBe('cpp')
  })
})
