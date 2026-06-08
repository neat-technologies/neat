import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { MultiDirectedGraph } from 'graphology'
import { type GraphEdge, type GraphNode, NodeType } from '@neat.is/types'
import { trace as otelTrace, SpanKind } from '@opentelemetry/api'
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { Resource } from '@opentelemetry/resources'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { buildOtelReceiver, type ParsedSpan } from '../src/otel.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import { buildApi } from '../src/api.js'
import type { NeatGraph } from '../src/graph.js'

// End-to-end for issue #481: a service makes a burst of failing outbound calls
// (the northsea-code shape — many HTTP 404s against one peer in one window),
// real OTel SDK spans go over the http/protobuf wire into a live receiver, and
// get_incident_history (the /incidents/:nodeId read path the MCP tool wraps)
// returns ONE coalesced incident carrying the count and the dominant code.
// Nothing here is hand-encoded — the exporter serializes real SDK spans whose
// CLIENT status stays UNSET on a 4xx, the exact gap that left the store empty.

function newGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  g.addNode('service:svc-incident-e2e', {
    id: 'service:svc-incident-e2e',
    type: NodeType.ServiceNode,
    name: 'svc-incident-e2e',
    language: 'javascript',
  })
  return g
}

describe('4xx-burst incident e2e — real exporter → receiver → get_incident_history (#481)', () => {
  let tmpDir: string
  let errorsPath: string
  let ctx: IngestContext
  let graph: NeatGraph
  let receiver: Awaited<ReturnType<typeof buildOtelReceiver>>
  let endpointBase: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-incident-e2e-'))
    errorsPath = path.join(tmpDir, 'errors.ndjson')
    graph = newGraph()
    // One long-lived ctx, exactly as the daemon keeps one across spans, so the
    // burst state accumulates the way it does in production.
    ctx = { graph, errorsPath }
    receiver = await buildOtelReceiver({
      onSpan: async (span: ParsedSpan) => {
        await handleSpan(ctx, span)
      },
    })
    await receiver.listen({ port: 0, host: '127.0.0.1' })
    const addr = receiver.server.address()
    if (addr === null || typeof addr === 'string') throw new Error('no bound port')
    endpointBase = `http://127.0.0.1:${addr.port}`
  })

  afterEach(async () => {
    await receiver.close()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('coalesces a 404 burst into one incident readable via /incidents/:nodeId', async () => {
    const provider = new BasicTracerProvider({
      resource: new Resource({ 'service.name': 'svc-incident-e2e' }),
    })
    provider.addSpanProcessor(
      new SimpleSpanProcessor(new OTLPTraceExporter({ url: `${endpointBase}/v1/traces` })),
    )
    const tracer = provider.getTracer('incident-e2e')

    // Eight consecutive 404 CLIENT calls against one peer, statuses UNSET — the
    // shape of a service whose Supabase REST calls are all PGRST205-ing.
    const startMs = Date.parse('2026-06-08T09:00:00.000Z')
    for (let i = 0; i < 8; i++) {
      const span = tracer.startSpan('GET /rest/v1/orders', {
        kind: SpanKind.CLIENT,
        startTime: startMs + i * 100,
        attributes: {
          'http.method': 'GET',
          'server.address': 'supabase-peer',
          'http.response.status_code': 404,
        },
      })
      span.end(startMs + i * 100 + 20)
    }

    await provider.forceFlush()
    await provider.shutdown()
    await receiver.flushPending()

    // get_incident_history reads /incidents/:nodeId. Stand up the same API the
    // MCP tool calls, over the same graph + errors log the receiver wrote.
    const app = await buildApi({ graph, errorsPath })
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/incidents/service:svc-incident-e2e',
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        count: number
        total: number
        events: Array<{
          incidentCount?: number
          httpStatusCode?: number
          errorType?: string
          affectedNode: string
        }>
      }
      // One coalesced incident, not eight per-span lines.
      expect(body.total).toBe(1)
      expect(body.events).toHaveLength(1)
      const ev = body.events[0]!
      expect(ev.errorType).toBe('http-failure')
      expect(ev.httpStatusCode).toBe(404)
      expect(ev.incidentCount).toBeGreaterThanOrEqual(5)
      expect(ev.affectedNode).toBe('service:svc-incident-e2e')
    } finally {
      await app.close()
    }
  })
})
