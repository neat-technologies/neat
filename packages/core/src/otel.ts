import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import protobuf from 'protobufjs'

// OTLP/HTTP receiver. Listens on /v1/traces and decodes the JSON wire format
// (collector's `otlphttp` exporter with `encoding: json`). Each span is
// flattened into a ParsedSpan and handed to the configured handler. The
// handler is the seam #8 wires its edge mapper into; #7 itself stays decoupled
// from graph mutation.

export interface ParsedSpan {
  service: string
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind?: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  // ISO8601 derived from startTimeUnixNano. Production paths (lastObserved on
  // OBSERVED edges) read this so the recorded time reflects when the span fired,
  // not when the receiver received it. Undefined only when startTimeUnixNano is
  // missing or unparseable — handler falls back to wall-clock in that case.
  // See docs/contracts/otel-ingest.md §lastObserved-from-span-time.
  startTimeIso?: string
  // bigint so the 9-digit-nanos arithmetic doesn't lose precision on long traces.
  durationNanos: bigint
  attributes: Record<string, AttributeValue>
  // Convenience accessors for the attributes #8 cares about.
  dbSystem?: string
  dbName?: string
  // 0 = UNSET, 1 = OK, 2 = ERROR per OTLP. We only care that 2 means error.
  statusCode?: number
  errorMessage?: string
  // Pre-extracted from a span event with name="exception". OTLP SDKs record
  // exceptions this way (richer than status.message). handleSpan reads these
  // first, falling back to status.message and span.name. See
  // docs/contracts/otel-ingest.md §exception-data-from-span-events.
  exception?: {
    type?: string
    message?: string
    stacktrace?: string
  }
}

export type AttributeValue =
  | string
  | number
  | boolean
  | bigint
  | string[]
  | number[]
  | boolean[]
  | null

export type SpanHandler = (span: ParsedSpan) => void | Promise<void>

export interface BuildOtelReceiverOptions {
  onSpan: SpanHandler
  // Synchronous handler for spans with statusCode === 2. The receiver awaits
  // it before replying, so a write failure can return 500 → OTel SDK retries.
  // Optional — wiring is expected to plumb appendErrorEvent here when error
  // durability matters; ad-hoc receivers leave it undefined.
  // See docs/contracts/otel-ingest.md §Error events.
  onErrorSpanSync?: (span: ParsedSpan) => Promise<void>
  // Fastify body limit. OTLP batches can be large; default is 16 MB.
  bodyLimit?: number
}

interface OtlpKeyValue {
  key: string
  value?: OtlpAnyValue
}

interface OtlpAnyValue {
  stringValue?: string
  intValue?: string | number
  doubleValue?: number
  boolValue?: boolean
  arrayValue?: { values?: OtlpAnyValue[] }
  // kvlistValue / bytesValue are skipped — neither is on the demo path.
}

interface OtlpStatus {
  code?: number
  message?: string
}

interface OtlpEvent {
  name?: string
  timeUnixNano?: string
  attributes?: OtlpKeyValue[]
}

interface OtlpSpan {
  traceId?: string
  spanId?: string
  parentSpanId?: string
  name?: string
  kind?: number
  startTimeUnixNano?: string
  endTimeUnixNano?: string
  attributes?: OtlpKeyValue[]
  events?: OtlpEvent[]
  status?: OtlpStatus
}

function extractExceptionFromEvents(events: OtlpEvent[] | undefined): ParsedSpan['exception'] {
  if (!events) return undefined
  for (const ev of events) {
    if (ev.name !== 'exception') continue
    const attrs = attrsToRecord(ev.attributes)
    const out: ParsedSpan['exception'] = {}
    const t = attrs['exception.type']
    const m = attrs['exception.message']
    const s = attrs['exception.stacktrace']
    if (typeof t === 'string') out.type = t
    if (typeof m === 'string') out.message = m
    if (typeof s === 'string') out.stacktrace = s
    if (out.type || out.message || out.stacktrace) return out
  }
  return undefined
}

interface OtlpScopeSpans {
  spans?: OtlpSpan[]
}

interface OtlpResourceSpans {
  resource?: { attributes?: OtlpKeyValue[] }
  scopeSpans?: OtlpScopeSpans[]
}

export interface OtlpTracesRequest {
  resourceSpans?: OtlpResourceSpans[]
}

function flattenAttribute(v: OtlpAnyValue | undefined): AttributeValue {
  if (!v) return null
  if (v.stringValue !== undefined) return v.stringValue
  if (v.boolValue !== undefined) return v.boolValue
  if (v.intValue !== undefined) {
    return typeof v.intValue === 'string' ? Number(v.intValue) : v.intValue
  }
  if (v.doubleValue !== undefined) return v.doubleValue
  if (v.arrayValue?.values) {
    return v.arrayValue.values.map((x) => flattenAttribute(x)) as AttributeValue
  }
  return null
}

function attrsToRecord(attrs: OtlpKeyValue[] | undefined): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {}
  if (!attrs) return out
  for (const kv of attrs) {
    if (kv.key) out[kv.key] = flattenAttribute(kv.value)
  }
  return out
}

function durationNanos(start?: string, end?: string): bigint {
  if (!start || !end) return 0n
  try {
    return BigInt(end) - BigInt(start)
  } catch {
    return 0n
  }
}

// Convert OTLP's startTimeUnixNano (a base-10 string of nanoseconds since the
// Unix epoch) to ISO8601. Returns undefined when the input is missing, zero,
// or unparseable, so the caller can fall back to wall-clock without surfacing
// a fake timestamp on the edge.
export function isoFromUnixNano(nanos: string | undefined): string | undefined {
  if (!nanos || nanos === '0') return undefined
  try {
    const ms = Number(BigInt(nanos) / 1_000_000n)
    if (!Number.isFinite(ms)) return undefined
    return new Date(ms).toISOString()
  } catch {
    return undefined
  }
}

export function parseOtlpRequest(body: OtlpTracesRequest): ParsedSpan[] {
  const out: ParsedSpan[] = []
  for (const rs of body.resourceSpans ?? []) {
    const resourceAttrs = attrsToRecord(rs.resource?.attributes)
    const service = typeof resourceAttrs['service.name'] === 'string'
      ? (resourceAttrs['service.name'] as string)
      : 'unknown'

    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const attrs = attrsToRecord(span.attributes)
        const parsed: ParsedSpan = {
          service,
          traceId: span.traceId ?? '',
          spanId: span.spanId ?? '',
          parentSpanId: span.parentSpanId || undefined,
          name: span.name ?? '',
          kind: span.kind,
          startTimeUnixNano: span.startTimeUnixNano ?? '0',
          endTimeUnixNano: span.endTimeUnixNano ?? '0',
          startTimeIso: isoFromUnixNano(span.startTimeUnixNano),
          durationNanos: durationNanos(span.startTimeUnixNano, span.endTimeUnixNano),
          attributes: attrs,
          dbSystem: typeof attrs['db.system'] === 'string' ? (attrs['db.system'] as string) : undefined,
          dbName: typeof attrs['db.name'] === 'string' ? (attrs['db.name'] as string) : undefined,
          statusCode: span.status?.code,
          errorMessage: span.status?.message,
          exception: extractExceptionFromEvents(span.events),
        }
        out.push(parsed)
      }
    }
  }
  return out
}

export interface OtelReceiver {
  app: FastifyInstance
  // Resolves once every span enqueued so far has been handed to opts.onSpan.
  // Test seam — production code never awaits this.
  flushPending: () => Promise<void>
}

// Lazy-loaded protobuf decoder for ExportTraceServiceRequest. The bundled
// .proto tree at packages/core/proto/ is shared with the gRPC receiver
// (ADR-020). Cached after first load so successive receiver builds reuse it.
let exportTraceServiceRequestType: protobuf.Type | null = null
let exportTraceServiceResponseType: protobuf.Type | null = null

function loadProtoRoot(): protobuf.Root {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const protoRoot = path.resolve(here, '..', 'proto')
  const root = new protobuf.Root()
  root.resolvePath = (_origin, target) => path.resolve(protoRoot, target)
  root.loadSync(
    'opentelemetry/proto/collector/trace/v1/trace_service.proto',
    { keepCase: true },
  )
  return root
}

function loadProtobufDecoder(): protobuf.Type {
  if (exportTraceServiceRequestType) return exportTraceServiceRequestType
  const root = loadProtoRoot()
  exportTraceServiceRequestType = root.lookupType(
    'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest',
  )
  return exportTraceServiceRequestType
}

function loadProtobufResponseEncoder(): protobuf.Type {
  if (exportTraceServiceResponseType) return exportTraceServiceResponseType
  const root = loadProtoRoot()
  exportTraceServiceResponseType = root.lookupType(
    'opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse',
  )
  return exportTraceServiceResponseType
}

// Empty-partial-success response, encoded once and cached. Per ADR-033 the
// receiver always reports "all accepted" today — there's no per-span reject
// path. Caching the bytes avoids re-running the protobuf encoder per request.
let cachedProtobufResponseBody: Buffer | null = null

function encodeProtobufResponseBody(): Buffer {
  if (cachedProtobufResponseBody) return cachedProtobufResponseBody
  const Type = loadProtobufResponseEncoder()
  // `partial_success` left unset = empty submessage = "everything accepted".
  // verify() returns null on success; the empty payload is always valid.
  const msg = Type.create({})
  const encoded = Type.encode(msg).finish()
  cachedProtobufResponseBody = Buffer.from(encoded)
  return cachedProtobufResponseBody
}

async function decodeProtobufBody(buf: Buffer): Promise<OtlpTracesRequest> {
  const Type = loadProtobufDecoder()
  // Decode keeps the proto field names verbatim (keepCase: true), matching the
  // GrpcExportRequest shape that reshapeGrpcRequest already understands.
  // Dynamic import sidesteps the circular module dep with otel-grpc.ts.
  const decoded = Type.decode(buf).toJSON() as Record<string, unknown>
  const { reshapeGrpcRequest } = await import('./otel-grpc.js')
  return reshapeGrpcRequest(decoded as never)
}

export async function buildOtelReceiver(
  opts: BuildOtelReceiverOptions,
): Promise<FastifyInstance & { flushPending: () => Promise<void> }> {
  const app = Fastify({
    logger: false,
    bodyLimit: opts.bodyLimit ?? 16 * 1024 * 1024,
  })

  // Non-blocking ingest (ADR-033). The receiver replies 200 OK as soon as the
  // body is parsed; mutation runs through this queue, drained on the next tick.
  // OTel SDK exporters retry on timeout, so blocking ingest produces observable
  // backpressure on the system being observed — ambient observation requires no
  // observable effect.
  const queue: ParsedSpan[] = []
  let draining = false
  let drainPromise: Promise<void> = Promise.resolve()

  const drain = async (): Promise<void> => {
    if (draining) return
    draining = true
    try {
      while (queue.length > 0) {
        const span = queue.shift()!
        try {
          await opts.onSpan(span)
        } catch (err) {
          console.warn(`[neat] otel handler error: ${(err as Error).message}`)
        }
      }
    } finally {
      draining = false
    }
  }

  const enqueue = (spans: ParsedSpan[]): void => {
    if (spans.length === 0) return
    for (const s of spans) queue.push(s)
    // Schedule on the next tick so the 200 response is on the wire before any
    // mutation runs. Each call gets its own promise so flushPending() can wait
    // on the latest drain cycle.
    drainPromise = drainPromise.then(() => drain())
  }

  // Buffer application/x-protobuf bodies as raw bytes; the route handler
  // decodes them via the bundled .proto tree (ADR-020).
  app.addContentTypeParser(
    'application/x-protobuf',
    { parseAs: 'buffer', bodyLimit: opts.bodyLimit ?? 16 * 1024 * 1024 },
    (_req, body, done) => {
      done(null, body)
    },
  )

  app.get('/health', async () => ({ ok: true }))

  app.post('/v1/traces', async (req, reply) => {
    // Content-Type dispatch (ADR-033). Both JSON and protobuf decode to the
    // same OtlpTracesRequest shape, then feed parseOtlpRequest unchanged.
    // The response encoding mirrors the request encoding per the OTLP spec —
    // a JSON exporter receives JSON, a protobuf exporter receives protobuf.
    // Mismatched encodings cause client SDKs to log decode errors every batch.
    const ct = (req.headers['content-type'] ?? '').toString().split(';')[0]!.trim().toLowerCase()
    let body: OtlpTracesRequest
    let responseFlavor: 'json' | 'protobuf'
    if (ct === 'application/x-protobuf') {
      responseFlavor = 'protobuf'
      try {
        body = await decodeProtobufBody(req.body as Buffer)
      } catch (err) {
        return reply.code(400).send({
          error: `protobuf decode failed: ${(err as Error).message}`,
        })
      }
    } else if (!ct || ct === 'application/json') {
      responseFlavor = 'json'
      body = (req.body ?? {}) as OtlpTracesRequest
    } else {
      return reply.code(415).send({ error: `unsupported content-type: ${ct}` })
    }
    const spans = parseOtlpRequest(body)
    // Synchronous error-event write before reply (ADR-033 §Error events).
    // Graph mutation stays on the async queue, but the receiver awaits the
    // file write so a write failure surfaces as 500 → OTel SDK retries.
    if (opts.onErrorSpanSync) {
      try {
        for (const span of spans) {
          if (span.statusCode === 2) await opts.onErrorSpanSync(span)
        }
      } catch (err) {
        return reply.code(500).send({
          error: `error-event write failed: ${(err as Error).message}`,
        })
      }
    }
    enqueue(spans)
    // OTLP success response is `{ partialSuccess: {} }` for "all accepted".
    // Match the response Content-Type to the request: protobuf in → protobuf
    // out, JSON in → JSON out. Default Fastify JSON reply path stays as the
    // historical shape for JSON callers.
    if (responseFlavor === 'protobuf') {
      const buf = encodeProtobufResponseBody()
      return reply
        .code(200)
        .header('content-type', 'application/x-protobuf')
        .send(buf)
    }
    return reply
      .code(200)
      .header('content-type', 'application/json')
      .send({ partialSuccess: {} })
  })

  // Attach flushPending so tests can wait for the queue without exporting a
  // separate handle. The cast goes through `unknown` because Fastify's typing
  // is parameterised over the raw server type and the simple intersection
  // confuses TS's structural narrowing.
  const decorated = app as unknown as FastifyInstance & { flushPending: () => Promise<void> }
  decorated.flushPending = async () => {
    // Settle the current drain chain, then loop until the queue is fully empty
    // (a span enqueued mid-flush would otherwise be missed).
    while (queue.length > 0 || draining) {
      await drainPromise
    }
  }
  return decorated
}

export function logSpanHandler(span: ParsedSpan): void {
  const parent = span.parentSpanId ? span.parentSpanId.slice(0, 8) : '<root>'
  const status = span.statusCode === 2 ? 'ERROR' : 'OK'
  const db = span.dbSystem ? ` db=${span.dbSystem}/${span.dbName ?? '?'}` : ''
  console.log(
    `otel: ${span.service} ${span.name} parent=${parent} status=${status}${db}`,
  )
}
