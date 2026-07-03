import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import type { ParsedSpan } from '../src/otel.js'
import type { GraphEdge, GrpcMethodNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  extractedEdgeId,
  grpcMethodId,
  serviceId,
} from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'grpc')

// ADR-123 — gRPC `.proto` service/method extraction, the static half of two-sided
// gRPC observation. The fixture is a real `orders` service carrying an
// `orders.proto` that declares `service OrderService { rpc GetOrder…; rpc
// ListOrders…; }` under `package orders;`. The producer reads it as data and
// mints a GrpcMethodNode per rpc, keyed on the fully-qualified `orders.OrderService`
// — the exact `rpc.service` an OBSERVED span carries — so declared and observed
// methods fuse.
describe('gRPC .proto method extraction (ADR-123)', () => {
  beforeEach(() => resetGraph())

  it('materialises a GrpcMethodNode per rpc with FQ service + method + file:line', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const getOrder = grpcMethodId('orders.OrderService', 'GetOrder')
    expect(getOrder).toBe('grpc:orders.OrderService/GetOrder')
    expect(graph.hasNode(getOrder)).toBe(true)
    const node = graph.getNodeAttributes(getOrder) as GrpcMethodNode
    expect(node.type).toBe(NodeType.GrpcMethodNode)
    expect(node.rpcService).toBe('orders.OrderService')
    expect(node.rpcMethod).toBe('GetOrder')
    expect(node.name).toBe('orders.OrderService/GetOrder')
    expect(node.path).toBe('proto/orders.proto')
    expect(node.line).toBeGreaterThan(0)
    expect(node.discoveredVia).toBe('static')

    // The streaming rpc is a method like any other — the `stream` qualifier
    // doesn't change identity.
    expect(graph.hasNode(grpcMethodId('orders.OrderService', 'ListOrders'))).toBe(true)
  })

  it('owns each method through a service ──CONTAINS──▶ method edge carrying file:line', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const getOrder = grpcMethodId('orders.OrderService', 'GetOrder')
    const containsId = extractedEdgeId(serviceId('orders'), getOrder, EdgeType.CONTAINS)
    expect(graph.hasEdge(containsId)).toBe(true)
    const contains = graph.getEdgeAttributes(containsId) as GraphEdge
    expect(contains.type).toBe(EdgeType.CONTAINS)
    expect(contains.provenance).toBe(Provenance.EXTRACTED)
    expect(contains.source).toBe(serviceId('orders'))
    expect(contains.target).toBe(getOrder)
    expect(contains.evidence?.file).toBe('proto/orders.proto')
    expect(contains.evidence?.line).toBeGreaterThan(0)
  })

  // The point of the whole feature: a `.proto`-declared method and an OBSERVED
  // gRPC span for the same rpc.service/method land on ONE node — both provenances,
  // no twin — because both key on the wire-canonical FQN.
  it('fuses the declared method and the observed span onto one node (two-sided)', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // Sanity: after static extraction the method node exists with a static origin.
    const methodId = grpcMethodId('orders.OrderService', 'GetOrder')
    expect(graph.hasNode(methodId)).toBe(true)

    // Now an OBSERVED serving span for the same method arrives.
    const ctx: IngestContext = { graph }
    const span: ParsedSpan = {
      service: 'orders',
      traceId: 'trace-fuse',
      spanId: 'span-fuse',
      name: 'orders.OrderService/GetOrder',
      kind: 2, // SERVER
      startTimeUnixNano: '0',
      endTimeUnixNano: '0',
      durationNanos: 0n,
      env: 'unknown',
      attributes: {
        'rpc.system': 'grpc',
        'rpc.service': 'orders.OrderService',
        'rpc.method': 'GetOrder',
      },
      rpcSystem: 'grpc',
      rpcService: 'orders.OrderService',
      rpcMethod: 'GetOrder',
      statusCode: 0,
    }
    await handleSpan(ctx, span)

    // Exactly one node for this method — the observed span reused the declared id.
    const methodNodes: string[] = []
    graph.forEachNode((id, a) => {
      if ((a as { type: string }).type === NodeType.GrpcMethodNode && id === methodId) {
        methodNodes.push(id)
      }
    })
    expect(methodNodes).toEqual([methodId])

    // Both provenances of CONTAINS point at it: the EXTRACTED `.proto` ownership
    // and the OBSERVED serving edge — this is the two-sided divergence surface.
    const extractedContains = extractedEdgeId(serviceId('orders'), methodId, EdgeType.CONTAINS)
    const observedContains = `${EdgeType.CONTAINS}:OBSERVED:service:orders->${methodId}`
    expect(graph.hasEdge(extractedContains)).toBe(true)
    expect(graph.hasEdge(observedContains)).toBe(true)
    expect((graph.getEdgeAttributes(extractedContains) as GraphEdge).provenance).toBe(
      Provenance.EXTRACTED,
    )
    expect((graph.getEdgeAttributes(observedContains) as GraphEdge).provenance).toBe(
      Provenance.OBSERVED,
    )
  })
})
