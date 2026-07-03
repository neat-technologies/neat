import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import protobuf from 'protobufjs'
import { mountBearerAuth } from './auth.js'

// OTLP/HTTP receiver. Listens on /v1/traces and decodes the JSON wire format
// (collector's `otlphttp` exporter with `encoding: json`). Each span is
// flattened into a ParsedSpan and handed to the configured handler. The
// handler is the seam #8 wires its edge mapper into; #7 itself stays decoupled
// from graph mutation.

export interface ParsedSpan {
  service: string
  // True when the resource carried a `service.name` attribute. False (or
  // omitted, for legacy producers) routes the span to `service:unidentified`
  // in the resolved project and trips a once-per-session-per-project warning
  // on the ingest side (issue #374). OTel spec requires SDKs to set
  // `service.name`, but customised exporters can omit it — diagnostic
  // visibility beats silent drop. Field is optional so test fixtures that
  // hand-construct ParsedSpan with a known service.name don't need to set
  // a flag they don't care about; the receiver always sets it.
  // See docs/contracts/otlp-routing.md §Fallback when `resource.service.name`
  // is missing.
  resourceServiceNamePresent?: boolean
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
  // Deployment environment from `deployment.environment(.name)`. Span attrs
  // win over resource attrs (per-span overrides a resource-wide declaration);
  // the canonical `deployment.environment.name` (OTel SC v1.27+) wins over
  // the compat form `deployment.environment`. Literal `'unknown'` is the
  // honest fallback when no env signal is present anywhere on the span or
  // its resource. See ADR-074 §2 / docs/contracts/env-dimension.md.
  env: string
  attributes: Record<string, AttributeValue>
  // Convenience accessors for the attributes #8 cares about.
  dbSystem?: string
  dbName?: string
  // Messaging semconv (OTel). `messaging.system` names the broker family
  // (kafka, rabbitmq, redis, …); the destination is the topic/queue the span
  // produced to or consumed from — the canonical `messaging.destination.name`
  // (SC v1.24+) with the legacy `messaging.destination` as fallback. handleSpan
  // reads these to mint a PUBLISHES_TO (PRODUCER) or CONSUMES_FROM (CONSUMER)
  // OBSERVED edge to the destination node, fusing with the static extractor's
  // topic node. See docs/contracts/otel-ingest.md §Queue producers and consumers.
  messagingSystem?: string
  messagingDestination?: string
  // GraphQL semconv (OTel). `graphql.operation.name` is the client-supplied
  // operation name the execution span resolved (`GetUser`); `graphql.operation.type`
  // is the operation kind (`query` / `mutation` / `subscription`). handleSpan reads
  // both to mint an OBSERVED `CONTAINS` edge from the serving service to a
  // per-operation node, recovering the operation-level topology that HTTP grain
  // collapses onto `POST /graphql`. See docs/contracts/otel-ingest.md §GraphQL
  // operations.
  graphqlOperationName?: string
  graphqlOperationType?: string
  // gRPC RPC semconv (OTel). `rpc.system` names the RPC framework (`grpc`);
  // `rpc.service` is the fully-qualified proto service (`orders.OrderService`)
  // and `rpc.method` the bare method (`GetOrder`). The serving (SERVER) and
  // calling (CLIENT) sides both carry these. handleSpan reads them off the
  // serving span to mint an OBSERVED `CONTAINS` edge from the serving service to
  // a per-method node, recovering the method-level topology gRPC's service-grain
  // edge collapses — and keyed so the static `.proto` definition fuses onto the
  // same node. See docs/contracts/otel-ingest.md §gRPC methods.
  rpcSystem?: string
  rpcService?: string
  rpcMethod?: string
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
// Variant that receives the project the URL already resolved to. Used by the
// project-scoped route mounted at `/projects/:project/v1/traces` (issue #367):
// the receiver hands the URL-path project to the daemon directly so the
// daemon never has to guess via `service.name`-against-registry matching.
export type ProjectSpanHandler = (project: string, span: ParsedSpan) => void | Promise<void>

export interface BuildOtelReceiverOptions {
  onSpan: SpanHandler
  // Synchronous handler for spans with statusCode === 2. The receiver awaits
  // it before replying, so a write failure can return 500 → OTel SDK retries.
  // Optional — wiring is expected to plumb appendErrorEvent here when error
  // durability matters; ad-hoc receivers leave it undefined.
  // See docs/contracts/otel-ingest.md §Error events.
  onErrorSpanSync?: (span: ParsedSpan) => Promise<void>
  // Project-scoped variants — used by the `/projects/:project/v1/traces`
  // route. When unset the route is still mounted but falls through to the
  // legacy `onSpan` / `onErrorSpanSync` handlers (the project name is then
  // available to the consumer via the `OTEL_PROJECT_OVERRIDE` attribute on
  // each parsed span; ad-hoc receivers commonly leave both unset).
  onProjectSpan?: ProjectSpanHandler
  onProjectErrorSpanSync?: (project: string, span: ParsedSpan) => Promise<void>
  // Fastify body limit. OTLP batches can be large; default is 16 MB.
  bodyLimit?: number
  // ADR-073 §4 — bearer required on `/v1/traces`. Defaults to `NEAT_AUTH_TOKEN`
  // when unset; `NEAT_OTEL_TOKEN` overrides at the call site so the REST and
  // OTLP surfaces rotate on independent schedules.
  authToken?: string
  // Same shape as the REST middleware: skip the request-side check when an
  // upstream reverse proxy already authenticated.
  trustProxy?: boolean
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

// Resolve `deployment.environment` per ADR-074 §2. The four-step fallback
// is: span-attr canonical form → span-attr compat form → resource-attr
// canonical form → resource-attr compat form → literal `'unknown'`. The
// literal `'unknown'` is the honest sentinel; defaulting to `'production'`
// or `'development'` would bake an incorrect assumption into every span
// from a workload that hasn't yet wired its env signal.
const ENV_ATTR_CANONICAL = 'deployment.environment.name'
const ENV_ATTR_COMPAT = 'deployment.environment'
const ENV_FALLBACK = 'unknown'

function pickEnv(
  spanAttrs: Record<string, AttributeValue>,
  resourceAttrs: Record<string, AttributeValue>,
): string {
  for (const attrs of [spanAttrs, resourceAttrs]) {
    for (const key of [ENV_ATTR_CANONICAL, ENV_ATTR_COMPAT]) {
      const v = attrs[key]
      if (typeof v === 'string' && v.length > 0) return v
    }
  }
  return ENV_FALLBACK
}

// The messaging destination (topic / queue / stream) a producer or consumer
// span names. `messaging.destination.name` is the canonical semconv key
// (SC v1.24+); `messaging.destination` is the older form some instrumentations
// still emit. Prefer the canonical one, fall back to the legacy, and treat an
// empty string as absent so an anonymous destination never keys a node.
function messagingDestinationOf(
  attrs: Record<string, AttributeValue>,
): string | undefined {
  for (const key of ['messaging.destination.name', 'messaging.destination']) {
    const v = attrs[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

export function parseOtlpRequest(body: OtlpTracesRequest): ParsedSpan[] {
  const out: ParsedSpan[] = []
  for (const rs of body.resourceSpans ?? []) {
    const resourceAttrs = attrsToRecord(rs.resource?.attributes)
    // OTel spec requires SDKs to set `service.name`, but customised exporters
    // can omit it. Missing `service.name` routes to `service:unidentified`
    // in handleSpan + emits a once-per-session-per-project warning so the
    // diagnostic stays visible (issue #374). Silent drop is not an option.
    const rawServiceName = resourceAttrs['service.name']
    const resourceServiceNamePresent =
      typeof rawServiceName === 'string' && rawServiceName.length > 0
    const service = resourceServiceNamePresent
      ? (rawServiceName as string)
      : 'unidentified'

    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const attrs = attrsToRecord(span.attributes)
        const parsed: ParsedSpan = {
          service,
          resourceServiceNamePresent,
          traceId: span.traceId ?? '',
          spanId: span.spanId ?? '',
          parentSpanId: span.parentSpanId || undefined,
          name: span.name ?? '',
          kind: span.kind,
          startTimeUnixNano: span.startTimeUnixNano ?? '0',
          endTimeUnixNano: span.endTimeUnixNano ?? '0',
          startTimeIso: isoFromUnixNano(span.startTimeUnixNano),
          durationNanos: durationNanos(span.startTimeUnixNano, span.endTimeUnixNano),
          env: pickEnv(attrs, resourceAttrs),
          attributes: attrs,
          dbSystem: typeof attrs['db.system'] === 'string' ? (attrs['db.system'] as string) : undefined,
          dbName: typeof attrs['db.name'] === 'string' ? (attrs['db.name'] as string) : undefined,
          messagingSystem:
            typeof attrs['messaging.system'] === 'string'
              ? (attrs['messaging.system'] as string)
              : undefined,
          messagingDestination: messagingDestinationOf(attrs),
          graphqlOperationName:
            typeof attrs['graphql.operation.name'] === 'string' &&
            (attrs['graphql.operation.name'] as string).length > 0
              ? (attrs['graphql.operation.name'] as string)
              : undefined,
          graphqlOperationType:
            typeof attrs['graphql.operation.type'] === 'string' &&
            (attrs['graphql.operation.type'] as string).length > 0
              ? (attrs['graphql.operation.type'] as string)
              : undefined,
          rpcSystem:
            typeof attrs['rpc.system'] === 'string' &&
            (attrs['rpc.system'] as string).length > 0
              ? (attrs['rpc.system'] as string)
              : undefined,
          rpcService:
            typeof attrs['rpc.service'] === 'string' &&
            (attrs['rpc.service'] as string).length > 0
              ? (attrs['rpc.service'] as string)
              : undefined,
          rpcMethod:
            typeof attrs['rpc.method'] === 'string' &&
            (attrs['rpc.method'] as string).length > 0
              ? (attrs['rpc.method'] as string)
              : undefined,
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
  // toObject() options mirror the gRPC receiver's proto-loader config
  // (otel-grpc.ts: longs: String, enums: Number, bytes left as Buffers) so
  // both protobuf paths hand reshapeGrpcRequest the identical shape. The old
  // .toJSON() here rendered bytes as base64 strings (bytesToHex returned ''
  // → empty trace/span IDs) and enums as name strings ("SPAN_KIND_CLIENT"
  // never matches the numeric mint gate) — every http/protobuf span was
  // accepted and then silently minted nothing (#468).
  // Dynamic import sidesteps the circular module dep with otel-grpc.ts.
  const decoded = Type.toObject(Type.decode(buf), {
    longs: String,
    enums: Number,
  }) as Record<string, unknown>
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

  // ADR-073 §4 — bearer on `/v1/traces`. `/health` stays unauthenticated via
  // the default suffix list (the CI smoke and supervisors lean on it for
  // liveness probes).
  //
  // A rejected OTLP POST is a silent failure on the sender's side — the app
  // gets a bare 401 and its telemetry vanishes, so the operator sees an empty
  // OBSERVED layer with no clue why. Emit a server-side warning when that
  // happens, rate-limited to one line per interval so a chatty misconfigured
  // exporter (they retry hard) can't flood the log. The plain REST 401 path
  // stays quiet — that surface leaves this hook unset.
  const REJECT_WARN_INTERVAL_MS = 60_000
  let lastRejectWarnAt = 0
  const warnRejectedOtlp = (): void => {
    const now = Date.now()
    if (now - lastRejectWarnAt < REJECT_WARN_INTERVAL_MS) return
    lastRejectWarnAt = now
    console.warn(
      '[neatd] rejecting OTLP spans on /v1/traces — missing or invalid bearer token (set NEAT_OTEL_TOKEN on the instrumented app)',
    )
  }
  mountBearerAuth(app, {
    token: opts.authToken,
    trustProxy: opts.trustProxy,
    onReject: warnRejectedOtlp,
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

  // Per-project queue is reusable across the project-scoped route — the
  // project name rides in the URL, not on the span. Drain semantics mirror
  // the global queue so flushPending() captures both.
  const projectQueue: Array<{ project: string; span: ParsedSpan }> = []
  let projectDraining = false
  let projectDrainPromise: Promise<void> = Promise.resolve()
  const drainProject = async (): Promise<void> => {
    if (projectDraining) return
    projectDraining = true
    try {
      while (projectQueue.length > 0) {
        const { project, span } = projectQueue.shift()!
        try {
          if (opts.onProjectSpan) {
            await opts.onProjectSpan(project, span)
          } else {
            await opts.onSpan(span)
          }
        } catch (err) {
          console.warn(`[neat] otel handler error: ${(err as Error).message}`)
        }
      }
    } finally {
      projectDraining = false
    }
  }
  const enqueueProject = (project: string, spans: ParsedSpan[]): void => {
    if (spans.length === 0) return
    for (const s of spans) projectQueue.push({ project, span: s })
    projectDrainPromise = projectDrainPromise.then(() => drainProject())
  }

  // One-time-per-service-name deprecation warning for spans landing on the
  // bare `/v1/traces` endpoint. Under one daemon per project (ADR-096) that
  // route is the project's own ingest path and needs no migration, so the
  // warning is gated on whether this receiver actually offers project-scoped
  // routing: only a receiver wired with `onProjectSpan` (the multi-project
  // daemon that mounts `/projects/<name>/v1/traces`) has somewhere to migrate
  // an exporter to. A single-project receiver leaves the gate closed and never
  // nags. Still once-per-name so a long-running daemon doesn't flood stderr
  // while an operator migrates.
  const offersProjectRouting = opts.onProjectSpan !== undefined
  const legacyEndpointWarned = new Set<string>()
  function warnLegacyEndpoint(serviceName: string): void {
    if (!offersProjectRouting) return
    if (legacyEndpointWarned.has(serviceName)) return
    legacyEndpointWarned.add(serviceName)
    console.warn(
      `[neatd] received span on the global endpoint; migrate OTEL_EXPORTER_OTLP_TRACES_ENDPOINT to /projects/<name>/v1/traces (service.name="${serviceName}").`,
    )
  }

  // Shared body-decode + content-negotiation. Both `/v1/traces` and
  // `/projects/:project/v1/traces` go through this so the protobuf/JSON
  // dispatch stays in one place.
  async function readOtlpBody(req: import('fastify').FastifyRequest): Promise<
    | { ok: true; body: OtlpTracesRequest; flavor: 'json' | 'protobuf' }
    | { ok: false; code: 400 | 415; error: string }
  > {
    const ct = (req.headers['content-type'] ?? '').toString().split(';')[0]!.trim().toLowerCase()
    if (ct === 'application/x-protobuf') {
      try {
        const body = await decodeProtobufBody(req.body as Buffer)
        return { ok: true, body, flavor: 'protobuf' }
      } catch (err) {
        return { ok: false, code: 400, error: `protobuf decode failed: ${(err as Error).message}` }
      }
    }
    if (!ct || ct === 'application/json') {
      return { ok: true, body: (req.body ?? {}) as OtlpTracesRequest, flavor: 'json' }
    }
    return { ok: false, code: 415, error: `unsupported content-type: ${ct}` }
  }

  function sendOtlpSuccess(reply: import('fastify').FastifyReply, flavor: 'json' | 'protobuf'): unknown {
    if (flavor === 'protobuf') {
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
    // Legacy global endpoint. Spans land here when an OTel exporter hasn't
    // migrated to the project-scoped URL yet (issue #367); the daemon still
    // routes by `service.name` against the registry. Per-service-name
    // deprecation warning fires once so an operator notices without their
    // stderr flooding.
    const result = await readOtlpBody(req)
    if (!result.ok) {
      return reply.code(result.code).send({ error: result.error })
    }
    const spans = parseOtlpRequest(result.body)
    for (const s of spans) warnLegacyEndpoint(s.service)
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
    return sendOtlpSuccess(reply, result.flavor)
  })

  // Project-scoped route (issue #367). The URL `:project` carries the routing
  // key, sidestepping the `service.name`-against-registry heuristic the legacy
  // path uses. Spans get dispatched into the named project's ingest path
  // directly; `OTEL_SERVICE_NAME` regains its proper semantic role of naming
  // the ServiceNode inside the one project the URL already picked.
  app.post<{ Params: { project: string } }>('/projects/:project/v1/traces', async (req, reply) => {
    const project = req.params.project
    const result = await readOtlpBody(req)
    if (!result.ok) {
      return reply.code(result.code).send({ error: result.error })
    }
    const spans = parseOtlpRequest(result.body)
    if (opts.onProjectErrorSpanSync) {
      try {
        for (const span of spans) {
          if (span.statusCode === 2) await opts.onProjectErrorSpanSync(project, span)
        }
      } catch (err) {
        return reply.code(500).send({
          error: `error-event write failed: ${(err as Error).message}`,
        })
      }
    } else if (opts.onErrorSpanSync) {
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
    enqueueProject(project, spans)
    return sendOtlpSuccess(reply, result.flavor)
  })

  // Attach flushPending so tests can wait for the queue without exporting a
  // separate handle. The cast goes through `unknown` because Fastify's typing
  // is parameterised over the raw server type and the simple intersection
  // confuses TS's structural narrowing.
  const decorated = app as unknown as FastifyInstance & { flushPending: () => Promise<void> }
  decorated.flushPending = async () => {
    // Settle both drain chains, then loop until both queues are fully empty
    // (a span enqueued mid-flush would otherwise be missed).
    while (queue.length > 0 || draining || projectQueue.length > 0 || projectDraining) {
      await Promise.all([drainPromise, projectDrainPromise])
    }
  }
  return decorated
}

// How far the OTLP receiver steps before giving up, and the stride between
// candidate ports. Matches the orchestrator's triple allocator (8 attempts,
// stride 1) so the daemon's own bind and the pre-spawn allocation reach the
// same free port under the same contention.
const OTLP_STEP_ATTEMPTS = 8
const OTLP_STEP_STRIDE = 1

// Bind an OTLP receiver, stepping to the next free port when the requested one
// is held (daemon.md §Binding — a held OTLP port steps, it does not crash the
// daemon; project-daemon §3). The REST port is the daemon's identity and stays
// fatal on collision, but every OTLP consumer resolves the port dynamically
// from `daemon.json` `ports.otlp`, so stepping the receiver and recording the
// port it actually bound keeps the OBSERVED layer alive instead of darking the
// whole daemon on a foreign collector holding `:4318`. Returns the bound
// address (host:port); callers read the real port back from it. A requested
// port of `0` means "let the kernel pick a free one" — no collision is
// possible, so no stepping happens. Non-`EADDRINUSE` failures (permission
// denied) and an exhausted step window propagate to the caller unchanged.
export async function listenSteppingOtlp(
  app: FastifyInstance,
  requestedPort: number,
  host: string,
): Promise<string> {
  let port = requestedPort
  for (let attempt = 0; ; attempt++) {
    try {
      return await app.listen({ port, host })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const canStep =
        requestedPort !== 0 && code === 'EADDRINUSE' && attempt < OTLP_STEP_ATTEMPTS - 1
      if (!canStep) throw err
      console.warn(
        `otel: OTLP port ${port} is in use, stepping to ${port + OTLP_STEP_STRIDE}`,
      )
      port += OTLP_STEP_STRIDE
    }
  }
}

export function logSpanHandler(span: ParsedSpan): void {
  const parent = span.parentSpanId ? span.parentSpanId.slice(0, 8) : '<root>'
  const status = span.statusCode === 2 ? 'ERROR' : 'OK'
  const db = span.dbSystem ? ` db=${span.dbSystem}/${span.dbName ?? '?'}` : ''
  console.log(
    `otel: ${span.service} ${span.name} parent=${parent} status=${status}${db}`,
  )
}
