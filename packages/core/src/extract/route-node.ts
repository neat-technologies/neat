import type { RouteNode } from '@neat.is/types'
import type { NeatGraph } from '../graph.js'

// Add a statically-extracted RouteNode. A route a SERVER span already minted
// observed-first (ADR-275) sits at the same id with no source locus; extraction
// fills in the declaration (`path`, `line`, `framework`) and flips it to
// `merged`, the way a ServiceNode or DatabaseNode merges. Returns true when the
// node is new.
export function upsertRouteNode(graph: NeatGraph, node: RouteNode): boolean {
  if (!graph.hasNode(node.id)) {
    graph.addNode(node.id, node)
    return true
  }
  const existing = graph.getNodeAttributes(node.id) as RouteNode
  if (existing.discoveredVia === 'otel') {
    graph.mergeNodeAttributes(node.id, {
      ...(node.path !== undefined ? { path: node.path } : {}),
      ...(node.line !== undefined ? { line: node.line } : {}),
      ...(node.framework !== undefined ? { framework: node.framework } : {}),
      discoveredVia: 'merged',
    })
  }
  return false
}
