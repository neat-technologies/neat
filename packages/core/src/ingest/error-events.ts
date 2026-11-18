import { storeRuntimeIncident } from '../incident-retry.js'
import type {
  ErrorEvent,
  ServiceNode,
} from '@neat.is/types'
import {
  ENV_UNKNOWN,
  fileId,
  incidentKindOf,
  serviceId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import { DEFAULT_PROJECT } from '../graph.js'
import type { ParsedSpan } from '../otel.js'
import { emitNeatEvent } from '../events.js'
import { deepestApplicationFrame } from '../stacktrace.js'
import { sanitizeAttributes } from '../credential-scrub.js'
import {
  CODE_FILEPATH_ATTR,
  CODE_LINENO_ATTR,
} from '../otel-code-attrs.js'
import {
  type CallSite,
  callSiteFromSpan,
  landObservedSymbol,
  reconcileObservedRelPath,
  relPathForRuntimeFile,
} from './call-site.js'
import { type BurstState, type IngestContext, type SpanIngest } from './context.js'
import { resolveFusedServiceId } from './service.js'
import {
  grpcStatusCodeFromAttrs,
  httpResponseStatus,
  incidentMessage,
  pickAddress,
  spanMintsObservedEdge,
} from './span.js'
import { stitchTrace } from './edges.js'

// Error events and runtime incidents: the errors.ndjson ledger, incident
// attribution, and the failing-response, exception, gRPC and 4xx-burst paths
// (ADR-033 §Error events).
// Moved out of ingest.ts; ingest.ts re-exports the public names.

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
export const DEFAULT_INCIDENT_THRESHOLDS = {
  threshold: 5,
  windowMs: 60_000,
}

export function loadIncidentThresholdsFromEnv(): { threshold: number; windowMs: number } {
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

// Announce a freshly-recorded incident on the event bus (ADR-221). A lean
// trigger — the affected node, service, and kind — that wakes `neat monitor`;
// the full incident card is a REST read (GET /graph/incident-card/:nodeId). The
// monitor dedupes on the incident id, so a stray double-emit is harmless. Fired
// from every incident write path that knows its project: the OTel paths (this
// one, plus the receiver's synchronous writer for status-error spans) and
// connector incidents (ADR-185) through appendConnectorIncident, which threads
// the project from its poll caller.
export function emitIncidentEvent(project: string, ev: ErrorEvent): void {
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

// Never throws: a sink failure holds the incident for retry (incident-retry.ts,
// #1678), and the bus event fires once it is stored.
export async function appendErrorEvent(ctx: IngestContext, ev: ErrorEvent): Promise<void> {
  const project = ctx.project ?? DEFAULT_PROJECT
  await storeRuntimeIncident(ctx.errorsPath, project, ev, (stored) => emitIncidentEvent(project, stored))
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
  // Never throws (#1678): a sink failure holds the incident for retry, so the
  // poll that found it keeps applying its other signals and its cursor advances.
  // Once stored it goes onto the bus (ADR-221) exactly as the OTLP paths do, so a
  // connector-sourced failure reaches an agent's monitor too. Only when the caller
  // threaded a project; a programmatic caller that passes none still writes the
  // ledger, it just doesn't push.
  await storeRuntimeIncident(errorsPath, project ?? DEFAULT_PROJECT, ev, (stored) => {
    if (project) emitIncidentEvent(project, stored)
  })
}

// The node an incident is attributed to, plus a code locus RECOVERED from the
// stacktrace when the span carried no `code.*` attributes of its own. The
// recovered locus is set only on the stacktrace-fallback path (ADR-216); the
// incident builders synthesize it onto the record so `symbolLocus`, root-cause,
// and the incidents surface all read the declaring file:line the same way a span
// that stamped `code.*` already does.
export interface IncidentLocus {
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
export function landIncidentCallSite(
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
export function serviceNodeName(graph: NeatGraph | undefined, span: ParsedSpan): string | undefined {
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
export function stacktraceCallSite(
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
export function incidentLocus(
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

export function incidentAffectedNode(
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
export function withRecoveredCodeAttrs(
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
    ...incidentEnv(span),
  }
}

// The receiver's error-span writer. The receiver awaits it before replying, but a
// sink failure no longer fails the batch (#1678): the incident is held for retry
// and counted, and the batch is accepted.
export function makeErrorSpanWriter(
  errorsPath: string,
  graph?: NeatGraph,
  scanPath?: string,
  project: string = DEFAULT_PROJECT,
): (span: ParsedSpan) => Promise<void> {
  return async (span) => {
    const ev = buildErrorEventForReceiver(span, graph, scanPath)
    if (!ev) return
    await storeRuntimeIncident(errorsPath, project, ev, (stored) => emitIncidentEvent(project, stored))
  }
}

// Write one failing-response incident (issue #481) to errors.ndjson. Used for
// an unambiguous 5xx (count 1) and for a flushed 4xx burst (count N). The
// dominant status code names the failure; `incidentCount` carries N so the
// incident surface shows "5× 404" without the per-span flood. Span attributes
// pass through verbatim, same as the statusCode === 2 path, so source

// The incident's environment (ADR-280 decision 2): the span's, already normalised
// at parse. Left off for `unknown`, the way every incident before ADR-280 reads.
function incidentEnv(span: ParsedSpan): { env?: string } {
  return span.env && span.env !== ENV_UNKNOWN ? { env: span.env } : {}
}

// attribution (`code.*`) and the response code survive to the consumer.
export async function recordFailingResponseIncident(
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
    ...incidentEnv(span),
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
export async function recordExceptionIncident(
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
    ...incidentEnv(span),
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
export async function recordGrpcFailureIncident(
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
    ...incidentEnv(span),
  }
  await appendErrorEvent(ctx, ev)
}

// Advance the 4xx burst for this (source, peer) pair (issue #481). A burst
// accumulates silently; only when it crosses the threshold inside the window
// does it flush ONE coalesced incident. A 4xx that arrives more than windowMs
// after the previous one resets the burst — a slow trickle of probes never
// coalesces. The dominant code is the most frequent 4xx seen across the burst.
export async function advance4xxBurst(
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
  // The environment is part of the burst (ADR-280): staging's 4xx run and
  // production's are two bursts, never one coalesced incident.
  const key = `${span.service}@${span.env}->${peer}`
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

// The span's in-graph error effects and its incident records.
export async function recordSpanErrors(s: SpanIngest): Promise<void> {
  const { ctx, span, ts, nowMs, sourceId } = s
  if (span.statusCode === 2) {
    stitchTrace(ctx.graph, sourceId, ts, span.env)
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
}
