import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  DatabaseNode,
  ErrorEvent,
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

function nowIso(ctx: IngestContext): string {
  return new Date(ctx.now ? ctx.now() : Date.now()).toISOString()
}

function pickAttr(span: ParsedSpan, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = span.attributes[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
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
  expiresAt: number
}

const parentSpanCache = new Map<string, ParentSpanCacheEntry>()

function parentSpanKey(traceId: string, spanId: string): string {
  return `${traceId}:${spanId}`
}

function cacheSpanService(span: ParsedSpan, now: number): void {
  if (!span.traceId || !span.spanId) return
  const key = parentSpanKey(span.traceId, span.spanId)
  // Map preserves insertion order, so deleting + re-inserting bumps an entry to
  // the back. Eviction is "drop oldest" once size exceeds the cap.
  parentSpanCache.delete(key)
  parentSpanCache.set(key, {
    service: span.service,
    env: span.env ?? 'unknown',
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
): { service: string; env: string } | null {
  const entry = parentSpanCache.get(parentSpanKey(traceId, parentSpanId))
  if (!entry) return null
  if (entry.expiresAt <= now) {
    parentSpanCache.delete(parentSpanKey(traceId, parentSpanId))
    return null
  }
  return { service: entry.service, env: entry.env }
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

// Build the minimal ErrorEvent the receiver writes synchronously before
// replying (ADR-033 §Error events, amended). affectedNode resolves to the
// originating service because graph state isn't available at this point —
// the queued handleSpan path may reach a more precise target later, but the
// durable record is what the receiver writes here.
//
// errorMessage reads from the exception event's `exception.message` (OTel
// semconv) so the incident surface shows the actual thrown error string.
// When the span carries no exception event the field falls back to the
// literal 'unknown error' rather than `span.name` — OTel HTTP server
// instrumentation routinely populates `span.name` with the HTTP method,
// which produces incidents that read 'GET' or 'POST' instead of the
// underlying failure. `span.status.message` is intentionally out of the
// chain for the same reason.
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

export function buildErrorEventForReceiver(span: ParsedSpan): ErrorEvent | null {
  if (span.statusCode !== 2) return null
  const ts = span.startTimeIso ?? new Date().toISOString()
  const attrs = sanitizeAttributes(span.attributes)
  return {
    id: `${span.traceId}:${span.spanId}`,
    timestamp: ts,
    service: span.service,
    traceId: span.traceId,
    spanId: span.spanId,
    errorMessage: span.exception?.message ?? 'unknown error',
    ...(span.exception?.type ? { exceptionType: span.exception.type } : {}),
    ...(span.exception?.stacktrace
      ? { exceptionStacktrace: span.exception.stacktrace }
      : {}),
    ...(Object.keys(attrs).length > 0 ? { attributes: attrs } : {}),
    affectedNode: serviceId(span.service, span.env),
  }
}

// Synchronous file-write helper bound to a receiver. The receiver awaits this
// before replying, so a write failure surfaces as 500 → OTel SDK retries.
export function makeErrorSpanWriter(
  errorsPath: string,
): (span: ParsedSpan) => Promise<void> {
  return async (span) => {
    const ev = buildErrorEventForReceiver(span)
    if (!ev) return
    await fs.mkdir(path.dirname(errorsPath), { recursive: true })
    await fs.appendFile(errorsPath, JSON.stringify(ev) + '\n', 'utf8')
  }
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
  // Auto-create a minimal ServiceNode for unseen span.service so OBSERVED
  // edges land instead of silently dropping. Static extraction merges richer
  // fields when it later finds the same id (ADR-033). The node is env-tagged
  // when the span carries an env signal.
  const sourceId = ensureServiceNode(ctx.graph, span.service, env)
  const isError = span.statusCode === 2
  // Stash this span in the parent-span cache so any later child whose address
  // resolution misses can still resolve the cross-service edge via parentSpanId.
  cacheSpanService(span, nowMs)

  let affectedNode = sourceId

  if (span.dbSystem) {
    // Database span — try to resolve the DatabaseNode by host.
    const host = pickAddress(span)
    if (host) {
      // Auto-create a minimal DatabaseNode when this host hasn't been seen.
      // Engine comes off the OTel attribute as a string per Rule 8.
      ensureDatabaseNode(ctx.graph, host, span.dbSystem)
      const targetId = databaseId(host)
      const result = upsertObservedEdge(
        ctx.graph,
        EdgeType.CONNECTS_TO,
        sourceId,
        targetId,
        ts,
        isError,
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
    const host = pickAddress(span)
    let resolvedViaAddress = false
    if (host && host !== span.service) {
      const targetId = resolveServiceId(ctx.graph, host, env)
      if (targetId && targetId !== sourceId) {
        upsertObservedEdge(
          ctx.graph,
          EdgeType.CALLS,
          sourceId,
          targetId,
          ts,
          isError,
        )
        affectedNode = targetId
        resolvedViaAddress = true
      } else if (!targetId) {
        const frontierNodeId = ensureFrontierNode(ctx.graph, host, ts)
        upsertObservedEdge(
          ctx.graph,
          EdgeType.CALLS,
          sourceId,
          frontierNodeId,
          ts,
          isError,
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
        upsertObservedEdge(
          ctx.graph,
          EdgeType.CALLS,
          parentId,
          sourceId,
          ts,
          isError,
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
        errorMessage: span.exception?.message ?? 'unknown error',
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
    return raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ErrorEvent)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
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
