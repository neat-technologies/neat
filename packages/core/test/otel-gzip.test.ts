import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { gzipSync, deflateSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import protobuf from 'protobufjs'
import {
  buildOtelReceiver,
  type OtlpTracesRequest,
  type ParsedSpan,
} from '../src/otel.js'

// A standard OpenTelemetry Collector's OTLP/HTTP exporter gzip-compresses its
// bodies by default (`Content-Encoding: gzip`). The receiver must decompress
// before parsing — protobuf or JSON — or every "bring your own collector"
// deployment fails to ingest. gRPC handles compression at the transport layer
// (@grpc/grpc-js), so this only touches the HTTP receiver.

const SAMPLE_BODY: OtlpTracesRequest = {
  resourceSpans: [
    {
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'svc-gzip' } }],
      },
      scopeSpans: [
        {
          spans: [
            {
              traceId: 'aabbccddeeff00112233445566778899',
              spanId: '1111111111111111',
              name: 'GET /gz',
              kind: 2,
              startTimeUnixNano: '1000000000000000000',
              endTimeUnixNano: '1000000000050000000',
              attributes: [{ key: 'http.method', value: { stringValue: 'GET' } }],
              status: { code: 0 },
            },
          ],
        },
      ],
    },
  ],
}

function encodeProtobufBody(): Buffer {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const protoRoot = path.resolve(here, '..', 'proto')
  const root = new protobuf.Root()
  root.resolvePath = (_o, t) => path.resolve(protoRoot, t)
  root.loadSync('opentelemetry/proto/collector/trace/v1/trace_service.proto', {
    keepCase: true,
  })
  const Type = root.lookupType(
    'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest',
  )
  return Buffer.from(
    Type.encode(
      Type.fromObject({
        resource_spans: [
          {
            resource: {
              attributes: [{ key: 'service.name', value: { string_value: 'svc-gzip-pb' } }],
            },
            scope_spans: [
              {
                spans: [
                  {
                    trace_id: Buffer.from('aabbccddeeff00112233445566778899', 'hex'),
                    span_id: Buffer.from('1122334455667788', 'hex'),
                    name: 'op-gz-pb',
                    kind: 3,
                    start_time_unix_nano: '1717777777123456789',
                    end_time_unix_nano: '1717777777987654321',
                    attributes: [{ key: 'server.address', value: { string_value: 'peer-b' } }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).finish(),
  )
}

describe('buildOtelReceiver — gzip / deflate content-encoding', () => {
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

  const flush = () =>
    (app as unknown as { flushPending: () => Promise<void> }).flushPending()

  it('ingests a gzip-compressed JSON OTLP batch identically to the uncompressed one', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: gzipSync(Buffer.from(JSON.stringify(SAMPLE_BODY))),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ partialSuccess: {} })
    await flush()
    expect(collected).toHaveLength(1)
    expect(collected[0].service).toBe('svc-gzip')
    expect(collected[0].name).toBe('GET /gz')
  })

  it('ingests a gzip-compressed protobuf OTLP batch (the collector default)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: {
        'content-type': 'application/x-protobuf',
        'content-encoding': 'gzip',
      },
      payload: gzipSync(encodeProtobufBody()),
    })
    expect(res.statusCode).toBe(200)
    await flush()
    const span = collected.find((s) => s.service === 'svc-gzip-pb' && s.name === 'op-gz-pb')
    expect(span).toBeDefined()
    expect(span!.traceId).toBe('aabbccddeeff00112233445566778899')
    expect(span!.kind).toBe(3)
    expect(span!.attributes['server.address']).toBe('peer-b')
  })

  it('ingests a deflate-compressed JSON OTLP batch', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { 'content-type': 'application/json', 'content-encoding': 'deflate' },
      payload: deflateSync(Buffer.from(JSON.stringify(SAMPLE_BODY))),
    })
    expect(res.statusCode).toBe(200)
    await flush()
    expect(collected).toHaveLength(1)
    expect(collected[0].service).toBe('svc-gzip')
  })

  it('still accepts an uncompressed JSON batch unchanged (no Content-Encoding)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { 'content-type': 'application/json' },
      payload: SAMPLE_BODY,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ partialSuccess: {} })
    await flush()
    expect(collected).toHaveLength(1)
  })

  it('still accepts an uncompressed protobuf batch unchanged', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { 'content-type': 'application/x-protobuf' },
      payload: encodeProtobufBody(),
    })
    expect(res.statusCode).toBe(200)
    await flush()
    expect(collected.find((s) => s.service === 'svc-gzip-pb')).toBeDefined()
  })

  it('rejects a malformed gzip body cleanly (400) without crashing the receiver', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      // Not valid gzip — the magic bytes and stream are garbage.
      payload: Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]),
    })
    expect(bad.statusCode).toBe(400)
    expect(collected).toEqual([])

    // The receiver is still alive and serves the next good request.
    const good = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: gzipSync(Buffer.from(JSON.stringify(SAMPLE_BODY))),
    })
    expect(good.statusCode).toBe(200)
    await flush()
    expect(collected).toHaveLength(1)
  })

  it('routes a gzip batch through the project-scoped endpoint too', async () => {
    await app.close()
    collected = []
    app = await buildOtelReceiver({
      onSpan: (s) => {
        collected.push(s)
      },
      onProjectSpan: (_project, s) => {
        collected.push(s)
      },
      isProjectRegistered: (p) => p === 'known',
    })
    const res = await app.inject({
      method: 'POST',
      url: '/projects/known/v1/traces',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: gzipSync(Buffer.from(JSON.stringify(SAMPLE_BODY))),
    })
    expect(res.statusCode).toBe(200)
    await flush()
    expect(collected).toHaveLength(1)
    expect(collected[0].service).toBe('svc-gzip')
  })
})
