import { describe, it, expect, beforeEach } from 'vitest'
import { resetGraph, getGraph } from '../src/graph.js'
import { parseOtlpRequest, type OtlpTracesRequest } from '../src/otel.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import { getBlastRadius } from '../src/traverse.js'
import { EdgeType, NodeType, Provenance, grpcMethodId, type GraphEdge, type GraphNode } from '@neat.is/types'

// #1473 / ADR-263 — on hotel-reservation, get_blast_radius(service:geo) said "no
// dependents" while search calls geo. A Jaeger-converted gRPC call lands as
// `search ──CALLS──▶ grpc:geo.Geo/Nearby`, which geo owns through CONTAINS
// (otel-ingest.md: caller → method → owner); nothing points at service:geo itself.
// The walk now steps from a node into the interface it serves and on to that
// interface's callers. The spans below have the capture's shape: operation name
// `/pkg.Service/Method`, `component=gRPC`, no rpc.* attributes.

function svc(name: string): GraphNode {
  return { id: `service:${name}`, type: NodeType.ServiceNode, name, language: 'go' } as GraphNode
}

function method(rpcService: string, rpcMethod: string): GraphNode {
  return {
    id: grpcMethodId(rpcService, rpcMethod),
    type: NodeType.GrpcMethodNode,
    name: `${rpcService}/${rpcMethod}`,
    rpcService,
    rpcMethod,
    discoveredVia: 'static',
  } as GraphNode
}

function contains(source: string, target: string): GraphEdge {
  const id = `CONTAINS:${source}->${target}`
  return { id, source, target, type: EdgeType.CONTAINS, provenance: Provenance.EXTRACTED } as GraphEdge
}

// The static half extraction leaves: three services, each owning its proto methods,
// and frontend's routes.
function seedStatic(): void {
  const g = getGraph()
  for (const n of ['frontend', 'search', 'geo']) g.addNode(`service:${n}`, svc(n))
  for (const [s, m, owner] of [
    ['search.Search', 'Nearby', 'search'],
    ['geo.Geo', 'Nearby', 'geo'],
  ] as const) {
    const node = method(s, m)
    g.addNode(node.id, node)
    const e = contains(`service:${owner}`, node.id)
    g.addEdgeWithKey(e.id, e.source, e.target, e)
  }
  for (const path of ['/hotels', '/cinema']) {
    const id = `route:frontend:ALL ${path}`
    g.addNode(id, { id, type: NodeType.RouteNode, name: `ALL ${path}`, service: 'frontend', method: 'ALL', path } as unknown as GraphNode)
    const e = contains('service:frontend', id)
    g.addEdgeWithKey(e.id, e.source, e.target, e)
  }
}

let n = 0
function jaegerSpan(service: string, name: string, kind: number, spanId: string, parentSpanId?: string): OtlpTracesRequest {
  const now = BigInt(Date.now()) * 1_000_000n + BigInt(n++)
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: service } },
            { key: 'opencensus.exporterversion', value: { stringValue: 'Jaeger-Go-2.30.0' } },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'aaaabbbbccccdddd0000000000000001',
                spanId,
                ...(parentSpanId ? { parentSpanId } : {}),
                name,
                kind,
                startTimeUnixNano: now.toString(),
                endTimeUnixNano: (now + 1_000_000n).toString(),
                attributes: [{ key: 'component', value: { stringValue: 'gRPC' } }],
              },
            ],
          },
        ],
      },
    ],
  }
}

async function ingest(body: OtlpTracesRequest): Promise<void> {
  const ctx: IngestContext = { graph: getGraph() }
  for (const span of parseOtlpRequest(body)) await handleSpan(ctx, span)
}

// One request through hotel: frontend → search.Nearby → geo.Nearby, each hop a
// CLIENT span in the caller and a SERVER span in the callee.
async function hotelTrace(): Promise<void> {
  await ingest(jaegerSpan('frontend', '/search.Search/Nearby', 3, '0000000000000001'))
  await ingest(jaegerSpan('search', '/search.Search/Nearby', 2, '0000000000000002', '0000000000000001'))
  await ingest(jaegerSpan('search', '/geo.Geo/Nearby', 3, '0000000000000003', '0000000000000002'))
  await ingest(jaegerSpan('geo', '/geo.Geo/Nearby', 2, '0000000000000004', '0000000000000003'))
}

describe('blast radius reaches callers through the interface a service serves (ADR-263)', () => {
  beforeEach(() => {
    resetGraph()
    seedStatic()
  })

  it('the Jaeger trace lands on the method nodes, not on service:geo', async () => {
    await hotelTrace()
    const g = getGraph()
    const calls = g
      .filterEdges((_id, a) => (a as GraphEdge).type === EdgeType.CALLS && (a as GraphEdge).provenance === Provenance.OBSERVED)
      .map((id) => `${g.source(id)} -> ${g.target(id)}`)
      .sort()
    expect(calls).toEqual(['service:frontend -> grpc:search.Search/Nearby', 'service:search -> grpc:geo.Geo/Nearby'])
    expect(g.inboundEdges('service:geo')).toEqual([])
  })

  it('blast radius of service:geo names search and frontend, OBSERVED', async () => {
    await hotelTrace()
    const r = getBlastRadius(getGraph(), 'service:geo')
    const by = new Map(r.affectedNodes.map((a) => [a.nodeId, a]))
    expect(by.get('service:search')).toMatchObject({
      distance: 2,
      edgeProvenance: Provenance.OBSERVED,
      path: ['service:geo', 'grpc:geo.Geo/Nearby', 'service:search'],
    })
    expect(by.get('service:frontend')).toMatchObject({
      distance: 4,
      edgeProvenance: Provenance.OBSERVED,
      path: ['service:geo', 'grpc:geo.Geo/Nearby', 'service:search', 'grpc:search.Search/Nearby', 'service:frontend'],
    })
    // geo's own method breaks with it.
    expect(by.get('grpc:geo.Geo/Nearby')?.distance).toBe(1)
  })

  it("a dependent's other interface is not listed as breaking", async () => {
    await hotelTrace()
    const ids = getBlastRadius(getGraph(), 'service:geo').affectedNodes.map((a) => a.nodeId)
    expect(ids).not.toContain('route:frontend:ALL /cinema')
    expect(ids).not.toContain('route:frontend:ALL /hotels')
    expect(ids.sort()).toEqual(['grpc:geo.Geo/Nearby', 'grpc:search.Search/Nearby', 'service:frontend', 'service:search'])
  })

  it("the origin's own interface is listed even with no caller yet", () => {
    const ids = getBlastRadius(getGraph(), 'service:frontend').affectedNodes.map((a) => a.nodeId).sort()
    expect(ids).toEqual(['route:frontend:ALL /cinema', 'route:frontend:ALL /hotels'])
  })

  it('a method node as origin still walks to its callers', async () => {
    await hotelTrace()
    const ids = getBlastRadius(getGraph(), 'grpc:geo.Geo/Nearby').affectedNodes.map((a) => a.nodeId)
    expect(ids).toContain('service:search')
    expect(ids).toContain('service:frontend')
    expect(ids).toContain('service:geo') // the owner, inbound over CONTAINS as before
  })
})
