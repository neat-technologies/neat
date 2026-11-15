import type {
  GraphEdge,
} from '@neat.is/types'
import {
  EdgeType,
  grpcMethodId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import type { AttributeValue, ParsedSpan } from '../otel.js'

// Reading a parsed span: wire kind gates, HTTP/gRPC status, peer addresses, and
// the streaming guard for the latency feed.
// Moved out of ingest.ts; ingest.ts re-exports the public names.

// ── Streaming / long-lived span guard for the latency digest (ADR-208) ────────
// `latencyMs: { p50, p95 }` is a per-request measurement (ADR-190). A streaming
// or otherwise long-lived span carries a duration equal to the whole stream's
// lifetime — not a per-request latency — so folding it into the per-edge latency
// histogram (latency-digest.ts) poisons p95 and false-fires the saturation
// classifier (traverse.ts `SATURATION_P95_MS`, ADR-189): flagd's gRPC
// server-stream `EventStream` ran ~10 minutes and read as a 606208ms inbound p95,
// which steered `get_root_cause` to a phantom "load-generator overloads
// everything" verdict. The guard withholds these spans from the latency feed
// only — spanCount, errorCount, and lastObserved still record like any other
// observation, and no other edge property is touched.
//
// Span-shape signals come first, because they name the stream directly:
//   • WebSocket upgrade span — the upgrade span lives for the whole connection
//     (otel-ingest.md §WebSocket channels); `websocketChannel` is already parsed.
//   • Server-Sent Events — an SSE response streams for its whole lifetime and
//     names itself `content-type: text/event-stream` on the response header,
//     when the HTTP instrumentation captured response headers.
// A duration ceiling is the documented fallback: the base gRPC semconv carries no
// streaming marker NEAT parses — a bidi / server-streaming RPC looks like a unary
// one on the wire but for its per-message span events — so a span longer than the
// ceiling is treated as long-lived. This is what catches flagd's `EventStream`.
// Override via NEAT_LATENCY_STREAM_CEILING_MS (a positive number of ms).
export const DEFAULT_LATENCY_STREAM_CEILING_MS = 60_000

export function latencyStreamCeilingMs(): number {
  const raw = process.env.NEAT_LATENCY_STREAM_CEILING_MS
  if (!raw) return DEFAULT_LATENCY_STREAM_CEILING_MS
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return n
  console.warn(
    `[neat] NEAT_LATENCY_STREAM_CEILING_MS could not be parsed (${raw}); using default`,
  )
  return DEFAULT_LATENCY_STREAM_CEILING_MS
}

// True when a captured response header names the SSE content type
// (`text/event-stream`). OTel HTTP instrumentation records captured response
// headers as `http.response.header.<name>`; SDKs differ on whether the header
// name keeps its dash or normalises it to `_`, and the value can arrive as a
// string or a single-element array — read both spellings and both shapes,
// honestly absent otherwise.
export function spanServesEventStream(attrs: Record<string, AttributeValue>): boolean {
  for (const key of [
    'http.response.header.content-type',
    'http.response.header.content_type',
  ]) {
    const v = attrs[key]
    const values = Array.isArray(v) ? v : v !== undefined && v !== null ? [v] : []
    for (const item of values) {
      if (typeof item === 'string' && item.toLowerCase().includes('text/event-stream')) {
        return true
      }
    }
  }
  return false
}

// A span whose duration is the whole stream's lifetime rather than a per-request
// latency. Such a span is kept out of the latency digest only (ADR-208) — every
// other part of its signal records normally.
export function spanIsStreaming(
  span: ParsedSpan,
  ceilingMs = latencyStreamCeilingMs(),
): boolean {
  if (span.websocketChannel !== undefined) return true
  if (spanServesEventStream(span.attributes)) return true
  // More than one message each way is a stream, however short it lived (ADR-272).
  if ((span.messageEventCount ?? 0) > 2) return true
  // durationNanos is a bigint; compare in nanos so no float round-trip is needed.
  return span.durationNanos > BigInt(Math.round(ceilingMs)) * 1_000_000n
}

// When a method is first found to stream, the latency already recorded from its
// earlier, shorter streams (cut off before the ceiling) is not a per-request
// latency either. The digest is aggregated, so those samples can't be picked out:
// clear the latency on the edges that carried the method — callers' edges into it,
// its serving CONTAINS, and those callers' service-level edges to its owner — and
// let them rebuild from calls that are not streams. Counts, errors and
// lastObserved are untouched (ADR-272).
export function clearStreamLatency(graph: NeatGraph, methodId: string): void {
  const clear = (edgeId: string): void => {
    const e = graph.getEdgeAttributes(edgeId) as GraphEdge
    if (!e.signal || (e.signal.latencyHist === undefined && e.signal.latencyMs === undefined)) return
    const { latencyHist: _h, latencyMs: _m, ...rest } = e.signal
    graph.mergeEdgeAttributes(edgeId, { signal: rest })
  }
  const owners = new Set<string>()
  for (const id of graph.inboundEdges(methodId)) {
    const e = graph.getEdgeAttributes(id) as GraphEdge
    if (e.type === EdgeType.CONTAINS) {
      owners.add(e.source)
      clear(id)
    }
  }
  for (const id of graph.inboundEdges(methodId)) {
    const e = graph.getEdgeAttributes(id) as GraphEdge
    if (e.type !== EdgeType.CALLS) continue
    clear(id)
    for (const owner of owners) {
      for (const sid of graph.edges(e.source, owner)) {
        if ((graph.getEdgeAttributes(sid) as GraphEdge).type === EdgeType.CALLS) clear(sid)
      }
    }
  }
}

/**
 * The span is part of a stream (ADR-272): it shows one itself (spanIsStreaming),
 * or its gRPC method is known to stream, from its `.proto` or an earlier span. A
 * stream cut short (a reset at 25 s, under the ceiling, from a client that records
 * no message events) is still a stream, so it is judged by its method, not by its
 * own duration. A span that shows a stream marks its method, OBSERVED.
 */
export function spanStreams(graph: NeatGraph, span: ParsedSpan, ceilingMs?: number): boolean {
  const mid = span.rpcService && span.rpcMethod ? grpcMethodId(span.rpcService, span.rpcMethod) : undefined
  if (spanIsStreaming(span, ceilingMs)) {
    if (mid && graph.hasNode(mid) && (graph.getNodeAttributes(mid) as { streaming?: boolean }).streaming !== true) {
      graph.mergeNodeAttributes(mid, { streaming: true })
      clearStreamLatency(graph, mid)
    }
    return true
  }
  return mid !== undefined && graph.hasNode(mid) && (graph.getNodeAttributes(mid) as { streaming?: boolean }).streaming === true
}

// An attribute bag — either a live span's `attributes` or the passthrough set a
// recorded ErrorEvent carries. The message helpers read from both, so the same
// "what failed here" logic that names an incident at record time can re-derive
// it at read time (dedupeIncidents).
export type AttrBag = Record<string, unknown>

// Read the HTTP response status off an attribute bag. OTel semconv renamed this
// attribute — modern SDKs write `http.response.status_code`, older ones
// `http.status_code`. Returns undefined when neither is present or parseable, so
// a span with no response status is never misclassified as a failure.
export function httpResponseStatusFromAttrs(attrs: AttrBag): number | undefined {
  for (const key of ['http.response.status_code', 'http.status_code']) {
    const v = attrs[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
  }
  return undefined
}

export function httpResponseStatus(span: ParsedSpan): number | undefined {
  return httpResponseStatusFromAttrs(span.attributes)
}

// A human incident line built from the HTTP context a server span carries even
// when no exception event was recorded — an Express error handler that answers
// 500 cleanly leaves `span.exception` empty but still carries the route and
// status. "500 on GET /users/:id" reads better than the literal 'unknown
// error'. Returns undefined when the bag has no usable HTTP context, so a
// non-HTTP failure falls through to nonHttpFailureMessage / 'unknown error'.
// Method/route follow the OTel semconv rename (modern `http.request.method` /
// legacy `http.method`; `http.route` matched template, `http.target` / `url.path`
// concrete-path fallback).
export function httpFailureMessageFromAttrs(attrs: AttrBag): string | undefined {
  const status = httpResponseStatusFromAttrs(attrs)
  const route = pickAttrFrom(attrs, 'http.route', 'http.target', 'url.path')
  const method = pickAttrFrom(attrs, 'http.request.method', 'http.method')
  const where = route ? `${method ? `${method} ` : ''}${route}` : undefined
  if (status !== undefined && where) return `${status} on ${where}`
  if (status !== undefined) return `HTTP ${status}`
  if (where) return `error on ${where}`
  return undefined
}

// Canonical gRPC status code → name (grpc/status.proto). Fixed protocol
// constants shared by every gRPC implementation — not driver/engine data, so
// they don't belong in compat.json (Rule 8 governs the latter, not a wire enum).
export const GRPC_STATUS_NAMES: Record<number, string> = {
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  11: 'OUT_OF_RANGE',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  15: 'DATA_LOSS',
  16: 'UNAUTHENTICATED',
}

export function grpcStatusCodeFromAttrs(attrs: AttrBag): number | undefined {
  const v = attrs['rpc.grpc.status_code']
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

// What counts as an OBSERVED error on a span — the boolean that increments an
// edge's `errorCount`, the signal get_root_cause roots its failing-CALLS chain
// on (ADR-209). Span status ERROR is the explicit marker, but most gRPC and HTTP
// microservice SDKs leave the span status UNSET and put the outcome in an
// attribute instead (issue #1065): a non-OK gRPC status (`rpc.grpc.status_code`
// != 0; 0 is OK) or an HTTP 5xx server response. Reading all three keeps a
// gRPC-based stack's failures from being invisible to RCA — a status-only gate
// recorded zero errors on an otel-demo `checkout` whose 3,349 failing spans were
// all `rpc.grpc.status_code=13` with UNSET status, so RCA had nothing to root on.
// HTTP 4xx is deliberately excluded here: a client error is not the callee
// failing, and a 4xx run is coalesced into its own incident separately
// (advance4xxBurst) rather than counted as an edge error.
export function spanRecordsError(span: ParsedSpan): boolean {
  if (span.statusCode === 2) return true
  const grpc = grpcStatusCodeFromAttrs(span.attributes)
  if (grpc !== undefined && grpc !== 0) return true
  const httpStatus = httpResponseStatusFromAttrs(span.attributes)
  if (httpStatus !== undefined && httpStatus >= 500) return true
  return false
}

// A non-HTTP failure still carries its cause in span attributes — a non-OK gRPC
// status, or a transport-level connection error (ECONNREFUSED reaching a peer).
// Reading them keeps the incident from degrading to the literal 'unknown error'
// when the span has no exception event and no HTTP response code. Returns
// undefined for a span carrying neither, so the 'unknown error' floor still
// applies to a genuinely opaque failure (issue #624).
export function nonHttpFailureMessageFromAttrs(attrs: AttrBag): string | undefined {
  const grpc = grpcStatusCodeFromAttrs(attrs)
  if (grpc !== undefined && grpc !== 0) {
    const name = GRPC_STATUS_NAMES[grpc] ?? `status ${grpc}`
    const detail = pickAttrFrom(attrs, 'rpc.grpc.status_message')
    return detail ? `gRPC ${name}: ${detail}` : `gRPC ${name}`
  }
  // Transport/connection failure — OTel's `error.type` carries the errno
  // (ECONNREFUSED, ETIMEDOUT, …) or the exception class for a call that never
  // got a response. Skip the HTTP status-class forms ("500", "_OTHER") that
  // http semconv also writes there; the HTTP path above owns those.
  const errType = pickAttrFrom(attrs, 'error.type')
  if (errType && errType !== '_OTHER' && !/^\d+$/.test(errType)) {
    const peer = pickAttrFrom(attrs, 'server.address', 'net.peer.name', 'net.host.name')
    return peer ? `${errType} connecting to ${peer}` : errType
  }
  return undefined
}

// The incident's human message: the recorded exception first, then the HTTP
// context a server span still carries, then a non-HTTP (gRPC / connection)
// failure read from attributes, and only then the 'unknown error' floor. Shared
// by every incident write path so the fallback chain can't drift between the
// receiver's synchronous write and handleSpan's inline write.
export function incidentMessage(span: ParsedSpan): string {
  return (
    span.exception?.message ??
    httpFailureMessageFromAttrs(span.attributes) ??
    nonHttpFailureMessageFromAttrs(span.attributes) ??
    'unknown error'
  )
}

export function pickAttrFrom(attrs: AttrBag, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = attrs[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

export function pickAttr(span: ParsedSpan, ...keys: string[]): string | undefined {
  return pickAttrFrom(span.attributes, ...keys)
}

export function hostFromUrl(u: string | undefined): string | undefined {
  if (!u) return undefined
  try {
    return new URL(u).hostname
  } catch {
    return undefined
  }
}

// OTel HTTP/db semconv has gone through several names for "the host on the
// other end of this call." Try the modern ones first, fall back to the legacy
// ones, then last resort parse out of a full URL.
export function pickAddress(span: ParsedSpan): string | undefined {
  return (
    pickAttr(span, 'server.address', 'net.peer.name', 'net.host.name') ??
    hostFromUrl(pickAttr(span, 'url.full', 'http.url'))
  )
}

// The callee host for the cross-service CALLS path (ADR-251, #1424). A span with no kind
// (undefined / UNSPECIFIED, the OpenTracing and OpenCensus bridges) says nothing
// about which side of the call it sits on, and its request URL names where the
// request went: on the receiving side that is the span's own address (nginx's
// request span carries `http.url` at its own ClusterIP). So for a kindless span
// only an attribute that names the peer stands in as the callee, never the URL.
// A kinded CLIENT/PRODUCER span is the caller, so its URL host is the callee.
export function calleeAddress(span: ParsedSpan): string | undefined {
  if (span.kind === undefined || span.kind === 0) {
    return pickAttr(span, 'server.address', 'net.peer.name')
  }
  return pickAddress(span)
}

// A loopback peer address is this host talking to itself, never a distinct
// upstream service. Cross-service correlation on the callee's SERVER span (the
// parent-span fallback, ADR-033) recovers the real peer, so a loopback address
// on a CLIENT span must not mint a standalone frontier:localhost /
// frontier:127.0.0.1 that duplicates that resolved edge (issues #590, #577).
// Scoped to the cross-service CALLS path — a loopback database is a real local
// dependency and keeps its CONNECTS_TO edge.
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  return (
    h === 'localhost' ||
    h === 'ip6-localhost' ||
    h === '::1' ||
    h === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(h)
  )
}

// OTLP-wire SpanKind values. The receiver decodes the raw wire integer onto
// `ParsedSpan.kind` (otel.ts), and the wire enum is offset by one from the
// `@opentelemetry/api` SpanKind the SDK uses in-process — UNSPECIFIED 0,
// INTERNAL 1, SERVER 2, CLIENT 3, PRODUCER 4, CONSUMER 5. So we must NOT import
// `@opentelemetry/api` here: its CLIENT is 2 (= wire SERVER) and PRODUCER is 3
// (= wire CLIENT), which would gate the wrong kinds. Cross-referenced with the
// wire fixtures in otel.test.ts (kind 2 = SERVER, kind 3 = CLIENT) and the
// CLIENT call-site spans in ingest.test.ts (kind 3).
export const WIRE_SPAN_KIND_CLIENT = 3

export const WIRE_SPAN_KIND_PRODUCER = 4

export const WIRE_SPAN_KIND_CONSUMER = 5

// The caller-side gate for the CALLS / CONNECTS_TO paths. A CLIENT or PRODUCER
// span is the caller/producer side of a service-to-service call or a datastore
// read; INTERNAL / SERVER spans are not — a SERVER span is the callee, and its
// edge is minted from its parent CLIENT via the parent-span fallback. Without
// this gate every INTERNAL span that happens to carry a peer address — e.g. a
// `tcp.connect` / `tls.connect` to an AWS endpoint — mints a spurious
// service-level edge (issue #429), because no §4 capture layer stamps `code.*`
// on INTERNAL spans.
//
// CONSUMER spans are handled by the messaging branch in handleSpan, not here:
// a queue consumer isn't calling a service, it's reading a topic, so it mints a
// CONSUMES_FROM edge to the destination node (spanMintsMessagingEdge below) —
// the observed mirror of the static consumer→topic edge, the queue-side pair of
// the PRODUCER→topic PUBLISHES_TO edge.
//
// A span that reports no kind (undefined) or UNSPECIFIED (0) carries no
// caller/callee signal, so it falls back to the historical unconditional
// behavior — hand-built and legacy producers keep minting. The leak this gates
// is always an explicitly-kinded INTERNAL span.
export function spanMintsObservedEdge(kind: number | undefined): boolean {
  if (kind === undefined || kind === 0) return true
  return kind === WIRE_SPAN_KIND_CLIENT || kind === WIRE_SPAN_KIND_PRODUCER
}

// The messaging counterpart to the caller-side gate. A PRODUCER span publishes
// to a destination; a CONSUMER span reads from one. Both sides mint an OBSERVED
// edge to the topic/queue node — the PRODUCER a PUBLISHES_TO, the CONSUMER a
// CONSUMES_FROM — so declared and observed queue topology fuse. Only spans that
// actually carry a messaging destination reach this (handleSpan checks the
// semconv attrs first), so a stray CONSUMER span with no destination stays inert.
export function spanMintsMessagingEdge(kind: number | undefined): boolean {
  return kind === WIRE_SPAN_KIND_PRODUCER || kind === WIRE_SPAN_KIND_CONSUMER
}

// The GraphQL execution span is emitted by the service that RESOLVES the
// operation — a SERVER or INTERNAL span (the instrumentation's `graphql.execute`),
// never the CLIENT side that only ever sees an opaque `POST /graphql`. Gating out
// the caller/producer/consumer kinds keeps a client-side operation span from
// attributing the operation to the caller (client-side operation attribution is
// deferred, ADR-122); an unkinded / UNSET span still mints, mirroring the
// caller-side gate's legacy-producer fallback.
export function spanServesGraphqlOperation(kind: number | undefined): boolean {
  return (
    kind !== WIRE_SPAN_KIND_CLIENT &&
    kind !== WIRE_SPAN_KIND_PRODUCER &&
    kind !== WIRE_SPAN_KIND_CONSUMER
  )
}

// The gRPC execution span carrying `rpc.service` / `rpc.method` is emitted on
// both sides of a call — the SERVER that resolves the method and the CLIENT that
// invokes it. Only the serving side owns the method (ADR-123): gating out the
// caller/producer/consumer kinds keeps a CLIENT gRPC span from attributing
// ownership to the caller (that client span still falls through to the
// cross-service resolver below, so the caller→callee edge is unaffected).
// Client→method attribution is deferred. An unkinded / UNSET span still mints,
// mirroring the graphql and caller-side gates' legacy fallbacks.
export function spanServesGrpcMethod(kind: number | undefined): boolean {
  return (
    kind !== WIRE_SPAN_KIND_CLIENT &&
    kind !== WIRE_SPAN_KIND_PRODUCER &&
    kind !== WIRE_SPAN_KIND_CONSUMER
  )
}

// The HTTP upgrade span that opens a WebSocket is emitted by the service that
// SERVES the channel — a SERVER span (the framework's inbound `GET`), or an
// unkinded / INTERNAL span from a hand-built handshake. The CLIENT that dials the
// socket carries the same upgrade header, but the channel belongs to the server
// (ADR-125), so gating out the caller/producer/consumer kinds keeps a client-side
// upgrade span from attributing the channel to the caller. An unkinded / UNSET
// span still mints, mirroring the graphql and gRPC serving-side gates.
export function spanServesWebsocketChannel(kind: number | undefined): boolean {
  return (
    kind !== WIRE_SPAN_KIND_CLIENT &&
    kind !== WIRE_SPAN_KIND_PRODUCER &&
    kind !== WIRE_SPAN_KIND_CONSUMER
  )
}
