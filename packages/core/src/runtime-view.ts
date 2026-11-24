import type { GraphEdge } from '@neat.is/types'
import type { NeatGraph } from './graph.js'
import { edgeEnv, isRuntimeEdge } from './runtime-env.js'

// In-memory views of one graph for a query that is evaluated per environment
// (ADR-280 decision 7). A view is a copy; the live graph is never written. They
// sit with the producers because building one drops edges from a graph, and
// every graph write stays with the producers (lifecycle.md), even on a copy.

function dropping(graph: NeatGraph, drop: (e: GraphEdge) => boolean): NeatGraph {
  const view = graph.copy() as NeatGraph
  const doomed: string[] = []
  view.forEachEdge((id, attrs) => {
    if (drop(attrs as GraphEdge)) doomed.push(id)
  })
  for (const id of doomed) view.dropEdge(id)
  return view
}

/** The graph with every other environment's runtime edges left out. */
export function viewForEnvironment(graph: NeatGraph, env: string): NeatGraph {
  return dropping(graph, (e) => isRuntimeEdge(e) && edgeEnv(e) !== env)
}

/** The graph with no runtime edges at all: what static structure alone says. */
export function staticView(graph: NeatGraph): NeatGraph {
  return dropping(graph, isRuntimeEdge)
}
