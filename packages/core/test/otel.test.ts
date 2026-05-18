import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  buildOtelReceiver,
  parseOtlpRequest,
  type OtlpTracesRequest,
  type ParsedSpan,
} from '../src/otel.js'

// Canned OTLP/HTTP JSON body: one trace, one root span on service-a calling
// service-b, plus a child span on service-b that errored against the database.
const SAMPLE_BODY: OtlpTracesRequest = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'service-a' } },
          { key: 'telemetry.sdk.language', value: { stringValue: 'nodejs' } },
        ],
      },
      scopeSpans: [
        {
          spans: [
            {
              traceId: 'aabbccddeeff00112233445566778899',
              spanId: '1111111111111111',
              name: 'GET /data',
              kind: 2,
              startTimeUnixNano: '1000000000000000000',
              endTimeUnixNano: '1000000000050000000',
              attributes: [
                { key: 'http.method', value: { stringValue: 'GET' } },
                { key: 'http.status_code', value: { intValue: '500' } },
              ],
              status: { code: 0 },
            },
          ],
        },
      ],
    },
    {
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'service-b' } }],
      },
      scopeSpans: [
        {
          spans: [
            {
              traceId: 'aabbccddeeff00112233445566778899',
              spanId: '2222222222222222',
              parentSpanId: '1111111111111111',
              name: 'pg.query',
              kind: 3,
              startTimeUnixNano: '1000000000010000000',
              endTimeUnixNano: '1000000000040000000',
              attributes: [
                { key: 'db.system', value: { stringValue: 'postgresql' } },
                { key: 'db.name', value: { stringValue: 'neatdemo' } },
                { key: 'db.statement', value: { stringValue: 'SELECT now()' } },
              ],
              status: { code: 2, message: 'SASL: SCRAM-SERVER-FIRST-MESSAGE' },
            },
          ],
        },
      ],
    },
  ],
}

describe('parseOtlpRequest', () => {
  it('flattens resource + scope + span into ParsedSpan list', () => {
    const spans = parseOtlpRequest(SAMPLE_BODY)
    expect(spans).toHaveLength(2)
  })

  it('extracts service.name from resource attributes', () => {
    const spans = parseOtlpRequest(SAMPLE_BODY)
    expect(spans[0].service).toBe('service-a')
    expect(spans[1].service).toBe('service-b')
  })

  it('keeps parent/child span linkage', () => {
    const spans = parseOtlpRequest(SAMPLE_BODY)
    expect(spans[0].parentSpanId).toBeUndefined()
    expect(spans[1].parentSpanId).toBe('1111111111111111')
  })

  it('hoists db.system and db.name onto the parsed span', () => {
    const spans = parseOtlpRequest(SAMPLE_BODY)
    expect(spans[0].dbSystem).toBeUndefined()
    expect(spans[1].dbSystem).toBe('postgresql')
    expect(spans[1].dbName).toBe('neatdemo')
  })

  it('preserves the full attribute bag', () => {
    const spans = parseOtlpRequest(SAMPLE_BODY)
    expect(spans[0].attributes['http.method']).toBe('GET')
    expect(spans[0].attributes['http.status_code']).toBe(500)
    expect(spans[1].attributes['db.statement']).toBe('SELECT now()')
  })

  it('captures status.code = 2 as the error signal', () => {
    const spans = parseOtlpRequest(SAMPLE_BODY)
    expect(spans[0].statusCode).toBe(0)
    expect(spans[1].statusCode).toBe(2)
    expect(spans[1].errorMessage).toMatch(/SCRAM/)
  })

  it('computes durationNanos as endTime - startTime', () => {
    const spans = parseOtlpRequest(SAMPLE_BODY)
    expect(spans[0].durationNanos).toBe(50_000_000n)
    expect(spans[1].durationNanos).toBe(30_000_000n)
  })

  it('returns [] for an empty body', () => {
    expect(parseOtlpRequest({})).toEqual([])
    expect(parseOtlpRequest({ resourceSpans: [] })).toEqual([])
  })

  it('falls back to "unknown" service when service.name is missing', () => {
    const spans = parseOtlpRequest({
      resourceSpans: [
        {
          scopeSpans: [
            { spans: [{ traceId: 'a', spanId: 'b', name: 'x' }] },
          ],
        },
      ],
    })
    expect(spans[0].service).toBe('unknown')
  })
})

describe('buildOtelReceiver', () => {
  let app: FastifyInstance
  let collected: ParsedSpan[]

  beforeEach(async () => {
    collected = []
    app = await buildOtelReceiver({
      onSpan: (s) => {
        collected.push(s)
      },
    })
  })

  afterEach(async () => {
    await app.close()
  })

  it('POST /v1/traces accepts JSON OTLP and dispatches each span', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { 'content-type': 'application/json' },
      payload: SAMPLE_BODY,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ partialSuccess: {} })
    expect(collected).toHaveLength(2)
    expect(collected[0].service).toBe('service-a')
    expect(collected[1].service).toBe('service-b')
  })

  it('GET /health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('handles an empty payload without erroring', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { 'content-type': 'application/json' },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(collected).toEqual([])
  })

  it('returns 200 before slow handlers complete and drains them after (ADR-033 non-blocking ingest)', async () => {
    await app.close()
    const observed: string[] = []
    const HANDLER_DELAY_MS = 250
    app = await buildOtelReceiver({
      onSpan: async (s) => {
        await new Promise((r) => setTimeout(r, HANDLER_DELAY_MS))
        observed.push(s.spanId)
      },
    })
    const start = Date.now()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { 'content-type': 'application/json' },
      payload: SAMPLE_BODY,
    })
    const replyMs = Date.now() - start
    expect(res.statusCode).toBe(200)
    // 2 spans × 30ms each = 60ms if blocking. Reply must come back well under
    // that — pick a generous bound to avoid CI flakiness.
    expect(replyMs).toBeLessThan(HANDLER_DELAY_MS)
    expect(observed).toEqual([])
    // After the queue drains, both spans land.
    await (app as unknown as { flushPending: () => Promise<void> }).flushPending()
    expect(observed).toEqual(['1111111111111111', '2222222222222222'])
  })

  it('rejects unsupported content types with 415', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { 'content-type': 'application/xml' },
      payload: '<not-otlp/>',
    })
    expect(res.statusCode).toBe(415)
  })

  it('returns 400 for malformed protobuf bodies', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { 'content-type': 'application/x-protobuf' },
      payload: Buffer.from([0xff, 0xff, 0xff]),
    })
    expect(res.statusCode).toBe(400)
  })

  it('decodes a valid application/x-protobuf body via the bundled .proto', async () => {
    const protobuf = (await import('protobufjs')).default
    const path = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = path.dirname(fileURLToPath(import.meta.url))
    const protoRoot = path.resolve(here, '..', 'proto')
    const root = new protobuf.Root()
    root.resolvePath = (_o, t) => path.resolve(protoRoot, t)
    root.loadSync(
      'opentelemetry/proto/collector/trace/v1/trace_service.proto',
      { keepCase: true },
    )
    const Type = root.lookupType(
      'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest',
    )
    const buf = Buffer.from(
      Type.encode({
        resource_spans: [
          {
            resource: {
              attributes: [
                { key: 'service.name', value: { string_value: 'service-pb' } },
              ],
            },
            scope_spans: [
              { spans: [{ name: 'op-pb', start_time_unix_nano: '0', end_time_unix_nano: '0' }] },
            ],
          },
        ],
      }).finish(),
    )

    const res = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { 'content-type': 'application/x-protobuf' },
      payload: buf,
    })
    expect(res.statusCode).toBe(200)
    await (app as unknown as { flushPending: () => Promise<void> }).flushPending()
    expect(collected.find((s) => s.service === 'service-pb' && s.name === 'op-pb')).toBeDefined()
  })

  it('replies with protobuf-encoded ExportTraceServiceResponse for protobuf requests', async () => {
    const protobuf = (await import('protobufjs')).default
    const path = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = path.dirname(fileURLToPath(import.meta.url))
    const protoRoot = path.resolve(here, '..', 'proto')
    const root = new protobuf.Root()
    root.resolvePath = (_o, t) => path.resolve(protoRoot, t)
    root.loadSync(
      'opentelemetry/proto/collector/trace/v1/trace_service.proto',
      { keepCase: true },
    )
    const RequestType = root.lookupType(
      'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest',
    )
    const ResponseType = root.lookupType(
      'opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse',
    )
    const reqBuf = Buffer.from(
      RequestType.encode({
        resource_spans: [
          {
            resource: {
              attributes: [
                { key: 'service.name', value: { string_value: 'svc-resp-pb' } },
              ],
            },
            scope_spans: [
              { spans: [{ name: 'op', start_time_unix_nano: '0', end_time_unix_nano: '0' }] },
            ],
          },
        ],
      }).finish(),
    )

    const res = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { 'content-type': 'application/x-protobuf' },
      payload: reqBuf,
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/x-protobuf')
    // Body decodes cleanly against the OTLP response schema; partial_success
    // either unset or with no rejected spans means "all accepted".
    const body = res.rawPayload
    expect(Buffer.isBuffer(body)).toBe(true)
    const decoded = ResponseType.decode(body).toJSON() as {
      partial_success?: { rejected_spans?: number | string; error_message?: string }
    }
    const rejected = decoded.partial_success?.rejected_spans
    expect(rejected === undefined || rejected === 0 || rejected === '0').toBe(true)
  })

  it('replies with JSON for JSON requests', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(SAMPLE_BODY),
    })
    expect(res.statusCode).toBe(200)
    expect((res.headers['content-type'] ?? '').toString()).toMatch(/application\/json/)
    expect(JSON.parse(res.payload)).toEqual({ partialSuccess: {} })
  })
})
