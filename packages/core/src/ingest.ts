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
  Policy,
  ServiceNode,
  StaleEvent,
} from '@neat.is/types'
import type { PersistedGraph } from './persist.js'
import type { EvaluationContext as PolicyEvaluationContext } from './policy.js'
import { canPromoteFrontier } from './policy.js'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForObservedSignal,
  databaseId,
  extractedEdgeId,
  fileId,
  frontierId,
  inferredEdgeId,
  observedEdgeId,
  serviceId,
  type EdgeTypeValue,
} from '@neat.is/types'
import type { NeatGraph } from './graph.js'
import { DEFAULT_PROJECT } from './graph.js'
import type { ParsedSpan } from './otel.js'
import { emitNeatEvent } from './events.js'

// Maps OTel spans to graph signal:
//   * Cross-service span → upsert CALLS edge.
//   * Database span (db.system attr present) → upsert CONNECTS_TO edge to a
//     DatabaseNode resolved by host.
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
// The injected SpanProcessor sets `code.filepath` / `code.lineno` /
// `code.function` on CLIENT/PRODUCER spans — the exact OTel attribute names,
// written by the emit template (installers/templates.ts) and read here. The
// two sites are cross-referenced so the names can't drift. When present, an
// OBSERVED relationship originates from the file rather than the service.
// SERVER spans and the callee side carry no call site and stay service-level;
// evidence is never fabricated (§6).
const CODE_FILEPATH_ATTR = 'code.filepath'
const CODE_LINENO_ATTR = 'code.lineno'
const CODE_FUNCTION_ATTR = 'code.function'

function toPosix(p: string): string {
  return p.split('\\').join('/')
}

function languageForExt(relPath: string): string | undefined {
  const dot = relPath.lastIndexOf('.')
  if (dot === -1) return undefined
  switch (relPath.slice(dot).toLowerCase()) {
    case '.py':
      return 'python'
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

interface CallSite {
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
    const pos = entry.consumer.originalPositionFor({
      line: line !== undefined && Number.isFinite(line) ? line : 1,
      column: 0,
    })
    if (!pos || !pos.source) return null
    const root = entry.consumer.sourceRoot ?? ''
    const resolved = path.resolve(entry.dir, root, pos.source)
    return { filepath: resolved, ...(pos.line ? { line: pos.line } : {}) }
  } catch {
    return null
  }
}

// Read the call-site attributes off a span. Returns null when the span carries
// no `code.filepath` (SERVER spans, un-instrumented peers, callee side) so the
// caller falls back to a service-level edge.
function callSiteFromSpan(
  span: ParsedSpan,
  serviceNode?: ServiceNode,
  scanPath?: string,
): CallSite | null {
  const filepath = span.attributes[CODE_FILEPATH_ATTR]
  if (typeof filepath !== 'string' || filepath.length === 0) return null
  const linenoRaw = span.attributes[CODE_LINENO_ATTR]
  let line =
    typeof linenoRaw === 'number' && Number.isFinite(linenoRaw) ? linenoRaw : undefined
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
  // (file-awareness.md §4 + §6, issue #430).
  if (!resolved && abs.endsWith('.js') && relPath.startsWith('dist/') && serviceNode?.name) {
    warnNoSourceMaps(serviceNode.name)
  }
  const fnRaw = span.attributes[CODE_FUNCTION_ATTR]
  const fn = typeof fnRaw === 'string' && fnRaw.length > 0 ? fnRaw : undefined
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
function reconcileObservedRelPath(
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
function ensureObservedFileNode(
  graph: NeatGraph,
  serviceName: string,
  serviceNodeId: string,
  callSite: CallSite,
): string {
  const relPath = reconcileObservedRelPath(graph, serviceName, callSite.relPath)
  const fileNodeId = fileId(serviceName, relPath)
  if (!graph.hasNode(fileNodeId)) {
    const language = languageForExt(relPath)
    const node: FileNode = {
      id: fileNodeId,
      type: NodeType.FileNode,
      service: serviceName,
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

// An OBSERVED edge originates from the caller/producer side of a call. CLIENT
// and PRODUCER spans are that side; INTERNAL / SERVER / CONSUMER are not — a
// SERVER span is the callee, and its edge is minted from its parent CLIENT via
// the parent-span fallback (the mirror image of CLIENT+SERVER, and of
// PRODUCER+CONSUMER for queues). Without this gate every INTERNAL span that
// happens to carry a peer address — e.g. a `tcp.connect` / `tls.connect` to an
// AWS endpoint — mints a spurious service-level edge (issue #429), because no
// §4 capture layer stamps `code.*` on INTERNAL spans.
//
// A span that reports no kind (undefined) or UNSPECIFIED (0) carries no
// caller/callee signal, so it falls back to the historical unconditional
// behavior — hand-built and legacy producers keep minting. The leak this gates
// is always an explicitly-kinded INTERNAL span.
function spanMintsObservedEdge(kind: number | undefined): boolean {
  if (kind === undefined || kind === 0) return true
  return kind === WIRE_SPAN_KIND_CLIENT || kind === WIRE_SPAN_KIND_PRODUCER
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
function ensureServiceNode(
  graph: NeatGraph,
  serviceName: string,
  env: string,
): string {
  const id = serviceId(serviceName, env)
  if (graph.hasNode(id)) return id
  const node: ServiceNode = {
    id,
    type: NodeType.ServiceNode,
    name: serviceName,
    language: 'unknown',
    discoveredVia: 'otel',
    ...(env !== 'unknown' ? { env } : {}),
  }
  graph.addNode(id, node)
  return id
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

interface UpsertResult {
  edge: GraphEdge
  created: boolean
}

function upsertObservedEdge(
  graph: NeatGraph,
  type: EdgeTypeValue,
  source: string,
  target: string,
  ts: string,
  isError = false,
  evidence?: { file: string; line?: number },
): UpsertResult | null {
  if (!graph.hasNode(source) || !graph.hasNode(target)) return null

  const id = makeObservedEdgeId(type, source, target)
  if (graph.hasEdge(id)) {
    const existing = graph.getEdgeAttributes(id) as GraphEdge
    const newSpanCount = (existing.signal?.spanCount ?? existing.callCount ?? 0) + 1
    const newErrorCount = (existing.signal?.errorCount ?? 0) + (isError ? 1 : 0)
    const newSignal = {
      spanCount: newSpanCount,
      errorCount: newErrorCount,
      lastObservedAgeMs: 0,
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
    }
    graph.replaceEdgeAttributes(id, updated)
    return { edge: updated, created: false }
  }

  const signal = {
    spanCount: 1,
    errorCount: isError ? 1 : 0,
    lastObservedAgeMs: 0,
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

async function appendErrorEvent(ctx: IngestContext, ev: ErrorEvent): Promise<void> {
  await fs.mkdir(path.dirname(ctx.errorsPath), { recursive: true })
  await fs.appendFile(ctx.errorsPath, JSON.stringify(ev) + '\n', 'utf8')
}

// Resolve the incident's affectedNode. When the span carries a `code.filepath`
// call site, the incident attributes to the FileNode the failure surfaced in —
// the same file grain OBSERVED CALLS edges land on (file-awareness.md §4) —
// resolving a compiled `dist/...js` frame through its disk-adjacent source map
// when one is present. Without a call site it stays at the originating service,
// the honest fallback (§2).
//
// The runtime `code.filepath` is a deploy-absolute path (`/var/task/...` on
// Lambda, `/app/...` in a container image) that need not match the daemon's
// checkout. When the graph is available it's reconciled onto the service-
// relative path the extractor already minted (reconcileObservedRelPath, the
// same trailing-suffix match the OBSERVED edge origin uses), so the incident
// lands on the ONE fused FileNode instead of a phantom keyed off the absolute
// path — the node root-cause actually walks. Without a graph the honest runtime
// path stands: the file node may not be materialised yet, but querying the
// service still surfaces the incident, and the file:line is real (§6 — never
// fabricated).
function incidentAffectedNode(
  span: ParsedSpan,
  graph?: NeatGraph,
  scanPath?: string,
): string {
  const sid = serviceId(span.service, span.env)
  const serviceNode =
    graph && graph.hasNode(sid)
      ? (graph.getNodeAttributes(sid) as ServiceNode)
      : undefined
  const callSite = callSiteFromSpan(span, serviceNode, scanPath)
  if (callSite) {
    const relPath = graph
      ? reconcileObservedRelPath(graph, span.service, callSite.relPath)
      : callSite.relPath
    return fileId(span.service, relPath)
  }
  return sid
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
  const attrs = sanitizeAttributes(span.attributes)
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
    ...(Object.keys(attrs).length > 0 ? { attributes: attrs } : {}),
    affectedNode: incidentAffectedNode(span, graph, scanPath),
  }
}

// Synchronous file-write helper bound to a receiver. The receiver awaits this
// before replying, so a write failure surfaces as 500 → OTel SDK retries.
export function makeErrorSpanWriter(
  errorsPath: string,
  graph?: NeatGraph,
  scanPath?: string,
): (span: ParsedSpan) => Promise<void> {
  return async (span) => {
    const ev = buildErrorEventForReceiver(span, graph, scanPath)
    if (!ev) return
    await fs.mkdir(path.dirname(errorsPath), { recursive: true })
    await fs.appendFile(errorsPath, JSON.stringify(ev) + '\n', 'utf8')
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
  const isError = span.statusCode === 2

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
    // Database span — try to resolve the DatabaseNode by host.
    const host = pickAddress(span)
    if (mintsFromCallerSide && host) {
      // Auto-create a minimal DatabaseNode when this host hasn't been seen.
      // Engine comes off the OTel attribute as a string per Rule 8.
      ensureDatabaseNode(ctx.graph, host, span.dbSystem)
      const targetId = databaseId(host)
      const result = upsertObservedEdge(
        ctx.graph,
        EdgeType.CONNECTS_TO,
        observedSource(),
        targetId,
        ts,
        isError,
        callSiteEvidence,
      )
      if (result) affectedNode = targetId
    }
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
        )
      }
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
      const attrs = sanitizeAttributes(span.attributes)
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
        affectedNode,
      }
      await appendErrorEvent(ctx, ev)
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
    // A failing-response incident is attributed to the SOURCE service — the
    // caller whose outbound calls are failing is the node a debugger asks
    // about ("why is my service erroring"). The peer it failed against is
    // carried in the message and in attributes. This is deliberately not the
    // edge target (frontier/peer) the OBSERVED edge above resolved to: the
    // signal is "this service's calls to X are failing", not "X failed".
    if (status !== undefined && status >= 500) {
      await recordFailingResponseIncident(ctx, span, sourceId, ts, status, 1)
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

export async function readErrorEvents(errorsPath: string): Promise<ErrorEvent[]> {
  try {
    const raw = await fs.readFile(errorsPath, 'utf8')
    const events = raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ErrorEvent)
    return dedupeIncidents(events)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
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

  const groupKey = (ev: ErrorEvent): string => `${ev.traceId} ${ev.affectedNode}`
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

export function mergeSnapshot(
  graph: NeatGraph,
  snapshot: PersistedGraph,
): MergeSnapshotResult {
  const exported = snapshot.graph as {
    nodes?: Array<{ key: string; attributes?: GraphNode }>
    edges?: Array<{ key?: string; source: string; target: string; attributes?: GraphEdge }>
  }

  let nodesAdded = 0
  let edgesAdded = 0

  for (const node of exported.nodes ?? []) {
    if (graph.hasNode(node.key)) continue
    if (!node.attributes) continue
    graph.addNode(node.key, node.attributes)
    nodesAdded++
  }

  for (const edge of exported.edges ?? []) {
    const attrs = edge.attributes
    if (!attrs) continue
    const id = edge.key ?? attrs.id
    if (!id) continue
    if (graph.hasEdge(id)) continue
    // Skip when either endpoint is missing — can happen if the snapshot
    // names a node the live graph already evicted and the incoming nodes
    // array didn't include.
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue
    graph.addEdgeWithKey(id, edge.source, edge.target, attrs)
    edgesAdded++
  }

  return { nodesAdded, edgesAdded }
}
