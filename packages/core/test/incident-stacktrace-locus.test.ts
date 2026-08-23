import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import { buildErrorEventForReceiver } from '../src/ingest.js'
import { computeDivergences } from '../src/divergences.js'
import {
  EdgeType,
  NodeType,
  Provenance,
  fileId,
  symbolId,
  serviceId,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import type { ParsedSpan } from '../src/otel.js'

// Stacktrace code-locus recovery (ADR-216).
//
// A Python `recommendation` service raises AttributeError at
// recommendation_server.py:96. OTel auto-instrumentation records the exception
// (exception.type / message / stacktrace) but stamps NO `code.*` span
// attributes. Before ADR-216 the incident degraded to `service:recommendation`
// and the code locus in the stacktrace was dropped; now the deepest application
// frame is parsed and joined to the FileNode/SymbolNode the graph already
// carries, so incidents, root-cause, and divergences all reach the file:line.

const SERVICE = 'recommendation'
const REL = 'recommendation_server.py'
const FILE = fileId(SERVICE, REL)
const SYM = symbolId(SERVICE, REL, 'get_product_list')

// The live traceback shape from the issue: two OTel library frames under
// site-packages, then the application frame that actually raised.
const STACKTRACE = [
  'Traceback (most recent call last):',
  '  File "/usr/local/lib/python3.12/site-packages/opentelemetry/trace/__init__.py", line 589, in use_span',
  '    yield span',
  '  File "/usr/local/lib/python3.12/site-packages/opentelemetry/sdk/trace/__init__.py", line 1105, in start_as_current_span',
  '    yield span',
  '  File "/usr/src/app/recommendation_server.py", line 96, in get_product_list',
  '    product_ids = [x.id for x in cat_response.products_list]',
  "AttributeError: 'ListProductsResponse' object has no attribute 'products_list'",
].join('\n')

const MESSAGE = "'ListProductsResponse' object has no attribute 'products_list'"

// A fused graph carrying the join targets the extractor already minted: the
// service, its file, and the function whose definition span contains line 96.
function fusedGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  g.addNode(serviceId(SERVICE), {
    id: serviceId(SERVICE),
    type: NodeType.ServiceNode,
    name: SERVICE,
    language: 'python',
    discoveredVia: 'static',
  } as GraphNode)
  g.addNode(FILE, {
    id: FILE,
    type: NodeType.FileNode,
    service: SERVICE,
    path: REL,
    language: 'python',
    discoveredVia: 'static',
  } as GraphNode)
  g.addNode(SYM, {
    id: SYM,
    type: NodeType.SymbolNode,
    kind: 'function',
    qualname: 'get_product_list',
    span: { startLine: 90, endLine: 110 },
    service: SERVICE,
    relPath: REL,
  } as GraphNode)
  // landObservedSymbol discovers the symbol by walking the file's outbound
  // CONTAINS edges, so the fixture needs the declared file→symbol edge.
  const contains = `${EdgeType.CONTAINS}:${FILE}->${SYM}`
  g.addEdgeWithKey(contains, FILE, SYM, {
    id: contains,
    source: FILE,
    target: SYM,
    type: EdgeType.CONTAINS,
    provenance: Provenance.EXTRACTED,
  } as GraphEdge)
  return g
}

function exceptionSpan(overrides: Partial<ParsedSpan> = {}): ParsedSpan {
  return {
    service: SERVICE,
    traceId: 'trace-1087',
    spanId: 'span-1087',
    name: 'recommendation.ListRecommendations',
    kind: 2,
    startTimeUnixNano: '0',
    endTimeUnixNano: '0',
    durationNanos: 0n,
    env: 'unknown',
    startTimeIso: '2026-08-24T12:00:00.000Z',
    statusCode: 2,
    attributes: { 'app.recommendation.cache_enabled': 'true' },
    exception: { type: 'AttributeError', message: MESSAGE, stacktrace: STACKTRACE },
    ...overrides,
  }
}

describe('stacktrace code-locus recovery (ADR-216)', () => {
  it('attributes a stacktrace-only exception incident to the declaring symbol and synthesizes code.filepath/lineno', () => {
    const graph = fusedGraph()
    const ev = buildErrorEventForReceiver(exceptionSpan(), graph)
    expect(ev).not.toBeNull()

    // Attributed to the exact declaring symbol — not the service fallback.
    expect(ev!.affectedNode).toBe(SYM)
    expect(graph.hasNode(ev!.affectedNode)).toBe(true)

    // The recovered locus is synthesized onto the record so every code-grain
    // consumer reads the file:line, exactly as a span that stamped code.* would.
    expect(ev!.attributes?.['code.filepath']).toBe(REL)
    expect(ev!.attributes?.['code.lineno']).toBe(96)

    // The raw stacktrace and the error semantics still ride along.
    expect(ev!.exceptionType).toBe('AttributeError')
    expect(ev!.errorMessage).toBe(MESSAGE)
  })

  it('closes the #1085 gap end-to-end: get_divergences returns a symbol-grain finding at the declaring file:line', () => {
    const graph = fusedGraph()
    const ev = buildErrorEventForReceiver(exceptionSpan(), graph)!

    const found = computeDivergences(graph, { incidents: [ev] }).divergences.filter(
      (d) => d.type === 'observed-symbol-mismatch',
    )
    expect(found).toHaveLength(1)
    const d = found[0]!
    if (d.type !== 'observed-symbol-mismatch') throw new Error('type narrow')
    expect(d.mismatchKind).toBe('missing-attribute')
    expect(d.symbol).toBe('products_list')
    expect(d.source).toBe(SYM)
    expect(d.target).toBe(SYM)
    expect(d.location).toBe(`${REL}:96`)
    expect(d.provenance).toBe(Provenance.INFERRED)
  })

  it('leaves the service attribution unchanged when the stacktrace has no application frame — never fabricates', () => {
    const graph = fusedGraph()
    const allVendor = [
      'Traceback (most recent call last):',
      '  File "/usr/local/lib/python3.12/site-packages/grpc/_server.py", line 552, in _call_behavior',
      '    response = behavior(request, context)',
      '  File "/usr/local/lib/python3.12/site-packages/opentelemetry/instrumentation/grpc/_server.py", line 300, in intercept',
      '    raise error',
      'RuntimeError: interceptor failed',
    ].join('\n')
    const ev = buildErrorEventForReceiver(
      exceptionSpan({
        exception: { type: 'RuntimeError', message: 'interceptor failed', stacktrace: allVendor },
      }),
      graph,
    )!

    // Falls back to the fused service node; no phantom code node, no synthesized
    // code.filepath.
    expect(ev.affectedNode).toBe(serviceId(SERVICE))
    expect(ev.attributes?.['code.filepath']).toBeUndefined()
    expect(ev.attributes?.['code.lineno']).toBeUndefined()
  })

  it('leaves the service attribution unchanged when the recovered frame resolves to no graph node', () => {
    const graph = fusedGraph()
    // A real application frame, but for a file the graph does not carry — so the
    // join finds nothing to land on and the service attribution stands.
    const unknownFileTrace = [
      'Traceback (most recent call last):',
      '  File "/usr/src/app/does_not_exist.py", line 5, in mystery',
      '    boom()',
      'ValueError: nope',
    ].join('\n')
    const ev = buildErrorEventForReceiver(
      exceptionSpan({
        exception: { type: 'ValueError', message: 'nope', stacktrace: unknownFileTrace },
      }),
      graph,
    )!
    expect(ev.affectedNode).toBe(serviceId(SERVICE))
    expect(ev.attributes?.['code.filepath']).toBeUndefined()
  })

  it('leaves a span that DOES carry code.filepath unaffected — the existing call-site path wins', () => {
    const graph = fusedGraph()
    // A second file the span points at directly via code.filepath. The direct
    // call site must win over the stacktrace fallback (which names a different
    // file), and nothing is synthesized because the span already carries code.*.
    const handler = fileId(SERVICE, 'handler.py')
    graph.addNode(handler, {
      id: handler,
      type: NodeType.FileNode,
      service: SERVICE,
      path: 'handler.py',
      language: 'python',
      discoveredVia: 'static',
    } as GraphNode)

    const ev = buildErrorEventForReceiver(
      exceptionSpan({
        attributes: {
          'app.recommendation.cache_enabled': 'true',
          'code.filepath': 'handler.py',
          'code.lineno': 20,
        },
      }),
      graph,
    )!

    // The code.filepath call site lands on handler.py, not the stacktrace's
    // recommendation_server.py symbol.
    expect(ev.affectedNode).toBe(handler)
    expect(ev.attributes?.['code.filepath']).toBe('handler.py')
    expect(ev.attributes?.['code.lineno']).toBe(20)
  })
})
