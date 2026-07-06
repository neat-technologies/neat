import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import protobuf from 'protobufjs'
import type { FastifyInstance } from 'fastify'
import { buildOtelReceiver } from '../src/otel.js'
import {
  buildOtelLogsReceiver,
  registerOtelLogsRoutes,
  parseOtlpLogsRequest,
  type OtlpLogsRequest,
  type ParsedLogRecord,
} from '../src/otel-logs.js'
import { appendLogEntry, queryLogEntries, resetLogsStore } from '../src/logs-store.js'
import type { LogEntry } from '@neat.is/types'

// Real OTLP/HTTP JSON shape (opentelemetry-proto's logs/v1/logs.proto +
// collector/logs/v1/logs_service.proto — verified against the upstream
// proto, not guessed). Three log records across two resources: a plain
// info-level string body with a call site + trace/span cross-reference, an
// error-level string body with no call site, and a non-string (int) body on
// a second service to exercise the "other value kinds stringify" path.
const SAMPLE_LOGS_BODY: OtlpLogsRequest = {
  resourceLogs: [
    {
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'service-a' } }],
      },
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: '1749300000123000000',
              severityNumber: 9,
              severityText: 'INFO',
              body: { stringValue: 'user signed in' },
              attributes: [
                { key: 'code.filepath', value: { stringValue: 'src/auth.ts' } },
                { key: 'code.lineno', value: { intValue: '42' } },
              ],
              traceId: 'aabbccddeeff00112233445566778899',
              spanId: '1111111111111111',
            },
            {
              timeUnixNano: '1749300000456000000',
              severityNumber: 17,
              severityText: 'ERROR',
              body: { stringValue: 'payment failed' },
            },
          ],
        },
      ],
    },
    {
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'service-b' } }],
      },
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: '1749300000789000000',
              severityText: 'warn',
              body: { intValue: '503' },
            },
          ],
        },
      ],
    },
  ],
}

describe('parseOtlpLogsRequest', () => {
  it('flattens resource + scope + log record into a ParsedLogRecord list', () => {
    const records = parseOtlpLogsRequest(SAMPLE_LOGS_BODY)
    expect(records).toHaveLength(3)
  })

  it('extracts service.name from resource attributes', () => {
    const records = parseOtlpLogsRequest(SAMPLE_LOGS_BODY)
    expect(records[0].serviceName).toBe('service-a')
    expect(records[1].serviceName).toBe('service-a')
    expect(records[2].serviceName).toBe('service-b')
  })

  it('leaves serviceName undefined when the resource carries none — no ServiceNode fallback for logs', () => {
    const records = parseOtlpLogsRequest({
      resourceLogs: [
        {
          scopeLogs: [{ logRecords: [{ body: { stringValue: 'no resource at all' } }] }],
        },
      ],
    })
    expect(records[0].serviceName).toBeUndefined()
    expect(records[0].resourceServiceNamePresent).toBe(false)
  })

  it('converts timeUnixNano to ISO8601', () => {
    const records = parseOtlpLogsRequest(SAMPLE_LOGS_BODY)
    expect(records[0].timestamp).toBe('2025-06-07T12:40:00.123Z')
  })

  it('falls back to wall-clock when no timestamp signal is present at all', () => {
    const before = Date.now()
    const records = parseOtlpLogsRequest({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: 'no time' } }] }] }],
    })
    const after = Date.now()
    const ts = Date.parse(records[0].timestamp)
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('normalizes severityNumber to the four-bucket scale, preferring it over severityText', () => {
    const records = parseOtlpLogsRequest(SAMPLE_LOGS_BODY)
    expect(records[0].severity).toBe('info') // 9 -> INFO bucket
    expect(records[1].severity).toBe('error') // 17 -> ERROR bucket
  })

  it('falls back to severityText when severityNumber is absent', () => {
    const records = parseOtlpLogsRequest(SAMPLE_LOGS_BODY)
    expect(records[2].severity).toBe('warn')
  })

  it('folds TRACE into debug and FATAL into error (no dedicated buckets on LogEntry)', () => {
    const records = parseOtlpLogsRequest({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                { severityNumber: 1, body: { stringValue: 'trace' } },
                { severityNumber: 24, body: { stringValue: 'fatal4' } },
              ],
            },
          ],
        },
      ],
    })
    expect(records[0].severity).toBe('debug')
    expect(records[1].severity).toBe('error')
  })

  it('takes body.stringValue as the message', () => {
    const records = parseOtlpLogsRequest(SAMPLE_LOGS_BODY)
    expect(records[0].message).toBe('user signed in')
    expect(records[1].message).toBe('payment failed')
  })

  it('stringifies a non-string body value kind rather than crashing', () => {
    const records = parseOtlpLogsRequest(SAMPLE_LOGS_BODY)
    expect(records[2].message).toBe('503')
  })

  it('handles a missing body without crashing', () => {
    const records = parseOtlpLogsRequest({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ severityText: 'info' }] }] }],
    })
    expect(records).toHaveLength(1)
    expect(records[0].message).toBe('')
  })

  it('stringifies an array-valued body without crashing', () => {
    const records = parseOtlpLogsRequest({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  body: {
                    arrayValue: {
                      values: [{ stringValue: 'a' }, { intValue: '1' }, { boolValue: true }],
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    })
    expect(() => JSON.parse(records[0].message)).not.toThrow()
    expect(JSON.parse(records[0].message)).toEqual(['a', 1, true])
  })

  it('carries code.filepath / code.lineno through as ordinary attributes', () => {
    const records = parseOtlpLogsRequest(SAMPLE_LOGS_BODY)
    expect(records[0].attributes['code.filepath']).toBe('src/auth.ts')
    expect(records[0].attributes['code.lineno']).toBe(42)
  })

  it('carries trace_id / span_id into attributes as a cross-reference when present', () => {
    const records = parseOtlpLogsRequest(SAMPLE_LOGS_BODY)
    expect(records[0].attributes.trace_id).toBe('aabbccddeeff00112233445566778899')
    expect(records[0].attributes.span_id).toBe('1111111111111111')
    // Second record on the same resource carries no traceId/spanId on the wire.
    expect(records[1].attributes.trace_id).toBeUndefined()
    expect(records[1].attributes.span_id).toBeUndefined()
  })

  it('assigns each record its own non-empty synthetic id', () => {
    const records = parseOtlpLogsRequest(SAMPLE_LOGS_BODY)
    const ids = records.map((r) => r.id)
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('handles an empty payload without erroring', () => {
    expect(parseOtlpLogsRequest({})).toEqual([])
  })
})

describe('buildOtelLogsReceiver', () => {
  let app: FastifyInstance
  let collected: ParsedLogRecord[]

  beforeEach(async () => {
    collected = []
    app = await buildOtelLogsReceiver({
      onLogRecord: (r) => {
        collected.push(r)
      },
    })
  })

  afterEach(async () => {
    await app.close()
  })

  it('POST /v1/logs accepts JSON OTLP and dispatches each log record', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { 'content-type': 'application/json' },
      payload: SAMPLE_LOGS_BODY,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ partialSuccess: {} })
    await (app as unknown as { flushPending: () => Promise<void> }).flushPending()
    expect(collected).toHaveLength(3)
    expect(collected[0].message).toBe('user signed in')
  })

  it('GET /health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('handles an empty payload without erroring', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { 'content-type': 'application/json' },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    await (app as unknown as { flushPending: () => Promise<void> }).flushPending()
    expect(collected).toEqual([])
  })

  it('returns 200 before a slow handler completes and drains it after (non-blocking append)', async () => {
    await app.close()
    const observed: string[] = []
    const HANDLER_DELAY_MS = 200
    app = await buildOtelLogsReceiver({
      onLogRecord: async (r) => {
        await new Promise((resolve) => setTimeout(resolve, HANDLER_DELAY_MS))
        observed.push(r.message)
      },
    })
    const start = Date.now()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { 'content-type': 'application/json' },
      payload: SAMPLE_LOGS_BODY,
    })
    const replyMs = Date.now() - start
    expect(res.statusCode).toBe(200)
    expect(replyMs).toBeLessThan(HANDLER_DELAY_MS)
    expect(observed).toEqual([])
    await (app as unknown as { flushPending: () => Promise<void> }).flushPending()
    expect(observed).toEqual(['user signed in', 'payment failed', '503'])
  })

  it('rejects unsupported content types with 415', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { 'content-type': 'application/xml' },
      payload: '<not-otlp/>',
    })
    expect(res.statusCode).toBe(415)
  })

  it('returns 400 for malformed protobuf bodies', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { 'content-type': 'application/x-protobuf' },
      payload: Buffer.from([0xff, 0xff, 0xff]),
    })
    expect(res.statusCode).toBe(400)
  })

  it('decodes a valid application/x-protobuf body via the bundled logs .proto', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const protoRoot = path.resolve(here, '..', 'proto')
    const root = new protobuf.Root()
    root.resolvePath = (_o, t) => path.resolve(protoRoot, t)
    root.loadSync('opentelemetry/proto/collector/logs/v1/logs_service.proto', { keepCase: true })
    const Type = root.lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest')

    const traceIdHex = 'aabbccddeeff00112233445566778899'
    const spanIdHex = '1122334455667788'
    const msg = Type.create({
      resource_logs: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { string_value: 'svc-proto-logs' } }],
          },
          scope_logs: [
            {
              log_records: [
                {
                  time_unix_nano: '1717777777123456789',
                  severity_number: 17,
                  severity_text: 'ERROR',
                  body: { string_value: 'downstream call failed' },
                  attributes: [
                    { key: 'code.filepath', value: { string_value: 'src/handler.ts' } },
                  ],
                  trace_id: Buffer.from(traceIdHex, 'hex'),
                  span_id: Buffer.from(spanIdHex, 'hex'),
                },
              ],
            },
          ],
        },
      ],
    })
    const buf = Buffer.from(Type.encode(msg).finish())

    const res = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { 'content-type': 'application/x-protobuf' },
      payload: buf,
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/x-protobuf')

    await (app as unknown as { flushPending: () => Promise<void> }).flushPending()
    expect(collected).toHaveLength(1)
    const parsed = collected[0]
    expect(parsed.serviceName).toBe('svc-proto-logs')
    expect(parsed.message).toBe('downstream call failed')
    expect(parsed.severity).toBe('error')
    expect(parsed.timestamp).toBe('2024-06-07T16:29:37.123Z')
    expect(parsed.attributes['code.filepath']).toBe('src/handler.ts')
    expect(parsed.attributes.trace_id).toBe(traceIdHex)
    expect(parsed.attributes.span_id).toBe(spanIdHex)
  })

  it('project-scoped route dispatches to onProjectLogRecord when set', async () => {
    await app.close()
    const projectCollected: Array<{ project: string; message: string }> = []
    app = await buildOtelLogsReceiver({
      onLogRecord: () => {
        throw new Error('should not be called when onProjectLogRecord is set')
      },
      onProjectLogRecord: (project, record) => {
        projectCollected.push({ project, message: record.message })
      },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/projects/acme/v1/logs',
      headers: { 'content-type': 'application/json' },
      payload: SAMPLE_LOGS_BODY,
    })
    expect(res.statusCode).toBe(200)
    await (app as unknown as { flushPending: () => Promise<void> }).flushPending()
    expect(projectCollected).toHaveLength(3)
    expect(projectCollected.every((p) => p.project === 'acme')).toBe(true)
  })

  it('project-scoped route falls back to onLogRecord when onProjectLogRecord is unset', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects/acme/v1/logs',
      headers: { 'content-type': 'application/json' },
      payload: SAMPLE_LOGS_BODY,
    })
    expect(res.statusCode).toBe(200)
    await (app as unknown as { flushPending: () => Promise<void> }).flushPending()
    expect(collected).toHaveLength(3)
  })
})

describe('buildOtelLogsReceiver — bearer token gate (ADR-073 §4, same as /v1/traces)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await buildOtelLogsReceiver({
      onLogRecord: () => {},
      authToken: 'right-token',
    })
  })

  afterEach(async () => {
    await app.close()
  })

  it('rejects a request with no bearer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { 'content-type': 'application/json' },
      payload: SAMPLE_LOGS_BODY,
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects a request with the wrong bearer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong-token',
      },
      payload: SAMPLE_LOGS_BODY,
    })
    expect(res.statusCode).toBe(401)
  })

  it('accepts a request with the correct bearer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer right-token',
      },
      payload: SAMPLE_LOGS_BODY,
    })
    expect(res.statusCode).toBe(200)
  })

  it('/health stays unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
  })
})

// daemon.ts mounts /v1/logs onto the exact same Fastify app /v1/traces
// already lives on (registerOtelLogsRoutes against buildOtelReceiver's
// app), so both receivers share one port and one bearer-auth hook. This
// proves that mounting doesn't collide on the protobuf content-type parser
// (already registered by buildOtelReceiver) and that the shared auth hook
// covers both paths.
describe('registerOtelLogsRoutes — mounted onto the shared /v1/traces app (daemon.ts wiring shape)', () => {
  let app: FastifyInstance
  let logRecords: ParsedLogRecord[]

  beforeEach(async () => {
    logRecords = []
    app = await buildOtelReceiver({
      onSpan: () => {},
      authToken: 'shared-token',
    })
    registerOtelLogsRoutes(app, {
      onLogRecord: (r) => {
        logRecords.push(r)
      },
    })
  })

  afterEach(async () => {
    await app.close()
  })

  it('does not throw when the protobuf content-type parser is already registered', () => {
    expect(app.hasContentTypeParser('application/x-protobuf')).toBe(true)
  })

  it('both /v1/traces and /v1/logs work on the one shared app', async () => {
    const tracesRes = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer shared-token',
      },
      payload: { resourceSpans: [] },
    })
    expect(tracesRes.statusCode).toBe(200)

    const logsRes = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer shared-token',
      },
      payload: SAMPLE_LOGS_BODY,
    })
    expect(logsRes.statusCode).toBe(200)
    await (app as unknown as { flushPending: () => Promise<void> }).flushPending()
    expect(logRecords).toHaveLength(3)
  })

  it('the shared bearer-auth hook covers /v1/logs too', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { 'content-type': 'application/json' },
      payload: SAMPLE_LOGS_BODY,
    })
    expect(res.statusCode).toBe(401)
  })
})

// End-to-end through the actual store — the receiver never touches
// NeatGraph, so the only production sink for a ParsedLogRecord is
// appendLogEntry (logs-store.ts). This exercises that full path.
describe('otel-logs receiver -> appendLogEntry -> queryLogEntries', () => {
  afterEach(() => {
    resetLogsStore()
  })

  it('a JSON OTLP payload maps to LogEntrys retrievable from the store', async () => {
    const app = await buildOtelLogsReceiver({
      onLogRecord: (record) => {
        const entry: LogEntry = {
          id: record.id,
          projectName: 'demo',
          source: 'native',
          serviceName: record.serviceName,
          timestamp: record.timestamp,
          severity: record.severity,
          message: record.message,
          attributes: Object.keys(record.attributes).length > 0 ? record.attributes : undefined,
        }
        appendLogEntry(entry)
      },
    })
    // logs-store.ts prunes anything older than 24h on every append
    // (LOGS_STORE_MAX_AGE_MS), so this integration test needs a live
    // timestamp rather than SAMPLE_LOGS_BODY's fixed 2025 fixture dates —
    // those are intentionally stable for the ISO-conversion assertions
    // above, but would prune themselves out of the store immediately here.
    const nowNanos = (BigInt(Date.now()) * 1_000_000n).toString()
    const freshBody: OtlpLogsRequest = JSON.parse(
      JSON.stringify(SAMPLE_LOGS_BODY).replaceAll(/"\d{19}"/g, `"${nowNanos}"`),
    )
    const res = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { 'content-type': 'application/json' },
      payload: freshBody,
    })
    expect(res.statusCode).toBe(200)
    await (app as unknown as { flushPending: () => Promise<void> }).flushPending()
    await app.close()

    const stored = queryLogEntries({ projectName: 'demo' })
    expect(stored).toHaveLength(3)
    expect(stored.some((e) => e.message === 'user signed in' && e.serviceName === 'service-a')).toBe(true)
    expect(stored.some((e) => e.message === 'payment failed' && e.severity === 'error')).toBe(true)
    expect(stored.some((e) => e.message === '503' && e.serviceName === 'service-b')).toBe(true)
    // Never a graph mutation — this is purely a store append. There's
    // nothing to assert "absence of" against a graph here since this
    // receiver is never handed one; the absence of any NeatGraph import in
    // otel-logs.ts is the actual guarantee (see otel-ingest.md's ADR-132
    // section).
  })
})
