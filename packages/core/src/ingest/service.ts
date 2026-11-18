import { isIP } from 'node:net'
import type {
  FrontierNode,
  InfraNode,
  ServiceNode,
} from '@neat.is/types'
import {
  NodeType,
  frontierId,
  infraId,
  serviceId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import type { ParsedSpan } from '../otel.js'
import { type CallSite } from './call-site.js'

// Service, infra and frontier nodes, peer-host resolution, and the parent-span
// cache that backs the cross-service fallback (ADR-033, ADR-068).
// Moved out of ingest.ts; ingest.ts re-exports the public names.

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
export const PARENT_SPAN_CACHE_SIZE = 10_000

export const PARENT_SPAN_CACHE_TTL_MS = 5 * 60 * 1000

export interface ParentSpanCacheEntry {
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

export const parentSpanCache = new Map<string, ParentSpanCacheEntry>()

export function parentSpanKey(traceId: string, spanId: string): string {
  return `${traceId}:${spanId}`
}

export function cacheSpanService(span: ParsedSpan, now: number, callSite: CallSite | null): void {
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

export function lookupParentSpan(
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
export function resolveServiceId(
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

// The service a bare-IP peer address belongs to, read off the OBSERVED addresses
// the k8s substrate stamped on ServiceNodes (ADR-248). A client span that dials a
// Service by its ClusterIP names the callee only as that IP; this is the one
// lookup ingest makes before it mints a frontier for it. A hostname never takes
// this path, and an address on more than one service resolves to none.
export function serviceIdForObservedAddress(graph: NeatGraph, host: string): string | null {
  if (isIP(host) === 0) return null
  let found: string | null = null
  let ambiguous = false
  graph.forEachNode((id, attrs) => {
    if (ambiguous) return
    const a = attrs as ServiceNode & { type?: string }
    if (a.type !== NodeType.ServiceNode || !a.observedAddresses?.includes(host)) return
    if (found !== null && found !== id) ambiguous = true
    else found = id
  })
  return ambiguous ? null : found
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
// first the extracted node at the env-less id, then the exact `(name, env)` id,
// then a case-insensitive `name` match against a statically extracted (non-otel)
// ServiceNode, ignoring env. Environment is a dimension of the evidence, not part
// of a code node's identity (ADR-280 decision 1): a service static extraction
// knows is one node whatever environments run it, and the environment rides on
// the edges and incidents. An env-tagged twin an older daemon minted beside an
// extracted service of the same name never wins; the snapshot migration folds
// such twins on load.
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
  // Fast paths, so a span on a known service does not scan the graph. The env-less
  // id is the extracted node itself when its name matches exactly; with no
  // environment, the exact id is the node a span has always fused onto.
  const bare = serviceId(serviceName)
  if (graph.hasNode(bare) && (graph.getNodeAttributes(bare) as ServiceNode).discoveredVia !== 'otel') return bare
  // An env-tagged node that exists is an OTel-only service in that environment
  // (an extracted service with this exact name was returned above). A twin beside
  // a differently-cased extracted service is left to the snapshot migration.
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

export function ensureFrontierNode(graph: NeatGraph, host: string, ts: string): string {
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
