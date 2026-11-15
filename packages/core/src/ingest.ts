import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  ErrorEvent,
  FrontierNode,
  GraphEdge,
  GraphNode,
  InfraNode,
  Policy,
  ServiceNode,
  StaleEvent,
} from '@neat.is/types'
import type { PersistedGraph } from './persist.js'
import type { EvaluationContext as PolicyEvaluationContext } from './policy.js'
import { canPromoteFrontier } from './policy.js'
import {
  GraphEdgeSchema,
  GraphNodeSchema,
  NodeType,
  Provenance,
  extractedEdgeId,
  inferredEdgeId,
  infraId,
  observedEdgeId,
  frontierEdgeId,
  type EdgeTypeValue,
  type FlagDefinition,
  type DeployContext,
  type ObservedDeployContext,
} from '@neat.is/types'
import { invalidateSourceBaseline } from './extract/source-baseline.js'
import { FLAG_STORE_KIND, foldObservedFlags } from './flags.js'
import type { NeatGraph } from './graph.js'
import { DEFAULT_PROJECT } from './graph.js'
import type { ParsedSpan } from './otel.js'
import { emitNeatEvent } from './events.js'
import { scrubIncidentEvent } from './credential-scrub.js'
import { type IngestContext, nowIso, type SpanIngest } from './ingest/context.js'
import { ingestDatabaseSpan } from './ingest/database.js'
import { ingestMessagingSpan } from './ingest/messaging.js'
import {
  ingestGraphqlOperationSpan,
  ingestGrpcMethodSpan,
  ingestWebsocketChannelSpan,
} from './ingest/serving.js'
import { ingestPeerSpan } from './ingest/peer.js'
import { ingestServerRoute } from './ingest/route.js'
import { recordSpanErrors } from './ingest/error-events.js'
import { recordSpanFlagEvaluations } from './ingest/flag-evaluations.js'
import {
  httpFailureMessageFromAttrs,
  spanMintsMessagingEdge,
  spanMintsObservedEdge,
  spanRecordsError,
  spanServesGraphqlOperation,
  spanServesGrpcMethod,
  spanServesWebsocketChannel,
  spanStreams,
} from './ingest/span.js'
import {
  callSiteFromSpan,
  ensureObservedFileNode,
  reconcileObservedRelPath,
} from './ingest/call-site.js'
import { edgeErrorDetailFromSpan, stitchTrace } from './ingest/edges.js'
import {
  cacheSpanService,
  ensureServiceNode,
  serviceIdForObservedAddress,
} from './ingest/service.js'

// Span-ingest helpers live under ingest/; these names stay importable from ingest.js.
export { type IngestContext } from './ingest/context.js'
export { spanIsStreaming, spanStreams } from './ingest/span.js'
export {
  type CallSite,
  ensureObservedFileNode,
  reconcileObservedRelPath,
  resetNoSourceMapWarnings,
} from './ingest/call-site.js'
export { EDGE_ERROR_MESSAGE_MAX, upsertObservedEdge, type UpsertResult } from './ingest/edges.js'
export {
  ensureInfraNode,
  ensureServiceNode,
  frontierIdFor,
  resetParentSpanCache,
  resolveFusedServiceId,
  serviceIdForObservedAddress,
} from './ingest/service.js'
export { mergeDeclaredColumns, mergeObservedColumns } from './ingest/table-column.js'
export {
  appendConnectorIncident,
  buildErrorEventForReceiver,
  type ConnectorIncidentInput,
  makeErrorSpanWriter,
} from './ingest/error-events.js'

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
// The code.* readers live in otel-code-attrs.ts; re-exported here so existing
// imports from ingest.js keep working.
export { codeFilepathOf, codeLinenoOf, codeFunctionOf } from './otel-code-attrs.js'

// Merge the observed k8s deploy state — the container image the cluster's pods
// actually run and the count of ready replicas — onto a `service:<name>` node as
// OBSERVED (ADR-225). The observed half of the k8s deployment substrate: the
// manifest extractor stamps `declaredImage`/`declaredReplicas` on this same node,
// and the compare between the two names a `deploy-mismatch` divergence — the stuck
// rollout that mints no incident because the service is still up on the old image.
// Node attributes carry provenance in the name (`observed*` vs `declared*`), so
// this is a plain attribute merge, not an edge; it never clobbers the declared
// side. A no-op when the service node isn't in the graph yet, the same honest
// missing-target discipline the connector pipeline holds.
export function mergeObservedDeployState(
  graph: NeatGraph,
  serviceNodeId: string,
  state: { image?: string; readyReplicas?: number; addresses?: string[] },
): void {
  if (!graph.hasNode(serviceNodeId)) return
  const attrs: Record<string, unknown> = {}
  if (typeof state.image === 'string' && state.image.length > 0) attrs['observedImage'] = state.image
  if (typeof state.readyReplicas === 'number') attrs['observedReadyReplicas'] = state.readyReplicas
  // Addresses are replaced whole by each read (ADR-248): a Service that went away
  // takes its address with it. Absent means the substrate didn't read them this
  // time, so the last read stands.
  if (Array.isArray(state.addresses)) {
    if (state.addresses.length > 0) attrs['observedAddresses'] = [...state.addresses].sort()
    else if ((graph.getNodeAttributes(serviceNodeId) as { observedAddresses?: unknown }).observedAddresses !== undefined) {
      graph.removeNodeAttribute(serviceNodeId, 'observedAddresses' as never)
    }
  }
  if (Object.keys(attrs).length === 0) return
  graph.mergeNodeAttributes(serviceNodeId, attrs)
}

// Stamp a live infrastructure object's spec onto its InfraNode as OBSERVED
// `observedSpec` (#1481) — a k8s Service's selector, ports and traffic policies,
// a Deployment's container ports. Replaced whole by each read, so a field the
// object dropped goes with it; the namespace rides beside it, as the manifest
// extractor records it. A no-op when the node isn't in the graph.
export function mergeObservedInfraSpec(
  graph: NeatGraph,
  nodeId: string,
  state: { namespace?: string; spec: Record<string, unknown> },
): void {
  if (!graph.hasNode(nodeId)) return
  const attrs: Record<string, unknown> = { observedSpec: state.spec }
  const current = graph.getNodeAttributes(nodeId) as { namespace?: string }
  if (state.namespace && current.namespace === undefined) attrs['namespace'] = state.namespace
  graph.mergeNodeAttributes(nodeId, attrs)
}

// Clear `observedSpec` off the InfraNodes of one kind whose object a full read no
// longer returned (#1484): a deleted NetworkPolicy or quota stops reading as
// live. Scoped to the read's namespace (or, for a cluster-scoped kind, to nodes
// with none), so one namespace's read never clears another's. The node stays —
// a manifest may still declare it — only the observed spec goes.
export function retireObservedInfraSpecs(
  graph: NeatGraph,
  inventory: { kind: string; provider: string; namespace?: string; present: string[] },
): void {
  const present = new Set(inventory.present)
  const stale: string[] = []
  graph.forEachNode((id, attrs) => {
    const n = attrs as { type?: string; kind?: string; provider?: string; name?: string; namespace?: string; observedSpec?: unknown }
    if (n.type !== NodeType.InfraNode || n.kind !== inventory.kind || n.provider !== inventory.provider) return
    if (n.observedSpec === undefined || present.has(n.name ?? '')) return
    if ((n.namespace ?? undefined) !== inventory.namespace) return
    stale.push(id)
  })
  for (const id of stale) graph.removeNodeAttribute(id, 'observedSpec' as never)
}

// Fuse a faulted workload's deploy/process/config context onto its node as OBSERVED
// (ADR-243, amending ADR-237/240). The one copy: the incident card, `neat incidents`
// and MCP read it from here, never from the incident. Tagged with the incident it
// was observed with, so a card shows it only for that incident; a newer fault on the
// same workload replaces it. Already redacted and bounded upstream
// (process-context.ts). A no-op when the node isn't in the graph.
export function mergeObservedDeployContext(
  graph: NeatGraph,
  nodeId: string,
  incidentId: string,
  observedAt: string,
  context: DeployContext,
): void {
  if (!graph.hasNode(nodeId)) return
  if (Object.keys(context).length === 0) return
  const value: ObservedDeployContext = { ...context, incidentId, observedAt }
  graph.mergeNodeAttributes(nodeId, { observedDeployContext: value })
}

// Merge what a flag store is serving onto its flag grain as OBSERVED (ADR-242).
// The store's sync reader calls in each poll with the full served set. Only a flag
// the code base declares takes the observed definition; a served flag with no
// committed twin mints nothing and comes back in `undeclared` for the reader's
// poll status. A no-op (everything undeclared) when the store node isn't in the
// graph, because then nothing declares a flag yet.
export function mergeObservedFlags(
  graph: NeatGraph,
  provider: string,
  served: ReadonlyMap<string, FlagDefinition>,
  at: string,
): { undeclared: string[] } {
  const storeId = infraId(FLAG_STORE_KIND, provider)
  if (!graph.hasNode(storeId)) return { undeclared: [...served.keys()].sort() }
  const node = graph.getNodeAttributes(storeId) as InfraNode
  const { flags, undeclared } = foldObservedFlags(node.flags, served, at)
  graph.mergeNodeAttributes(storeId, { flags })
  return { undeclared }
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
    span.durationNanos > 0n && !spanStreams(ctx.graph, span)
      ? Number(span.durationNanos) / 1e6
      : undefined
  // The bounded last-error exemplar's detail (ADR-236). Resolved once from the
  // span's exception event + HTTP status and passed into every OBSERVED edge
  // minted on this span's error path, so a failing edge carries WHAT failed —
  // the real span exception type/message — not just an error count. Only built
  // on a failing span; a clean span passes `undefined` and never disturbs a
  // prior exemplar. The ledger still records the full exception independently
  // (§Error events); this is the edge-level complement, not a replacement.
  const errorDetail = isError ? edgeErrorDetailFromSpan(span) : undefined

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

  // Only the caller/producer side of a call mints an OBSERVED edge directly
  // (issue #429). INTERNAL / SERVER / CONSUMER spans don't: a SERVER/CONSUMER
  // span is the callee, and its edge is minted from its parent via the
  // parent-span fallback below (left ungated). Gating here keeps INTERNAL
  // connection spans (`tcp.connect` / `tls.connect` with a peer address) from
  // minting spurious service-level edges.
  const mintsFromCallerSide = spanMintsObservedEdge(span.kind)

  // Everything a per-concern handler reads off this span, computed once above.
  const s: SpanIngest = {
    ctx,
    span,
    ts,
    nowMs,
    env,
    sourceId,
    isError,
    durationMs,
    errorDetail,
    callSiteEvidence,
    observedSource,
    mintsFromCallerSide,
  }

  recordSpanFlagEvaluations(s)

  if (span.dbSystem) {
    ingestDatabaseSpan(s)
  } else if (
    span.messagingSystem &&
    span.messagingDestination &&
    spanMintsMessagingEdge(span.kind)
  ) {
    ingestMessagingSpan(s)
  } else if (
    span.graphqlOperationName &&
    span.graphqlOperationType &&
    spanServesGraphqlOperation(span.kind)
  ) {
    ingestGraphqlOperationSpan(s)
  } else if (
    span.rpcSystem === 'grpc' &&
    span.rpcService &&
    span.rpcMethod &&
    spanServesGrpcMethod(span.kind)
  ) {
    ingestGrpcMethodSpan(s)
  } else if (span.websocketChannel && spanServesWebsocketChannel(span.kind)) {
    ingestWebsocketChannelSpan(s)
  } else {
    ingestPeerSpan(s)
  }

  ingestServerRoute(s)
  await recordSpanErrors(s)

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
  // A frontier minted for a ClusterIP before the k8s substrate read the Services
  // (ADR-248) promotes to the service the address now names.
  graph.forEachNode((_id, attrs) => {
    const a = attrs as FrontierNode & { type?: string }
    if (a.type !== NodeType.FrontierNode || aliasIndex.has(a.host)) return
    const owner = serviceIdForObservedAddress(graph, a.host)
    if (owner) aliasIndex.set(a.host, owner)
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

// ADR-226 — a staged FRONTIER surface graduates to OBSERVED by PROMOTION when its
// real twin arrives. An OBSERVED edge with the same (source, target, type) means
// NEAT can now see the hop it had only reached toward — a hung service came back,
// a proposed edge became real — so the placeholder is dropped and the settled
// OBSERVED edge stands in its place. This is the edge-level twin of
// promoteFrontierNodes (ADR-044): a placeholder replaced once the real thing
// resolves. Never gated — a settled fact is not blockable (the gate is the future
// face, ADR-093). Returns the number of surfaces graduated; runs in the same
// reconciliation sweep as promoteFrontierNodes.
// ADR-226 — stage a FRONTIER surface edge. The hang sensor (hang-sensor.ts) does
// the detection and resolves the hop; the graph write belongs here per the
// lifecycle authority (ADR-030). Returns false when the hop is already OBSERVED
// (production can see it — not a hang), already staged, or an endpoint is missing;
// true when a new surface was added.
export function stageFrontierEdge(
  graph: NeatGraph,
  source: string,
  target: string,
  type: EdgeTypeValue,
): boolean {
  if (!graph.hasNode(source) || !graph.hasNode(target)) return false
  if (graph.hasEdge(observedEdgeId(source, target, type))) return false
  const key = frontierEdgeId(source, target, type)
  if (graph.hasEdge(key)) return false
  graph.addEdgeWithKey(key, source, target, {
    id: key,
    source,
    target,
    type,
    provenance: Provenance.FRONTIER,
  } as GraphEdge)
  return true
}

export function promoteFrontierEdges(graph: NeatGraph): number {
  const graduated: string[] = []
  graph.forEachEdge((edgeId, attrs) => {
    const e = attrs as GraphEdge
    if (e.provenance !== Provenance.FRONTIER) return
    if (graph.hasEdge(observedEdgeId(e.source, e.target, e.type))) {
      graduated.push(edgeId)
    }
  })
  for (const edgeId of graduated) graph.dropEdge(edgeId)
  return graduated.length
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
  // Post-ingest reconciliation (ADR-226). Fires after each tick, the periodic
  // point where OBSERVED state has settled. Daemons wire this to graduate FRONTIER
  // surfaces whose twin has arrived (promoteFrontierEdges) and stage new hang
  // surfaces (the hang sensor). Kept as a callback so ingest.ts never imports the
  // sensor/traverse (which would cycle) — the daemon owns those wires.
  onReconcile?: (graph: NeatGraph) => Promise<void> | void
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
        if (options.onReconcile) await options.onReconcile(graph)
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

// A record persisted before the write-path scrub (#1184) can still carry
// credential headers in its `attributes`: the sidecar is append-only, so the
// bytes on disk predate the fix. Every reader (incident cards, get_divergences,
// the web) gets the same scrub on load, without rewriting the file.
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
    .map((line) => scrubIncidentEvent(JSON.parse(line) as ErrorEvent))
  const deduped = dedupeIncidents(events)
  const cap =
    opts?.limit !== undefined && opts.limit > 0
      ? Math.min(opts.limit, INCIDENT_READ_MAX_EVENTS)
      : INCIDENT_READ_MAX_EVENTS
  // Keep the most-recent `cap`. dedupeIncidents preserves append order, so the
  // tail is newest.
  return deduped.length > cap ? deduped.slice(deduped.length - cap) : deduped
}

/** Resolve a pinned incident without the 5000-event list cap. Hosted replay can
 * name an older event, while ordinary incident reads remain bounded to the
 * newest window. The byte bound still prevents an unbounded ledger read.
 */
export async function readErrorEventById(errorsPath: string, id: string): Promise<ErrorEvent | undefined> {
  let raw: string
  try {
    raw = await readErrorFileTail(errorsPath, INCIDENT_READ_MAX_BYTES)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    const event = JSON.parse(line) as ErrorEvent
    if (event.id === id) return scrubIncidentEvent(event)
  }
  return undefined
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
  invalidateSourceBaseline(graph)
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
