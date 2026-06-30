import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import protobuf from 'protobufjs'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  type GraphEdge,
  type GraphNode,
  NodeType,
  Provenance,
} from '@neat.is/types'
import { buildOtelReceiver, type ParsedSpan } from '../src/otel.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import type { NeatGraph } from '../src/graph.js'

// Real OTel SDK exporters set the W3C sampled bit, so every sampled span
// carries `flags` on the wire as a fixed32 (wire type 5, 4 bytes) and the
// timestamps as fixed64. The bundled proto used to type `flags` as uint32,
// which made protobufjs read the 4-byte fixed32 as a varint and overrun the
// rest of the buffer — every sampled span 400'd with "index out of range" and
// the OBSERVED layer stayed dark for the default Python/JS http/protobuf
// exporters. The hand-built JS-SDK fixture missed it because those spans left
// `flags` at the proto3 default (0, omitted). This encodes the exact wire shape
// — fixed32 flags + fixed64 timestamps — and asserts it decodes to a span and
// mints an OBSERVED edge.

// Canonical OTel field types: flags is fixed32, the timestamps fixed64. This
// matches what the real SDK serializes, so the bytes below are the same shape
// the production exporter puts on the wire (the receiver's own bundled proto is
// what does the decoding under test).
const CANONICAL_PROTO = `
syntax = "proto3";
package neat.test.otlp;
message AnyValue { string string_value = 1; }
message KeyValue { string key = 1; AnyValue value = 2; }
message Resource { repeated KeyValue attributes = 1; }
message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  bytes parent_span_id = 4;
  string name = 5;
  int32 kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
  Status status = 15;
  fixed32 flags = 16;
}
message Status { string message = 2; int32 code = 3; }
message ScopeSpans { repeated Span spans = 2; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
`

function encodeSampledSpanRequest(): Buffer {
  const root = protobuf.parse(CANONICAL_PROTO, { keepCase: true }).root
  const Req = root.lookupType('neat.test.otlp.ExportTraceServiceRequest')
  // Strings, not native bigint — protobufjs's fixed64 writer parses Long
  // values from strings but coerces an unrecognised bigint to 0.
  const startNanos = '1717761600123000000'
  const endNanos = '1717761600148000000'
  const msg = Req.create({
    resource_spans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { string_value: 'svc-flags-fixed32' } },
          ],
        },
        scope_spans: [
          {
            spans: [
              {
                trace_id: Buffer.alloc(16, 0xab),
                span_id: Buffer.alloc(8, 0xcd),
                name: 'GET /downstream',
                kind: 3, // CLIENT
                start_time_unix_nano: startNanos,
                end_time_unix_nano: endNanos,
                // The W3C sampled bit. Non-zero is what forces flags onto the
                // wire as a fixed32 — the exact byte that used to 400.
                flags: 1,
                attributes: [
                  { key: 'server.address', value: { string_value: 'svc-flags-peer' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  })
  return Buffer.from(Req.encode(msg).finish())
}

function newGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  g.addNode('service:svc-flags-fixed32', {
    id: 'service:svc-flags-fixed32',
    type: NodeType.ServiceNode,
    name: 'svc-flags-fixed32',
    language: 'javascript',
  })
  g.addNode('service:svc-flags-peer', {
    id: 'service:svc-flags-peer',
    type: NodeType.ServiceNode,
    name: 'svc-flags-peer',
    language: 'javascript',
  })
  return g
}

describe('http/protobuf — sampled span with fixed32 flags decodes and mints an edge', () => {
  let tmpDir: string
  let ctx: IngestContext
  let collected: ParsedSpan[]
  let receiver: Awaited<ReturnType<typeof buildOtelReceiver>>

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-flags-fixed32-'))
    ctx = { graph: newGraph(), errorsPath: path.join(tmpDir, 'errors.ndjson') }
    collected = []
    receiver = await buildOtelReceiver({
      onSpan: async (span) => {
        collected.push(span)
        await handleSpan(ctx, span)
      },
    })
  })

  afterEach(async () => {
    await receiver.close()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns 200, decodes the span, and mints the OBSERVED CALLS edge', async () => {
    const payload = encodeSampledSpanRequest()
    const res = await receiver.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { 'content-type': 'application/x-protobuf' },
      payload,
    })
    expect(res.statusCode).toBe(200)

    await receiver.flushPending()

    expect(collected).toHaveLength(1)
    const parsed = collected[0]
    expect(parsed.service).toBe('svc-flags-fixed32')
    expect(parsed.traceId).toBe('ab'.repeat(16))
    expect(parsed.spanId).toBe('cd'.repeat(8))
    expect(parsed.kind).toBe(3)
    // fixed64 timestamps survived the decode intact.
    expect(parsed.startTimeUnixNano).toBe('1717761600123000000')
    expect(parsed.durationNanos).toBe(25_000_000n)
    expect(parsed.attributes['server.address']).toBe('svc-flags-peer')

    const edgeId = `${EdgeType.CALLS}:OBSERVED:service:svc-flags-fixed32->service:svc-flags-peer`
    expect(ctx.graph.hasEdge(edgeId)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
  })
})
