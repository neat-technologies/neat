import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { parseOtlpRequest, type OtlpTracesRequest } from '../src/otel.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import type { GraphEdge, SymbolNode } from '@neat.is/types'
import { EdgeType, NodeType, Provenance, extractedEdgeId, fileId, symbolId } from '@neat.is/types'

// ADR-192 — the load-bearing invariant. Symbol extraction is only worth its keep
// if an OBSERVED span fuses onto the SymbolNode static minted, at symbol grain,
// on ONE node. These tests run the real extractor over a Python and a Go fixture,
// then push a real OTLP span carrying a `code.*` call site inside one function's
// definition span through parseOtlpRequest → handleSpan, and assert the observed
// edge originates from the SAME SymbolNode — never a twin.
//
// The fusion key is span containment: ingest lands the observed edge on the
// SymbolNode whose `{startLine, endLine}` brackets the span's `code.lineno`, with
// `code.function` (the qualname's terminal name) the tiebreaker — the same join
// JS/TS rides (ingest.ts landObservedSymbol, ADR-158 §4). If the extracted id and
// the observed line ever key different nodes, the graph twins instead of fusing,
// which is exactly what these tests catch.
//
// The span carries the prior-convention `code.filepath` / `code.function` /
// `code.lineno` — the names today's ingest reads (`codeFilepathOf` et al.). The
// stable semconv names (`code.file.path` …) are a separate ingest item (ADR-193).

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'symbols-polyglot')

function ctxFor(): IngestContext {
  return { graph: getGraph(), errorsPath: path.join(os.tmpdir(), 'neat-1017-errors.ndjson') }
}

// One OTLP resource span, the shape an OTel exporter POSTs to /v1/traces.
function otlp(
  service: string,
  attrs: Record<string, string | number>,
  kind: number,
): OtlpTracesRequest {
  const attributes = Object.entries(attrs).map(([key, value]) =>
    typeof value === 'number'
      ? { key, value: { intValue: String(value) } }
      : { key, value: { stringValue: value } },
  )
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'aabbccddeeff00112233445566778899',
                spanId: '1111111111111111',
                name: `${service} db span`,
                kind,
                startTimeUnixNano: '1000000000000000000',
                endTimeUnixNano: '1000000000050000000',
                attributes,
                status: { code: 0 },
              },
            ],
          },
        ],
      },
    ],
  }
}

// Count SymbolNodes matching (service, relPath, qualname) regardless of
// provenance — fusion means exactly one, twinning means two.
function symbolNodesFor(service: string, relPath: string, qualname: string): SymbolNode[] {
  const graph = getGraph()
  const out: SymbolNode[] = []
  graph.forEachNode((_id, a) => {
    const n = a as SymbolNode
    if (
      n.type === NodeType.SymbolNode &&
      n.service === service &&
      n.relPath === relPath &&
      n.qualname === qualname
    ) {
      out.push(n)
    }
  })
  return out
}

// The OBSERVED edges that originate from a given node.
function observedEdgesFrom(source: string): GraphEdge[] {
  const graph = getGraph()
  const out: GraphEdge[] = []
  graph.forEachEdge((_id, a) => {
    const e = a as GraphEdge
    if (e.source === source && e.provenance === Provenance.OBSERVED) out.push(e)
  })
  return out
}

const WIRE_CLIENT = 3

describe('Python symbol grain fuses declared with observed (#1017)', () => {
  beforeEach(() => resetGraph())

  it('an observed DB CLIENT span whose code.* falls inside a method fuses onto the extracted SymbolNode', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // EXTRACTED: `OrderService.create` under orders.py, owned by its file.
    const sid = symbolId('orders-py', 'orders.py', 'OrderService.create')
    const created = graph.getNodeAttributes(sid) as SymbolNode
    expect(created.type).toBe(NodeType.SymbolNode)
    expect(created.discoveredVia).toBe('static')
    const fnode = fileId('orders-py', 'orders.py')
    expect(graph.hasEdge(extractedEdgeId(fnode, sid, EdgeType.CONTAINS))).toBe(true)

    // OBSERVED: a real psycopg CLIENT span (wire kind 3) whose call site is a line
    // inside `OrderService.create` and whose `code.function` names it. The span
    // reports the deployed `/app/orders.py`; it reconciles onto the extracted
    // `orders.py`, then lands one grain finer than the file — on the method.
    const callLine = created.span.startLine + 1
    expect(callLine).toBeLessThanOrEqual(created.span.endLine)
    const [span] = parseOtlpRequest(
      otlp(
        'orders-py',
        {
          'db.system': 'postgresql',
          'db.name': 'ordersdb',
          'server.address': 'db.internal',
          'code.filepath': '/app/orders.py',
          'code.lineno': callLine,
          'code.function': 'create',
        },
        WIRE_CLIENT,
      ),
    )
    await handleSpan(ctxFor(), span!)

    // FUSION: exactly one `OrderService.create` node — still the static one, no
    // OTel twin — and the observed CONNECTS_TO originates from it at symbol grain.
    const nodes = symbolNodesFor('orders-py', 'orders.py', 'OrderService.create')
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.id).toBe(sid)
    expect(nodes[0]!.discoveredVia).toBe('static')

    const observed = observedEdgesFrom(sid).filter((e) => e.type === EdgeType.CONNECTS_TO)
    expect(observed).toHaveLength(1)
    expect(observed[0]!.provenance).toBe(Provenance.OBSERVED)

    // Both provenances meet on the one symbol: the EXTRACTED file → symbol
    // ownership and the OBSERVED edge that originates from the symbol.
    expect(graph.hasEdge(extractedEdgeId(fnode, sid, EdgeType.CONTAINS))).toBe(true)
  })
})

describe('Go symbol grain fuses declared with observed (#1017)', () => {
  beforeEach(() => resetGraph())

  it('an observed DB CLIENT span whose code.* falls inside a method fuses onto the extracted SymbolNode', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // EXTRACTED: `Server.CreateOrder` under orders.go (receiver → Server.CreateOrder).
    const sid = symbolId('orders-go', 'orders.go', 'Server.CreateOrder')
    const created = graph.getNodeAttributes(sid) as SymbolNode
    expect(created.type).toBe(NodeType.SymbolNode)
    expect(created.discoveredVia).toBe('static')
    const fnode = fileId('orders-go', 'orders.go')
    expect(graph.hasEdge(extractedEdgeId(fnode, sid, EdgeType.CONTAINS))).toBe(true)

    // OBSERVED: a real database/sql CLIENT span whose call site is inside
    // `Server.CreateOrder`. `code.function` may arrive package-qualified from Go
    // instrumentation, but the line-in-span join lands it regardless.
    const callLine = created.span.startLine + 2
    expect(callLine).toBeLessThanOrEqual(created.span.endLine)
    const [span] = parseOtlpRequest(
      otlp(
        'orders-go',
        {
          'db.system': 'postgresql',
          'db.name': 'ordersdb',
          'server.address': 'db.internal',
          'code.filepath': '/app/orders.go',
          'code.lineno': callLine,
          'code.function': 'CreateOrder',
        },
        WIRE_CLIENT,
      ),
    )
    await handleSpan(ctxFor(), span!)

    const nodes = symbolNodesFor('orders-go', 'orders.go', 'Server.CreateOrder')
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.id).toBe(sid)
    expect(nodes[0]!.discoveredVia).toBe('static')

    const observed = observedEdgesFrom(sid).filter((e) => e.type === EdgeType.CONNECTS_TO)
    expect(observed).toHaveLength(1)
    expect(observed[0]!.provenance).toBe(Provenance.OBSERVED)
    expect(graph.hasEdge(extractedEdgeId(fnode, sid, EdgeType.CONTAINS))).toBe(true)
  })
})

describe('Ruby symbol grain fuses declared with observed (#1019)', () => {
  beforeEach(() => resetGraph())

  it('an observed DB CLIENT span whose code.* falls inside a method fuses onto the extracted SymbolNode', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // EXTRACTED: `OrderService.create` under orders.rb, owned by its file. Ruby's
    // `Class#method` reduces to the same dotted qualname JS/TS and Python mint.
    const sid = symbolId('orders-rb', 'orders.rb', 'OrderService.create')
    const created = graph.getNodeAttributes(sid) as SymbolNode
    expect(created.type).toBe(NodeType.SymbolNode)
    expect(created.discoveredVia).toBe('static')
    const fnode = fileId('orders-rb', 'orders.rb')
    expect(graph.hasEdge(extractedEdgeId(fnode, sid, EdgeType.CONTAINS))).toBe(true)

    // OBSERVED: a real pg CLIENT span (wire kind 3) whose call site is a line inside
    // `OrderService.create` and whose `code.function` names it. The span reports the
    // deployed `/app/orders.rb`; it reconciles onto the extracted `orders.rb`, then
    // lands one grain finer than the file — on the method.
    const callLine = created.span.startLine + 1
    expect(callLine).toBeLessThanOrEqual(created.span.endLine)
    const [span] = parseOtlpRequest(
      otlp(
        'orders-rb',
        {
          'db.system': 'postgresql',
          'db.name': 'ordersdb',
          'server.address': 'db.internal',
          'code.filepath': '/app/orders.rb',
          'code.lineno': callLine,
          'code.function': 'create',
        },
        WIRE_CLIENT,
      ),
    )
    await handleSpan(ctxFor(), span!)

    // FUSION: exactly one `OrderService.create` node — still the static one, no OTel
    // twin — and the observed CONNECTS_TO originates from it at symbol grain.
    const nodes = symbolNodesFor('orders-rb', 'orders.rb', 'OrderService.create')
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.id).toBe(sid)
    expect(nodes[0]!.discoveredVia).toBe('static')

    const observed = observedEdgesFrom(sid).filter((e) => e.type === EdgeType.CONNECTS_TO)
    expect(observed).toHaveLength(1)
    expect(observed[0]!.provenance).toBe(Provenance.OBSERVED)
    expect(graph.hasEdge(extractedEdgeId(fnode, sid, EdgeType.CONTAINS))).toBe(true)
  })
})
