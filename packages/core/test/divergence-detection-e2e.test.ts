import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { promises as fs } from 'node:fs'
import { SpanKind } from '@opentelemetry/api'
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { Resource } from '@opentelemetry/resources'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { buildOtelReceiver, type ParsedSpan } from '../src/otel.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { computeDivergences } from '../src/divergences.js'
import { buildApi } from '../src/api.js'
import type { NeatGraph } from '../src/graph.js'

// The flagship "is anything weird?" proof: get_divergences DETECTING a real
// declared-vs-observed divergence over a genuinely fused graph — the northsea-code
// bug shape. Prior coverage only asserted the endpoint returned 200 (e2e-brief) or
// ran computeDivergences over a hand-built synthetic graph; nothing drove real OTel
// spans into a real extracted graph and checked the divergence was flagged.

const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../demo')

describe('divergence detection over a real fused graph (EXTRACTED demo + real OTel)', () => {
  let tmpDir: string
  let errorsPath: string
  let ctx: IngestContext
  let graph: NeatGraph
  let receiver: Awaited<ReturnType<typeof buildOtelReceiver>>
  let endpointBase: string

  beforeEach(async () => {
    resetGraph()
    graph = getGraph()
    await extractFromDirectory(graph, DEMO) // EXTRACTED: service-a → service-b → payments-db, all declared
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-divergence-e2e-'))
    errorsPath = path.join(tmpDir, 'errors.ndjson')
    ctx = { graph, errorsPath }
    receiver = await buildOtelReceiver({ onSpan: async (span: ParsedSpan) => handleSpan(ctx, span) })
    await receiver.listen({ port: 0, host: '127.0.0.1' })
    const addr = receiver.server.address()
    if (addr === null || typeof addr === 'string') throw new Error('no bound port')
    endpointBase = `http://127.0.0.1:${addr.port}`
  })

  afterEach(async () => {
    await receiver.close()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('detects undeclared production traffic (missing-extracted) + a declared-unobserved edge, via the endpoint', async () => {
    const provider = new BasicTracerProvider({
      resource: new Resource({ 'service.name': 'service-a' }),
    })
    provider.addSpanProcessor(
      new SimpleSpanProcessor(new OTLPTraceExporter({ url: `${endpointBase}/v1/traces` })),
    )
    const tracer = provider.getTracer('divergence-e2e')

    // service-a really calls an external API the extracted code never declares.
    const startMs = Date.parse('2026-06-08T09:00:00.000Z')
    for (let i = 0; i < 4; i++) {
      const span = tracer.startSpan('POST /charge', {
        kind: SpanKind.CLIENT,
        startTime: startMs + i * 100,
        attributes: {
          'http.method': 'POST',
          'server.address': 'stripe-api.example.com',
          'http.response.status_code': 200,
        },
      })
      span.end(startMs + i * 100 + 20)
    }
    await provider.forceFlush()
    await provider.shutdown()
    await receiver.flushPending()

    // (1) computeDivergences over the fused graph detects the real shapes.
    const { divergences } = computeDivergences(graph)

    // missing-extracted: production calls stripe-api, the code never declared it —
    // the northsea-code bug pattern (production diverges from the source of truth).
    const undeclared = divergences.find(
      (d) =>
        d.type === 'missing-extracted' &&
        d.source === 'service:service-a' &&
        d.target === 'frontier:stripe-api.example.com',
    )
    expect(undeclared, 'undeclared production traffic must surface as missing-extracted').toBeDefined()

    // missing-observed: a declared edge production never exercised (the inverse shape).
    const unexercised = divergences.find(
      (d) =>
        d.type === 'missing-observed' &&
        d.source === 'file:service-a:index.js' &&
        d.target === 'service:service-b',
    )
    expect(unexercised, 'a declared-but-unobserved edge must surface as missing-observed').toBeDefined()

    // (2) the same detection through the endpoint the MCP get_divergences tool calls —
    // not just a 200, the actual flagged divergence.
    const app = await buildApi({ graph, scanPath: DEMO })
    try {
      const res = await app.inject({ method: 'GET', url: '/graph/divergences' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { divergences: Array<{ type: string; source: string; target: string }> }
      expect(
        body.divergences.some(
          (d) => d.type === 'missing-extracted' && d.target === 'frontier:stripe-api.example.com',
        ),
        'the /graph/divergences endpoint must surface the missing-extracted divergence',
      ).toBe(true)
    } finally {
      await app.close()
    }
  })
})
