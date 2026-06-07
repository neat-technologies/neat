import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  type GraphEdge,
  type GraphNode,
  NodeType,
  Provenance,
} from '@neat.is/types'
import { trace as otelTrace, SpanKind } from '@opentelemetry/api'
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { Resource } from '@opentelemetry/resources'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { buildOtelReceiver, type ParsedSpan } from '../src/otel.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import type { NeatGraph } from '../src/graph.js'

// End-to-end over the OTel JS SDK's DEFAULT export protocol: a real
// @opentelemetry/exporter-trace-otlp-proto serializes real SDK spans onto the
// http/protobuf wire against a live receiver, and the assertion reaches all
// the way to the OBSERVED edge. This exists because the hand-built protobuf
// fixture false-passed for the entire life of the decode bug (#468): spans
// were accepted with 200 while base64 IDs, string-name kinds, and the numeric
// mint gate conspired to mint zero OBSERVED edges. Nothing here is
// hand-encoded — if the decode layer diverges from what the SDK actually
// sends, this fails.

function newGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  g.addNode('service:svc-proto-e2e', {
    id: 'service:svc-proto-e2e',
    type: NodeType.ServiceNode,
    name: 'svc-proto-e2e',
    language: 'javascript',
  })
  g.addNode('service:svc-proto-peer', {
    id: 'service:svc-proto-peer',
    type: NodeType.ServiceNode,
    name: 'svc-proto-peer',
    language: 'javascript',
  })
  return g
}

describe('http/protobuf e2e — real OTel SDK exporter → receiver → OBSERVED edge', () => {
  let tmpDir: string
  let ctx: IngestContext
  let collected: ParsedSpan[]
  let receiver: Awaited<ReturnType<typeof buildOtelReceiver>>
  let endpointBase: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-proto-e2e-'))
    ctx = {
      graph: newGraph(),
      errorsPath: path.join(tmpDir, 'errors.ndjson'),
    }
    collected = []
    receiver = await buildOtelReceiver({
      onSpan: async (span) => {
        collected.push(span)
        await handleSpan(ctx, span)
      },
    })
    // Real socket — the OTLP exporter speaks actual HTTP, not inject().
    await receiver.listen({ port: 0, host: '127.0.0.1' })
    const addr = receiver.server.address()
    if (addr === null || typeof addr === 'string') throw new Error('no bound port')
    endpointBase = `http://127.0.0.1:${addr.port}`
  })

  afterEach(async () => {
    await receiver.close()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('mints an OBSERVED CALLS edge from a CLIENT span exported over http/protobuf', async () => {
    const provider = new BasicTracerProvider({
      resource: new Resource({ 'service.name': 'svc-proto-e2e' }),
    })
    provider.addSpanProcessor(
      new SimpleSpanProcessor(
        new OTLPTraceExporter({ url: `${endpointBase}/v1/traces` }),
      ),
    )
    const tracer = provider.getTracer('proto-e2e')

    // Pin the span's start time so the timestamp assertion is exact: the
    // ISO that lands on the edge's lastObserved must be the span's own start
    // time, not the receiver's wall clock.
    const startMs = Date.parse('2026-06-07T12:00:00.123Z')
    const span = tracer.startSpan(
      'GET /downstream',
      {
        kind: SpanKind.CLIENT,
        startTime: startMs,
        attributes: {
          'http.method': 'GET',
          'server.address': 'svc-proto-peer',
          'server.port': 3001,
        },
      },
    )
    const sdkTraceId = span.spanContext().traceId
    const sdkSpanId = span.spanContext().spanId
    span.end(startMs + 25)

    await provider.forceFlush()
    await provider.shutdown()
    await receiver.flushPending()

    // The decode layer reproduced the SDK's view of the span exactly.
    expect(collected).toHaveLength(1)
    const parsed = collected[0]
    expect(parsed.service).toBe('svc-proto-e2e')
    expect(parsed.traceId).toBe(sdkTraceId)
    expect(parsed.spanId).toBe(sdkSpanId)
    expect(parsed.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(parsed.spanId).toMatch(/^[0-9a-f]{16}$/)
    // API SpanKind.CLIENT serializes to wire kind 3 — numeric, or the mint
    // gate in spanMintsObservedEdge() drops the span silently.
    expect(parsed.kind).toBe(3)
    expect(parsed.startTimeUnixNano).toBe(String(BigInt(startMs) * 1_000_000n))
    expect(parsed.durationNanos).toBe(25_000_000n)
    expect(parsed.startTimeIso).toBe('2026-06-07T12:00:00.123Z')
    expect(parsed.attributes['server.address']).toBe('svc-proto-peer')

    // And the load-bearing outcome: the OBSERVED edge actually minted.
    const edgeId = `${EdgeType.CALLS}:OBSERVED:service:svc-proto-e2e->service:svc-proto-peer`
    expect(ctx.graph.hasEdge(edgeId)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    expect(edge.lastObserved).toBe('2026-06-07T12:00:00.123Z')
  })
})
