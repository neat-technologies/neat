import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode } from '@neat.is/types'
import { parseOtlpRequest, type OtlpTracesRequest } from '../src/otel.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import { grpcMethodsFromProto } from '../src/extract/proto.js'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'

// ADR-272 / #1480 — flagd's EventStream is a server stream that runs ~600 s and
// reconnects at its deadline (astronomy capture 2026-10-16: 20 serving spans, p50
// 599997 ms, 31 message events each; client ends DEADLINE_EXCEEDED). ADR-208's
// ceiling withholds those, but a stream cut short (a reset at 23-32 s on the live
// daemon, 2026-10-18) from a .NET client that records no message events slipped
// under it, and flagd read as saturated (inbound p95 28160 ms on the bench). A
// stream is now judged by its method, not by each span's duration.

let seq = 0
const T0 = BigInt(Date.parse('2026-10-18T15:52:00.000Z')) * 1_000_000n
function body(service: string, kind: number, method: string, ms: number, events: number, status: number, spanId: string, parent?: string, extra: Array<[string, string]> = []): OtlpTracesRequest {
  const start = T0 + BigInt(seq++) * 1_000_000_000n
  return { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] }, scopeSpans: [{ spans: [{
    traceId: 'aaaabbbbccccdddd000000000000000' + (seq % 10), spanId, ...(parent ? { parentSpanId: parent } : {}), name: `flagd.evaluation.v1.Service/${method}`, kind,
    startTimeUnixNano: start.toString(), endTimeUnixNano: (start + BigInt(ms * 1_000_000)).toString(),
    attributes: [
      { key: 'rpc.system', value: { stringValue: 'grpc' } }, { key: 'rpc.service', value: { stringValue: 'flagd.evaluation.v1.Service' } },
      { key: 'rpc.method', value: { stringValue: method } }, { key: 'rpc.grpc.status_code', value: { intValue: status } },
      ...extra.map(([k, v]) => ({ key: k, value: { stringValue: v } })),
    ],
    events: Array.from({ length: events }, (_, i) => ({ name: 'message', attributes: [{ key: 'message.type', value: { stringValue: i % 2 ? 'SENT' : 'RECEIVED' } }] })),
    ...(status !== 0 ? { status: { code: 2 } } : {}),
  }] }] }] } as OtlpTracesRequest
}

function newCtx(): { graph: MultiDirectedGraph<GraphNode, GraphEdge>; ctx: IngestContext } {
  const graph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  const ctx = { graph, errorsPath: path.join(mkdtempSync(path.join(os.tmpdir(), 'neat-stream-')), 'errors.ndjson') } as IngestContext
  return { graph, ctx }
}
async function ingest(ctx: IngestContext, b: OtlpTracesRequest): Promise<void> {
  for (const s of parseOtlpRequest(b)) await handleSpan(ctx, s)
}
const p95 = (g: MultiDirectedGraph<GraphNode, GraphEdge>, id: string) => (g.getEdgeAttributes(id) as GraphEdge).signal?.latencyMs?.p95
const CART_STREAM = 'CALLS:OBSERVED:service:cart->grpc:flagd.evaluation.v1.Service/EventStream'

describe('a gRPC stream is judged by its method (ADR-272)', () => {
  it('counts message events at parse', () => {
    const [s] = parseOtlpRequest(body('flagd', 2, 'EventStream', 600000, 31, 0, '00000000000000a1'))
    expect(s!.messageEventCount).toBe(31)
    const [u] = parseOtlpRequest(body('flagd', 2, 'ResolveBoolean', 0.1, 2, 0, '00000000000000a2'))
    expect(u!.messageEventCount).toBe(2)
  })

  it('a stream cut short is withheld once its method is known to stream, and earlier samples are cleared', async () => {
    const { graph, ctx } = newCtx()
    // A .NET client's stream reset at 25 s, before anything marked the method.
    await ingest(ctx, body('cart', 3, 'EventStream', 25000, 0, 14, '0000000000000001', undefined, [['server.address', 'flagd']]))
    expect(p95(graph, CART_STREAM)).toBeGreaterThan(20000)
    // flagd's serving span shows the stream: 31 messages.
    await ingest(ctx, body('flagd', 2, 'EventStream', 25000, 31, 0, '0000000000000002', '0000000000000001'))
    expect((graph.getNodeAttributes('grpc:flagd.evaluation.v1.Service/EventStream') as { streaming?: boolean }).streaming).toBe(true)
    expect(p95(graph, CART_STREAM)).toBeUndefined()
    // The next cut-short stream from the same client records no latency.
    await ingest(ctx, body('cart', 3, 'EventStream', 31000, 0, 14, '0000000000000003', undefined, [['server.address', 'flagd']]))
    expect(p95(graph, CART_STREAM)).toBeUndefined()
    expect((graph.getEdgeAttributes(CART_STREAM) as GraphEdge).signal?.spanCount).toBe(2)
    // A unary call still records its latency.
    await ingest(ctx, body('cart', 3, 'ResolveBoolean', 0.6, 0, 0, '0000000000000004', undefined, [['server.address', 'flagd']]))
    expect(p95(graph, 'CALLS:OBSERVED:service:cart->grpc:flagd.evaluation.v1.Service/ResolveBoolean')).toBeLessThan(5)
  })

  it('a unary call with one message each way is not a stream', async () => {
    const { graph, ctx } = newCtx()
    await ingest(ctx, body('flagd', 2, 'ResolveInt', 1200, 2, 0, '0000000000000005'))
    expect((graph.getNodeAttributes('grpc:flagd.evaluation.v1.Service/ResolveInt') as { streaming?: boolean }).streaming).toBeUndefined()
  })

  it('a .proto stream qualifier marks the method', () => {
    const proto = 'syntax = "proto3";\npackage flagd.evaluation.v1;\nservice Service {\n  rpc ResolveBoolean(ResolveBooleanRequest) returns (ResolveBooleanResponse) {}\n  rpc EventStream(EventStreamRequest) returns (stream EventStreamResponse) {}\n}\n'
    expect(grpcMethodsFromProto(proto, 'flagd.evaluation.v1')).toEqual([
      { rpcService: 'flagd.evaluation.v1.Service', rpcMethod: 'ResolveBoolean', line: 4 },
      { rpcService: 'flagd.evaluation.v1.Service', rpcMethod: 'EventStream', line: 5, streaming: true },
    ])
  })
})
