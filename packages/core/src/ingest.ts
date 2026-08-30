import { promises as fs, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as sourceMapJs from 'source-map-js'
import type {
  DatabaseNode,
  ErrorEvent,
  FileNode,
  FrontierNode,
  GraphEdge,
  GraphNode,
  GraphQLOperationNode,
  GrpcMethodNode,
  InfraNode,
  Policy,
  ServiceNode,
  StaleEvent,
  SymbolNode,
  WebSocketChannelNode,
} from '@neat.is/types'
import type { PersistedGraph } from './persist.js'
import type { EvaluationContext as PolicyEvaluationContext } from './policy.js'
import { canPromoteFrontier } from './policy.js'
import {
  EdgeType,
  GraphEdgeSchema,
  GraphNodeSchema,
  NodeType,
  Provenance,
  confidenceForObservedSignal,
  databaseId,
  localDatabaseId,
  extractedEdgeId,
  fileId,
  frontierId,
  graphqlOperationId,
  grpcMethodId,
  incidentKindOf,
  inferredEdgeId,
  infraId,
  observedEdgeId,
  serviceId,
  symbolId,
  websocketChannelId,
  type EdgeTypeValue,
  type ProvenanceValue,
  type RouteNode,
} from '@neat.is/types'
import { normalizePathTemplate } from './extract/routes.js'
import { foldColumns, OBSERVED_COLUMN_CONFIDENCE } from './columns.js'
import { recordLatency, latencyPercentiles } from './latency-digest.js'
import type { NeatGraph } from './graph.js'
import { DEFAULT_PROJECT } from './graph.js'
import type { AttributeValue, ParsedSpan } from './otel.js'
import { emitNeatEvent } from './events.js'
import { deepestApplicationFrame } from './stacktrace.js'

// Maps OTel spans to graph signal:
//   * Cross-service span → upsert CALLS edge.
//   * Database span (db.system attr present) → upsert CONNECTS_TO edge to a
//     DatabaseNode resolved by host, or a service-scoped local DatabaseNode when
//     the span carries no peer host (an in-process / embedded DB, ADR-118).
//   * Span with status.code === 2 → ErrorEvent appended to errors.ndjson.
//
// Contract anchors (see /docs/contracts.md):
//   * Rule 1 — Provenance: every edge here carries Provenance.X from @neat.is/types.
//   * Rule 2 — Coexistence: OBSERVED edges live alongside EXTRACTED ones with a
//     distinct id pattern (`${type}:OBSERVED:src->tgt`). Never write OBSERVED
//     under the EXTRACTED id; that erases the gap NEAT exists to surface.
//   * Rule 4 — Per-edge-type staleness (ADR-024): STALE_THRESHOLDS_BY_EDGE_TYPE
//     governs decay; never hardcode a flat 24h threshold.
//   * Rule 8 — No demo names: derive driver/engine identifiers from node
//     properties, not literals.

export interface IngestContext {
  graph: NeatGraph
  errorsPath: string
  // Absolute scan root the daemon is watching for this project. When set, a
  // runtime `code.filepath` is made service-root-relative against it before the
  // FileNode is keyed (file-awareness.md §4) — the service's absolute root is
  // `scanPath/<repoPath>`, which recovers `dist/foo.js` even for a single-
  // package service whose `repoPath` is empty (issue #430). Omitted by ad-hoc
  // callers and most tests, which rely on the repoPath-segment anchor instead.
  scanPath?: string
  // Project name for event-bus routing (ADR-051). Defaults to DEFAULT_PROJECT
  // when omitted — keeps single-project tests / scripts wire-compatible.
  project?: string
  now?: () => number
  // Set to false when the receiver already wrote the ErrorEvent synchronously
  // (production daemons via watch.ts wire this). When true or omitted, handleSpan
  // appends the ErrorEvent itself — the path used by ad-hoc scripts and tests
  // that don't go through buildOtelReceiver. ADR-033 §Error events.
  writeErrorEventInline?: boolean
  // Post-mutation policy trigger (ADR-043). Fires after handleSpan finishes
  // and the queue is drained. Daemons wire this to evaluateAllPolicies +
  // PolicyViolationsLog.append. Ad-hoc callers leave it undefined; their tests
  // don't need policy side effects.
  onPolicyTrigger?: (graph: NeatGraph) => Promise<void> | void
  // 4xx-burst coalescing state, keyed by `${source}->${peer}` (issue #481).
  // Lazily created the first time handleSpan sees a 4xx CLIENT/PRODUCER span.
  // Carried on the context so each project/daemon keeps its own bursts and a
  // long-lived handler accumulates across spans; ad-hoc callers reuse one ctx
  // across a batch and get the same coalescing.
  burstState?: Map<string, BurstState>
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

// Per-edge-type stale thresholds. HTTP CALLS at 24h is meaningless because
// healthy traffic recurs in seconds; infra DEPENDS_ON is the opposite — a
// docker-compose service can sit idle overnight without anything being wrong.
// Override via NEAT_STALE_THRESHOLDS (JSON, ms-per-edge-type).
const DEFAULT_STALE_THRESHOLDS: Record<string, number> = {
  CALLS: HOUR_MS,
  CONNECTS_TO: 4 * HOUR_MS,
  PUBLISHES_TO: 4 * HOUR_MS,
  CONSUMES_FROM: 4 * HOUR_MS,
  DEPENDS_ON: DAY_MS,
  CONFIGURED_BY: DAY_MS,
  RUNS_ON: DAY_MS,
}
// Fallback for any edge type not in the map (forward compat — adding a new
// EdgeType shouldn't break staleness sweeps).
const FALLBACK_STALE_THRESHOLD_MS = DAY_MS

function loadStaleThresholdsFromEnv(): Record<string, number> {
  const raw = process.env.NEAT_STALE_THRESHOLDS
  if (!raw) return DEFAULT_STALE_THRESHOLDS
  try {
    const overrides = JSON.parse(raw) as Record<string, unknown>
    const merged = { ...DEFAULT_STALE_THRESHOLDS }
    for (const [k, v] of Object.entries(overrides)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) merged[k] = v
    }
    return merged
  } catch (err) {
    console.warn(
      `[neat] NEAT_STALE_THRESHOLDS could not be parsed (${(err as Error).message}); using defaults`,
    )
    return DEFAULT_STALE_THRESHOLDS
  }
}

export function thresholdForEdgeType(
  edgeType: string,
  overrides?: Record<string, number>,
): number {
  const map = overrides ?? loadStaleThresholdsFromEnv()
  return map[edgeType] ?? FALLBACK_STALE_THRESHOLD_MS
}

// Failing-response incident tuning. A span that completes 5xx, carries an
// ERROR status, or an exception event records an incident on its own — those
// are unambiguous failures. A 4xx CLIENT/PRODUCER span doesn't: a single 404 is
// often correct app behavior (auth probe, conditional fetch). 4xx becomes a
// signal only when it repeats — N consecutive 4xx against the same (source,
// peer) pair inside a window record ONE coalesced incident carrying the count
// and the dominant status code, rather than N separate lines that would drown
// the history. Mirrors the NEAT_STALE_THRESHOLDS override shape.
//   threshold — how many consecutive 4xx against one peer trip the burst.
//   windowMs  — the gap that ends a burst; a 4xx more than this after the
//               previous one starts a fresh burst rather than extending it.
const DEFAULT_INCIDENT_THRESHOLDS = {
  threshold: 5,
  windowMs: 60_000,
}

function loadIncidentThresholdsFromEnv(): { threshold: number; windowMs: number } {
  const raw = process.env.NEAT_INCIDENT_THRESHOLDS
  if (!raw) return DEFAULT_INCIDENT_THRESHOLDS
  try {
    const overrides = JSON.parse(raw) as Record<string, unknown>
    const merged = { ...DEFAULT_INCIDENT_THRESHOLDS }
    if (
      typeof overrides.threshold === 'number' &&
      Number.isFinite(overrides.threshold) &&
      overrides.threshold >= 1
    ) {
      merged.threshold = Math.floor(overrides.threshold)
    }
    if (
      typeof overrides.windowMs === 'number' &&
      Number.isFinite(overrides.windowMs) &&
      overrides.windowMs >= 0
    ) {
      merged.windowMs = overrides.windowMs
    }
    return merged
  } catch (err) {
    console.warn(
      `[neat] NEAT_INCIDENT_THRESHOLDS could not be parsed (${(err as Error).message}); using defaults`,
    )
    return DEFAULT_INCIDENT_THRESHOLDS
  }
}

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
const DEFAULT_LATENCY_STREAM_CEILING_MS = 60_000

function latencyStreamCeilingMs(): number {
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
function spanServesEventStream(attrs: Record<string, AttributeValue>): boolean {
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
  // durationNanos is a bigint; compare in nanos so no float round-trip is needed.
  return span.durationNanos > BigInt(Math.round(ceilingMs)) * 1_000_000n
}

// An attribute bag — either a live span's `attributes` or the passthrough set a
// recorded ErrorEvent carries. The message helpers read from both, so the same
// "what failed here" logic that names an incident at record time can re-derive
// it at read time (dedupeIncidents).
type AttrBag = Record<string, unknown>

// Read the HTTP response status off an attribute bag. OTel semconv renamed this
// attribute — modern SDKs write `http.response.status_code`, older ones
// `http.status_code`. Returns undefined when neither is present or parseable, so
// a span with no response status is never misclassified as a failure.
function httpResponseStatusFromAttrs(attrs: AttrBag): number | undefined {
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

function httpResponseStatus(span: ParsedSpan): number | undefined {
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
function httpFailureMessageFromAttrs(attrs: AttrBag): string | undefined {
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
const GRPC_STATUS_NAMES: Record<number, string> = {
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

function grpcStatusCodeFromAttrs(attrs: AttrBag): number | undefined {
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
function spanRecordsError(span: ParsedSpan): boolean {
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
function nonHttpFailureMessageFromAttrs(attrs: AttrBag): string | undefined {
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
function incidentMessage(span: ParsedSpan): string {
  return (
    span.exception?.message ??
    httpFailureMessageFromAttrs(span.attributes) ??
    nonHttpFailureMessageFromAttrs(span.attributes) ??
    'unknown error'
  )
}

// In-flight 4xx burst against one (source, peer) pair. Lives on IngestContext so
// it survives across spans without leaking into module state shared by every
// project. firstTs/lastTs are the span timestamps (ADR-033 — span time, not
// wall clock); codes counts each 4xx by status so the dominant one can be named
// when the burst flushes.
interface BurstState {
  count: number
  firstTs: string
  lastTs: string
  lastMs: number
  codes: Map<number, number>
}

function nowIso(ctx: IngestContext): string {
  return new Date(ctx.now ? ctx.now() : Date.now()).toISOString()
}

// One-time-per-session-per-project warning for spans whose resource omits
// `service.name`. The OTel spec requires SDKs to set it; customised exporters
// occasionally don't. Routing the span to `service:unidentified` keeps
// diagnostic visibility intact (silent drop hides a real SDK misconfiguration);
// the warning gives an operator one line of stderr per project to act on.
// See docs/contracts/otlp-routing.md §Fallback when `resource.service.name`
// is missing.
const unidentifiedWarnedProjects = new Set<string>()
function warnUnidentifiedSpan(project: string): void {
  if (unidentifiedWarnedProjects.has(project)) return
  unidentifiedWarnedProjects.add(project)
  console.warn(
    `[neatd] span lacked service.name; routed to 'unidentified' in project ${project}; check your OTel SDK config.`,
  )
}

// Test seam — production code never calls this. Tests that exercise the
// once-per-session contract reset between cases so each assertion sees a
// fresh warned-set.
export function resetUnidentifiedSpanWarnings(): void {
  unidentifiedWarnedProjects.clear()
}

// One-time-per-session-per-service audit for a compiled `dist/...js` call site
// that carried no adjacent source map (file-awareness.md §4 + §6). Without a
// map, ingest can't reconcile the observed dist file to the static `src/...ts`
// the extractor parsed — the dist path is the honest answer, never a fabricated
// src path. The leak this surfaces (issue #430) was hiding behind an absolute
// path prefix; once the path is service-root-relative the mismatch is legible,
// and this line tells the operator how to close it.
const noSourceMapWarnedServices = new Set<string>()
function warnNoSourceMaps(serviceName: string): void {
  if (noSourceMapWarnedServices.has(serviceName)) return
  noSourceMapWarnedServices.add(serviceName)
  console.warn(
    `[neat] ${serviceName}: no .map files found under dist/; observed file edges will land on dist paths, not src. Set sourceMap: true in tsconfig to enable file-level reconciliation.`,
  )
}

// Test seam — mirrors resetUnidentifiedSpanWarnings for the once-per-service
// audit above.
export function resetNoSourceMapWarnings(): void {
  noSourceMapWarnedServices.clear()
}

function pickAttrFrom(attrs: AttrBag, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = attrs[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

function pickAttr(span: ParsedSpan, ...keys: string[]): string | undefined {
  return pickAttrFrom(span.attributes, ...keys)
}

function hostFromUrl(u: string | undefined): string | undefined {
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
function pickAddress(span: ParsedSpan): string | undefined {
  return (
    pickAttr(span, 'server.address', 'net.peer.name', 'net.host.name') ??
    hostFromUrl(pickAttr(span, 'url.full', 'http.url'))
  )
}

// A loopback peer address is this host talking to itself, never a distinct
// upstream service. Cross-service correlation on the callee's SERVER span (the
// parent-span fallback, ADR-033) recovers the real peer, so a loopback address
// on a CLIENT span must not mint a standalone frontier:localhost /
// frontier:127.0.0.1 that duplicates that resolved edge (issues #590, #577).
// Scoped to the cross-service CALLS path — a loopback database is a real local
// dependency and keeps its CONNECTS_TO edge.
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  return (
    h === 'localhost' ||
    h === 'ip6-localhost' ||
    h === '::1' ||
    h === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(h)
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Call-site capture (file-awareness.md §4)
//
// The call-site processor stamps the source location on CLIENT/PRODUCER spans.
// OpenTelemetry stabilized the code attributes at semconv v1.33 —
// `code.file.path` / `code.line.number` / `code.function.name` — renaming the
// prior `code.filepath` / `code.lineno` / `code.function`. NEAT's own emit
// templates (installers/templates.ts, and the Python processor, ADR-151) and any
// third-party instrumentation may carry either generation, so the read accepts
// BOTH, stable-name first. When present, an OBSERVED relationship originates from
// the file rather than the service; a span with neither stays service-level, and
// evidence is never fabricated (§6).
const CODE_FILE_PATH_ATTR = 'code.file.path' // semconv ≥1.33 (stable)
const CODE_FILEPATH_ATTR = 'code.filepath' // prior convention
const CODE_LINE_NUMBER_ATTR = 'code.line.number'
const CODE_LINENO_ATTR = 'code.lineno'
const CODE_FUNCTION_NAME_ATTR = 'code.function.name'
const CODE_FUNCTION_ATTR = 'code.function'

// Read the source call site off an attribute bag, accepting the stable
// (semconv ≥1.33) and prior attribute names. Exported so every code.* reader —
// edge attribution here, incident localization in traverse.ts — shares one
// definition and the names can't drift across sites.
export function codeFilepathOf(attrs: Record<string, AttributeValue>): string | undefined {
  const stable = attrs[CODE_FILE_PATH_ATTR]
  if (typeof stable === 'string' && stable.length > 0) return stable
  const prior = attrs[CODE_FILEPATH_ATTR]
  return typeof prior === 'string' && prior.length > 0 ? prior : undefined
}
export function codeLinenoOf(attrs: Record<string, AttributeValue>): number | undefined {
  const stable = attrs[CODE_LINE_NUMBER_ATTR]
  if (typeof stable === 'number' && Number.isFinite(stable)) return stable
  const prior = attrs[CODE_LINENO_ATTR]
  return typeof prior === 'number' && Number.isFinite(prior) ? prior : undefined
}
export function codeFunctionOf(attrs: Record<string, AttributeValue>): string | undefined {
  const stable = attrs[CODE_FUNCTION_NAME_ATTR]
  if (typeof stable === 'string' && stable.length > 0) return stable
  const prior = attrs[CODE_FUNCTION_ATTR]
  return typeof prior === 'string' && prior.length > 0 ? prior : undefined
}

function toPosix(p: string): string {
  return p.split('\\').join('/')
}

function languageForExt(relPath: string): string | undefined {
  const dot = relPath.lastIndexOf('.')
  if (dot === -1) return undefined
  switch (relPath.slice(dot).toLowerCase()) {
    case '.py':
      return 'python'
    case '.go':
      return 'go'
    case '.ts':
    case '.tsx':
      return 'typescript'
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript'
    default:
      return undefined
  }
}

// Join the runtime `code.filepath` against the service root so the OBSERVED
// relPath lines up with the EXTRACTED service-relative path (file-awareness.md
// §4 + §7). ServiceNode.repoPath is the scanPath-relative package dir; its
// segments appear inside the absolute runtime path, so anchoring on it recovers
// the package-relative tail. With no usable anchor, the real runtime path is
// returned in a relative-looking form — honest, even if it doesn't align with a
// static src path. Never fabricated.
function relPathForRuntimeFile(
  filepath: string,
  serviceNode?: ServiceNode,
  scanPath?: string,
): string | null {
  let p = toPosix(filepath).replace(/^file:\/\//, '')
  // When ingest knows the absolute scan root, the service's absolute root is
  // `scanPath/<repoPath>`. Stripping it directly recovers the service-relative
  // tail (`dist/foo.js`) even for a single-package service whose `repoPath` is
  // empty — the segment anchor below has nothing to grab in that case, so the
  // absolute path used to leak into the FileNode key (issue #430).
  if (scanPath && scanPath.length > 0) {
    const absRoot = toPosix(path.resolve(scanPath, serviceNode?.repoPath ?? ''))
    const anchor = absRoot.endsWith('/') ? absRoot : `${absRoot}/`
    if (p.startsWith(anchor)) return p.slice(anchor.length)
  }
  const root = serviceNode?.repoPath
  if (root && root !== '.' && root.length > 0) {
    const rootPosix = toPosix(root)
    const anchor = `/${rootPosix}/`
    const idx = p.lastIndexOf(anchor)
    if (idx !== -1) return p.slice(idx + anchor.length)
    const base = rootPosix.split('/').filter(Boolean).pop()
    if (base) {
      const baseAnchor = `/${base}/`
      const bidx = p.lastIndexOf(baseAnchor)
      if (bidx !== -1) return p.slice(bidx + baseAnchor.length)
    }
  }
  p = p.replace(/^[A-Za-z]:/, '').replace(/^\/+/, '')
  return p.length > 0 ? p : null
}

// Exported so the connectors plane (packages/core/src/connectors/index.ts,
// docs/contracts/connectors.md) can build one from a signal's own callSite —
// a connector's file:line comes from the provider's telemetry rather than an
// OTel span's code.* attributes, but reconciles onto the same EXTRACTED
// FileNode through the same primitives below.
export interface CallSite {
  relPath: string
  line?: number
  fn?: string
  // The service-relative dist path the call site was captured on, when ingest
  // resolved it through a source map to a different (source) `relPath`
  // (file-awareness.md §4). Surfaces as FileNode.originalPath. Absent when the
  // captured frame was already source-grained.
  originalRelPath?: string
}

// dist→src source-map resolution (file-awareness.md §4). A runtime call site in
// a compiled `dist/...js` is resolved through a disk-adjacent `.map` to the
// original `src/...ts`, so an OBSERVED edge lands on the source file an agent
// can open. Same-host only — when the daemon's filesystem doesn't carry the map
// (a service that ran on a different machine) the dist frame is kept, honestly,
// never fabricated (§6). Each dist file is read from disk once: a present map
// caches its consumer, an absent one caches `null`. Synchronous reads keep
// callSiteFromSpan synchronous; the cost is amortised across a file's spans.
const sourceMapCache = new Map<
  string,
  { consumer: sourceMapJs.SourceMapConsumer; dir: string } | null
>()

interface ResolvedSrc {
  filepath: string
  line?: number
}

function resolveDistToSrc(absFilepath: string, line?: number): ResolvedSrc | null {
  if (!absFilepath.endsWith('.js')) return null
  let entry = sourceMapCache.get(absFilepath)
  if (entry === undefined) {
    entry = null
    const mapPath = `${absFilepath}.map`
    try {
      if (existsSync(mapPath)) {
        const raw = JSON.parse(readFileSync(mapPath, 'utf8')) as unknown
        const consumer = new sourceMapJs.SourceMapConsumer(raw as never)
        entry = { consumer, dir: path.dirname(mapPath) }
      }
    } catch {
      entry = null
    }
    sourceMapCache.set(absFilepath, entry)
  }
  if (!entry) return null
  try {
    const queryLine = line !== undefined && Number.isFinite(line) ? line : 1
    // tsc anchors every mapping at the token's real (indented) column, so a
    // column-0 lookup under the default GREATEST_LOWER_BOUND bias finds no
    // mapping on any indented statement — which is exactly the call site an
    // OBSERVED CLIENT span reports for compiled Nest/TS code (issue #915). The
    // map is on disk and read fine; only the position lookup came back empty,
    // so the whole dist frame used to fall through to the raw path. Retry the
    // lookup biased to the LEAST_UPPER_BOUND — the first mapping at or after
    // column 0 on that generated line — so the line resolves to its source.
    let pos = entry.consumer.originalPositionFor({ line: queryLine, column: 0 })
    if (!pos || !pos.source) {
      pos = entry.consumer.originalPositionFor({
        line: queryLine,
        column: 0,
        bias: sourceMapJs.SourceMapConsumer.LEAST_UPPER_BOUND,
      })
    }
    if (!pos || !pos.source) return null
    const root = entry.consumer.sourceRoot ?? ''
    const resolved = path.resolve(entry.dir, root, pos.source)
    return { filepath: resolved, ...(pos.line ? { line: pos.line } : {}) }
  } catch {
    return null
  }
}

// Whether a disk-adjacent `.map` was found for a compiled `dist/...js` frame.
// Reuses the module-level cache resolveDistToSrc already warmed — a non-null
// entry means the map is present (resolution may still have missed a specific
// line), a null entry means none was on disk. Lets the missing-map audit stay
// honest: it must not claim "no .map files found" when a map exists but a lone
// line failed to resolve (file-awareness.md §6, issue #915).
function hasAdjacentSourceMap(absFilepath: string): boolean {
  return sourceMapCache.get(absFilepath) != null
}

// Read the call-site attributes off a span. Returns null when the span carries
// no `code.filepath` (SERVER spans, un-instrumented peers, callee side) so the
// caller falls back to a service-level edge.
function callSiteFromSpan(
  span: ParsedSpan,
  serviceNode?: ServiceNode,
  scanPath?: string,
): CallSite | null {
  const filepath = codeFilepathOf(span.attributes)
  if (filepath === undefined) return null
  let line = codeLinenoOf(span.attributes)
  // Resolve a compiled dist frame to its source before computing the service-
  // relative path, so the FileNode lands on the original `src/...ts`.
  const abs = toPosix(filepath).replace(/^file:\/\//, '')
  const resolved = resolveDistToSrc(abs, line)
  let effectivePath = filepath
  let originalRelPath: string | undefined
  if (resolved) {
    originalRelPath = relPathForRuntimeFile(filepath, serviceNode, scanPath) ?? undefined
    effectivePath = resolved.filepath
    if (resolved.line !== undefined) line = resolved.line
  }
  const relPath = relPathForRuntimeFile(effectivePath, serviceNode, scanPath)
  if (!relPath) return null
  // A compiled `dist/...js` call site that didn't resolve through a map keeps
  // the (honest) dist path. Surface the absence once per service so the
  // operator can enable source maps and recover src-level reconciliation
  // (file-awareness.md §4 + §6, issue #430). Only warn when no `.map` is
  // actually on disk — a present-but-unresolved line must not masquerade as a
  // missing map, the misdiagnosis issue #915 called out.
  if (
    !resolved &&
    abs.endsWith('.js') &&
    relPath.startsWith('dist/') &&
    !hasAdjacentSourceMap(abs) &&
    serviceNode?.name
  ) {
    warnNoSourceMaps(serviceNode.name)
  }
  const fn = codeFunctionOf(span.attributes)
  return {
    relPath,
    ...(line !== undefined ? { line } : {}),
    ...(fn ? { fn } : {}),
    ...(originalRelPath && originalRelPath !== relPath ? { originalRelPath } : {}),
  }
}

// Reconcile a runtime-derived relPath onto the service-relative path the
// extractor already minted, so OBSERVED and EXTRACTED FileNodes for the same
// source file fuse into ONE node instead of two disjoint subgraphs
// (file-awareness.md §4 — ingest joins the runtime path against the service
// root to land the edge on a FileNode).
//
// relPathForRuntimeFile anchors the absolute `code.filepath` against scanPath /
// repoPath. When that anchor can't be found — no scanPath wired, or the span
// was emitted from a service whose absolute root differs from the daemon's
// checkout (a container image rooted at `/app`, a relocated clone) — the
// leftover relPath still carries the unanchored leading segments
// (`app/src/foo.ts`, `Users/me/repo/src/foo.ts`) and forks a parallel FileNode
// keyed off the absolute path. That splits the graph: the OBSERVED layer never
// lands on the EXTRACTED `src/foo.ts` node, and divergence/traversal see two
// half-graphs for one file.
//
// The extractor's FileNode paths are ground truth for which service-relative
// paths exist. Recover the right one by matching the longest EXTRACTED (non-
// OTel) FileNode path that is a trailing segment-suffix of the runtime relPath.
// A match means the runtime path is the same file the extractor parsed, just
// carrying extra leading directories the anchor couldn't strip — reuse the
// extractor's path so both layers key the same node. No match means the file is
// genuinely OTel-only; the honest runtime path stands (never fabricated, §6).
export function reconcileObservedRelPath(
  graph: NeatGraph,
  serviceName: string,
  relPath: string,
): string {
  // Already lands on a known node (the anchor resolved cleanly, or a prior span
  // created this node) — fused, nothing to recover.
  if (graph.hasNode(fileId(serviceName, relPath))) return relPath
  let best: string | null = null
  graph.forEachNode((_id, attrs) => {
    const a = attrs as FileNode & { type?: string }
    if (a.type !== NodeType.FileNode || a.service !== serviceName) return
    // Only fuse onto a statically-known file. An existing OTel-only node would
    // already have matched the hasNode short-circuit above.
    if (a.discoveredVia === 'otel') return
    const p = a.path
    if (!p) return
    if ((relPath === p || relPath.endsWith(`/${p}`)) && (!best || p.length > best.length)) {
      best = p
    }
  })
  return best ?? relPath
}

// Ensure the FileNode for an observed call site and the owning service's
// OBSERVED `CONTAINS` edge both exist, returning the FileNode id so the caller
// can originate the relationship from it (file-awareness.md §1–2 + §4). The
// CONTAINS edge carries no `lastObserved` — structural ownership doesn't go
// STALE when traffic quiets (markStaleEdges skips edges without lastObserved),
// and divergence detection skips CONTAINS so an OTel-only file node doesn't
// surface as a missing-extracted finding.
export function ensureObservedFileNode(
  graph: NeatGraph,
  serviceName: string,
  serviceNodeId: string,
  callSite: CallSite,
): string {
  // Key the file node on the service the span already FUSED onto, not the raw
  // span service.name. ensureServiceNode resolves a differently-cased or
  // env-tagged OTEL_SERVICE_NAME onto the extracted service (`proofrun` → the
  // ServiceNode named `ProofRun`, #880). Keying the file on the raw name here
  // forks a `file:proofrun:…` twin off the extracted `file:ProofRun:…` — the
  // file-level sibling of #880. Reading the canonical name back off the fused
  // service node also lets reconcileObservedRelPath recover the extractor's
  // relative path from a runtime absolute path: its file scan filters by an
  // exact-cased `service`, so the raw name skipped every extracted file before
  // the suffix match could run. Both forks — case and absolute path — close here.
  const svcAttrs = graph.hasNode(serviceNodeId) ? (graph.getNodeAttributes(serviceNodeId) as ServiceNode) : undefined
  const canonicalService =
    svcAttrs && svcAttrs.type === NodeType.ServiceNode && typeof svcAttrs.name === 'string'
      ? svcAttrs.name
      : serviceName
  const relPath = reconcileObservedRelPath(graph, canonicalService, callSite.relPath)
  const fileNodeId = fileId(canonicalService, relPath)
  if (!graph.hasNode(fileNodeId)) {
    const language = languageForExt(relPath)
    const node: FileNode = {
      id: fileNodeId,
      type: NodeType.FileNode,
      service: canonicalService,
      path: relPath,
      ...(language ? { language } : {}),
      ...(callSite.originalRelPath ? { originalPath: callSite.originalRelPath } : {}),
      discoveredVia: 'otel',
    }
    graph.addNode(fileNodeId, node)
  }
  const containsId = makeObservedEdgeId(EdgeType.CONTAINS, serviceNodeId, fileNodeId)
  if (!graph.hasEdge(containsId)) {
    const edge: GraphEdge = {
      id: containsId,
      source: serviceNodeId,
      target: fileNodeId,
      type: EdgeType.CONTAINS,
      provenance: Provenance.OBSERVED,
    }
    graph.addEdgeWithKey(containsId, serviceNodeId, fileNodeId, edge)
  }
  // Observed-first edges land one grain finer than the file when the call site
  // falls inside a symbol's definition span (ADR-158, file-awareness.md §4).
  return landObservedSymbol(graph, fileNodeId, canonicalService, relPath, callSite)
}

// The terminal name of a source-declared qualname (`OrderService.create` →
// `create`) — what `code.function` carries on a span, and the tiebreaker that
// picks the intended symbol when nested definition spans both contain the line.
function terminalName(qualname: string): string {
  const dot = qualname.lastIndexOf('.')
  return dot === -1 ? qualname : qualname.slice(dot + 1)
}

// Given the symbols whose definition span contains the observed `code.line`,
// pick the one the edge lands on. Line-in-span is primary (every candidate
// already contains the line); `code.function` is the tiebreaker and drift check —
// when it names one of the candidates, that symbol wins; otherwise the innermost
// (smallest) span wins, since a call site inside nested definitions belongs to
// the tightest one enclosing it (ADR-158 point 4).
function pickContainingSymbol(
  candidates: { id: string; symbol: SymbolNode }[],
  fn: string | undefined,
): string {
  const bySpan = (a: { symbol: SymbolNode }, b: { symbol: SymbolNode }): number => {
    const sizeA = a.symbol.span.endLine - a.symbol.span.startLine
    const sizeB = b.symbol.span.endLine - b.symbol.span.startLine
    if (sizeA !== sizeB) return sizeA - sizeB
    // Deterministic tiebreak on an exact-size tie: the later-starting span is the
    // more deeply nested one.
    return b.symbol.span.startLine - a.symbol.span.startLine
  }
  if (fn) {
    const named = candidates.filter((c) => terminalName(c.symbol.qualname) === fn)
    if (named.length > 0) return [...named].sort(bySpan)[0]!.id
  }
  return [...candidates].sort(bySpan)[0]!.id
}

// Mint the OBSERVED symbol a runtime call landed on that static never produced —
// the symbol-grain missing-extracted signal (ADR-158 point 5, lifecycle.md
// auto-create-and-merge). `code.function` names it, so the symbol is honest, not
// guessed; the span is the single observed line NEAT can vouch for, and static
// fields override it on the next extract pass if the definition later resolves.
// The file owns it through an OBSERVED `file ──CONTAINS──▶ symbol` edge.
function ensureObservedSymbolNode(
  graph: NeatGraph,
  fileNodeId: string,
  service: string,
  relPath: string,
  fn: string,
  line: number,
): string {
  const sid = symbolId(service, relPath, fn)
  if (!graph.hasNode(sid)) {
    const node: SymbolNode = {
      id: sid,
      type: NodeType.SymbolNode,
      kind: 'function',
      qualname: fn,
      span: { startLine: line, endLine: line },
      service,
      relPath,
      discoveredVia: 'otel',
    }
    graph.addNode(sid, node)
  }
  const containsId = makeObservedEdgeId(EdgeType.CONTAINS, fileNodeId, sid)
  if (!graph.hasEdge(containsId)) {
    const edge: GraphEdge = {
      id: containsId,
      source: fileNodeId,
      target: sid,
      type: EdgeType.CONTAINS,
      provenance: Provenance.OBSERVED,
    }
    graph.addEdgeWithKey(containsId, fileNodeId, sid, edge)
  }
  return sid
}

// Resolve the observed edge's origin to a symbol under the file when the call
// site's line falls inside a symbol's definition span; otherwise land on the file
// (ADR-158, file-awareness.md §4–§5). Boundary-grained, not a full call graph:
// the returned node is what the edge originates from.
//
// Degrade to the file honestly when there is no line, or the line is inside no
// symbol span and either the file was never symbol-extracted (no symbols to be
// "missing" from) or the span carries no function name. When the file *was*
// symbol-extracted, the line is in no static symbol, and `code.function` names
// the executing function, mint an `otel` symbol — the missing-extracted signal at
// symbol grain (point 5), never a degrade that hides the dynamic wiring.
function landObservedSymbol(
  graph: NeatGraph,
  fileNodeId: string,
  service: string,
  relPath: string,
  callSite: CallSite,
  // Whether to MINT an observed-only symbol when the line is in no static symbol
  // span (the missing-extracted-at-symbol-grain signal, ADR-158 §5). The edge
  // mint path leaves it true; the incident resolver (ADR-191) passes false so it
  // reads the containing static symbol without mutating — safe at the receiver,
  // which runs before reply and off the mutation queue (otel-ingest §Non-blocking).
  mint = true,
): string {
  const line = callSite.line
  if (line === undefined) return fileNodeId

  let sawSymbol = false
  const candidates: { id: string; symbol: SymbolNode }[] = []
  graph.forEachOutboundEdge(fileNodeId, (_edge, edgeAttrs, _source, target) => {
    if (edgeAttrs.type !== EdgeType.CONTAINS) return
    const t = graph.getNodeAttributes(target) as GraphNode
    if (t.type !== NodeType.SymbolNode) return
    sawSymbol = true
    if (line >= t.span.startLine && line <= t.span.endLine) {
      candidates.push({ id: target, symbol: t })
    }
  })

  if (candidates.length > 0) return pickContainingSymbol(candidates, callSite.fn)

  if (mint && sawSymbol && callSite.fn) {
    return ensureObservedSymbolNode(graph, fileNodeId, service, relPath, callSite.fn, line)
  }
  return fileNodeId
}

// Edge id helpers live in @neat.is/types/identity.ts (ADR-029). The local
// signatures below preserve the (type, source, target) argument order ingest.ts
// has used historically while delegating to the canonical wire-format helpers.
function makeObservedEdgeId(type: EdgeTypeValue, source: string, target: string): string {
  return observedEdgeId(source, target, type)
}

function makeInferredEdgeId(type: EdgeTypeValue, source: string, target: string): string {
  return inferredEdgeId(source, target, type)
}

const INFERRED_CONFIDENCE = 0.6
const STITCH_MAX_DEPTH = 2

// The trace stitcher only reasons about runtime *dependency* edges — the ones an
// error actually propagates along (a service calling a service, connecting to a
// datastore, a declared runtime dependency). Structural edges (CONTAINS a file,
// IMPORTS a module, CONFIGURED_BY a ConfigNode, RUNS_ON a host) are static facts
// learned by extraction; a 500 says nothing new about them. Minting an INFERRED
// twin of a structural EXTRACTED edge would corrupt the trust signal — the twin
// (conf 0.6) outranks the ground-truth EXTRACTED edge (0.85) under PROV_RANK, so
// consumer queries would surface the inference in place of the hard fact
// (docs/contracts/trace-stitcher.md — dependency-edge-type allowlist).
const STITCH_EDGE_TYPES = new Set<EdgeTypeValue>([
  EdgeType.CALLS,
  EdgeType.CONNECTS_TO,
  EdgeType.DEPENDS_ON,
])

// OTLP-wire SpanKind values. The receiver decodes the raw wire integer onto
// `ParsedSpan.kind` (otel.ts), and the wire enum is offset by one from the
// `@opentelemetry/api` SpanKind the SDK uses in-process — UNSPECIFIED 0,
// INTERNAL 1, SERVER 2, CLIENT 3, PRODUCER 4, CONSUMER 5. So we must NOT import
// `@opentelemetry/api` here: its CLIENT is 2 (= wire SERVER) and PRODUCER is 3
// (= wire CLIENT), which would gate the wrong kinds. Cross-referenced with the
// wire fixtures in otel.test.ts (kind 2 = SERVER, kind 3 = CLIENT) and the
// CLIENT call-site spans in ingest.test.ts (kind 3).
const WIRE_SPAN_KIND_CLIENT = 3
const WIRE_SPAN_KIND_PRODUCER = 4
const WIRE_SPAN_KIND_CONSUMER = 5

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
function spanMintsObservedEdge(kind: number | undefined): boolean {
  if (kind === undefined || kind === 0) return true
  return kind === WIRE_SPAN_KIND_CLIENT || kind === WIRE_SPAN_KIND_PRODUCER
}

// The messaging counterpart to the caller-side gate. A PRODUCER span publishes
// to a destination; a CONSUMER span reads from one. Both sides mint an OBSERVED
// edge to the topic/queue node — the PRODUCER a PUBLISHES_TO, the CONSUMER a
// CONSUMES_FROM — so declared and observed queue topology fuse. Only spans that
// actually carry a messaging destination reach this (handleSpan checks the
// semconv attrs first), so a stray CONSUMER span with no destination stays inert.
function spanMintsMessagingEdge(kind: number | undefined): boolean {
  return kind === WIRE_SPAN_KIND_PRODUCER || kind === WIRE_SPAN_KIND_CONSUMER
}

// The GraphQL execution span is emitted by the service that RESOLVES the
// operation — a SERVER or INTERNAL span (the instrumentation's `graphql.execute`),
// never the CLIENT side that only ever sees an opaque `POST /graphql`. Gating out
// the caller/producer/consumer kinds keeps a client-side operation span from
// attributing the operation to the caller (client-side operation attribution is
// deferred, ADR-122); an unkinded / UNSET span still mints, mirroring the
// caller-side gate's legacy-producer fallback.
function spanServesGraphqlOperation(kind: number | undefined): boolean {
  return (
    kind !== WIRE_SPAN_KIND_CLIENT &&
    kind !== WIRE_SPAN_KIND_PRODUCER &&
    kind !== WIRE_SPAN_KIND_CONSUMER
  )
}

// A GraphQL operation node keyed on (service, operationType, operationName) via
// graphqlOperationId (ADR-122). Minted observed-first from the execution span so
// operation-level topology is legible even before any static GraphQL extractor
// exists; a later static extractor fuses onto the same id. `operationType` is
// stored lower-cased to match the id's normalisation, so a `query` observed and a
// `Query` static resolver land on one node. Idempotent — a high-volume operation
// upserts, never grows the node set.
function ensureGraphqlOperationNode(
  graph: NeatGraph,
  serviceName: string,
  operationType: string,
  operationName: string,
): string {
  const id = graphqlOperationId(serviceName, operationType, operationName)
  if (graph.hasNode(id)) return id
  const node: GraphQLOperationNode = {
    id,
    type: NodeType.GraphQLOperationNode,
    name: operationName,
    service: serviceName,
    operationType: operationType.toLowerCase(),
    operationName,
    discoveredVia: 'otel',
  }
  graph.addNode(id, node)
  return id
}

// The gRPC execution span carrying `rpc.service` / `rpc.method` is emitted on
// both sides of a call — the SERVER that resolves the method and the CLIENT that
// invokes it. Only the serving side owns the method (ADR-123): gating out the
// caller/producer/consumer kinds keeps a CLIENT gRPC span from attributing
// ownership to the caller (that client span still falls through to the
// cross-service resolver below, so the caller→callee edge is unaffected).
// Client→method attribution is deferred. An unkinded / UNSET span still mints,
// mirroring the graphql and caller-side gates' legacy fallbacks.
function spanServesGrpcMethod(kind: number | undefined): boolean {
  return (
    kind !== WIRE_SPAN_KIND_CLIENT &&
    kind !== WIRE_SPAN_KIND_PRODUCER &&
    kind !== WIRE_SPAN_KIND_CONSUMER
  )
}

// A gRPC method node keyed on (rpcService, rpcMethod) via grpcMethodId (ADR-123).
// `rpcService` is the fully-qualified `rpc.service` the wire carries verbatim
// (`orders.OrderService`), so an OBSERVED span and a static `.proto` definition
// fuse onto one node rather than twinning. Idempotent — a high-volume method
// upserts, never grows the node set.
function ensureGrpcMethodNode(
  graph: NeatGraph,
  rpcService: string,
  rpcMethod: string,
): string {
  const id = grpcMethodId(rpcService, rpcMethod)
  if (graph.hasNode(id)) return id
  const node: GrpcMethodNode = {
    id,
    type: NodeType.GrpcMethodNode,
    name: `${rpcService}/${rpcMethod}`,
    rpcService,
    rpcMethod,
    discoveredVia: 'otel',
  }
  graph.addNode(id, node)
  return id
}

// The HTTP upgrade span that opens a WebSocket is emitted by the service that
// SERVES the channel — a SERVER span (the framework's inbound `GET`), or an
// unkinded / INTERNAL span from a hand-built handshake. The CLIENT that dials the
// socket carries the same upgrade header, but the channel belongs to the server
// (ADR-125), so gating out the caller/producer/consumer kinds keeps a client-side
// upgrade span from attributing the channel to the caller. An unkinded / UNSET
// span still mints, mirroring the graphql and gRPC serving-side gates.
function spanServesWebsocketChannel(kind: number | undefined): boolean {
  return (
    kind !== WIRE_SPAN_KIND_CLIENT &&
    kind !== WIRE_SPAN_KIND_PRODUCER &&
    kind !== WIRE_SPAN_KIND_CONSUMER
  )
}

// A WebSocket channel node keyed on (service, channel) via websocketChannelId
// (ADR-125). Minted OBSERVED-only from the upgrade span — a WebSocket channel is
// known from observation, never from static extraction, so there is no declared
// twin to fuse with and no static producer to fill in `path` / `line` (those stay
// absent, never fabricated — file-awareness.md §6). Idempotent — every reconnect
// on the same channel upserts, never grows the node set.
function ensureWebsocketChannelNode(
  graph: NeatGraph,
  serviceName: string,
  channel: string,
): string {
  const id = websocketChannelId(serviceName, channel)
  if (graph.hasNode(id)) return id
  const node: WebSocketChannelNode = {
    id,
    type: NodeType.WebSocketChannelNode,
    name: channel,
    service: serviceName,
    channel,
    discoveredVia: 'otel',
  }
  graph.addNode(id, node)
  return id
}

// A messaging destination node (Kafka topic, queue, stream) keyed exactly the
// way the static extractor keys it, so the OBSERVED and EXTRACTED edges fuse
// onto one node instead of twinning. The Kafka static side names its topic
// `infra:kafka-topic:<topic>` (extract/calls/kafka.ts), so the kind is
// `<messaging.system>-topic` — `kafka` → `kafka-topic` — and the same shape
// generalises to every messaging system the semconv names. `provider: 'self'`
// mirrors the static extractor's non-AWS provider so an observed-first node
// merges cleanly when static analysis later reaches the same destination.
function messagingDestinationKind(system: string): string {
  return `${system}-topic`
}

function ensureMessagingDestinationNode(
  graph: NeatGraph,
  system: string,
  destination: string,
): string {
  const id = infraId(messagingDestinationKind(system), destination)
  if (graph.hasNode(id)) return id
  const node: InfraNode = {
    id,
    type: NodeType.InfraNode,
    name: destination,
    provider: 'self',
    kind: messagingDestinationKind(system),
  }
  graph.addNode(id, node)
  return id
}

// Parent-span TTL cache (ADR-033). Address-based peer resolution (server.address /
// net.peer.name / url.full) misses non-HTTP RPCs and any span with an opaque
// peer. The cache stores each span's service keyed by `${traceId}:${spanId}` so
// a child span whose address resolution fails can fall back to its parent's
// service, identifying a cross-service CALLS edge from parent → current.
//
// Bounded size + TTL — out-of-order arrival (child before parent) drops the
// child rather than buffering. We accept that loss because the cache is best-
// effort: for every cross-service call, the CLIENT span on the caller side
// covers the same edge via address-based resolution, so missing one direction
// is recoverable.
const PARENT_SPAN_CACHE_SIZE = 10_000
const PARENT_SPAN_CACHE_TTL_MS = 5 * 60 * 1000

interface ParentSpanCacheEntry {
  service: string
  // Env discriminator from the parent span (ADR-074 §2). The parent-span
  // fallback in handleSpan uses this so the auto-created parent ServiceNode
  // lands on the same env-tagged id the OTel emitter advertised.
  env: string
  // The parent span's own `code.*` call site, when its SpanProcessor captured
  // one (file-awareness.md §4). The parent-span fallback below originates its
  // edge from the parent's FileNode instead of the bare parent ServiceNode when
  // this is present, so the fallback edge anchors to file:line rather than
  // pinning to a service node (issue #536). Undefined when the parent carried no
  // call site — never fabricated (§6), so the service-level fallback stands.
  callSite?: CallSite
  expiresAt: number
}

const parentSpanCache = new Map<string, ParentSpanCacheEntry>()

function parentSpanKey(traceId: string, spanId: string): string {
  return `${traceId}:${spanId}`
}

function cacheSpanService(span: ParsedSpan, now: number, callSite: CallSite | null): void {
  if (!span.traceId || !span.spanId) return
  const key = parentSpanKey(span.traceId, span.spanId)
  // Map preserves insertion order, so deleting + re-inserting bumps an entry to
  // the back. Eviction is "drop oldest" once size exceeds the cap.
  parentSpanCache.delete(key)
  parentSpanCache.set(key, {
    service: span.service,
    env: span.env ?? 'unknown',
    ...(callSite ? { callSite } : {}),
    expiresAt: now + PARENT_SPAN_CACHE_TTL_MS,
  })
  while (parentSpanCache.size > PARENT_SPAN_CACHE_SIZE) {
    const oldest = parentSpanCache.keys().next().value
    if (!oldest) break
    parentSpanCache.delete(oldest)
  }
}

function lookupParentSpan(
  traceId: string,
  parentSpanId: string,
  now: number,
): { service: string; env: string; callSite?: CallSite } | null {
  const entry = parentSpanCache.get(parentSpanKey(traceId, parentSpanId))
  if (!entry) return null
  if (entry.expiresAt <= now) {
    parentSpanCache.delete(parentSpanKey(traceId, parentSpanId))
    return null
  }
  return {
    service: entry.service,
    env: entry.env,
    ...(entry.callSite ? { callSite: entry.callSite } : {}),
  }
}

// Test seam: lets unit tests start from a clean slate.
export function resetParentSpanCache(): void {
  parentSpanCache.clear()
}

// Peer host → ServiceNode id resolution. With env-dimension (ADR-074 §2),
// the same `name` may live across multiple ServiceNodes — one per env, plus
// the env-less form from static extraction. When `env` is known (the source
// span's env), prefer a same-env match; fall back to the env-less node so
// EXTRACTED edges from static analysis remain reachable until OBSERVED
// traffic from the same env promotes them.
//
// Match passes:
//   1. Exact id lookup for `(host, env)` — `serviceId(host, env)`.
//   2. Exact id lookup for env-less `serviceId(host)`.
//   3. Name/alias scan across every ServiceNode, preferring same-env then
//      env-less then any other env.
function resolveServiceId(
  graph: NeatGraph,
  host: string,
  env: string,
): string | null {
  const envTagged = serviceId(host, env)
  if (graph.hasNode(envTagged)) return envTagged
  const envLess = serviceId(host)
  if (envLess !== envTagged && graph.hasNode(envLess)) return envLess

  let sameEnv: string | null = null
  let envLessMatch: string | null = null
  let anyMatch: string | null = null
  graph.forEachNode((id, attrs) => {
    if (sameEnv) return
    const a = attrs as ServiceNode & { type?: string }
    if (a.type !== NodeType.ServiceNode) return
    const matchesByName = a.name === host
    const matchesByAlias = a.aliases ? a.aliases.includes(host) : false
    if (!matchesByName && !matchesByAlias) return
    const nodeEnv = a.env ?? 'unknown'
    if (nodeEnv === env) {
      sameEnv = id
      return
    }
    if (nodeEnv === 'unknown' && !envLessMatch) envLessMatch = id
    else if (!anyMatch) anyMatch = id
  })
  return sameEnv ?? envLessMatch ?? anyMatch
}

export function frontierIdFor(host: string): string {
  return frontierId(host)
}

// Auto-create a minimal ServiceNode for span.service when no such node exists.
// Used at the top of handleSpan so subsequent edge upserts always have endpoints
// — without it, OBSERVED edges silently drop for any service the static
// extractor hasn't reached yet (and never reaches at all in OTel-only setups).
// `language: 'unknown'` is the contract's specified placeholder (ADR-033). When
// static extraction later produces a ServiceNode at the same id, addServiceNodes
// merges and flips discoveredVia to 'merged' rather than overwriting.
// Exported for the connectors plane (connectors/index.ts) — a connector
// signal needs the same auto-vivified ServiceNode any OTel span gets before
// an edge upsert, since a connector-sourced service may never have been
// statically extracted or seen a span yet.
// Pure, read-only resolution of an observed `service.name` + `env` onto the id
// of the ServiceNode it fuses with. This is the #880 matching, factored out of
// ensureServiceNode so the incident/error path can share it without mutating
// the graph.
//
// Two things push the observed id away from the extracted `service:<name>`:
// `deployment.environment` (standard OTel semconv, commonly set) tags it
// `service:<name>:<env>`, and OTEL_SERVICE_NAME is routinely a differently-
// cased form of the manifest name the extractor used (`casetest` vs the
// registered `CaseTest`). Either one alone splits the fused graph in two. So:
// first an exact `(name, env)` id lookup, then a case-insensitive `name` match
// against a statically extracted (non-otel) ServiceNode, ignoring env — env is
// a dimension, not identity.
//
// When neither matches, the raw `serviceId(name, env)` is returned and the
// caller decides: ensureServiceNode mints a node at that id, the incident path
// (incidentAffectedNode) just attributes against it — the honest fallback for
// an OTel-only service the graph hasn't materialised yet.
//
// Exported (ADR-185) so an incident-emitting connector's `resolveTarget` can
// share the exact fused-service lookup — landing a build-failure incident on
// the same extracted ServiceNode a span would, never a connector twin.
export function resolveFusedServiceId(
  graph: NeatGraph,
  serviceName: string,
  env: string,
): string {
  const id = serviceId(serviceName, env)
  if (graph.hasNode(id)) return id
  const wanted = serviceName.toLowerCase()
  const extractedId = graph.findNode((_nid, attrs) => {
    if (attrs.type !== NodeType.ServiceNode) return false
    const svc = attrs as ServiceNode
    // Skip observed twins (discoveredVia 'otel') — only fuse onto a statically
    // extracted (or already-merged) service, never onto another observed node.
    if (svc.discoveredVia === 'otel') return false
    return typeof svc.name === 'string' && svc.name.toLowerCase() === wanted
  })
  return extractedId ?? id
}

export function ensureServiceNode(
  graph: NeatGraph,
  serviceName: string,
  env: string,
): string {
  // Fuse an observed span onto the service the static extractor already minted
  // (#880), rather than forking a twin that never joins the extracted graph —
  // without it `observed-dependencies` reports "no traffic" on the extracted
  // node while the traffic sits on the twin, and every divergence doubles.
  const resolved = resolveFusedServiceId(graph, serviceName, env)
  if (graph.hasNode(resolved)) return resolved
  // Nothing matched — `resolved` is the raw serviceId, so this is a genuinely
  // new OTel-only service. Mint it (the env-tagged or differently-cased spans
  // that DID match an extracted node already returned above).
  const node: ServiceNode = {
    id: resolved,
    type: NodeType.ServiceNode,
    name: serviceName,
    language: 'unknown',
    discoveredVia: 'otel',
    ...(env !== 'unknown' ? { env } : {}),
  }
  graph.addNode(resolved, node)
  return resolved
}

// Exported so a connector's generic pipeline (connectors/index.ts) can create
// an honest placeholder InfraNode for a provider-named resource no static
// extractor has (yet) declared — a provider module has no mutation authority
// of its own (ADR-030), so `resolveTarget` declares this need instead of
// creating the node itself (ADR-133 §4a, docs/contracts/connectors.md).
// Idempotent, same shape as `ensureServiceNode`.
export function ensureInfraNode(
  graph: NeatGraph,
  kind: string,
  name: string,
  provider: string,
): string {
  const id = infraId(kind, name)
  if (graph.hasNode(id)) return id
  const node: InfraNode = {
    id,
    type: NodeType.InfraNode,
    name,
    provider,
    kind,
  }
  graph.addNode(id, node)
  return id
}

// InfraNode kinds that carry columns — a database table read at column grain
// (ADR-157 §1). `sql-table` is the canonical table node the OTel `db.statement`
// mint and the Neon connector both land on; `supabase-table` is the same table
// grain on the Supabase pull path. A project-level or non-table InfraNode (a
// `supabase` project node, a `mongodb-collection`, a queue/route node) carries no
// columns, so a merge onto one is a no-op.
const COLUMN_BEARING_INFRA_KINDS = new Set(['sql-table', 'supabase-table'])

// Fold columns onto a table InfraNode at the given provenance (ADR-157 §1-2).
// Columns are provenanced attributes on the table node, never their own nodes. A
// column records each side it has been seen with in its `provenances` set — a
// declared column production also touches ends up `[EXTRACTED, OBSERVED]`, not one
// side clobbering the other — so column drift (ADR-157 §4) can read the declared
// set and the observed set off one node. A no-op for a non-table node or an empty
// column set, so a wildcard / join / DDL statement (which recovers no columns)
// grows nothing. Mutation lives here in ingest.ts per the lifecycle authority
// (ADR-030); the pure fold is columns.ts so extract/* can call it without a cycle.
function mergeColumnsAt(
  graph: NeatGraph,
  tableNodeId: string,
  columns: readonly string[] | undefined,
  provenance: ProvenanceValue,
  confidence: number,
): void {
  if (!columns || columns.length === 0 || !graph.hasNode(tableNodeId)) return
  const node = graph.getNodeAttributes(tableNodeId) as InfraNode
  if (node.type !== NodeType.InfraNode || !node.kind || !COLUMN_BEARING_INFRA_KINDS.has(node.kind)) {
    return
  }
  graph.replaceNodeAttributes(tableNodeId, {
    ...node,
    columns: foldColumns(node.columns, columns, provenance, confidence),
  })
}

// Merge the columns a production statement touched onto a table InfraNode as
// OBSERVED (ADR-157 §1-2). OTel ingest and the connector mint path both call in.
export function mergeObservedColumns(
  graph: NeatGraph,
  tableNodeId: string,
  columns: readonly string[] | undefined,
): void {
  mergeColumnsAt(graph, tableNodeId, columns, Provenance.OBSERVED, OBSERVED_COLUMN_CONFIDENCE)
}

// Merge the columns a schema/ORM declares onto a table InfraNode as EXTRACTED
// (ADR-157 §3). The declared side of column grain: the static extractor recovers
// each column at database-name fidelity and calls in from extract/calls/*.
export function mergeDeclaredColumns(
  graph: NeatGraph,
  tableNodeId: string,
  columns: readonly string[] | undefined,
  confidence: number,
): void {
  mergeColumnsAt(graph, tableNodeId, columns, Provenance.EXTRACTED, confidence)
}

// Same shape for unseen db.system + host pairs. Engine comes off the OTel
// attribute as a string per Rule 8 — no hardcoded engine list. compatibleDrivers
// is empty until static extraction merges in the matrix-derived drivers.
function ensureDatabaseNode(graph: NeatGraph, host: string, engine: string): string {
  const id = databaseId(host)
  if (graph.hasNode(id)) return id
  const node: DatabaseNode = {
    id,
    type: NodeType.DatabaseNode,
    name: host,
    engine,
    engineVersion: 'unknown',
    compatibleDrivers: [],
    host,
    discoveredVia: 'otel',
  }
  graph.addNode(id, node)
  return id
}

// An in-process / embedded database (SQLite, better-sqlite3, an in-memory
// store) crosses no network boundary, so its span carries no peer host to key a
// DatabaseNode on. Key it on a service-scoped local identity instead so two
// services each reading their own `app.db` stay distinct nodes rather than
// collapsing onto one (ADR-118). `name` is the logical database from the span
// (db.name) when present, the engine string otherwise. `host` is intentionally
// omitted — an embedded database has no network host, and evidence is never
// fabricated (file-awareness.md §6); host-mismatch divergence skips a hostless
// DatabaseNode. Returns the node id so the caller can point the CONNECTS_TO edge
// at it. Idempotent — high-volume DB spans upsert, never grow the node set.
function ensureLocalDatabaseNode(
  graph: NeatGraph,
  serviceName: string,
  name: string,
  engine: string,
): string {
  const id = localDatabaseId(serviceName, name)
  if (graph.hasNode(id)) return id
  const node: DatabaseNode = {
    id,
    type: NodeType.DatabaseNode,
    name,
    engine,
    engineVersion: 'unknown',
    compatibleDrivers: [],
    discoveredVia: 'otel',
  }
  graph.addNode(id, node)
  return id
}

// ADR-141 — an ORM such as Prisma emits a `db.system` span with no peer host
// (its query engine backdates the span off the connection), so a host-less span
// would mint a fresh service-local DatabaseNode and leave the service's
// statically declared database — the one parsed from its connection string / ORM
// schema — with no OBSERVED twin: a false `missing-observed` divergence for a DB
// the service demonstrably hammers. Before minting a local node, fuse onto the
// service's already-declared database of the same engine when there is exactly
// one. Ambiguous (two-plus same-engine declared DBs) or none falls back to the
// ADR-118 service-local node — the fusion never guesses which of several it is.
function findDeclaredDatabaseForService(
  graph: NeatGraph,
  serviceNodeId: string,
  engine: string,
): string | null {
  if (!graph.hasNode(serviceNodeId)) return null
  // A declared database CONNECTS_TO is file-grained by design — it originates
  // from the config file that named the connection (databases/index.ts,
  // file-awareness §7), not the service node. So scan the service node and every
  // file it CONTAINS for a same-engine EXTRACTED CONNECTS_TO target.
  const sources = [serviceNodeId]
  for (const edgeId of graph.outboundEdges(serviceNodeId)) {
    const e = graph.getEdgeAttributes(edgeId) as GraphEdge
    if (e.type === EdgeType.CONTAINS) sources.push(e.target)
  }
  const matches = new Set<string>()
  for (const src of sources) {
    if (!graph.hasNode(src)) continue
    for (const edgeId of graph.outboundEdges(src)) {
      const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
      if (edge.type !== EdgeType.CONNECTS_TO || edge.provenance !== Provenance.EXTRACTED) continue
      if (!graph.hasNode(edge.target)) continue
      const target = graph.getNodeAttributes(edge.target) as DatabaseNode
      if (target.type !== NodeType.DatabaseNode || target.engine !== engine) continue
      matches.add(edge.target)
    }
  }
  return matches.size === 1 ? [...matches][0]! : null
}

function ensureFrontierNode(graph: NeatGraph, host: string, ts: string): string {
  const id = frontierIdFor(host)
  if (graph.hasNode(id)) {
    const existing = graph.getNodeAttributes(id) as FrontierNode
    graph.replaceNodeAttributes(id, { ...existing, lastObserved: ts })
    return id
  }
  const node: FrontierNode = {
    id,
    type: NodeType.FrontierNode,
    name: host,
    host,
    firstObserved: ts,
    lastObserved: ts,
  }
  graph.addNode(id, node)
  return id
}

// Exported so the connectors plane (connectors/index.ts) mints edges through
// the identical primitive OTel ingest uses — a connector-sourced edge and a
// span-sourced edge are meant to be indistinguishable to traversal,
// divergence, and staleness (docs/connectors/README.md).
export interface UpsertResult {
  edge: GraphEdge
  created: boolean
}

export function upsertObservedEdge(
  graph: NeatGraph,
  type: EdgeTypeValue,
  source: string,
  target: string,
  ts: string,
  isError = false,
  evidence?: { file: string; line?: number },
  // Span duration in ms (ADR-190). Present on span-derived edges; absent on a
  // connector edge with no provider latency, which then carries no latency.
  durationMs?: number,
): UpsertResult | null {
  if (!graph.hasNode(source) || !graph.hasNode(target)) return null

  // ADR-142 — grain is a stored fact, not a re-derivation. A `file:` source means
  // a call site was captured (observedSource / the connector's callSite path both
  // mint a FileNode only when they have one), so the edge is file-grained;
  // anything else (service:/infra:/frontier:) is the coarse service-grained
  // fallback. Set on both the OTel and the connector path — they share this mint.
  // A `symbol:` source is finer still (ADR-158) — the call site landed on the
  // calling symbol under its file — and belongs in the same call-site-captured
  // bucket as `file:`, never the coarse service fallback.
  const grain: 'file' | 'service' =
    source.startsWith('file:') || source.startsWith('symbol:') ? 'file' : 'service'

  const id = makeObservedEdgeId(type, source, target)
  if (graph.hasEdge(id)) {
    const existing = graph.getEdgeAttributes(id) as GraphEdge
    const newSpanCount = (existing.signal?.spanCount ?? existing.callCount ?? 0) + 1
    const newErrorCount = (existing.signal?.errorCount ?? 0) + (isError ? 1 : 0)
    // Fold this span's duration into the bounded per-edge latency histogram and
    // re-derive p50/p95 (latency-digest.ts, ADR-190). A call with no duration
    // (a connector signal) leaves the prior latency untouched, never clears it.
    const latencyHist =
      durationMs !== undefined
        ? recordLatency({ ...(existing.signal?.latencyHist ?? {}) }, durationMs)
        : existing.signal?.latencyHist
    const latencyMs = latencyPercentiles(latencyHist) ?? existing.signal?.latencyMs
    const newSignal = {
      spanCount: newSpanCount,
      errorCount: newErrorCount,
      lastObservedAgeMs: 0,
      ...(latencyHist ? { latencyHist } : {}),
      ...(latencyMs ? { latencyMs } : {}),
      ...(existing.signal?.anomalous !== undefined
        ? { anomalous: existing.signal.anomalous }
        : {}),
    }
    // ADR-066 §2 — confidence grades from the signal block. PROV_RANK stays;
    // the grade reflects volume + recency + error ratio within the OBSERVED
    // tier.
    const updated: GraphEdge = {
      ...existing,
      provenance: Provenance.OBSERVED,
      lastObserved: ts,
      callCount: newSpanCount,
      signal: newSignal,
      confidence: confidenceForObservedSignal(newSignal),
      grain, // backfills legacy edges that predate ADR-142
    }
    graph.replaceEdgeAttributes(id, updated)
    return { edge: updated, created: false }
  }

  const latencyHist = durationMs !== undefined ? recordLatency({}, durationMs) : undefined
  const latencyMs = latencyHist ? latencyPercentiles(latencyHist) : undefined
  const signal = {
    spanCount: 1,
    errorCount: isError ? 1 : 0,
    lastObservedAgeMs: 0,
    ...(latencyHist ? { latencyHist } : {}),
    ...(latencyMs ? { latencyMs } : {}),
  }
  const edge: GraphEdge = {
    id,
    source,
    target,
    type,
    provenance: Provenance.OBSERVED,
    confidence: confidenceForObservedSignal(signal),
    lastObserved: ts,
    callCount: 1,
    signal,
    grain,
    // Call-site evidence from span code.* semconv (file-awareness.md §4 + §6).
    // Only set when code.filepath was present on the span — never fabricated.
    ...(evidence ? { evidence } : {}),
  }
  graph.addEdgeWithKey(id, source, target, edge)
  return { edge, created: true }
}

// When a span errors, the system is exercising its dependencies right now even
// if some of them aren't auto-instrumented (pg 7.4.0 in the demo, see ADR-014).
// Walk EXTRACTED edges out from the erroring service for a couple of hops and
// promote them to INFERRED twins so traversal can prefer them over the bare
// static edges without claiming OBSERVED-grade certainty.
function stitchTrace(graph: NeatGraph, sourceServiceId: string, ts: string): void {
  if (!graph.hasNode(sourceServiceId)) return

  const visited = new Set<string>([sourceServiceId])
  const queue: { nodeId: string; depth: number }[] = [{ nodeId: sourceServiceId, depth: 0 }]

  while (queue.length > 0) {
    const { nodeId, depth } = queue.shift()!
    if (depth >= STITCH_MAX_DEPTH) continue

    const outbound = graph.outboundEdges(nodeId)
    for (const edgeId of outbound) {
      const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
      if (edge.provenance !== Provenance.EXTRACTED) continue

      // Only runtime dependency edges get stitched. Structural edges (CONTAINS /
      // IMPORTS / CONFIGURED_BY / RUNS_ON) are never mirrored into INFERRED twins
      // and the BFS does not recurse through them — an error propagates along
      // dependencies, not static containment (trace-stitcher.md allowlist).
      if (!STITCH_EDGE_TYPES.has(edge.type)) continue

      // OBSERVED twin already covers this hop with ground truth — no inference
      // needed (ADR-034). Stomping it with INFERRED erases the gap NEAT exists
      // to surface; skipping it keeps the OBSERVED edge as the authoritative
      // record and avoids cluttering the graph with a redundant INFERRED twin.
      if (graph.hasEdge(observedEdgeId(edge.source, edge.target, edge.type))) continue

      upsertInferredEdge(graph, edge.type, edge.source, edge.target, ts)

      if (!visited.has(edge.target)) {
        visited.add(edge.target)
        queue.push({ nodeId: edge.target, depth: depth + 1 })
      }
    }
  }
}

function upsertInferredEdge(
  graph: NeatGraph,
  type: EdgeTypeValue,
  source: string,
  target: string,
  ts: string,
): void {
  const id = makeInferredEdgeId(type, source, target)
  if (graph.hasEdge(id)) {
    const existing = graph.getEdgeAttributes(id) as GraphEdge
    const updated: GraphEdge = { ...existing, lastObserved: ts }
    graph.replaceEdgeAttributes(id, updated)
    return
  }

  const edge: GraphEdge = {
    id,
    source,
    target,
    type,
    provenance: Provenance.INFERRED,
    confidence: INFERRED_CONFIDENCE,
    lastObserved: ts,
  }
  graph.addEdgeWithKey(id, source, target, edge)
}

// Announce a freshly-recorded incident on the event bus (ADR-221). A lean
// trigger — the affected node, service, and kind — that wakes `neat monitor`;
// the full incident card is a REST read (GET /graph/incident-card/:nodeId). The
// monitor dedupes on the incident id, so a stray double-emit is harmless. Fired
// from every incident write path that knows its project: the OTel paths (this
// one, plus the receiver's synchronous writer for status-error spans) and
// connector incidents (ADR-185) through appendConnectorIncident, which threads
// the project from its poll caller.
function emitIncidentEvent(project: string, ev: ErrorEvent): void {
  emitNeatEvent({
    type: 'incident',
    project,
    payload: {
      incidentId: ev.id,
      affectedNode: ev.affectedNode,
      service: ev.service,
      incidentKind: incidentKindOf(ev),
      at: ev.timestamp,
    },
  })
}

async function appendErrorEvent(ctx: IngestContext, ev: ErrorEvent): Promise<void> {
  await fs.mkdir(path.dirname(ctx.errorsPath), { recursive: true })
  await fs.appendFile(ctx.errorsPath, JSON.stringify(ev) + '\n', 'utf8')
  emitIncidentEvent(ctx.project ?? DEFAULT_PROJECT, ev)
}

// The semantic fields an incident-emitting connector's failure carries, minus
// the ErrorEvent bookkeeping this function fills in (ADR-185, connectors.md §10).
export interface ConnectorIncidentInput {
  // Stable dedupe key for the one failure (e.g. `eas:build:<buildId>`).
  id: string
  // The failure's own event time (ISO8601).
  timestamp: string
  // The NEAT service the failure belongs to.
  service: string
  // Short stable classifier (e.g. 'eas-build-failure'), the connector analog of
  // the 'http-failure' errorType the response-code incidents carry.
  errorType: string
  // The human-readable failure line the incident surface shows.
  errorMessage: string
  // Provider context passed through verbatim (phase, commit, capped logs, docs
  // URL). Same JSON-safe shape ErrorEvent.attributes carries.
  attributes?: ErrorEvent['attributes']
  // The graph node the failure implicates — already resolved by the connector's
  // resolveTarget through the fused-node lookup, so this lands on the extracted
  // node get_incident_history / get_root_cause query, never a twin.
  affectedNode: string
}

// Write one connector-sourced incident to the project's incident ledger
// (`errors.ndjson`) — the SAME store OTLP-derived incidents use, so
// get_incident_history / get_root_cause read it with no special-casing (ADR-185,
// connectors.md §10). The connectors plane has no mutation authority (ADR-030),
// so it calls this ingest.ts primitive rather than writing the ledger itself.
//
// A connector failure carries no OTel trace, but the ErrorEvent shape requires
// traceId/spanId. They are derived deterministically from the stable `id` so a
// re-poll of the same failure collapses on them the same way `dedupeIncidents`
// collapses on `id`, and two distinct failures never share a (traceId,
// affectedNode) group. errorType is always set, so the incident is never mistaken
// for a synthesized-HTTP echo and dropped.
export async function appendConnectorIncident(
  errorsPath: string,
  input: ConnectorIncidentInput,
  project?: string,
): Promise<void> {
  const ev: ErrorEvent = {
    id: input.id,
    timestamp: input.timestamp,
    service: input.service,
    traceId: input.id,
    spanId: input.id,
    errorType: input.errorType,
    errorMessage: input.errorMessage,
    ...(input.attributes && Object.keys(input.attributes).length > 0
      ? { attributes: input.attributes }
      : {}),
    affectedNode: input.affectedNode,
  }
  await fs.mkdir(path.dirname(errorsPath), { recursive: true })
  await fs.appendFile(errorsPath, JSON.stringify(ev) + '\n', 'utf8')
  // Push it onto the bus (ADR-221) exactly as the OTLP paths do, so a
  // connector-sourced failure reaches an agent's monitor too — same event, same
  // lean payload. Only when the caller threaded a project; a programmatic caller
  // that passes none still writes the ledger, it just doesn't push.
  if (project) emitIncidentEvent(project, ev)
}

// The node an incident is attributed to, plus a code locus RECOVERED from the
// stacktrace when the span carried no `code.*` attributes of its own. The
// recovered locus is set only on the stacktrace-fallback path (ADR-216); the
// incident builders synthesize it onto the record so `symbolLocus`, root-cause,
// and the incidents surface all read the declaring file:line the same way a span
// that stamped `code.*` already does.
interface IncidentLocus {
  affectedNode: string
  codeFilepath?: string
  codeLineno?: number
}

// Land a resolved runtime call site on the finest code node the graph carries —
// the SYMBOL the line falls inside, else its FileNode, else the honest raw
// service-relative file id. `trusted` distinguishes the two entry paths: a
// span's own `code.*` call site is authoritative and lands on the file id even
// when the graph has no matching node yet (the file:line is real, unchanged
// pre-ADR-216 behavior); a stacktrace-recovered frame is a heuristic join, so it
// attributes to code ONLY when it resolves to a FileNode the graph already
// holds, and otherwise recovers nothing (never fabricated). Returns null to mean
// "keep the service attribution".
function landIncidentCallSite(
  span: ParsedSpan,
  callSite: CallSite,
  trusted: boolean,
  graph?: NeatGraph,
): IncidentLocus | null {
  const relPath = graph
    ? reconcileObservedRelPath(graph, span.service, callSite.relPath)
    : callSite.relPath
  // Descend one grain finer to the SYMBOL the failure surfaced in — the same
  // span-containment resolution OBSERVED edges use (landObservedSymbol, ADR-158
  // §4) — so an in-process throw attributes to the function, not just its file
  // (ADR-191). Keyed on the fused service name so the symbol id matches the
  // statically-extracted symbol it fuses onto. Read-only (mint=false): it lands
  // on an existing static symbol whose span contains the line, and degrades to
  // the file honestly when no static symbol contains the line.
  const canonicalService = serviceNodeName(graph, span) ?? span.service
  const recovered = !trusted
  if (graph) {
    const fusedFileId = fileId(canonicalService, relPath)
    if (graph.hasNode(fusedFileId)) {
      const node = landObservedSymbol(
        graph,
        fusedFileId,
        canonicalService,
        relPath,
        { ...callSite, relPath },
        false,
      )
      return {
        affectedNode: node,
        ...(recovered
          ? {
              codeFilepath: relPath,
              ...(callSite.line !== undefined ? { codeLineno: callSite.line } : {}),
            }
          : {}),
      }
    }
    // A recovered frame that joins to no graph node is not attributed to code —
    // that would fabricate a locus the graph can't vouch for. The trusted
    // `code.*` path keeps its honest file id.
    if (recovered) return null
  }
  return { affectedNode: fileId(span.service, relPath) }
}

// The fused ServiceNode's canonical name, so a differently-cased or env-tagged
// `service.name` keys the same node the extractor minted (#880 / #988).
function serviceNodeName(graph: NeatGraph | undefined, span: ParsedSpan): string | undefined {
  if (!graph) return undefined
  const sid = resolveFusedServiceId(graph, span.service, span.env)
  if (!graph.hasNode(sid)) return undefined
  const node = graph.getNodeAttributes(sid) as ServiceNode
  return typeof node.name === 'string' ? node.name : undefined
}

// Recover a call site from the exception stacktrace's deepest application frame
// (ADR-216) — the fallback for a span that carries a stacktrace but no `code.*`
// attributes, the dominant shape of Python (and other) auto-instrumented
// exception spans. The frame's absolute deploy path runs through the same
// runtime-path → service-relative join a `code.*` call site uses, so it lands on
// the FileNode the extractor already minted. Returns null when the stacktrace
// names no application frame.
function stacktraceCallSite(
  span: ParsedSpan,
  serviceNode: ServiceNode | undefined,
  scanPath?: string,
): CallSite | null {
  const frame = deepestApplicationFrame(span.exception?.stacktrace)
  if (!frame) return null
  const relPath = relPathForRuntimeFile(frame.file, serviceNode, scanPath)
  if (!relPath) return null
  return { relPath, line: frame.line, ...(frame.fn ? { fn: frame.fn } : {}) }
}

// Resolve the incident's affectedNode (and any recovered code locus). When the
// span carries a `code.filepath` call site, the incident attributes to the
// FileNode/SymbolNode the failure surfaced in — the same file grain OBSERVED
// CALLS edges land on (file-awareness.md §4) — resolving a compiled `dist/…js`
// frame through its disk-adjacent source map when one is present. When the span
// carries no call site but does carry an exception stacktrace, the deepest
// application frame is parsed and run through the same runtime-path → graph-node
// join (ADR-216), so a stacktrace-only exception span (Python
// auto-instrumentation, the prime case) is attributed to code instead of
// degrading to the service. Without either, or when a recovered frame joins to
// no graph node, it stays at the originating service, the honest fallback (§2).
//
// The runtime paths are deploy-absolute (`/usr/src/app/…` in a container image,
// `/var/task/…` on Lambda) and need not match the daemon's checkout; when the
// graph is available they're reconciled onto the service-relative path the
// extractor already minted (reconcileObservedRelPath), so the incident lands on
// the ONE fused FileNode instead of a phantom keyed off the absolute path — the
// node root-cause actually walks.
function incidentLocus(
  span: ParsedSpan,
  graph?: NeatGraph,
  scanPath?: string,
): IncidentLocus {
  // Resolve onto the fused ServiceNode the same way handleSpan's edge upserts
  // do (ensureServiceNode / resolveFusedServiceId) — a case-insensitive,
  // env-ignoring match against the extracted node — so an errored span carrying
  // `deployment.environment` (or a differently-cased service.name) and no call
  // site attributes to the ONE `service:<name>` the graph holds, not a phantom
  // `service:<name>:<env>` twin that's absent from it, which get_incident_history
  // and get_root_cause then miss (#988). Without a graph (the ad-hoc receiver
  // surface, no fusion target) the honest raw serviceId stands.
  const sid = graph
    ? resolveFusedServiceId(graph, span.service, span.env)
    : serviceId(span.service, span.env)
  const serviceNode =
    graph && graph.hasNode(sid)
      ? (graph.getNodeAttributes(sid) as ServiceNode)
      : undefined

  const callSite = callSiteFromSpan(span, serviceNode, scanPath)
  if (callSite) {
    const landed = landIncidentCallSite(span, callSite, true, graph)
    if (landed) return landed
  } else {
    const recovered = stacktraceCallSite(span, serviceNode, scanPath)
    if (recovered) {
      const landed = landIncidentCallSite(span, recovered, false, graph)
      if (landed) return landed
    }
  }
  return { affectedNode: sid }
}

function incidentAffectedNode(
  span: ParsedSpan,
  graph?: NeatGraph,
  scanPath?: string,
): string {
  return incidentLocus(span, graph, scanPath).affectedNode
}

// Merge a stacktrace-recovered code locus onto an incident's attributes so the
// synthesized `code.filepath`/`code.lineno` ride the record the same way a
// span's own `code.*` would — `symbolLocus` (divergences.ts), root-cause, and
// the incidents surface all read them. A no-op when the span already carried
// `code.*` (locus.codeFilepath unset): the real attributes stand untouched.
function withRecoveredCodeAttrs(
  attrs: ReturnType<typeof sanitizeAttributes>,
  locus: IncidentLocus,
): ReturnType<typeof sanitizeAttributes> {
  if (locus.codeFilepath === undefined) return attrs
  attrs[CODE_FILEPATH_ATTR] = locus.codeFilepath
  if (locus.codeLineno !== undefined) attrs[CODE_LINENO_ATTR] = locus.codeLineno
  return attrs
}

// Build the minimal ErrorEvent the receiver writes synchronously before
// replying (ADR-033 §Error events, amended). affectedNode attributes to the
// FileNode when the span carries a `code.filepath` call site, else to the
// originating service (incidentAffectedNode above).
//
// errorMessage reads from the exception event's `exception.message` (OTel
// semconv) so the incident surface shows the actual thrown error string.
// When the span carries no exception event the field falls back to the HTTP
// context the span still holds — "500 on GET /users/:id" (httpFailureMessage)
// — and only then to the literal 'unknown error'. `span.name` is never in the
// chain: OTel HTTP server instrumentation routinely populates it with the HTTP
// method, which produces incidents that read 'GET' or 'POST' instead of the
// underlying failure. `span.status.message` is intentionally out for the same
// reason.
// Span attributes pass through verbatim so consumers can read source
// attribution (`code.filepath`, `code.lineno`, `code.function`) and other
// SDK-emitted context without ingest enumerating every key it cares about.
// Coerce span attributes to a JSON-safe shape — bigint values from the
// parsed span (long ids, high-cardinality counters) become strings so the
// passthrough record can be serialised to the ErrorEvent shape and round-
// tripped through ErrorEventSchema. All other types pass through verbatim.
function sanitizeAttributes(
  attrs: ParsedSpan['attributes'],
): Record<string, string | number | boolean | null | string[] | number[] | boolean[]> {
  const out: Record<string, string | number | boolean | null | string[] | number[] | boolean[]> = {}
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'bigint') out[k] = v.toString()
    else out[k] = v as string | number | boolean | null | string[] | number[] | boolean[]
  }
  return out
}

export function buildErrorEventForReceiver(
  span: ParsedSpan,
  graph?: NeatGraph,
  scanPath?: string,
): ErrorEvent | null {
  if (span.statusCode !== 2) return null
  const ts = span.startTimeIso ?? new Date().toISOString()
  const locus = incidentLocus(span, graph, scanPath)
  const attrs = withRecoveredCodeAttrs(sanitizeAttributes(span.attributes), locus)
  // #1118 — an ERROR-status span can also carry an HTTP response status: an
  // ingress/proxy (Envoy) returns a 504 with status=Error and the code in the
  // old-semconv `http.status_code` (a string). httpResponseStatus reads both
  // semconv keys and coerces the string, so surface it here — otherwise the 504
  // is dropped and the incident reads as a generic exception. incidentKindOf
  // reads httpStatusCode to classify a 5xx, and the #1114 boundary-timeout
  // classifier reads it to recognise a gateway timeout. Deliberately NOT tagging
  // errorType: the SERVER-5xx echo of a downstream failure is identified by an
  // absent errorType (isSynthesizedHttpIncident) so the trace-dedupe (#624) can
  // drop it — tagging it would defeat that collapse.
  const httpStatus = httpResponseStatus(span)
  return {
    id: `${span.traceId}:${span.spanId}`,
    timestamp: ts,
    service: span.service,
    traceId: span.traceId,
    spanId: span.spanId,
    errorMessage: incidentMessage(span),
    ...(span.exception?.type ? { exceptionType: span.exception.type } : {}),
    ...(span.exception?.stacktrace
      ? { exceptionStacktrace: span.exception.stacktrace }
      : {}),
    ...(httpStatus !== undefined ? { httpStatusCode: httpStatus } : {}),
    ...(Object.keys(attrs).length > 0 ? { attributes: attrs } : {}),
    affectedNode: locus.affectedNode,
  }
}

// Synchronous file-write helper bound to a receiver. The receiver awaits this
// before replying, so a write failure surfaces as 500 → OTel SDK retries.
export function makeErrorSpanWriter(
  errorsPath: string,
  graph?: NeatGraph,
  scanPath?: string,
  project: string = DEFAULT_PROJECT,
): (span: ParsedSpan) => Promise<void> {
  return async (span) => {
    const ev = buildErrorEventForReceiver(span, graph, scanPath)
    if (!ev) return
    await fs.mkdir(path.dirname(errorsPath), { recursive: true })
    await fs.appendFile(errorsPath, JSON.stringify(ev) + '\n', 'utf8')
    emitIncidentEvent(project, ev)
  }
}

// Write one failing-response incident (issue #481) to errors.ndjson. Used for
// an unambiguous 5xx (count 1) and for a flushed 4xx burst (count N). The
// dominant status code names the failure; `incidentCount` carries N so the
// incident surface shows "5× 404" without the per-span flood. Span attributes
// pass through verbatim, same as the statusCode === 2 path, so source
// attribution (`code.*`) and the response code survive to the consumer.
async function recordFailingResponseIncident(
  ctx: IngestContext,
  span: ParsedSpan,
  affectedNode: string,
  timestamp: string,
  statusCode: number,
  count: number,
  firstTimestamp?: string,
): Promise<void> {
  const attrs = sanitizeAttributes(span.attributes)
  const first = firstTimestamp ?? timestamp
  const peer = pickAddress(span)
  const message =
    count > 1
      ? `${count} consecutive HTTP ${statusCode} responses` +
        (peer ? ` to ${peer}` : '')
      : `HTTP ${statusCode} response` + (peer ? ` from ${peer}` : '')
  const ev: ErrorEvent = {
    id: `${span.traceId}:${span.spanId}`,
    timestamp,
    service: span.service,
    traceId: span.traceId,
    spanId: span.spanId,
    errorType: 'http-failure',
    errorMessage: message,
    ...(Object.keys(attrs).length > 0 ? { attributes: attrs } : {}),
    affectedNode,
    httpStatusCode: statusCode,
    incidentCount: count,
    firstTimestamp: first,
    lastTimestamp: timestamp,
  }
  await appendErrorEvent(ctx, ev)
}

// Record one incident for a span that carries an exception event but no ERROR
// status and no HTTP failure code — an async / queue / background worker
// (bullmq, Redis Streams, a scheduled task) whose job threw (ADR-117). Incident
// recording keys on the failure signal, not on HTTP context: the message
// follows the shared incidentMessage chain and the record attributes to the
// handler file:line when the span carries `code.filepath`, else to the
// originating service (incidentAffectedNode). handleSpan owns this write — the
// receiver's synchronous error-writer fires only for statusCode === 2, so an
// exception-only worker span reaches durability here, the same way the
// response-code incidents below do.
async function recordExceptionIncident(
  ctx: IngestContext,
  span: ParsedSpan,
  ts: string,
): Promise<void> {
  const locus = incidentLocus(span, ctx.graph, ctx.scanPath)
  const attrs = withRecoveredCodeAttrs(sanitizeAttributes(span.attributes), locus)
  const ev: ErrorEvent = {
    id: `${span.traceId}:${span.spanId}`,
    timestamp: ts,
    service: span.service,
    traceId: span.traceId,
    spanId: span.spanId,
    errorMessage: incidentMessage(span),
    ...(span.exception?.type ? { exceptionType: span.exception.type } : {}),
    ...(span.exception?.stacktrace
      ? { exceptionStacktrace: span.exception.stacktrace }
      : {}),
    ...(Object.keys(attrs).length > 0 ? { attributes: attrs } : {}),
    affectedNode: locus.affectedNode,
  }
  await appendErrorEvent(ctx, ev)
}

// Record one incident for a non-OK gRPC span (issue #1065). OTel's gRPC
// instrumentation leaves the span status UNSET and carries the outcome in
// `rpc.grpc.status_code` (0 = OK), so both the ERROR-status path and the HTTP
// response-code path above miss it — the dominant failure representation on a
// gRPC microservice stack, and the reason get_incident_history read empty over a
// service whose calls were all failing INTERNAL (13). Recorded immediately, the
// same as an unambiguous 5xx: gRPC has no numeric 4xx/5xx split to coalesce on,
// and the errorCount signal already counts every non-OK code, so the incident
// ledger agrees with it. The message names the canonical gRPC status
// (incidentMessage → nonHttpFailureMessage) and the raw `rpc.grpc.status_code`
// rides along in the passed-through attributes; attribution matches the
// exception path — the handler `file:line` when the span carries `code.filepath`,
// the failing service otherwise (incidentAffectedNode).
async function recordGrpcFailureIncident(
  ctx: IngestContext,
  span: ParsedSpan,
  ts: string,
): Promise<void> {
  const attrs = sanitizeAttributes(span.attributes)
  const ev: ErrorEvent = {
    id: `${span.traceId}:${span.spanId}`,
    timestamp: ts,
    service: span.service,
    traceId: span.traceId,
    spanId: span.spanId,
    errorType: 'grpc-failure',
    errorMessage: incidentMessage(span),
    ...(Object.keys(attrs).length > 0 ? { attributes: attrs } : {}),
    affectedNode: incidentAffectedNode(span, ctx.graph, ctx.scanPath),
  }
  await appendErrorEvent(ctx, ev)
}

// Advance the 4xx burst for this (source, peer) pair (issue #481). A burst
// accumulates silently; only when it crosses the threshold inside the window
// does it flush ONE coalesced incident. A 4xx that arrives more than windowMs
// after the previous one resets the burst — a slow trickle of probes never
// coalesces. The dominant code is the most frequent 4xx seen across the burst.
async function advance4xxBurst(
  ctx: IngestContext,
  span: ParsedSpan,
  affectedNode: string,
  ts: string,
  nowMs: number,
  status: number,
): Promise<void> {
  const { threshold, windowMs } = loadIncidentThresholdsFromEnv()
  if (!ctx.burstState) ctx.burstState = new Map()
  const peer = pickAddress(span) ?? span.spanId
  const key = `${span.service}->${peer}`
  const existing = ctx.burstState.get(key)
  let state: BurstState
  if (existing && nowMs - existing.lastMs <= windowMs) {
    existing.count += 1
    existing.lastTs = ts
    existing.lastMs = nowMs
    existing.codes.set(status, (existing.codes.get(status) ?? 0) + 1)
    state = existing
  } else {
    state = {
      count: 1,
      firstTs: ts,
      lastTs: ts,
      lastMs: nowMs,
      codes: new Map([[status, 1]]),
    }
    ctx.burstState.set(key, state)
  }

  if (state.count < threshold) return

  // Threshold met — flush one incident carrying the count, the dominant code,
  // and the burst's first/last timestamps, then clear the burst so the next
  // run of failures records its own incident rather than re-flushing every span.
  let dominant = status
  let max = 0
  for (const [code, n] of state.codes) {
    if (n > max) {
      max = n
      dominant = code
    }
  }
  await recordFailingResponseIncident(
    ctx,
    span,
    affectedNode,
    state.lastTs,
    dominant,
    state.count,
    state.firstTs,
  )
  ctx.burstState.delete(key)
}

// Next.js API-route serving spans name the matched route in `next.span_name`
// (mirrored on the span's own name), NOT in `http.route`: the Pages Router emits
// `executing api route (pages) /api/products/[productId]` and the App Router
// `executing api route (app) /api/products/[productId]`. That phrase carries the
// *templated* route — `[productId]` brackets and all — which is what fuses onto a
// declared RouteNode; the same request's `http.target` carries only the concrete
// path (`/api/products/L9ECAV7KIM`), which no param template ever matches. Pull
// the template out of that phrase so a Next route earns its OBSERVED twin the way
// an Express `http.route` already does (ADR-204). Returns undefined for any span
// without the phrase, so the caller falls back to `http.route` and every other
// framework fuses exactly as before — the source is additive, never a swap.
const NEXT_API_ROUTE_SPAN_NAME = /^executing api route \((?:pages|app)\) (\/\S*)$/

function nextApiRouteTemplate(span: ParsedSpan): string | undefined {
  const raw = pickAttr(span, 'next.span_name') ?? span.name
  const match = raw ? NEXT_API_ROUTE_SPAN_NAME.exec(raw) : null
  return match ? match[1] : undefined
}

// Match a SERVER span's `http.route` to the RouteNode the static extractor
// minted, by normalized (method, template) so param-syntax differences
// (`{id}` vs `:id` vs `<int:id>`) don't block the fusion. Returns the node id or
// undefined; an unmatched route mints nothing here — a route NEAT never extracted
// has no declared twin to fuse, and the served-but-undeclared case is a follow-on.
function findRouteNodeByHttpRoute(
  graph: NeatGraph,
  serviceName: string,
  method: string | undefined,
  httpRoute: string,
): string | undefined {
  const target = normalizePathTemplate(httpRoute)
  const m = method?.toUpperCase()
  let found: string | undefined
  graph.forEachNode((id, attrs) => {
    if (found) return
    const a = attrs as RouteNode & { type?: string }
    if (a.type !== NodeType.RouteNode || a.service !== serviceName) return
    if (m && a.method !== 'ALL' && a.method !== m) return
    if (normalizePathTemplate(a.pathTemplate) === target) found = id
  })
  return found
}

export async function handleSpan(ctx: IngestContext, span: ParsedSpan): Promise<void> {
  // lastObserved derives from the span's own startTime per ADR-033 — replayed
  // traces and out-of-order spans get a timestamp that reflects when the call
  // actually fired, not when the receiver received it. Wall-clock is only the
  // fallback for spans whose startTimeUnixNano is missing or unparseable.
  const ts = span.startTimeIso ?? nowIso(ctx)
  const nowMs = ctx.now ? ctx.now() : Date.now()
  // Env discriminator from `deployment.environment(.name)` (ADR-074 §2).
  // Older ParsedSpan producers may omit it — fall back to the literal
  // `'unknown'` so the env-less wire format is preserved on auto-creation.
  const env = span.env ?? 'unknown'
  // Issue #374 — spans whose resource omits `service.name` route to
  // `service:unidentified` in the URL-resolved project (the parser already
  // substitutes the fallback). One warning per project per session names
  // the project so an operator can fix the SDK config without grepping.
  if (span.resourceServiceNamePresent === false) {
    warnUnidentifiedSpan(ctx.project ?? DEFAULT_PROJECT)
  }
  // Auto-create a minimal ServiceNode for unseen span.service so OBSERVED
  // edges land instead of silently dropping. Static extraction merges richer
  // fields when it later finds the same id (ADR-033). The node is env-tagged
  // when the span carries an env signal.
  const sourceId = ensureServiceNode(ctx.graph, span.service, env)
  // Fires on the span's own ERROR status AND on the attribute forms most gRPC/HTTP
  // SDKs actually use — a non-OK gRPC status or an HTTP 5xx left on an UNSET span
  // (spanRecordsError, issue #1065). This is the sole feed for the edge's
  // errorCount signal, so the failing-CALLS chain get_root_cause walks now sees a
  // gRPC-based stack's failures instead of reading them as clean traffic.
  const isError = spanRecordsError(span)
  // Span duration in ms for the OBSERVED latency signal (ADR-190). Only a real,
  // positive duration is recorded; a span with missing/degenerate times
  // contributes no latency rather than a fabricated zero (file-awareness.md §6).
  // A streaming / long-lived span (WebSocket, SSE, a gRPC stream past the
  // duration ceiling) carries the stream's whole lifetime as its duration, not a
  // per-request latency, so it is withheld from the latency feed — the digest
  // stays a per-request p95 and the saturation classifier does not false-fire
  // (ADR-208). Every other signal on the span still records; `undefined` here
  // leaves any prior latency on the edge untouched, never cleared (upsertObservedEdge).
  const durationMs =
    span.durationNanos > 0n && !spanIsStreaming(span)
      ? Number(span.durationNanos) / 1e6
      : undefined

  // File-first OBSERVED origin (file-awareness.md §4). When the injected
  // SpanProcessor captured a call site on this outbound (CLIENT/PRODUCER) span,
  // the relationship originates from the file; without one it stays
  // service-level. `observedSource()` creates the FileNode + CONTAINS lazily so
  // they only land when an edge actually does — and never for the inbound
  // (SERVER) parent-fallback side, which carries no call site.
  const sourceServiceNode = ctx.graph.getNodeAttributes(sourceId) as ServiceNode
  const callSite = callSiteFromSpan(span, sourceServiceNode, ctx.scanPath)

  // Stash this span in the parent-span cache so any later child whose address
  // resolution misses can still resolve the cross-service edge via parentSpanId.
  // The call site rides along so the fallback edge anchors to this span's
  // file:line when this span turns out to be a parent (issue #536).
  cacheSpanService(span, nowMs, callSite)
  const observedSource = (): string =>
    callSite ? ensureObservedFileNode(ctx.graph, span.service, sourceId, callSite) : sourceId
  // Evidence for the OBSERVED edge — populated from the span's code.* semconv
  // when the call site resolved (file-awareness.md §4 + §6). Never fabricated:
  // absent call site → undefined evidence. The path is reconciled the same way
  // the edge's origin node is (reconcileObservedRelPath), so evidence.file names
  // the fused EXTRACTED path the edge lands on rather than the raw deployed
  // absolute path — otherwise the edge node and its own evidence disagree.
  const callSiteEvidence: { file: string; line?: number } | undefined = callSite
    ? {
        file: reconcileObservedRelPath(ctx.graph, span.service, callSite.relPath),
        ...(callSite.line !== undefined ? { line: callSite.line } : {}),
      }
    : undefined

  let affectedNode = sourceId

  // Only the caller/producer side of a call mints an OBSERVED edge directly
  // (issue #429). INTERNAL / SERVER / CONSUMER spans don't: a SERVER/CONSUMER
  // span is the callee, and its edge is minted from its parent via the
  // parent-span fallback below (left ungated). Gating here keeps INTERNAL
  // connection spans (`tcp.connect` / `tls.connect` with a peer address) from
  // minting spurious service-level edges.
  const mintsFromCallerSide = spanMintsObservedEdge(span.kind)

  if (span.dbSystem) {
    // Database span. A networked database resolves its DatabaseNode by peer
    // host; an in-process / embedded one (SQLite, better-sqlite3, an in-memory
    // store) crosses no network boundary and carries no peer address, so it
    // keys on a service-scoped local identity instead (ADR-118). Both mint the
    // same file-grained service→database CONNECTS_TO OBSERVED edge — the edge
    // that makes a leaf service's datastore reads legible (#576, #546).
    if (mintsFromCallerSide) {
      const host = pickAddress(span)
      // Engine comes off the OTel attribute as a string per Rule 8 — no
      // hardcoded engine list on either branch.
      let targetId: string
      if (host) {
        ensureDatabaseNode(ctx.graph, host, span.dbSystem)
        targetId = databaseId(host)
      } else {
        // No peer host. Prefer fusing onto the service's declared database of
        // the same engine (ADR-141) so an ORM's host-less span confirms the
        // static dependency instead of minting a divergent twin. Falls back to a
        // service-local node (ADR-118) for a genuinely embedded DB (SQLite) or an
        // ambiguous declaration. Name the local node by its logical database
        // (db.name) when the span carries one, the engine otherwise.
        const declared = findDeclaredDatabaseForService(ctx.graph, sourceId, span.dbSystem)
        if (declared) {
          targetId = declared
        } else {
          const localName = span.dbName ?? span.dbSystem
          targetId = ensureLocalDatabaseNode(
            ctx.graph,
            span.service,
            localName,
            span.dbSystem,
          )
        }
      }
      const result = upsertObservedEdge(
        ctx.graph,
        EdgeType.CONNECTS_TO,
        observedSource(),
        targetId,
        ts,
        isError,
        callSiteEvidence,
        durationMs,
      )
      if (result) affectedNode = targetId

      // ADR-148 — a mongodb span also names the collection it operated on, one
      // grain finer than the database node above. Mint an additive OBSERVED
      // CALLS edge to `infra:mongodb-collection:<name>` — the same node id the
      // mongoose extractor emits (ensureInfraNode + infraId match calls/index.ts
      // exactly) — so the declared and observed collection edges fuse instead of
      // twinning. The collection is read straight off the span (dbCollection:
      // db.collection.name / db.mongodb.collection), so it is ground truth where
      // the extractor's Mongoose-pluralized derivation is quirk-wrong. Additive:
      // a mongodb span with no collection still mints only the db-grain edge
      // above.
      if (span.dbSystem === 'mongodb' && span.dbCollection) {
        const collectionId = ensureInfraNode(ctx.graph, 'mongodb-collection', span.dbCollection, 'self')
        upsertObservedEdge(
          ctx.graph,
          EdgeType.CALLS,
          observedSource(),
          collectionId,
          ts,
          isError,
          callSiteEvidence,
          durationMs,
        )
      }
      // A SQL span's table (ADR-152), recovered from `db.statement` because the
      // SQLAlchemy / dbapi instrumentation carries no table attribute. It mints
      // onto the same `infra:sql-table:<name>` node the SQLAlchemy extractor
      // produces, so the declared and observed table access fuse rather than
      // twin. `db.statement`-derived, so it is ground truth where the extractor's
      // model→table derivation is unresolved; additive to the db-grain edge.
      if (span.dbTable) {
        const tableId = ensureInfraNode(ctx.graph, 'sql-table', span.dbTable, 'self')
        upsertObservedEdge(
          ctx.graph,
          EdgeType.CALLS,
          observedSource(),
          tableId,
          ts,
          isError,
          callSiteEvidence,
          durationMs,
        )
        // ADR-157 — the same `db.statement` that named the table also names the
        // columns it touched. Merge them onto the table node as OBSERVED column
        // attributes (parsed in `parseOtlpRequest` via `columnsFromSqlStatement`).
        // A statement that recovers no columns (`SELECT *`, a join/subquery
        // degrade) grows nothing.
        mergeObservedColumns(ctx.graph, tableId, span.dbColumns)
      }
    }
  } else if (
    span.messagingSystem &&
    span.messagingDestination &&
    spanMintsMessagingEdge(span.kind)
  ) {
    // Messaging span. The semantic destination is the topic / queue / stream the
    // code talks to — not the broker host, which is transport. A PRODUCER span
    // publishes; a CONSUMER span consumes. Both mint an OBSERVED edge to the same
    // destination node the static extractor names (extract/calls/kafka.ts), so
    // the declared and observed queue edges fuse into one (→ divergence) instead
    // of twinning. File-grained through the same call-site path as any other
    // OBSERVED edge (file-awareness.md §4): when the span carries `code.*`, the
    // edge originates from the caller's FileNode at the exact call site,
    // reconciled onto the EXTRACTED service-relative path (`reconcileObservedRelPath`,
    // ADR-118); without a call site it stays service-level, honestly. This is the
    // consumer-side pair of the producer edge — the queue topology the OBSERVED
    // layer used to leave dark on the consumer side (issue #614).
    const targetId = ensureMessagingDestinationNode(
      ctx.graph,
      span.messagingSystem,
      span.messagingDestination,
    )
    const edgeType =
      span.kind === WIRE_SPAN_KIND_CONSUMER
        ? EdgeType.CONSUMES_FROM
        : EdgeType.PUBLISHES_TO
    const result = upsertObservedEdge(
      ctx.graph,
      edgeType,
      observedSource(),
      targetId,
      ts,
      isError,
      callSiteEvidence,
      durationMs,
    )
    if (result) affectedNode = targetId
  } else if (
    span.graphqlOperationName &&
    span.graphqlOperationType &&
    spanServesGraphqlOperation(span.kind)
  ) {
    // GraphQL execution span (issue #615). Every GraphQL request rides one HTTP
    // endpoint (`POST /graphql`), so at HTTP grain the whole API collapses to a
    // single edge and the operation-level topology is invisible. The execution
    // span carries the operation the client actually named — `graphql.operation.name`
    // with `graphql.operation.type` — so mint an OBSERVED `CONTAINS` edge from the
    // serving service to a per-operation node, the same ownership shape a service
    // has over a route (ADR-119) and a file (file-awareness.md §2). OBSERVED-only:
    // the SDL / resolver map is not parsed statically in this cut; the node is
    // minted observed-first and a future static GraphQL extractor fuses onto the
    // same id (ADR-122). File-grained through the same call-site path as any other
    // OBSERVED edge (file-awareness.md §4): when the span carries `code.*` (the
    // resolver call site) the edge originates from that `FileNode` at the exact
    // `file:line`, reconciled onto the EXTRACTED service-relative path; without a
    // call site it stays service-level, honestly. Both operation name and type
    // must be present to key a stable id — a nameless/typeless execution span
    // falls through rather than minting a fabricated operation.
    const targetId = ensureGraphqlOperationNode(
      ctx.graph,
      span.service,
      span.graphqlOperationType,
      span.graphqlOperationName,
    )
    const result = upsertObservedEdge(
      ctx.graph,
      EdgeType.CONTAINS,
      observedSource(),
      targetId,
      ts,
      isError,
      callSiteEvidence,
      durationMs,
    )
    if (result) affectedNode = targetId
  } else if (
    span.rpcSystem === 'grpc' &&
    span.rpcService &&
    span.rpcMethod &&
    spanServesGrpcMethod(span.kind)
  ) {
    // gRPC execution span (issue #616). gRPC used to engage only at service
    // grain: every method collapsed onto one service→service edge, so the
    // per-method topology was invisible and one-sided. The serving span carries
    // the method the caller actually invoked — `rpc.service` (the fully-qualified
    // `orders.OrderService`) with `rpc.method` (`GetOrder`) — so mint an OBSERVED
    // `CONTAINS` edge from the serving service to a per-method node, the same
    // ownership shape a service has over a route (ADR-119), a GraphQL operation
    // (ADR-122), and a file (file-awareness.md §2). The node is keyed on the
    // fully-qualified `rpc.service` — the wire contract both the span and the
    // `.proto` carry verbatim — so the static `.proto` extractor's declared
    // method fuses onto this same id into a two-sided divergence (ADR-123).
    // File-grained through the same call-site path as any other OBSERVED edge
    // (file-awareness.md §4): when the span carries `code.*` (the handler call
    // site) the edge originates from that `FileNode` at the exact `file:line`,
    // reconciled onto the EXTRACTED service-relative path; without a call site it
    // stays service-level, honestly. The gate admits only the serving side —
    // SERVER / INTERNAL / unkinded — so a CLIENT span mints no ownership
    // (client→method attribution is deferred) and instead falls through to the
    // cross-service resolver, leaving the caller→callee edge intact. Both service
    // and method must be present to key a stable id.
    const targetId = ensureGrpcMethodNode(ctx.graph, span.rpcService, span.rpcMethod)
    const result = upsertObservedEdge(
      ctx.graph,
      EdgeType.CONTAINS,
      observedSource(),
      targetId,
      ts,
      isError,
      callSiteEvidence,
      durationMs,
    )
    if (result) affectedNode = targetId
  } else if (span.websocketChannel && spanServesWebsocketChannel(span.kind)) {
    // WebSocket upgrade span (issue #617). A WebSocket app used to produce no
    // OBSERVED topology at all: only message-handler errors surfaced, as
    // incidents, and the channels themselves stayed invisible — the frames after
    // the handshake ride the socket, not more spans. The one span that reliably
    // marks a channel is the HTTP upgrade that opens it: a SERVER `GET` carrying
    // `Upgrade: websocket` and the connection path. So mint an OBSERVED
    // `CONNECTS_TO` edge from the serving service to a per-channel node —
    // reusing the same connection edge a service has to a datastore (#576), not a
    // new edge type. Unlike the structural `CONTAINS` a service has over a route /
    // operation / method — durably declared artifacts whose edge never goes
    // stale — a channel's whole meaning is liveness, so `CONNECTS_TO` is the right
    // shape: it carries `lastObserved` and decays OBSERVED → STALE on
    // CONNECTS_TO's own threshold when the channel goes quiet (the daemon
    // staleness loop, #532). OBSERVED-only: a WebSocket channel is known from
    // observation, never from static extraction, so the node has no declared twin
    // and is excluded from `missing-extracted` (divergences.ts). File-grained
    // through the same call-site path as any other OBSERVED edge
    // (file-awareness.md §4): when the span carries `code.*` the edge originates
    // from that `FileNode` at the exact `file:line`, reconciled onto the EXTRACTED
    // service-relative path; without a call site it stays service-level, honestly.
    // The gate admits only the serving side — SERVER / INTERNAL / unkinded — so a
    // CLIENT upgrade span mints no channel (client→channel attribution is
    // deferred, ADR-125).
    const targetId = ensureWebsocketChannelNode(
      ctx.graph,
      span.service,
      span.websocketChannel,
    )
    const result = upsertObservedEdge(
      ctx.graph,
      EdgeType.CONNECTS_TO,
      observedSource(),
      targetId,
      ts,
      isError,
      callSiteEvidence,
      durationMs,
    )
    if (result) affectedNode = targetId
  } else {
    // Possibly a cross-service call. Resolve the peer; if it matches a known
    // ServiceNode, record an OBSERVED CALLS edge to the typed target. If it
    // matches nothing — pod IP, ingress hostname, AWS PrivateLink endpoint —
    // create a FrontierNode placeholder and record an OBSERVED edge to that
    // FrontierNode so the call carries the same provenance + signal-block +
    // graded confidence as any other OBSERVED edge (ADR-068). The target ref
    // identifies the node-type; provenance describes how the edge was learned.
    // promoteFrontierNodes (run by the extract orchestrator) rewrites the
    // target ref once a later round resolves the host; the edge's provenance
    // stays OBSERVED across promotion.
    // A loopback host (localhost / 127.0.0.0/8 / ::1) is skipped here: it never
    // resolves to a distinct peer, and minting frontier:localhost would double
    // the edge that the callee's parent-span fallback already records for this
    // same call (issues #590, #577). Leaving resolvedViaAddress false hands the
    // call to that fallback instead.
    const host = pickAddress(span)
    let resolvedViaAddress = false
    if (mintsFromCallerSide && host && host !== span.service && !isLoopbackHost(host)) {
      const targetId = resolveServiceId(ctx.graph, host, env)
      if (targetId && targetId !== sourceId) {
        upsertObservedEdge(
          ctx.graph,
          EdgeType.CALLS,
          observedSource(),
          targetId,
          ts,
          isError,
          callSiteEvidence,
          durationMs,
        )
        affectedNode = targetId
        resolvedViaAddress = true
      } else if (!targetId) {
        const frontierNodeId = ensureFrontierNode(ctx.graph, host, ts)
        upsertObservedEdge(
          ctx.graph,
          EdgeType.CALLS,
          observedSource(),
          frontierNodeId,
          ts,
          isError,
          callSiteEvidence,
          durationMs,
        )
        affectedNode = frontierNodeId
        resolvedViaAddress = true
      }
    }

    // Parent-span fallback (ADR-033): when address-based resolution didn't
    // produce an edge and the span has a parentSpanId we've cached, the
    // parent's service identifies the caller. The current span is the server
    // side of the call, so the edge direction is parent.service → current.
    // The cached entry carries the parent span's env, so the auto-created
    // parent ServiceNode lands on the env-tagged id the parent advertised.
    if (!resolvedViaAddress && span.parentSpanId) {
      const parent = lookupParentSpan(span.traceId, span.parentSpanId, nowMs)
      if (parent && parent.service !== span.service) {
        const parentId = ensureServiceNode(ctx.graph, parent.service, parent.env)
        // When the parent span carried a `code.*` call site, originate the edge
        // from the parent's FileNode so it anchors to file:line instead of the
        // bare parent ServiceNode (issue #536). Without a cached call site the
        // edge stays service-coarse — never fabricated (file-awareness.md §6).
        const fallbackSource = parent.callSite
          ? ensureObservedFileNode(ctx.graph, parent.service, parentId, parent.callSite)
          : parentId
        const fallbackEvidence: { file: string; line?: number } | undefined =
          parent.callSite
            ? {
                file: reconcileObservedRelPath(
                  ctx.graph,
                  parent.service,
                  parent.callSite.relPath,
                ),
                ...(parent.callSite.line !== undefined
                  ? { line: parent.callSite.line }
                  : {}),
              }
            : undefined
        upsertObservedEdge(
          ctx.graph,
          EdgeType.CALLS,
          fallbackSource,
          sourceId,
          ts,
          isError,
          fallbackEvidence,
          durationMs,
        )
      }
    }
  }

  // A SERVER span's route fuses onto the declared RouteNode, giving an inbound
  // route its OBSERVED twin the way GraphQL/gRPC serving spans do (#576). Matched
  // by normalized (method, template) so a route NEAT extracted gets its observed
  // counterpart; an unmatched route mints nothing here, honestly. Next.js names
  // the template in `next.span_name` rather than `http.route`, so prefer that
  // templated form over the concrete path when it's present (ADR-204); a span
  // carrying neither falls through with no edge, as before.
  const fusionRoute = nextApiRouteTemplate(span) ?? span.httpRoute
  if (
    fusionRoute &&
    (span.kind === 2 || span.kind === 1 || span.kind === 0 || span.kind === undefined)
  ) {
    const routeNodeId = findRouteNodeByHttpRoute(
      ctx.graph,
      span.service,
      span.httpMethod,
      fusionRoute,
    )
    if (routeNodeId) {
      const routeSvc = (ctx.graph.getNodeAttributes(routeNodeId) as RouteNode).service
      upsertObservedEdge(ctx.graph, EdgeType.CONTAINS, serviceId(routeSvc), routeNodeId, ts, isError, undefined, durationMs)
    }
  }

  if (span.statusCode === 2) {
    stitchTrace(ctx.graph, sourceId, ts)
    // The durable ErrorEvent write moved to the receiver so the file write
    // happens synchronously before the 200 reply (ADR-033 §Error events,
    // amended). watch.ts wires makeErrorSpanWriter into onErrorSpanSync.
    // handleSpan still runs the in-graph error effects (stitchTrace above);
    // it just doesn't append to errors.ndjson anymore. ctx.errorsPath stays
    // for the optional opt-in path below — daemon-less callers (CLI tests,
    // ad-hoc scripts) that skip the receiver hook still get a write here.
    if (ctx.writeErrorEventInline !== false) {
      // Daemon-less callers (CLI tests, ad-hoc scripts) that skip the receiver
      // hook get their write here — through the same builder the receiver uses
      // (buildErrorEventForReceiver), so the incident shape is one source of
      // truth: the source-based ADR-191/216 attribution and the #1118 HTTP-status
      // enrichment live in one place, not two drifting copies.
      const ev = buildErrorEventForReceiver(span, ctx.graph, ctx.scanPath)
      if (ev) await appendErrorEvent(ctx, ev)
    }
  }

  // Failing-response incidents (issue #481). OTel semconv leaves a CLIENT span's
  // status UNSET on a 4xx/5xx response, so the status-only path above is blind
  // to a service whose outbound calls are failing en masse — the exact gap a
  // debugging session hits (80× HTTP 404 against one peer surfacing nothing).
  // A response status is read from the span here regardless of statusCode:
  //   * 5xx → record an incident immediately (unambiguous failure, even with
  //     UNSET status). Skipped when statusCode === 2 already recorded above so
  //     a 5xx that also carries ERROR status isn't double-counted.
  //   * 4xx on a CLIENT/PRODUCER span → coalesce. The burst against this
  //     (source, peer) pair advances; when it reaches the threshold inside the
  //     window it records ONE incident carrying the count and dominant code.
  //   * a lone 4xx, or any 2xx/3xx → no incident.
  // Always written here (not gated on writeErrorEventInline): the daemon's
  // receiver only fires its synchronous error-writer for statusCode === 2, so
  // these spans never reach that durability handoff — handleSpan owns them.
  if (span.statusCode !== 2) {
    const status = httpResponseStatus(span)
    const grpcStatus = grpcStatusCodeFromAttrs(span.attributes)
    // ADR-117 — an exception event on a span that left its status UNSET is
    // still an unambiguous failure: a bullmq / Redis-Streams / background
    // worker whose job threw carries the exception and no HTTP response
    // context, so the status-only and response-code paths both miss it. Record
    // it independent of HTTP, attributed to the handler file:line (or the
    // service) the same way the statusCode === 2 path is. Ordered first because
    // the exception is the unambiguous signal; the response-code branches below
    // carry the exception-less HTTP failures.
    if (span.exception) {
      await recordExceptionIncident(ctx, span, ts)
    } else if (status !== undefined && status >= 500) {
      // A failing-response incident is attributed to the SOURCE service — the
      // caller whose outbound calls are failing is the node a debugger asks
      // about ("why is my service erroring"). The peer it failed against is
      // carried in the message and in attributes. This is deliberately not the
      // edge target (frontier/peer) the OBSERVED edge above resolved to: the
      // signal is "this service's calls to X are failing", not "X failed".
      await recordFailingResponseIncident(ctx, span, sourceId, ts, status, 1)
    } else if (grpcStatus !== undefined && grpcStatus !== 0) {
      // A non-OK gRPC status with UNSET span status (issue #1065) — the case the
      // HTTP branches above can't see. Record it immediately, mirroring the 5xx
      // path. The branches are mutually exclusive in practice (a span is a gRPC
      // call or an HTTP one, not both), and the else-if chain records at most one
      // incident per span, so this never double-counts against the 4xx-burst path
      // below (a pure gRPC span carries no HTTP status to reach it anyway).
      await recordGrpcFailureIncident(ctx, span, ts)
    } else if (
      status !== undefined &&
      status >= 400 &&
      spanMintsObservedEdge(span.kind)
    ) {
      await advance4xxBurst(ctx, span, sourceId, ts, nowMs, status)
    }
  }
  void affectedNode

  // Post-ingest policy trigger (ADR-043). The hook is awaited so failures
  // surface; daemons wrap it in a try/catch that logs without throwing.
  if (ctx.onPolicyTrigger) await ctx.onPolicyTrigger(ctx.graph)
}

export { stitchTrace }

// Promote any frontier:<host> placeholder whose host matches an alias on a
// real ServiceNode: re-link inbound/outbound edges to the service, then drop
// the placeholder. Returns the count of nodes promoted, for tests + logs.
//
// Called at the end of every extraction round. Static rounds are when new
// aliases land (compose names, k8s metadata.name, Dockerfile labels), so
// running it there picks up the case the issue describes: ingest fills in a
// frontier when traffic arrives for an unknown host, and the next extraction
// round resolves it.
// Optional gate for block-action policies (ADR-044). When `policies` is
// non-empty, each candidate FrontierNode runs through `canPromoteFrontier`
// before its incident edges are rewired. Block-action policies that fire on
// the frontier veto the promotion — the FrontierNode persists; the next
// extract pass tries again.
export interface PromoteFrontierOptions {
  policies?: Policy[]
  policyCtx?: PolicyEvaluationContext
}

export function promoteFrontierNodes(
  graph: NeatGraph,
  opts: PromoteFrontierOptions = {},
): number {
  const aliasIndex = new Map<string, string>()
  graph.forEachNode((id, attrs) => {
    const a = attrs as ServiceNode & { type?: string }
    if (a.type !== NodeType.ServiceNode) return
    aliasIndex.set(a.name, id)
    if (a.aliases) {
      for (const alias of a.aliases) aliasIndex.set(alias, id)
    }
  })

  const toPromote: { frontierId: string; serviceId: string }[] = []
  graph.forEachNode((id, attrs) => {
    const a = attrs as FrontierNode & { type?: string }
    if (a.type !== NodeType.FrontierNode) return
    const target = aliasIndex.get(a.host)
    if (!target) return
    if (target === id) return
    toPromote.push({ frontierId: id, serviceId: target })
  })

  let promoted = 0
  for (const { frontierId, serviceId } of toPromote) {
    if (opts.policies && opts.policies.length > 0 && opts.policyCtx) {
      const gate = canPromoteFrontier(graph, frontierId, opts.policies, opts.policyCtx)
      if (!gate.allowed) {
        // Block-action policy fired on this frontier — skip the rewire and
        // leave the FrontierNode in place. Violations already surfaced via
        // the policy log on the same evaluation pass.
        continue
      }
    }
    rewireFrontierEdges(graph, frontierId, serviceId)
    graph.dropNode(frontierId)
    promoted++
  }
  return promoted
}

function rewireFrontierEdges(graph: NeatGraph, frontierId: string, serviceId: string): void {
  const inbound = [...graph.inboundEdges(frontierId)]
  const outbound = [...graph.outboundEdges(frontierId)]

  for (const edgeId of inbound) {
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    rebuildEdge(graph, edge, edge.source, serviceId, edgeId)
  }
  for (const edgeId of outbound) {
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    rebuildEdge(graph, edge, serviceId, edge.target, edgeId)
  }
}

function rebuildEdge(
  graph: NeatGraph,
  edge: GraphEdge,
  newSource: string,
  newTarget: string,
  oldEdgeId: string,
): void {
  graph.dropEdge(oldEdgeId)
  // ADR-068 — promotion rewrites the target ref; provenance carries forward.
  // An OBSERVED edge to a FrontierNode promotes to an OBSERVED edge to the
  // matched typed node; an INFERRED edge stays INFERRED; etc.
  const newId =
    edge.provenance === Provenance.OBSERVED
      ? observedEdgeId(newSource, newTarget, edge.type)
      : edge.provenance === Provenance.INFERRED
        ? inferredEdgeId(newSource, newTarget, edge.type)
        : extractedEdgeId(newSource, newTarget, edge.type)

  if (graph.hasEdge(newId)) {
    const existing = graph.getEdgeAttributes(newId) as GraphEdge
    const merged: GraphEdge = {
      ...existing,
      callCount: (existing.callCount ?? 0) + (edge.callCount ?? 0),
      lastObserved: pickLater(existing.lastObserved, edge.lastObserved),
    }
    graph.replaceEdgeAttributes(newId, merged)
    return
  }

  const rebuilt: GraphEdge = {
    ...edge,
    id: newId,
    source: newSource,
    target: newTarget,
  }
  graph.addEdgeWithKey(newId, newSource, newTarget, rebuilt)
}

function pickLater(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b
  if (!b) return a
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b
}

export function makeSpanHandler(ctx: IngestContext): (span: ParsedSpan) => Promise<void> {
  return (span) => handleSpan(ctx, span)
}

export type { StaleEvent }

export interface MarkStaleOptions {
  // Per-edge-type override map. Defaults to DEFAULT_STALE_THRESHOLDS, merged
  // with NEAT_STALE_THRESHOLDS if the env var is set.
  thresholds?: Record<string, number>
  now?: number
  // ndjson path. When set, every OBSERVED → STALE transition appends one
  // line. Skipped if undefined — tests and embedded use cases don't need a
  // log.
  staleEventsPath?: string
  // Project tag for event-bus routing (ADR-051). Defaults to DEFAULT_PROJECT.
  project?: string
}

// Demote OBSERVED edges that haven't been seen in a while. Per-edge-type
// thresholds: HTTP CALLS go stale fast; infra DEPENDS_ON is patient. Returns
// the count of demotions and the events appended to the log.
export async function markStaleEdges(
  graph: NeatGraph,
  options: MarkStaleOptions = {},
): Promise<{ count: number; events: StaleEvent[] }> {
  const thresholds = options.thresholds ?? loadStaleThresholdsFromEnv()
  const now = options.now ?? Date.now()
  const events: StaleEvent[] = []

  const project = options.project ?? DEFAULT_PROJECT
  graph.forEachEdge((id, attrs) => {
    const e = attrs as GraphEdge
    if (e.provenance !== Provenance.OBSERVED) return
    if (!e.lastObserved) return
    const threshold = thresholdForEdgeType(e.type, thresholds)
    const age = now - new Date(e.lastObserved).getTime()
    if (age > threshold) {
      const updated: GraphEdge = { ...e, provenance: Provenance.STALE, confidence: 0.3 }
      graph.replaceEdgeAttributes(id, updated)
      events.push({
        edgeId: id,
        source: e.source,
        target: e.target,
        edgeType: e.type,
        thresholdMs: threshold,
        ageMs: age,
        lastObserved: e.lastObserved,
        transitionedAt: new Date(now).toISOString(),
      })
      // Stale-transition fires through the bus (ADR-051). The graph
      // subscription in events.ts can't see the OBSERVED→STALE semantic on
      // its own — a provenance flip is just an attribute update from
      // graphology's view.
      emitNeatEvent({
        type: 'stale-transition',
        project,
        payload: {
          edgeId: id,
          from: Provenance.OBSERVED,
          to: Provenance.STALE,
        },
      })
    }
  })

  if (options.staleEventsPath && events.length > 0) {
    await appendStaleEvents(options.staleEventsPath, events)
  }

  return { count: events.length, events }
}

async function appendStaleEvents(staleEventsPath: string, events: StaleEvent[]): Promise<void> {
  await fs.mkdir(path.dirname(staleEventsPath), { recursive: true })
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await fs.appendFile(staleEventsPath, lines, 'utf8')
}

export async function readStaleEvents(staleEventsPath: string): Promise<StaleEvent[]> {
  try {
    const raw = await fs.readFile(staleEventsPath, 'utf8')
    return raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as StaleEvent)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

export interface StalenessLoopOptions {
  thresholds?: Record<string, number>
  intervalMs?: number
  staleEventsPath?: string
  // Project tag for event-bus routing (ADR-051).
  project?: string
  // Post-stale-transition policy trigger (ADR-043). Fires after each tick of
  // markStaleEdges so policies see the new STALE state. Daemons wire this to
  // evaluateAllPolicies + PolicyViolationsLog.append.
  onPolicyTrigger?: (graph: NeatGraph) => Promise<void> | void
}

export function startStalenessLoop(
  graph: NeatGraph,
  options: StalenessLoopOptions = {},
): () => void {
  let stopped = false
  const intervalMs = options.intervalMs ?? 60_000
  const tick = (): void => {
    if (stopped) return
    void (async () => {
      try {
        await markStaleEdges(graph, {
          thresholds: options.thresholds,
          staleEventsPath: options.staleEventsPath,
          project: options.project,
        })
        if (options.onPolicyTrigger) await options.onPolicyTrigger(graph)
      } catch (err) {
        console.error('staleness tick failed', err)
      }
    })()
  }
  const interval = setInterval(tick, intervalMs)
  if (typeof interval.unref === 'function') interval.unref()
  return () => {
    stopped = true
    clearInterval(interval)
  }
}

// errors.ndjson is append-only and unbounded, so on a long-running daemon with
// a busy erroring service it grows without limit. Reading the whole file into
// one utf8 string then throws `RangeError: Invalid string length` once it crosses
// V8's ~2^29-char ceiling, which took down every incident-backed query
// (get_incident_history / get_root_cause / ask) with a 500 (#1083). Two bounds
// keep the read safe regardless of store size: never pull more than this many
// bytes into a string, and never return more than INCIDENT_READ_MAX_EVENTS
// parsed incidents. The newest incidents sit at the tail of the append-only file
// and are the ones every consumer wants, so when the file is larger than the
// byte budget we tail-read the most recent slice instead of the whole thing.
const INCIDENT_READ_MAX_BYTES = 32 * 1024 * 1024

// Hard ceiling on how many incidents a single read hands back. Bounds both memory
// and the size of any response built from the result, well under the string ceiling
// even with large per-incident stacktraces. A caller can ask for fewer via `limit`.
export const INCIDENT_READ_MAX_EVENTS = 5000

// Read at most `maxBytes` from the end of the file. When the file is larger than
// the budget the first line in the window is almost certainly a partial record
// (we cut mid-line), so drop everything up to and including the first newline —
// every remaining line is whole, and the writer always terminates records with a
// newline so the tail never ends mid-record.
async function readErrorFileTail(errorsPath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(errorsPath, 'r')
  try {
    const { size } = await handle.stat()
    if (size <= maxBytes) {
      return (await handle.readFile()).toString('utf8')
    }
    const buf = Buffer.alloc(maxBytes)
    await handle.read(buf, 0, maxBytes, size - maxBytes)
    const raw = buf.toString('utf8')
    const firstNewline = raw.indexOf('\n')
    return firstNewline === -1 ? '' : raw.slice(firstNewline + 1)
  } finally {
    await handle.close()
  }
}

export async function readErrorEvents(
  errorsPath: string,
  opts?: { limit?: number },
): Promise<ErrorEvent[]> {
  let raw: string
  try {
    raw = await readErrorFileTail(errorsPath, INCIDENT_READ_MAX_BYTES)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const events = raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ErrorEvent)
  const deduped = dedupeIncidents(events)
  const cap =
    opts?.limit !== undefined && opts.limit > 0
      ? Math.min(opts.limit, INCIDENT_READ_MAX_EVENTS)
      : INCIDENT_READ_MAX_EVENTS
  // Keep the most-recent `cap`. dedupeIncidents preserves append order, so the
  // tail is newest.
  return deduped.length > cap ? deduped.slice(deduped.length - cap) : deduped
}

// A synthesized HTTP-status incident carries no failure of its own — it's the
// "500 on GET /users/:id" line handleSpan mints for a server span that answered
// 5xx with no exception event of its own (httpFailureMessage). When the real
// failure surfaced deeper in the same trace (a DB driver threw, a downstream
// gRPC returned UNAVAILABLE), that exception is recorded as its own incident on
// the same node, and the server's HTTP echo is a duplicate of it. A record is
// "synthesized HTTP" when it carries no exception data, no explicit errorType
// (the coalesced http-failure incidents set one and carry their own count), and
// its message is exactly the HTTP line re-derived from its own attributes.
function isSynthesizedHttpIncident(ev: ErrorEvent): boolean {
  if (ev.exceptionType || ev.exceptionStacktrace) return false
  if (ev.errorType) return false
  if (!ev.attributes) return false
  const synth = httpFailureMessageFromAttrs(ev.attributes)
  return synth !== undefined && synth === ev.errorMessage
}

// Make the incident surface idempotent per failure. Two passes:
//
// Pass 1 — collapse exact `(traceId, spanId)` re-deliveries. The ndjson sidecar
// is append-only (persistence contract), so a re-delivered span — OTel
// BatchSpanProcessor retries, or a receiver + handler both writing one POST —
// leaves duplicate lines on disk. The deterministic incident `id` already
// encodes the pair (`${traceId}:${spanId}`); we dedupe on it directly, falling
// back to the raw pair for any record that predates the id. Records that carry
// neither (extract parse-failure rows, `source: 'extract'`) pass through
// untouched — they aren't span incidents. First write wins so the original
// timestamp is preserved.
//
// Pass 2 — collapse one failure recorded from two spans of the same trace. A
// failing request lands one incident from the span that actually threw (the DB
// child's exception, a downstream gRPC error) and a second, synthesized one from
// the HTTP server span that echoed it as a 5xx. Both key to the same
// `(traceId, affectedNode)`; the exact-id pass can't see it because the spanIds
// differ. When a real failure shares a trace and node with a synthesized HTTP
// echo, drop the echo so the request counts once (issue #624). A cross-service
// failure keeps both sides: the caller's failing-response incident and the
// callee's exception land on different `affectedNode`s (separate ledgers per the
// otel-ingest contract), so they never share a group.
function dedupeIncidents(events: ErrorEvent[]): ErrorEvent[] {
  const seen = new Set<string>()
  const once: ErrorEvent[] = []
  for (const ev of events) {
    const key =
      ev.id ??
      (ev.traceId && ev.spanId ? `${ev.traceId}:${ev.spanId}` : undefined)
    if (key === undefined) {
      once.push(ev)
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    once.push(ev)
  }

  const groupKey = (ev: ErrorEvent): string => `${ev.traceId}\u0000${ev.affectedNode}`
  const hasRealFailure = new Set<string>()
  for (const ev of once) {
    if (ev.traceId && !isSynthesizedHttpIncident(ev)) hasRealFailure.add(groupKey(ev))
  }
  return once.filter((ev) => {
    if (!ev.traceId || !isSynthesizedHttpIncident(ev)) return true
    return !hasRealFailure.has(groupKey(ev))
  })
}

// ──────────────────────────────────────────────────────────────────────────
// Snapshot merge (ADR-074 §1)
//
// `neat sync` (local) and `neat sync --to <url>` (remote) feed snapshots into
// a live graph through this helper. It lives in ingest.ts because mutation
// authority sits with ingest + extract per the lifecycle contract (ADR-030);
// the merge is ingestion of an external snapshot, no different in shape from
// the way handleSpan ingests an OTel span.
//
// The merge preserves EXTRACTED + OBSERVED coexistence per Rule 2 — each
// provenance variant has its own edge id, so the incoming EXTRACTED edges
// can't stomp the daemon's accumulated OBSERVED edges and vice versa. Rule of
// thumb: incoming wins for nodes/edges the live graph hasn't seen yet;
// everything already present keeps its current attributes.
// ──────────────────────────────────────────────────────────────────────────

export interface MergeSnapshotResult {
  nodesAdded: number
  edgesAdded: number
}

// A pushed snapshot is untrusted input — it can arrive from `neat sync --to`
// against a daemon the operator doesn't fully control, or from anything else
// that can reach the `/snapshot` route. Before #693, every entry's
// `attributes` went straight from `JSON.parse` to `graph.addNode` /
// `graph.addEdgeWithKey` with only a schemaVersion check upstream in api.ts —
// a malformed or hostile payload (wrong `type` literal, missing required
// field, wrong field type) landed on the live graph as-is. This error
// collects every entry that fails `GraphNodeSchema` / `GraphEdgeSchema` — the
// same canonical shapes the rest of the API validates responses against
// (packages/types) — so the caller gets back exactly what was wrong instead
// of a generic parse failure or, worse, a silently corrupted graph.
export class SnapshotValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`snapshot failed validation (${issues.length} invalid ${issues.length === 1 ? 'entry' : 'entries'})`)
    this.name = 'SnapshotValidationError'
  }
}

function describeZodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ')
}

export function mergeSnapshot(
  graph: NeatGraph,
  snapshot: PersistedGraph,
): MergeSnapshotResult {
  const exported = snapshot.graph as {
    nodes?: Array<{ key: string; attributes?: unknown }>
    edges?: Array<{ key?: string; source: string; target: string; attributes?: unknown }>
  }
  const incomingNodes = Array.isArray(exported.nodes) ? exported.nodes : []
  const incomingEdges = Array.isArray(exported.edges) ? exported.edges : []

  // Validate everything up front and merge nothing until every entry checks
  // out — a snapshot that's partly hostile or partly corrupt is rejected
  // whole rather than landing its valid entries and silently dropping the
  // rest (matching how the schemaVersion check upstream already treats a
  // bad snapshot as all-or-nothing).
  const issues: string[] = []
  const validNodes: Array<{ key: string; attributes: GraphNode }> = []
  const validEdges: Array<{ key: string; source: string; target: string; attributes: GraphEdge }> = []

  for (const node of incomingNodes) {
    // No attributes at all is a no-op skip, not a malformed entry — mirrors
    // the pre-#693 behaviour for this specific (empty) shape.
    if (node.attributes === undefined) continue
    const parsed = GraphNodeSchema.safeParse(node.attributes)
    if (!parsed.success) {
      issues.push(`node "${node.key}": ${describeZodIssues(parsed.error)}`)
      continue
    }
    validNodes.push({ key: node.key, attributes: parsed.data })
  }

  for (const edge of incomingEdges) {
    if (edge.attributes === undefined) continue
    const parsed = GraphEdgeSchema.safeParse(edge.attributes)
    if (!parsed.success) {
      const label = edge.key ?? `${edge.source}->${edge.target}`
      issues.push(`edge "${label}": ${describeZodIssues(parsed.error)}`)
      continue
    }
    const id = edge.key ?? parsed.data.id
    validEdges.push({ key: id, source: edge.source, target: edge.target, attributes: parsed.data })
  }

  if (issues.length > 0) {
    throw new SnapshotValidationError(issues)
  }

  let nodesAdded = 0
  let edgesAdded = 0

  for (const node of validNodes) {
    if (graph.hasNode(node.key)) continue
    graph.addNode(node.key, node.attributes)
    nodesAdded++
  }

  for (const edge of validEdges) {
    if (graph.hasEdge(edge.key)) continue
    // Skip when either endpoint is missing — can happen if the snapshot
    // names a node the live graph already evicted and the incoming nodes
    // array didn't include.
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue
    graph.addEdgeWithKey(edge.key, edge.source, edge.target, edge.attributes)
    edgesAdded++
  }

  return { nodesAdded, edgesAdded }
}
