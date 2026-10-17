import { describe, it, expect, beforeEach } from 'vitest'
import { resetGraph, getGraph } from '../src/graph.js'
import { parseOtlpRequest, type OtlpTracesRequest } from '../src/otel.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import { EdgeType, NodeType, grpcMethodId } from '@neat.is/types'

// C# Grpc.AspNetCore records a serving gRPC call as an ASP.NET HTTP SERVER span —
// `http.route = /oteldemo.CartService/AddItem`, no `rpc.service` / `rpc.method` — so
// the serving CONTAINS (ADR-123 / #616, keyed on rpc.service) never fired and a C#
// service's own gRPC methods stayed unjoined. The parse now recovers the method from
// the gRPC-shaped `http.route` on a SERVER span, the same way grpcFromSpanName
// recovers it from a Jaeger operation name (#1427). Grounded on the astronomy
// capture: cart's AddItem/EmptyCart/GetCart SERVER spans carry http.route and no
// rpc.* (#1460).
function csharpGrpcServerBody(route: string, kind = 2, service = 'cart'): OtlpTracesRequest {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 't',
                spanId: 's',
                name: `POST ${route}`,
                kind,
                startTimeUnixNano: '0',
                endTimeUnixNano: '0',
                attributes: [
                  { key: 'http.route', value: { stringValue: route } },
                  { key: 'http.request.method', value: { stringValue: 'POST' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

describe('C# Grpc.AspNetCore server spans fuse via http.route (#1460)', () => {
  beforeEach(() => resetGraph())

  it('recovers rpc.service/method from a gRPC-shaped http.route on a SERVER span', () => {
    const [span] = parseOtlpRequest(csharpGrpcServerBody('/oteldemo.CartService/AddItem'))
    expect(span.rpcSystem).toBe('grpc')
    expect(span.rpcService).toBe('oteldemo.CartService')
    expect(span.rpcMethod).toBe('AddItem')
  })

  it('handles a dotted multi-segment package (flagd.evaluation.v1.Service)', () => {
    const [span] = parseOtlpRequest(
      csharpGrpcServerBody('/flagd.evaluation.v1.Service/ResolveBoolean'),
    )
    expect(span.rpcService).toBe('flagd.evaluation.v1.Service')
    expect(span.rpcMethod).toBe('ResolveBoolean')
  })

  it('does not misread a REST route as gRPC', () => {
    expect(parseOtlpRequest(csharpGrpcServerBody('/api/users'))[0].rpcService).toBeUndefined()
    expect(parseOtlpRequest(csharpGrpcServerBody('/v1.0/orders'))[0].rpcService).toBeUndefined()
    expect(parseOtlpRequest(csharpGrpcServerBody('/users/42'))[0].rpcService).toBeUndefined()
  })

  it('only the serving side — a CLIENT span (kind 3) is left alone', () => {
    const [span] = parseOtlpRequest(csharpGrpcServerBody('/oteldemo.CartService/AddItem', 3))
    expect(span.rpcService).toBeUndefined()
  })

  it('defers to rpc.* when present (a native gRPC span is unaffected)', () => {
    const body = csharpGrpcServerBody('/oteldemo.CartService/AddItem')
    body.resourceSpans![0]!.scopeSpans![0]!.spans![0]!.attributes!.push(
      { key: 'rpc.system', value: { stringValue: 'grpc' } },
      { key: 'rpc.service', value: { stringValue: 'oteldemo.CartService' } },
      { key: 'rpc.method', value: { stringValue: 'AddItem' } },
    )
    const [span] = parseOtlpRequest(body)
    expect(span.rpcSystem).toBe('grpc')
    expect(span.rpcService).toBe('oteldemo.CartService')
  })

  it('mints the serving CONTAINS and no phantom RouteNode', async () => {
    const graph = getGraph()
    const [span] = parseOtlpRequest(csharpGrpcServerBody('/oteldemo.CartService/AddItem'))
    const ctx: IngestContext = { graph }
    await handleSpan(ctx, span)

    const method = grpcMethodId('oteldemo.CartService', 'AddItem')
    expect(graph.hasNode(method)).toBe(true)
    const observedContains = `${EdgeType.CONTAINS}:OBSERVED:service:cart->${method}`
    expect(graph.hasEdge(observedContains)).toBe(true)

    // The gRPC path is not a REST route — no RouteNode is minted for it.
    let routeNodes = 0
    graph.forEachNode((_id, a) => {
      if ((a as { type: string }).type === NodeType.RouteNode) routeNodes++
    })
    expect(routeNodes).toBe(0)
  })
})
