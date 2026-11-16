import { Provenance, type GraphEdge, type GraphNode } from '@neat.is/types'
import type { NeatGraph } from '../graph.js'

// Declarers (#1698 slice zero, #1729). A static node or EXTRACTED edge records the
// repositories whose extraction pass declared it, in `declaredBy`. A pass gets a
// declaring handle on the graph: every node or edge it writes through the handle,
// and every one it marks with `declared()` (the "add only if missing" sites, which
// write nothing when another repository minted the element first), is stamped with
// the pass's source when the pass finishes. The handle is the pass's own, so a
// span ingested while the pass awaits a file read writes the real graph and is
// never stamped. A pass that names no source stamps nothing.

const RECORDER = Symbol('neat.declaring')

interface Recorder {
  nodes: Set<string>
  edges: Set<string>
}

const NODE_WRITES = new Set([
  'addNode', 'mergeNode', 'updateNode', 'replaceNodeAttributes', 'mergeNodeAttributes',
  'updateNodeAttributes', 'setNodeAttribute', 'updateNodeAttribute',
])
const EDGE_KEYED_WRITES = new Set([
  'addEdgeWithKey', 'mergeEdgeWithKey', 'updateEdgeWithKey', 'replaceEdgeAttributes',
  'mergeEdgeAttributes', 'updateEdgeAttributes', 'setEdgeAttribute', 'updateEdgeAttribute',
])
// Writes that replace a whole attribute object. The element's recorded declarers
// are carried into the new object, so one repository's re-declaration never
// erases another's.
const NODE_REPLACES = new Set(['replaceNodeAttributes'])
const EDGE_REPLACES = new Set(['replaceEdgeAttributes'])

function withDeclarers<T extends { declaredBy?: string[] }>(next: T, prior: string[] | undefined): T {
  if (!prior || prior.length === 0 || next.declaredBy) return next
  return { ...next, declaredBy: prior }
}

/** The sorted union of a declarer list and one more source. */
export function declarersWith(prior: string[] | undefined, source: string): string[] {
  return prior?.includes(source) ? prior : [...(prior ?? []), source].sort()
}

/** A declarer list without `source`; undefined when nothing is left. */
export function declarersWithout(prior: string[] | undefined, source: string): string[] | undefined {
  const rest = (prior ?? []).filter((s) => s !== source)
  return rest.length > 0 ? rest : undefined
}

/**
 * A handle on `graph` for one extraction pass. Reads pass through; writes pass
 * through and are recorded. `finish()` stamps every recorded element still in the
 * graph with `source` and returns how many it stamped.
 */
export function declaringGraph(graph: NeatGraph, source: string | undefined): {
  graph: NeatGraph
  finish(): { nodes: number; edges: number }
} {
  if (!source) return { graph, finish: () => ({ nodes: 0, edges: 0 }) }
  const recorder: Recorder = { nodes: new Set(), edges: new Set() }
  const handle = new Proxy(graph, {
    get(target, prop, receiver) {
      if (prop === RECORDER) return recorder
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      const name = String(prop)
      if (NODE_WRITES.has(name)) {
        return (key: string, ...rest: unknown[]) => {
          if (NODE_REPLACES.has(name) && target.hasNode(key)) {
            rest[0] = withDeclarers(rest[0] as GraphNode, target.getNodeAttributes(key).declaredBy)
          }
          const out = (value as (...a: unknown[]) => unknown).call(target, key, ...rest)
          recorder.nodes.add(key)
          return out
        }
      }
      if (EDGE_KEYED_WRITES.has(name)) {
        return (key: string, ...rest: unknown[]) => {
          if (EDGE_REPLACES.has(name) && target.hasEdge(key)) {
            rest[0] = withDeclarers(rest[0] as GraphEdge, target.getEdgeAttributes(key).declaredBy)
          }
          const out = (value as (...a: unknown[]) => unknown).call(target, key, ...rest)
          recorder.edges.add(key)
          return out
        }
      }
      if (name === 'addEdge' || name === 'mergeEdge' || name === 'updateEdge') {
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(target, args)
          const key = Array.isArray(out) ? out[0] : out
          if (typeof key === 'string') recorder.edges.add(key)
          return out
        }
      }
      return value.bind(target)
    },
  }) as NeatGraph
  return {
    graph: handle,
    finish() {
      let nodes = 0, edges = 0
      for (const id of recorder.nodes) {
        if (!graph.hasNode(id)) continue
        const attrs = graph.getNodeAttributes(id)
        const next = declarersWith(attrs.declaredBy, source)
        if (next !== attrs.declaredBy) { graph.replaceNodeAttributes(id, { ...attrs, declaredBy: next }); nodes++ }
      }
      for (const id of recorder.edges) {
        if (!graph.hasEdge(id)) continue
        const attrs = graph.getEdgeAttributes(id)
        if (attrs.provenance !== Provenance.EXTRACTED) continue
        const next = declarersWith(attrs.declaredBy, source)
        if (next !== attrs.declaredBy) { graph.replaceEdgeAttributes(id, { ...attrs, declaredBy: next }); edges++ }
      }
      recorder.nodes.clear(); recorder.edges.clear()
      return { nodes, edges }
    },
  }
}

/**
 * Marks a node or edge this pass declares without writing it: the "add only if
 * missing" sites, where another repository minted it first. A no-op on a graph
 * that isn't a pass's declaring handle.
 */
export function declared(graph: NeatGraph, kind: 'node' | 'edge', id: string): void {
  const recorder = (graph as unknown as { [RECORDER]?: Recorder })[RECORDER]
  if (!recorder) return
  ;(kind === 'node' ? recorder.nodes : recorder.edges).add(id)
}
