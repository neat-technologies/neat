// Types for graph.mjs — the pure graph-diff and comment-rendering logic. The
// Action runs the .mjs directly; the daemon's pr-verdict route imports it, so
// the two render one verdict from one implementation.

export interface ActionGraph {
  nodes: Map<string, Record<string, unknown> & { type?: string; name?: string; path?: string }>
  edges: Array<{ key?: string; source: string; target: string; type?: string } & Record<string, unknown>>
}

export interface GraphDelta {
  routesAdded: string[]
  routesRemoved: string[]
  tablesAdded: string[]
  tablesRemoved: string[]
}

export interface ScanNode {
  id: string
  type?: string
  label: string
  change: 'removed' | 'changed'
}

export interface ObservedBreak extends ScanNode {
  dependentCount: number
  callCount: number
  inboundVolume?: number
  window?: string
  inboundLastObserved?: string
}

export interface RenderedComment {
  marker: string
  body: string
}

export const MARKER: string
export function loadGraph(path: string): ActionGraph
export function graphFromExport(raw: unknown): ActionGraph
export function diffGraphs(base: ActionGraph, head: ActionGraph): GraphDelta
export function changedFileNodeIds(graph: ActionGraph, changedPaths: string[]): string[]
export function changedNodeIds(base: ActionGraph | null, head: ActionGraph): string[]
export function formatDivergences(data: unknown, changedIds: string[]): string[]
export function observedBreakFrom(node: ScanNode, data: unknown): ObservedBreak | null
export function blastRadius(graph: ActionGraph, nodeId: string, maxDepth?: number): string[]
export function changedNodesForObservedScan(
  base: ActionGraph,
  head: ActionGraph,
  opts?: { limit?: number },
): ScanNode[]
export function renderComment(input: {
  graph: ActionGraph
  delta: GraphDelta
  changedFiles?: string[]
  divergences?: string[]
  connected?: boolean
}): RenderedComment
export function renderVerdict(input: {
  graph: ActionGraph
  delta: GraphDelta
  changedFiles?: string[]
  divergences?: string[]
  observedBreaks?: ObservedBreak[]
  tone?: 'loud' | 'professional'
  sniperDispatchUrl?: string
  graphDiffUrl?: string
}): RenderedComment
