import { hasObservedIn } from '../runtime-env.js'
import type {
  GraphEdge,
} from '@neat.is/types'
import {
  ENV_UNKNOWN,
  EdgeType,
  Provenance,
  confidenceForObservedSignal,
  normalizeEnv,
  inferredEdgeId,
  observedEdgeId,
  type EdgeErrorExemplar,
  type EdgeTypeValue,
} from '@neat.is/types'
import { recordLatency, latencyPercentiles } from '../latency-digest.js'
import type { NeatGraph } from '../graph.js'
import type { ParsedSpan } from '../otel.js'
import { httpResponseStatus } from './span.js'

// OBSERVED and INFERRED edge upserts, the last-error exemplar, and the trace
// stitcher.
// Moved out of ingest.ts; ingest.ts re-exports the public names.

// Edge id helpers live in @neat.is/types/identity.ts (ADR-029). The local
// signatures below preserve the (type, source, target) argument order ingest.ts
// has used historically while delegating to the canonical wire-format helpers.
export function makeObservedEdgeId(type: EdgeTypeValue, source: string, target: string, env?: string): string {
  return observedEdgeId(source, target, type, env)
}

export function makeInferredEdgeId(type: EdgeTypeValue, source: string, target: string, env?: string): string {
  return inferredEdgeId(source, target, type, env)
}

// Whether the graph holds an OBSERVED edge of this type between the two nodes in
// any environment (ADR-280). A runtime edge id carries its environment, so a
// question about the hop itself (is it seen at all?) asks every environment's id.
export function hasObservedEdge(graph: NeatGraph, source: string, target: string, type: EdgeTypeValue): boolean {
  if (!graph.hasNode(source) || !graph.hasNode(target)) return false
  if (graph.hasEdge(observedEdgeId(source, target, type))) return true
  return graph.someDirectedEdge(source, target, (_id, attrs) => {
    const e = attrs as GraphEdge
    return e.type === type && e.provenance === Provenance.OBSERVED
  })
}

// The `env` attribute a runtime edge carries: the normalised environment, absent
// for `unknown` so an edge minted with no environment label is byte-for-byte the
// edge NEAT minted before ADR-280.
function envField(env: string | undefined): { env?: string } {
  const e = normalizeEnv(env)
  return e === ENV_UNKNOWN ? {} : { env: e }
}

export const INFERRED_CONFIDENCE = 0.6

export const STITCH_MAX_DEPTH = 2

// The trace stitcher only reasons about runtime *dependency* edges — the ones an
// error actually propagates along (a service calling a service, connecting to a
// datastore, a declared runtime dependency). Structural edges (CONTAINS a file,
// IMPORTS a module, CONFIGURED_BY a ConfigNode, RUNS_ON a host) are static facts
// learned by extraction; a 500 says nothing new about them. Minting an INFERRED
// twin of a structural EXTRACTED edge would corrupt the trust signal — the twin
// (conf 0.6) outranks the ground-truth EXTRACTED edge (0.85) under PROV_RANK, so
// consumer queries would surface the inference in place of the hard fact
// (docs/contracts/trace-stitcher.md — dependency-edge-type allowlist).
export const STITCH_EDGE_TYPES = new Set<EdgeTypeValue>([
  EdgeType.CALLS,
  EdgeType.CONNECTS_TO,
  EdgeType.DEPENDS_ON,
])

// Exported so the connectors plane (connectors/index.ts) mints edges through
// the identical primitive OTel ingest uses — a connector-sourced edge and a
// span-sourced edge are meant to be indistinguishable to traversal,
// divergence, and staleness (docs/connectors/README.md).
export interface UpsertResult {
  edge: GraphEdge
  created: boolean
}

// Bounded ceiling for an edge exemplar's message (ADR-236). The full exception
// text lives in the incident ledger; the edge carries only enough to name the
// failure's nature, so a pathological stack-dump message never bloats the edge.
export const EDGE_ERROR_MESSAGE_MAX = 512

// Build the bounded last-error exemplar written onto `signal.lastError`
// (ADR-236). `at` is the span's own observation time (ts), mirroring
// `lastObserved`. Only fields the caller actually resolved are set — a failure
// may carry a type, a message, a status, or only some of these — and `message`
// is trimmed defensively here too, so no caller can route an unbounded string
// onto the edge.
export function buildEdgeErrorExemplar(
  detail: { exceptionType?: string; message?: string; httpStatusCode?: number },
  ts: string,
): EdgeErrorExemplar {
  return {
    ...(detail.exceptionType !== undefined ? { exceptionType: detail.exceptionType } : {}),
    ...(detail.message !== undefined
      ? { message: detail.message.slice(0, EDGE_ERROR_MESSAGE_MAX) }
      : {}),
    ...(detail.httpStatusCode !== undefined ? { httpStatusCode: detail.httpStatusCode } : {}),
    at: ts,
  }
}

// The detail for a failing span's edge exemplar (ADR-236): the real span
// exception type/message (the `exception` event, parsed in `otel.ts`) plus the
// HTTP response status when the failure is an HTTP one (`httpResponseStatus`,
// the same helper the incident path reads). Returns `undefined` when the span
// carries none of these — a failure with no detail leaves any prior exemplar
// untouched (`upsertObservedEdge`). A non-exception, non-HTTP failure (a bare
// gRPC status with no exception event) resolves to no detail here and rides as a
// plain error count, honestly — the exemplar never fabricates a reason.
export function edgeErrorDetailFromSpan(
  span: ParsedSpan,
): { exceptionType?: string; message?: string; httpStatusCode?: number } | undefined {
  const exceptionType = span.exception?.type
  const message = span.exception?.message
  const httpStatusCode = httpResponseStatus(span)
  if (exceptionType === undefined && message === undefined && httpStatusCode === undefined) {
    return undefined
  }
  return {
    ...(exceptionType !== undefined ? { exceptionType } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(httpStatusCode !== undefined ? { httpStatusCode } : {}),
  }
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
  // The failing observation's exception detail (ADR-236). When `isError` and
  // this is present, it is written/overwritten onto `signal.lastError` as a
  // bounded exemplar (last-write-wins, no history) so the edge carries WHAT
  // failed. A non-error call, or an error without detail, leaves any prior
  // exemplar untouched — mirrors the latency "absent leaves prior untouched"
  // rule above. The caller trims `message` before passing it.
  errorDetail?: { exceptionType?: string; message?: string; httpStatusCode?: number },
  // The environment the observation came from (ADR-280 decision 2). The edge id
  // includes it, so each environment's evidence is its own edge. Omitted (a
  // connector signal, which names no environment) means `unknown`.
  env?: string,
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

  const id = makeObservedEdgeId(type, source, target, env)
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
    // Bounded last-error exemplar (ADR-236): a failing observation that carries
    // detail overwrites it (last-write-wins, O(1)); a clean call or a failure
    // without detail leaves the prior exemplar untouched, mirroring latency.
    const lastError =
      isError && errorDetail
        ? buildEdgeErrorExemplar(errorDetail, ts)
        : existing.signal?.lastError
    const newSignal = {
      spanCount: newSpanCount,
      errorCount: newErrorCount,
      lastObservedAgeMs: 0,
      ...(latencyHist ? { latencyHist } : {}),
      ...(latencyMs ? { latencyMs } : {}),
      ...(existing.signal?.anomalous !== undefined
        ? { anomalous: existing.signal.anomalous }
        : {}),
      ...(lastError ? { lastError } : {}),
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
  const lastError = isError && errorDetail ? buildEdgeErrorExemplar(errorDetail, ts) : undefined
  const signal = {
    spanCount: 1,
    errorCount: isError ? 1 : 0,
    lastObservedAgeMs: 0,
    ...(latencyHist ? { latencyHist } : {}),
    ...(latencyMs ? { latencyMs } : {}),
    ...(lastError ? { lastError } : {}),
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
    ...envField(env),
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
// The INFERRED twins it mints carry the failing span's environment (ADR-280), the
// same as the OBSERVED evidence they stand in for.
export function stitchTrace(graph: NeatGraph, sourceServiceId: string, ts: string, env?: string): void {
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
      if (hasObservedIn(graph, edge.source, edge.target, edge.type, normalizeEnv(env))) continue

      upsertInferredEdge(graph, edge.type, edge.source, edge.target, ts, env)

      if (!visited.has(edge.target)) {
        visited.add(edge.target)
        queue.push({ nodeId: edge.target, depth: depth + 1 })
      }
    }
  }
}

export function upsertInferredEdge(
  graph: NeatGraph,
  type: EdgeTypeValue,
  source: string,
  target: string,
  ts: string,
  env?: string,
): void {
  const id = makeInferredEdgeId(type, source, target, env)
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
    ...envField(env),
  }
  graph.addEdgeWithKey(id, source, target, edge)
}
