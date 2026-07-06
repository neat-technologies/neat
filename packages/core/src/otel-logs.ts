import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import protobuf from 'protobufjs'
import { mountBearerAuth } from './auth.js'

// OTLP/HTTP logs receiver (ADR-132, docs/contracts/logs.md, the
// otel-ingest.md "sibling /v1/logs receiver" amendment). Structurally this
// is `otel.ts`'s `/v1/traces` receiver retargeted at the OTLP *logs* signal:
// same JSON + protobuf content-type dispatch, same bearer-token gate, same
// non-blocking-receiver shape. The one deliberate difference is the
// destination — this module never touches `NeatGraph`. It only ever
// produces `ParsedLogRecord`s for a caller-supplied handler to turn into
// `LogEntry`s via `logs-store.ts`'s `appendLogEntry`. No node is minted, no
// edge is minted, no graph is read.

export interface ParsedLogRecord {
  // Synthetic — OTLP log records carry no wire-level identity the way a span
  // carries `(traceId, spanId)`. Most structured-logger output has neither a
  // trace nor a span attached, so `randomUUID()` (already the codebase's
  // convention — see connectors/cloudflare/client.ts) is the honest choice
  // over fabricating one from fields that are frequently absent.
  id: string
  // `resource.attributes['service.name']`. Left undefined when the resource
  // didn't carry one — unlike a span, a log record mints nothing and needs
  // no service to route against, so there's no pressure to fall back to a
  // placeholder like span parsing's `'unidentified'`.
  serviceName?: string
  resourceServiceNamePresent?: boolean
  // ISO8601. Always set: `timeUnixNano` when present, else
  // `observedTimeUnixNano` (the proto's own documented fallback order),
  // else wall-clock as a last resort so a record is never dropped merely for
  // missing every timestamp signal.
  timestamp: string
  // Normalized 'debug' | 'info' | 'warn' | 'error'. Undefined when neither
  // `severityNumber` nor `severityText` yields a signal.
  severity?: string
  message: string
  // The log record's own attributes, flattened, plus (when present)
  // `trace_id` / `span_id` as a cross-reference back to the trace that
  // produced it. `code.filepath` / `code.lineno`, when the SDK stamped them,
  // ride through here unchanged — no special-casing needed since they're
  // ordinary OTLP attributes.
  attributes: Record<string, unknown>
}

export type LogRecordHandler = (record: ParsedLogRecord) => void | Promise<void>
// Project-scoped variant, mirroring otel.ts's ProjectSpanHandler — used by
// `/projects/:project/v1/logs` once the URL already names the project.
export type ProjectLogRecordHandler = (
  project: string,
  record: ParsedLogRecord,
) => void | Promise<void>

interface OtlpAnyValue {
  stringValue?: string
  intValue?: string | number
  doubleValue?: number
  boolValue?: boolean
  arrayValue?: { values?: OtlpAnyValue[] }
  kvlistValue?: { values?: OtlpKeyValue[] }
  bytesValue?: string
}

interface OtlpKeyValue {
  key: string
  value?: OtlpAnyValue
}

interface OtlpLogRecord {
  timeUnixNano?: string
  observedTimeUnixNano?: string
  severityNumber?: number
  severityText?: string
  body?: OtlpAnyValue
  attributes?: OtlpKeyValue[]
  traceId?: string
  spanId?: string
}

interface OtlpScopeLogs {
  logRecords?: OtlpLogRecord[]
}

interface OtlpResourceLogs {
  resource?: { attributes?: OtlpKeyValue[] }
  scopeLogs?: OtlpScopeLogs[]
}

export interface OtlpLogsRequest {
  resourceLogs?: OtlpResourceLogs[]
}

function flattenAnyValue(v: OtlpAnyValue | undefined): unknown {
  if (!v) return null
  if (v.stringValue !== undefined) return v.stringValue
  if (v.boolValue !== undefined) return v.boolValue
  if (v.intValue !== undefined) {
    return typeof v.intValue === 'string' ? Number(v.intValue) : v.intValue
  }
  if (v.doubleValue !== undefined) return v.doubleValue
  if (v.arrayValue?.values) return v.arrayValue.values.map((x) => flattenAnyValue(x))
  if (v.kvlistValue?.values) {
    const out: Record<string, unknown> = {}
    for (const kv of v.kvlistValue.values) {
      if (kv.key) out[kv.key] = flattenAnyValue(kv.value)
    }
    return out
  }
  if (v.bytesValue !== undefined) return v.bytesValue
  return null
}

function attrsToRecord(attrs: OtlpKeyValue[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!attrs) return out
  for (const kv of attrs) {
    if (kv.key) out[kv.key] = flattenAnyValue(kv.value)
  }
  return out
}

// `body` is an `AnyValue` (docs/contracts/otel-ingest.md's ADR-132 section).
// Structured loggers overwhelmingly emit a plain string body; anything else
// (a numeric/bool body, or a structured object a logger chose to attach as
// the body rather than as attributes) is stringified rather than dropped.
function messageFromBody(body: OtlpAnyValue | undefined): string {
  if (!body) return ''
  if (body.stringValue !== undefined) return body.stringValue
  const flattened = flattenAnyValue(body)
  if (flattened === null || flattened === undefined) return ''
  if (typeof flattened === 'string') return flattened
  try {
    return JSON.stringify(flattened)
  } catch {
    return String(flattened)
  }
}

// OTel's SeverityNumber buckets (1-4 TRACE, 5-8 DEBUG, 9-12 INFO, 13-16
// WARN, 17-20 ERROR, 21-24 FATAL). `LogEntry.severity` only has four
// buckets, so TRACE folds into 'debug' and FATAL folds into 'error' — the
// nearest neighbour in each case, and consistent with how most log
// frontends collapse a finer OTel scale onto a four-level one.
function severityFromNumber(n: number | undefined): string | undefined {
  if (typeof n !== 'number' || n <= 0) return undefined
  if (n >= 17) return 'error'
  if (n >= 13) return 'warn'
  if (n >= 9) return 'info'
  return 'debug'
}

const SEVERITY_TEXT_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/^(fatal|critical|crit|panic|error|err)/i, 'error'],
  [/^warn/i, 'warn'],
  [/^(info|notice|log)/i, 'info'],
  [/^(trace|debug)/i, 'debug'],
]

function severityFromText(t: string | undefined): string | undefined {
  if (!t) return undefined
  const trimmed = t.trim()
  for (const [re, sev] of SEVERITY_TEXT_PATTERNS) {
    if (re.test(trimmed)) return sev
  }
  return undefined
}

// `severityNumber` is the canonical, spec-defined numeric signal — prefer it
// when present. `severityText` (the log-library's own level string) is the
// fallback for producers that only set the text form.
function normalizeSeverity(
  severityNumber: number | undefined,
  severityText: string | undefined,
): string | undefined {
  return severityFromNumber(severityNumber) ?? severityFromText(severityText)
}

// Same conversion `otel.ts` uses for `startTimeUnixNano`, duplicated locally
// rather than imported — logs.md/otel-ingest.md govern this file
// independently of otel.ts, and the conversion itself is a two-line, ADR-free
// utility not worth a cross-file dependency for.
function isoFromUnixNano(nanos: string | undefined): string | undefined {
  if (!nanos || nanos === '0') return undefined
  try {
    const ms = Number(BigInt(nanos) / 1_000_000n)
    if (!Number.isFinite(ms)) return undefined
    return new Date(ms).toISOString()
  } catch {
    return undefined
  }
}

// time_unix_nano first, observed_time_unix_nano second (the proto's own
// documented recommendation), wall-clock last. A record is never dropped
// merely for missing every timestamp signal — the honest fallback mirrors
// `pickEnv`'s literal-'unknown' pattern in otel.ts rather than fabricating a
// span-time-shaped value from nothing.
function timestampOf(record: OtlpLogRecord): string {
  return (
    isoFromUnixNano(record.timeUnixNano) ??
    isoFromUnixNano(record.observedTimeUnixNano) ??
    new Date().toISOString()
  )
}

export function parseOtlpLogsRequest(body: OtlpLogsRequest): ParsedLogRecord[] {
  const out: ParsedLogRecord[] = []
  for (const rl of body.resourceLogs ?? []) {
    const resourceAttrs = attrsToRecord(rl.resource?.attributes)
    const rawServiceName = resourceAttrs['service.name']
    const resourceServiceNamePresent =
      typeof rawServiceName === 'string' && rawServiceName.length > 0
    const serviceName = resourceServiceNamePresent ? (rawServiceName as string) : undefined

    for (const sl of rl.scopeLogs ?? []) {
      for (const lr of sl.logRecords ?? []) {
        const attributes = attrsToRecord(lr.attributes)
        // Cross-reference back to the trace this log line was written
        // during, when the SDK correlated the two (docs/contracts/
        // otel-ingest.md's ADR-132 section). Carried in the free-form
        // attribute bag — `LogEntry` has no dedicated field for either.
        if (lr.traceId) attributes.trace_id = lr.traceId
        if (lr.spanId) attributes.span_id = lr.spanId

        out.push({
          id: randomUUID(),
          serviceName,
          resourceServiceNamePresent,
          timestamp: timestampOf(lr),
          severity: normalizeSeverity(lr.severityNumber, lr.severityText),
          message: messageFromBody(lr.body),
          attributes,
        })
      }
    }
  }
  return out
}

// ── protobuf decode (application/x-protobuf) ────────────────────────────────
//
// Mirrors otel.ts's ExportTraceServiceRequest decoder against the bundled
// logs proto tree (packages/core/proto/opentelemetry/proto/{logs,collector/
// logs}/v1/*.proto — added alongside this receiver; the trace-only proto
// tree otel.ts already bundles doesn't cover the logs signal, a distinct
// OTLP message family). `keepCase: true` decodes snake_case field names, so
// the result is reshaped onto the same camelCase shape parseOtlpLogsRequest
// already understands — the same two-step decode-then-reshape otel-grpc.ts
// uses for the gRPC trace path.

interface ProtoAnyValue {
  string_value?: string
  bool_value?: boolean
  int_value?: string | number
  double_value?: number
  array_value?: { values?: ProtoAnyValue[] }
  kvlist_value?: { values?: ProtoKeyValue[] }
  bytes_value?: Buffer | Uint8Array
}

interface ProtoKeyValue {
  key?: string
  value?: ProtoAnyValue
}

interface ProtoLogRecord {
  time_unix_nano?: string | number
  observed_time_unix_nano?: string | number
  severity_number?: number
  severity_text?: string
  body?: ProtoAnyValue
  attributes?: ProtoKeyValue[]
  trace_id?: Buffer | Uint8Array
  span_id?: Buffer | Uint8Array
}

interface ProtoScopeLogs {
  log_records?: ProtoLogRecord[]
}

interface ProtoResourceLogs {
  resource?: { attributes?: ProtoKeyValue[] }
  scope_logs?: ProtoScopeLogs[]
}

interface ProtoExportLogsServiceRequest {
  resource_logs?: ProtoResourceLogs[]
}

// Bytes fields (trace_id/span_id) arrive as Buffer/Uint8Array under the
// default toObject() decode; hex-encode for consistency with the JSON wire
// format's hex string convention (same fix #468 applied to span IDs).
function bytesToHex(buf: Buffer | Uint8Array | undefined): string | undefined {
  if (!buf) return undefined
  if (Buffer.isBuffer(buf)) return buf.toString('hex')
  if (buf instanceof Uint8Array) return Buffer.from(buf).toString('hex')
  return undefined
}

function reshapeAnyValue(v: ProtoAnyValue | undefined): OtlpAnyValue | undefined {
  if (!v) return undefined
  return {
    stringValue: v.string_value,
    boolValue: v.bool_value,
    intValue: v.int_value,
    doubleValue: v.double_value,
    arrayValue: v.array_value
      ? { values: (v.array_value.values ?? []).map((x) => reshapeAnyValue(x)) as OtlpAnyValue[] }
      : undefined,
    kvlistValue: v.kvlist_value
      ? { values: reshapeKeyValues(v.kvlist_value.values) }
      : undefined,
    bytesValue: bytesToHex(v.bytes_value),
  }
}

function reshapeKeyValues(attrs: ProtoKeyValue[] | undefined): OtlpKeyValue[] {
  return (attrs ?? []).map((kv) => ({ key: kv.key ?? '', value: reshapeAnyValue(kv.value) }))
}

function nanosToString(n: string | number | undefined): string | undefined {
  if (n === undefined || n === null) return undefined
  return typeof n === 'string' ? n : String(n)
}

function reshapeLogsRequest(decoded: ProtoExportLogsServiceRequest): OtlpLogsRequest {
  return {
    resourceLogs: (decoded.resource_logs ?? []).map((rl) => ({
      resource: rl.resource ? { attributes: reshapeKeyValues(rl.resource.attributes) } : undefined,
      scopeLogs: (rl.scope_logs ?? []).map((sl) => ({
        logRecords: (sl.log_records ?? []).map((lr) => ({
          timeUnixNano: nanosToString(lr.time_unix_nano),
          observedTimeUnixNano: nanosToString(lr.observed_time_unix_nano),
          severityNumber: lr.severity_number,
          severityText: lr.severity_text,
          body: reshapeAnyValue(lr.body),
          attributes: reshapeKeyValues(lr.attributes),
          traceId: bytesToHex(lr.trace_id),
          spanId: bytesToHex(lr.span_id),
        })),
      })),
    })),
  }
}

let exportLogsServiceRequestType: protobuf.Type | null = null
let exportLogsServiceResponseType: protobuf.Type | null = null

function loadLogsProtoRoot(): protobuf.Root {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const protoRoot = path.resolve(here, '..', 'proto')
  const root = new protobuf.Root()
  root.resolvePath = (_origin, target) => path.resolve(protoRoot, target)
  root.loadSync('opentelemetry/proto/collector/logs/v1/logs_service.proto', { keepCase: true })
  return root
}

function loadLogsProtobufDecoder(): protobuf.Type {
  if (exportLogsServiceRequestType) return exportLogsServiceRequestType
  const root = loadLogsProtoRoot()
  exportLogsServiceRequestType = root.lookupType(
    'opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest',
  )
  return exportLogsServiceRequestType
}

function loadLogsProtobufResponseEncoder(): protobuf.Type {
  if (exportLogsServiceResponseType) return exportLogsServiceResponseType
  const root = loadLogsProtoRoot()
  exportLogsServiceResponseType = root.lookupType(
    'opentelemetry.proto.collector.logs.v1.ExportLogsServiceResponse',
  )
  return exportLogsServiceResponseType
}

let cachedLogsProtobufResponseBody: Buffer | null = null

function encodeLogsProtobufResponseBody(): Buffer {
  if (cachedLogsProtobufResponseBody) return cachedLogsProtobufResponseBody
  const Type = loadLogsProtobufResponseEncoder()
  const msg = Type.create({})
  const encoded = Type.encode(msg).finish()
  cachedLogsProtobufResponseBody = Buffer.from(encoded)
  return cachedLogsProtobufResponseBody
}

function decodeProtobufLogsBody(buf: Buffer): OtlpLogsRequest {
  const Type = loadLogsProtobufDecoder()
  const decoded = Type.toObject(Type.decode(buf), {
    longs: String,
    enums: Number,
  }) as ProtoExportLogsServiceRequest
  return reshapeLogsRequest(decoded)
}

// ── Fastify wiring ───────────────────────────────────────────────────────────

export interface RegisterOtelLogsRoutesOptions {
  onLogRecord: LogRecordHandler
  // Project-scoped route (`/projects/:project/v1/logs`). When unset, that
  // route still exists but falls through to `onLogRecord` — same fallback
  // shape as otel.ts's `onProjectSpan`.
  onProjectLogRecord?: ProjectLogRecordHandler
  bodyLimit?: number
}

export interface OtelLogsRoutes {
  // Test seam — resolves once every record enqueued so far has reached its
  // handler. Production code never awaits this.
  flushPending: () => Promise<void>
}

async function readOtlpLogsBody(
  req: import('fastify').FastifyRequest,
): Promise<
  | { ok: true; body: OtlpLogsRequest; flavor: 'json' | 'protobuf' }
  | { ok: false; code: 400 | 415; error: string }
> {
  const ct = (req.headers['content-type'] ?? '').toString().split(';')[0]!.trim().toLowerCase()
  if (ct === 'application/x-protobuf') {
    try {
      const body = decodeProtobufLogsBody(req.body as Buffer)
      return { ok: true, body, flavor: 'protobuf' }
    } catch (err) {
      return { ok: false, code: 400, error: `protobuf decode failed: ${(err as Error).message}` }
    }
  }
  if (!ct || ct === 'application/json') {
    return { ok: true, body: (req.body ?? {}) as OtlpLogsRequest, flavor: 'json' }
  }
  return { ok: false, code: 415, error: `unsupported content-type: ${ct}` }
}

function sendOtlpLogsSuccess(
  reply: import('fastify').FastifyReply,
  flavor: 'json' | 'protobuf',
): unknown {
  if (flavor === 'protobuf') {
    const buf = encodeLogsProtobufResponseBody()
    return reply.code(200).header('content-type', 'application/x-protobuf').send(buf)
  }
  return reply.code(200).header('content-type', 'application/json').send({ partialSuccess: {} })
}

// Registers `/v1/logs` and `/projects/:project/v1/logs` onto an existing
// Fastify instance. This is the seam daemon.ts uses to mount the logs
// receiver onto the same app (and therefore the same port) the `/v1/traces`
// receiver already binds — OTLP's own convention is one collector endpoint
// serving every signal on distinct paths, and reusing the app means reusing
// its already-mounted bearer-auth hook for free rather than standing up a
// second port with its own auth and its own daemon.json bookkeeping.
//
// Registers the `application/x-protobuf` content-type parser only if the app
// doesn't already have one (buildOtelReceiver's `/v1/traces` app registers
// it first when both receivers share an instance; a bare app built for
// testing this module in isolation won't have it yet).
export function registerOtelLogsRoutes(
  app: FastifyInstance,
  opts: RegisterOtelLogsRoutesOptions,
): OtelLogsRoutes {
  const bodyLimit = opts.bodyLimit ?? 16 * 1024 * 1024
  if (!app.hasContentTypeParser('application/x-protobuf')) {
    app.addContentTypeParser(
      'application/x-protobuf',
      { parseAs: 'buffer', bodyLimit },
      (_req, body, done) => {
        done(null, body)
      },
    )
  }

  // Non-blocking append. `appendLogEntry` (logs-store.ts) is a synchronous,
  // in-memory push + prune with no I/O — unlike graph mutation, there's no
  // real backpressure risk in calling it inline before replying. The
  // queue/drain shape below is kept anyway, for three reasons: it makes the
  // "the sender is never blocked on the mutation" invariant literally true
  // rather than true only by the mutation's current speed; it gives tests
  // the same `flushPending()` seam every other OTLP receiver in this
  // codebase already exposes; and it means a future change to the store
  // (persistence, a slower sink) doesn't require touching the receiver
  // shape. This is a judgment call, not a requirement — appendLogEntry's own
  // synchronous cost is negligible either way.
  const queue: ParsedLogRecord[] = []
  let draining = false
  let drainPromise: Promise<void> = Promise.resolve()
  const drain = async (): Promise<void> => {
    if (draining) return
    draining = true
    try {
      while (queue.length > 0) {
        const record = queue.shift()!
        try {
          await opts.onLogRecord(record)
        } catch (err) {
          console.warn(`[neat] otel-logs handler error: ${(err as Error).message}`)
        }
      }
    } finally {
      draining = false
    }
  }
  const enqueue = (records: ParsedLogRecord[]): void => {
    if (records.length === 0) return
    for (const r of records) queue.push(r)
    drainPromise = drainPromise.then(() => drain())
  }

  const projectQueue: Array<{ project: string; record: ParsedLogRecord }> = []
  let projectDraining = false
  let projectDrainPromise: Promise<void> = Promise.resolve()
  const drainProject = async (): Promise<void> => {
    if (projectDraining) return
    projectDraining = true
    try {
      while (projectQueue.length > 0) {
        const { project, record } = projectQueue.shift()!
        try {
          if (opts.onProjectLogRecord) {
            await opts.onProjectLogRecord(project, record)
          } else {
            await opts.onLogRecord(record)
          }
        } catch (err) {
          console.warn(`[neat] otel-logs handler error: ${(err as Error).message}`)
        }
      }
    } finally {
      projectDraining = false
    }
  }
  const enqueueProject = (project: string, records: ParsedLogRecord[]): void => {
    if (records.length === 0) return
    for (const r of records) projectQueue.push({ project, record: r })
    projectDrainPromise = projectDrainPromise.then(() => drainProject())
  }

  app.post('/v1/logs', async (req, reply) => {
    const result = await readOtlpLogsBody(req)
    if (!result.ok) return reply.code(result.code).send({ error: result.error })
    enqueue(parseOtlpLogsRequest(result.body))
    return sendOtlpLogsSuccess(reply, result.flavor)
  })

  app.post<{ Params: { project: string } }>('/projects/:project/v1/logs', async (req, reply) => {
    const result = await readOtlpLogsBody(req)
    if (!result.ok) return reply.code(result.code).send({ error: result.error })
    enqueueProject(req.params.project, parseOtlpLogsRequest(result.body))
    return sendOtlpLogsSuccess(reply, result.flavor)
  })

  return {
    flushPending: async () => {
      while (queue.length > 0 || draining || projectQueue.length > 0 || projectDraining) {
        await Promise.all([drainPromise, projectDrainPromise])
      }
    },
  }
}

export interface BuildOtelLogsReceiverOptions extends RegisterOtelLogsRoutesOptions {
  // ADR-073 §4 — same bearer gate as `/v1/traces` (`NEAT_OTEL_TOKEN`).
  authToken?: string
  trustProxy?: boolean
}

// Standalone receiver — its own Fastify app, own bearer auth, own `/health`,
// own protobuf content-type parser. Exists for tests and any caller that
// wants an independent `/v1/logs` server rather than mounting onto an
// existing OTLP app; daemon.ts instead calls `registerOtelLogsRoutes`
// directly against the already-built `/v1/traces` app so both receivers
// share one port.
export async function buildOtelLogsReceiver(
  opts: BuildOtelLogsReceiverOptions,
): Promise<FastifyInstance & OtelLogsRoutes> {
  const app = Fastify({
    logger: false,
    bodyLimit: opts.bodyLimit ?? 16 * 1024 * 1024,
  })

  mountBearerAuth(app, { token: opts.authToken, trustProxy: opts.trustProxy })

  app.get('/health', async () => ({ ok: true }))

  const routes = registerOtelLogsRoutes(app, opts)

  const decorated = app as unknown as FastifyInstance & OtelLogsRoutes
  decorated.flushPending = routes.flushPending
  return decorated
}
