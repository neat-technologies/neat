import GraphDefault from 'graphology'
import type { MultiDirectedGraph as MDGType } from 'graphology'
import type { GraphEdge, GraphNode } from '@neat.is/types'

// graphology ships as a CJS bundle that does `module.exports = Graph` with
// the other constructors attached as properties (`Graph.MultiDirectedGraph =
// ...`). cjs-module-lexer can't see through that attachment, so a named
// import like `import { MultiDirectedGraph } from 'graphology'` fails under
// strict Node ESM (Node 22+ via tsx in particular). Pull the constructor off
// the default export instead — same shape under tsx and tsup-bundled output.
type MultiDirectedGraphCtor = typeof MDGType
const MultiDirectedGraph: MultiDirectedGraphCtor = (
  GraphDefault as unknown as { MultiDirectedGraph: MultiDirectedGraphCtor }
).MultiDirectedGraph

// Multi because two nodes can have edges of different types simultaneously
// (e.g. CALLS and DEPENDS_ON between the same pair of services).
export type NeatGraph = MDGType<GraphNode, GraphEdge>

export const DEFAULT_PROJECT = 'default'

// One graph per project. The map is the source of truth; getGraph() with no
// arg or with 'default' hits the legacy single-project path so existing
// callers keep working byte-for-byte (ADR-026).
const graphs = new Map<string, NeatGraph>()

// A graph that belongs to no project — scratch space for a one-off extraction
// (pr-verdict.ts) that must never be reachable through getGraph().
export function makeGraph(): NeatGraph {
  return new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
}

export function getGraph(project: string = DEFAULT_PROJECT): NeatGraph {
  let g = graphs.get(project)
  if (!g) {
    g = makeGraph()
    graphs.set(project, g)
  }
  return g
}

export function hasProject(project: string): boolean {
  return graphs.has(project)
}

export function listProjects(): string[] {
  return [...graphs.keys()].sort()
}

// Reset a single project, or all of them when the arg is omitted. Tests use
// the no-arg form between cases; runtime never calls it.
export function resetGraph(project?: string): void {
  if (project === undefined) {
    graphs.clear()
    return
  }
  graphs.delete(project)
}
