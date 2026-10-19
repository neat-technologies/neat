import { EdgeType, NodeType, Provenance, type ErrorEvent, type GraphEdge, type GraphNode } from '@neat.is/types'
import type { NeatGraph } from './graph.js'

// A traffic source (ADR-264): a service nothing calls at runtime, that consumes
// from no queue, and whose errors are all on its own outbound calls. A load
// generator, a synthetic client, a browser. Its errors are responses it received,
// so it is never a culprit: the incident lead lists it apart, and root cause never
// names it as the origin of the load it sends. Structural (runtime in-degree and
// edge direction), never a name list. One predicate, read by both (#1373).

// Kept as functions, not module-level `new Set([Enum.X])` constants: the enum
// values are read at call time, never at module load, so this module's body
// dereferences no imported binding before it is initialized — which keeps it safe
// under the parallel module initialization the test runner does.
function isRuntimeProvenance(p: string): boolean {
  return p === Provenance.OBSERVED || p === Provenance.INFERRED || p === Provenance.STALE
}
// Edges that carry no traffic: ownership and placement.
function isStructuralEdge(t: string): boolean {
  return t === EdgeType.CONTAINS || t === EdgeType.RUNS_ON || t === EdgeType.CONFIGURED_BY
}

export function isTrafficEdge(e: GraphEdge): boolean {
  return isRuntimeProvenance(e.provenance) && !isStructuralEdge(e.type)
}

export function nodeType(graph: NeatGraph, id: string): string | undefined {
  return graph.hasNode(id) ? (graph.getNodeAttributes(id) as GraphNode).type : undefined
}


// A method or route callee is reported as the service that serves it, when the
// graph knows one: that is the callee a reader acts on.
export function owningService(graph: NeatGraph, id: string): string {
  if (nodeType(graph, id) === NodeType.ServiceNode) return id
  for (const eid of graph.inboundEdges(id)) {
    const e = graph.getEdgeAttributes(eid) as GraphEdge
    if (e.type === EdgeType.CONTAINS && nodeType(graph, e.source) === NodeType.ServiceNode) return e.source
  }
  return id
}

/**
 * The callees a traffic source's failing calls went to, or null when `nodeId` is
 * not a traffic source. A traffic source has no runtime caller (and consumes from
 * no queue, whose messages would be its inbound work), sends traffic, and has at
 * least as many errors on its outbound calls as incidents of its own, so every
 * error it recorded can be one it received.
 */
export function trafficSourceCallees(
  graph: NeatGraph | undefined,
  nodeId: string,
  incidentCount: number,
): string[] | null {
  if (!graph || nodeType(graph, nodeId) !== NodeType.ServiceNode) return null
  for (const id of graph.inboundEdges(nodeId)) {
    if (isTrafficEdge(graph.getEdgeAttributes(id) as GraphEdge)) return null
  }
  let outboundErrors = 0
  const callees = new Map<string, number>()
  for (const id of graph.outboundEdges(nodeId)) {
    const e = graph.getEdgeAttributes(id) as GraphEdge
    if (!isTrafficEdge(e)) continue
    if (e.type === EdgeType.CONSUMES_FROM) return null
    const errs = e.signal?.errorCount ?? 0
    if (errs === 0) continue
    outboundErrors += errs
    const callee = owningService(graph, e.target)
    callees.set(callee, (callees.get(callee) ?? 0) + errs)
  }
  if (outboundErrors === 0 || outboundErrors < incidentCount) return null
  return [...callees.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id)
}

/**
 * `trafficSourceCallees` for a service, counting its incidents from the store:
 * every incident recorded against the service or a node it owns.
 */
export function trafficSourceOf(
  graph: NeatGraph | undefined,
  serviceNodeId: string,
  incidents: readonly ErrorEvent[] | undefined,
): string[] | null {
  const svc = serviceNodeId.replace(/^service:/, '')
  const n = (incidents ?? []).filter((e) => e.service === svc || e.affectedNode === serviceNodeId).length
  return trafficSourceCallees(graph, serviceNodeId, n)
}
