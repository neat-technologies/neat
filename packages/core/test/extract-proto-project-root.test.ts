import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import type { ParsedSpan } from '../src/otel.js'
import type { GrpcMethodNode } from '@neat.is/types'
import { EdgeType, NodeType, grpcMethodId, serviceId, extractedEdgeId } from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, 'fixtures', 'grpc-centralized')

// ADR-123 scan scope (#1459) — a centralized `.proto` contract that sits OUTSIDE
// every service dir (otel-demo keeps its whole gRPC surface in `pb/demo.proto`, a
// sibling of `src/`) is still extracted: the project-root pass mints the method
// node so the OBSERVED spans have a static twin to fuse onto. The per-service walk
// (ADR-123, covered by extract-proto.test.ts) is unchanged. A `vendor/` proto is
// never this repo's contract and mints nothing.
describe('project-root .proto scan for a centralized contract (ADR-123, #1459)', () => {
  beforeEach(() => resetGraph())

  it('mints a static GrpcMethodNode for a proto no service dir contains', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURE)

    // src/cart is the discovered service; pb/demo.proto is its sibling, not under it.
    expect(graph.hasNode(serviceId('cart'))).toBe(true)

    const addItem = grpcMethodId('oteldemo.CartService', 'AddItem')
    expect(addItem).toBe('grpc:oteldemo.CartService/AddItem')
    expect(graph.hasNode(addItem)).toBe(true)
    const node = graph.getNodeAttributes(addItem) as GrpcMethodNode
    expect(node.type).toBe(NodeType.GrpcMethodNode)
    expect(node.rpcService).toBe('oteldemo.CartService')
    expect(node.rpcMethod).toBe('AddItem')
    expect(node.discoveredVia).toBe('static')
    expect(node.path).toBe('pb/demo.proto')

    expect(graph.hasNode(grpcMethodId('oteldemo.CartService', 'GetCart'))).toBe(true)
    expect(graph.hasNode(grpcMethodId('oteldemo.CartService', 'EmptyCart'))).toBe(true)
  })

  it('mints the node only — no static CONTAINS, since no service dir owns it', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURE)

    const addItem = grpcMethodId('oteldemo.CartService', 'AddItem')
    // The only candidate owner is service:cart; a centralized proto gets no static
    // CONTAINS — the OBSERVED serving span supplies the service link instead.
    expect(
      graph.hasEdge(extractedEdgeId(serviceId('cart'), addItem, EdgeType.CONTAINS)),
    ).toBe(false)
  })

  it('excludes a vendor/ proto — not the repo contract', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURE)
    expect(graph.hasNode(grpcMethodId('vendored.Vendored', 'Do'))).toBe(false)
  })

  // The acceptance criterion: a centralized method that used to exist only as an
  // observed node now has a static twin, so the OBSERVED serving span fuses onto it
  // (same id, two provenances) rather than minting an observed-only node.
  it('an OBSERVED serving span fuses onto the static twin (two-sided)', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURE)

    const addItem = grpcMethodId('oteldemo.CartService', 'AddItem')
    expect(graph.hasNode(addItem)).toBe(true) // static twin present first

    const ctx: IngestContext = { graph }
    const span: ParsedSpan = {
      service: 'cart',
      traceId: 'trace-fuse',
      spanId: 'span-fuse',
      name: 'oteldemo.CartService/AddItem',
      kind: 2, // SERVER
      startTimeUnixNano: '0',
      endTimeUnixNano: '0',
      durationNanos: 0n,
      env: 'unknown',
      attributes: {
        'rpc.system': 'grpc',
        'rpc.service': 'oteldemo.CartService',
        'rpc.method': 'AddItem',
      },
      rpcSystem: 'grpc',
      rpcService: 'oteldemo.CartService',
      rpcMethod: 'AddItem',
      statusCode: 0,
    }
    await handleSpan(ctx, span)

    // The serving span reused the declared id (no twin) and added the OBSERVED
    // CONTAINS from the emitting service — the static node is now two-sided.
    const observedContains = `${EdgeType.CONTAINS}:OBSERVED:service:cart->${addItem}`
    expect(graph.hasEdge(observedContains)).toBe(true)
  })
})
