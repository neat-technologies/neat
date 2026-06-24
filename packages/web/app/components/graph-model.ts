// File-first graph model for the dashboard's level-of-detail drill-down.
//
// The graph is file-first (file-awareness.md §1-§3): FileNodes are primary,
// CALLS edges originate from files, and `service ──CONTAINS──▶ file` is the
// only place a service appears in relation to its files. Drill-down navigates
// *by the grouping* — it never rolls file edges up into service edges and
// never shows a service-level edge view (§3). A service is a container you
// open, not an aggregation.
//
// Level-of-detail:
//   - collapsed (default): each service shows as one collapsed container;
//     its files are hidden so the canvas isn't a flat file hairball.
//   - expanded (drilled): the focused service's FileNodes are revealed via
//     its CONTAINS edges; files outside the focus stay collapsed under their
//     own service container.
//
// Rendered edges are always file-grained. When a file is hidden inside a
// collapsed service, an edge that originates from (or lands on) that file is
// re-anchored onto the visible service *container* so the relationship still
// reads — but it stays the same file-grained edge with its own provenance and
// evidence; we never synthesize a service→service summary edge.

import { EdgeType, type GraphNode, type GraphEdge } from '@neat.is/types'

export const CONTAINS = 'CONTAINS'

export interface FileFirstModel {
  /** every node by id */
  byId: Map<string, GraphNode>
  /** service id → file node ids it CONTAINS */
  filesByService: Map<string, string[]>
  /** file id → owning service id (from the inbound CONTAINS edge) */
  serviceByFile: Map<string, string>
  /** service ids present in the graph */
  serviceIds: string[]
  /** file ids present in the graph */
  fileIds: string[]
}

export function isFileNode(node: GraphNode | undefined): boolean {
  return node?.type === 'FileNode'
}

export function isServiceNode(node: GraphNode | undefined): boolean {
  return node?.type === 'ServiceNode'
}

// Build the service↔file containment index from CONTAINS edges. CONTAINS is
// the structural ownership edge (service → file); we read it rather than the
// FileNode.service string so the model matches the graph the daemon actually
// shipped.
export function buildModel(nodes: GraphNode[], edges: GraphEdge[]): FileFirstModel {
  const byId = new Map<string, GraphNode>()
  for (const n of nodes) byId.set(n.id, n)

  const filesByService = new Map<string, string[]>()
  const serviceByFile = new Map<string, string>()

  for (const e of edges) {
    if (e.type !== CONTAINS) continue
    const svc = byId.get(e.source)
    const file = byId.get(e.target)
    if (!isServiceNode(svc) || !isFileNode(file)) continue
    const list = filesByService.get(e.source) ?? []
    list.push(e.target)
    filesByService.set(e.source, list)
    serviceByFile.set(e.target, e.source)
  }

  const serviceIds: string[] = []
  const fileIds: string[] = []
  for (const n of nodes) {
    if (n.type === 'ServiceNode') serviceIds.push(n.id)
    else if (n.type === 'FileNode') fileIds.push(n.id)
  }

  return { byId, filesByService, serviceByFile, serviceIds, fileIds }
}

export interface VisibleGraph {
  nodes: GraphNode[]
  // edges re-anchored onto whatever node currently represents each endpoint,
  // carrying the original edge id so selection + evidence still resolve.
  edges: (GraphEdge & { _origSource: string; _origTarget: string })[]
}

// Compute the visible node + edge set.
//
// file-awareness §3 — no service rollup, no service-level view. ServiceNodes
// are a grouping concept (namespace for files), not visible canvas entities.
// Only FileNodes, DatabaseNodes, ConfigNodes, InfraNodes, and FrontierNodes
// appear. Edges whose source or target is a ServiceNode are not rendered —
// their service-level attribution is the data-layer fallback, not a canvas
// relationship. CONTAINS edges are structural and never rendered as arrows.
export function visibleGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  _model: FileFirstModel,
  _expanded: Set<string>,
): VisibleGraph {
  const visibleNodes: GraphNode[] = []
  const shown = new Set<string>()

  for (const n of nodes) {
    if (n.type === 'ServiceNode') continue  // file-awareness §3 — service is a namespace, not a node
    visibleNodes.push(n)
    shown.add(n.id)
  }

  const out: VisibleGraph['edges'] = []
  const seen = new Set<string>()

  for (const e of edges) {
    if (e.type === CONTAINS) continue // structural only — not an arrow

    const src = e.source
    const tgt = e.target

    if (!shown.has(src) || !shown.has(tgt)) continue
    if (src === tgt) continue

    const key = `${e.type}:${src}->${tgt}:${e.provenance}`
    if (seen.has(key)) continue
    seen.add(key)

    out.push({ ...e, source: src, target: tgt, _origSource: e.source, _origTarget: e.target })
  }

  return { nodes: visibleNodes, edges: out }
}

// ----------------------------------------------------------------------------
// Compound canvas model (web-shell / live-canvas-layout ADRs + file-awareness
// compound-container amendment).
//
// The canvas renders services as COMPOUND CONTAINERS (cytoscape compound nodes
// built off the CONTAINS hierarchy), collapsed by default, with their files as
// child nodes. This honors file-awareness §3's hard lines:
//
//   - No file→service edge rollup. Every rendered relationship edge stays the
//     same file-grained edge with its own provenance/evidence. When an endpoint
//     file is hidden inside a collapsed service, cytoscape-expand-collapse
//     re-anchors the edge onto the visible service *container* — but it is NOT
//     summarized into a synthetic service→service edge.
//   - No service-as-leaf hiding files. A service is a compound parent the user
//     opens, never a blob node that stands in for its files.
//   - Service-coarse OBSERVED fallback edges (#536 parent-fallback) render
//     honestly: an edge whose ORIGINAL endpoint is a ServiceNode (no call site
//     to attribute) is flagged `_coarse` so the canvas styles it distinctly
//     (faded/dashed-into-the-container) instead of faking file→file precision.
//
// The returned elements are plain data; GraphCanvas attaches cytoscape classes
// and the ELK layout. Collapse/expand is driven by cytoscape-expand-collapse at
// render time, not here.

export interface CompoundElement {
  group: 'nodes' | 'edges'
  data: Record<string, unknown>
}

const RENDERED_NODE_TYPES = new Set([
  'FileNode',
  'DatabaseNode',
  'ConfigNode',
  'InfraNode',
  'FrontierNode',
])

export function compoundElements(
  nodes: GraphNode[],
  edges: GraphEdge[],
  model: FileFirstModel,
): CompoundElement[] {
  const els: CompoundElement[] = []
  const present = new Set<string>()

  // Service compound parents first (cytoscape needs a parent to exist before a
  // child references it). Only services that actually CONTAIN a file.
  for (const sid of model.serviceIds) {
    const files = model.filesByService.get(sid) ?? []
    if (files.length === 0) continue
    const svc = model.byId.get(sid)
    els.push({
      group: 'nodes',
      data: {
        id: sid,
        label: (svc as { name?: string })?.name ?? sid,
        _nodeType: 'ServiceNode',
        _kind: 'service',
        _isParent: true,
        _raw: svc,
      },
    })
    present.add(sid)
  }

  // File children + non-file leaf nodes (db / config / infra / frontier).
  for (const n of nodes) {
    if (!RENDERED_NODE_TYPES.has(n.type)) continue
    if (present.has(n.id)) continue
    const parent =
      n.type === 'FileNode' ? model.serviceByFile.get(n.id) : undefined
    const parentExists = !!parent && present.has(parent)
    els.push({
      group: 'nodes',
      data: {
        id: n.id,
        label: nodeDisplayLabel(n),
        _nodeType: n.type,
        _kind: visualKind(n),
        ...(parentExists ? { parent } : {}),
        _raw: n,
      },
    })
    present.add(n.id)
  }

  // Relationship edges — file-grained, never rolled up. CONTAINS is structural
  // (it builds the compound hierarchy via `parent`) and is not drawn as an arrow.
  const seen = new Set<string>()
  for (const e of edges) {
    if (e.type === CONTAINS) continue
    const srcIsService = model.byId.get(e.source)?.type === 'ServiceNode'
    const tgtIsService = model.byId.get(e.target)?.type === 'ServiceNode'
    const coarse = srcIsService || tgtIsService

    if (!present.has(e.source) || !present.has(e.target)) continue
    if (e.source === e.target) continue
    const key = `${e.type}:${e.source}->${e.target}:${e.provenance}`
    if (seen.has(key)) continue
    seen.add(key)

    els.push({
      group: 'edges',
      data: {
        id: e.id,
        source: e.source,
        target: e.target,
        _type: e.type,
        _verb: e.type.toLowerCase().replace(/_/g, ' '),
        _provenance: e.provenance,
        _confidence: e.confidence,
        _coarse: coarse,
        _raw: e,
      },
    })
  }

  return els
}

// Degree per rendered node (relationship edges only, CONTAINS excluded), used
// to size nodes so hubs read larger — visible hierarchy, part of the de-slop.
export function degreeByNode(edges: GraphEdge[]): Map<string, number> {
  const deg = new Map<string, number>()
  for (const e of edges) {
    if (e.type === CONTAINS) continue
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1)
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1)
  }
  return deg
}

function visualKind(n: GraphNode): string {
  switch (n.type) {
    case 'FileNode':
      return 'file'
    case 'ServiceNode':
      return 'service'
    case 'DatabaseNode':
      return 'db'
    case 'ConfigNode':
      return 'config'
    case 'FrontierNode':
      return 'frontier'
    case 'InfraNode':
      return 'infra'
    default:
      return 'service'
  }
}

// A FileNode shows its basename on the canvas; the full path lives in the
// Inspector. Other nodes show their name. Keeps the canvas legible.
function nodeDisplayLabel(n: GraphNode): string {
  if (n.type === 'FileNode') {
    const p = (n as { path?: string }).path ?? n.id
    const parts = p.split('/')
    return parts[parts.length - 1] || p
  }
  return (n as { name?: string }).name ?? n.id
}

// Files a service CONTAINS, resolved to nodes (for the Inspector's service view).
export function filesOf(serviceId: string, model: FileFirstModel): GraphNode[] {
  const ids = model.filesByService.get(serviceId) ?? []
  return ids.map((id) => model.byId.get(id)).filter((n): n is GraphNode => !!n)
}

// A file-grained outbound edge, resolved to its target's display name, with
// evidence. Shared shape for the Inspector's "Calls from this file" and
// "Imports" sections (file-awareness.md §10 — IMPORTS is distinct from CALLS).
export interface OriginatingEdge {
  edgeId: string
  targetId: string
  targetName: string
  provenance: string
  confidence?: number
  evidenceFile?: string
  evidenceLine?: number
}

function originatingEdges(
  fileId: string,
  edges: GraphEdge[],
  byId: Map<string, GraphNode>,
  matchesType: (type: string) => boolean,
): OriginatingEdge[] {
  const out: OriginatingEdge[] = []
  for (const e of edges) {
    if (e.source !== fileId) continue
    if (!matchesType(e.type)) continue
    const target = byId.get(e.target)
    const name = target ? ((target as { name?: string; path?: string }).name ?? (target as { path?: string }).path ?? e.target) : e.target
    out.push({
      edgeId: e.id,
      targetId: e.target,
      targetName: name,
      provenance: e.provenance,
      confidence: e.confidence,
      evidenceFile: e.evidence?.file,
      evidenceLine: e.evidence?.line,
    })
  }
  return out
}

// The runtime calls originating from a file — HTTP requests, queue
// publish/consume, and other live invocations (file-grained CALLS /
// PUBLISHES_TO / CONSUMES_FROM edges), with evidence. CONNECTS_TO and
// CONFIGURED_BY are declared/static relationships, not runtime calls, and
// IMPORTS is a compile-time module dependency — see importsFrom — so none of
// the three belong in this list (file-awareness.md §10).
export function callsFrom(fileId: string, edges: GraphEdge[], byId: Map<string, GraphNode>): OriginatingEdge[] {
  return originatingEdges(
    fileId,
    edges,
    byId,
    (t) => t === EdgeType.CALLS || t === EdgeType.PUBLISHES_TO || t === EdgeType.CONSUMES_FROM,
  )
}

// The static module imports originating from a file (file-grained IMPORTS
// edges), with evidence. Compile-time module dependencies, distinct from
// runtime calls (file-awareness.md §10).
export function importsFrom(fileId: string, edges: GraphEdge[], byId: Map<string, GraphNode>): OriginatingEdge[] {
  return originatingEdges(fileId, edges, byId, (t) => t === EdgeType.IMPORTS)
}
