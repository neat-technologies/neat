import {
  Provenance,
  frontierEdgeId,
  type EdgeTypeValue,
  type GraphEdge,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import { hasObservedEdge } from './edges.js'

// FRONTIER surface edges (ADR-226): the one writer of a FRONTIER edge and its
// promotion when the OBSERVED twin arrives. Moved out of ingest.ts so other
// producers can stage through ingest without importing the ingest.ts barrel.
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
  if (hasObservedEdge(graph, source, target, type)) return false
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
    if (hasObservedEdge(graph, e.source, e.target, e.type)) {
      graduated.push(edgeId)
    }
  })
  for (const edgeId of graduated) graph.dropEdge(edgeId)
  return graduated.length
}
