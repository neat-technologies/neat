import type {
  GraphNode,
  InfraNode,
} from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  infraId,
} from '@neat.is/types'
import { FLAG_STORE_KIND, foldObservedVariant } from '../flags.js'
import type { NeatGraph } from '../graph.js'
import type { FlagEvaluation } from '../otel.js'
import { upsertObservedEdge } from './edges.js'
import type { SpanIngest } from './context.js'

// Feature-flag evaluations carried on a span (ADR-242).
// Moved out of ingest.ts; ingest.ts re-exports the public names.

// The flag store an evaluation came from: the one its provider names, else the
// only flag store in the graph. Null when neither picks exactly one.
export function flagStoreFor(graph: NeatGraph, provider: string | undefined): string | null {
  if (provider) {
    const id = infraId(FLAG_STORE_KIND, provider)
    return graph.hasNode(id) ? id : null
  }
  const stores: string[] = []
  graph.forEachNode((id, attrs) => {
    const n = attrs as GraphNode
    if (n.type === NodeType.InfraNode && n.kind === FLAG_STORE_KIND) stores.push(id)
  })
  return stores.length === 1 ? stores[0]! : null
}

// Fold one service-side flag evaluation (a `feature_flag.evaluation` span event)
// onto the flag grain, and record that the evaluating code reads the store: an
// OBSERVED CONNECTS_TO from the span's origin, the twin of the EXTRACTED edge the
// literal join mints. Only a flag the code base declares is recorded. Returns
// whether it landed.
export function recordFlagEvaluation(
  graph: NeatGraph,
  source: () => string,
  ev: FlagEvaluation,
  ts: string,
  callSiteEvidence: { file: string; line?: number } | undefined,
  // The span's environment (ADR-280): the evaluation edge is that environment's evidence.
  env?: string,
): boolean {
  if (!ev.variant) return false
  const storeId = flagStoreFor(graph, ev.provider)
  if (!storeId) return false
  const node = graph.getNodeAttributes(storeId) as InfraNode
  const flags = foldObservedVariant(node.flags, ev.key, ev.variant, ev.reason, ts)
  if (!flags) return false
  graph.mergeNodeAttributes(storeId, { flags })
  upsertObservedEdge(graph, EdgeType.CONNECTS_TO, source(), storeId, ts, false, callSiteEvidence, undefined, undefined, env)
  return true
}

// Feature-flag evaluations on this span (ADR-242): the second OBSERVED source
export function recordSpanFlagEvaluations(s: SpanIngest): void {
  const { ctx, span, ts, callSiteEvidence, observedSource } = s
  // for the flag grain, beside the store's own sync reader.
  for (const ev of span.flagEvaluations ?? []) {
    recordFlagEvaluation(ctx.graph, observedSource, ev, ts, callSiteEvidence, s.env)
  }
}
