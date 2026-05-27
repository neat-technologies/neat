import type {
  BlastRadiusAffectedNode,
  BlastRadiusResult,
  DatabaseNode,
  ErrorEvent,
  GraphEdge,
  GraphNode,
  RootCauseResult,
  ServiceNode,
  TransitiveDependenciesResult,
  TransitiveDependency,
} from '@neat.is/types'
import {
  BlastRadiusResultSchema,
  EdgeType,
  NodeType,
  PROV_RANK,
  RootCauseResultSchema,
  TransitiveDependenciesResultSchema,
} from '@neat.is/types'
import type { NeatGraph } from './graph.js'
import {
  checkCompatibility,
  checkNodeEngineConstraint,
  checkPackageConflict,
  compatPairs,
  nodeEngineConstraints,
  packageConflicts,
} from './compat.js'

// Contract anchors (see /docs/contracts.md + docs/contracts/provenance.md):
//   * Rule 2 — Coexistence: walk by provenance priority, never collapse edges.
//   * Rule 3 — FrontierNodes terminate traversal — edges to/from FrontierNodes
//     are skipped, not merely deprioritized. If a node's only neighbour is a
//     FrontierNode, traversal stops there. ADR-068 makes node-type the gating
//     property, independent of edge provenance.
//   * Rule 5 — Validate results against RootCauseResultSchema /
//     BlastRadiusResultSchema before returning.
//   * Rule 8 — No demo-name hardcoding: driver/engine identifiers come from
//     node properties + compatPairs(), never literals.
//   * ADR-029 — PROV_RANK is the canonical provenance ranking, imported
//     from @neat.is/types so consumers (traversal, MCP, policies) all agree.

const ROOT_CAUSE_MAX_DEPTH = 5
const BLAST_RADIUS_DEFAULT_DEPTH = 10

function isFrontierNode(graph: NeatGraph, nodeId: string): boolean {
  if (!graph.hasNode(nodeId)) return false
  const attrs = graph.getNodeAttributes(nodeId) as GraphNode
  return attrs.type === NodeType.FrontierNode
}

// Resolve a node on the walk path to the ServiceNode that carries the compat
// evidence (declared dependencies + node engine). A ServiceNode resolves to
// itself; a FileNode resolves to its owning service via the inbound
// `service ──CONTAINS──▶ file` edge (file-awareness.md §2) — in a file-first
// graph the caller on the path is a FileNode, but the dependency declaration
// lives on the service that owns it. Anything else has no service to resolve
// to. Returns the resolved ServiceNode's id + attributes, or null.
function resolveOwningService(
  graph: NeatGraph,
  nodeId: string,
): { id: string; svc: ServiceNode } | null {
  if (!graph.hasNode(nodeId)) return null
  const attrs = graph.getNodeAttributes(nodeId) as GraphNode
  if (attrs.type === NodeType.ServiceNode) {
    return { id: nodeId, svc: attrs as ServiceNode }
  }
  if (attrs.type === NodeType.FileNode) {
    for (const edgeId of graph.inboundEdges(nodeId)) {
      const e = graph.getEdgeAttributes(edgeId) as GraphEdge
      if (e.type !== EdgeType.CONTAINS) continue
      const owner = graph.getNodeAttributes(e.source) as GraphNode
      if (owner.type === NodeType.ServiceNode) {
        return { id: e.source, svc: owner as ServiceNode }
      }
    }
  }
  return null
}

// Multiple edges between the same pair coexist by provenance (EXTRACTED next to
// OBSERVED next to INFERRED). Traversal walks the system as the graph "sees it
// best", so for any neighbour pair we pick the highest-provenance edge.
// Edges connecting to FrontierNodes are skipped at the node level (ADR-068):
// FrontierNodes are unresolved peers, traversal terminates at them rather than
// pretending the path continues into unknown territory.
function bestEdgeBySource(graph: NeatGraph, edgeIds: string[]): Map<string, GraphEdge> {
  const best = new Map<string, GraphEdge>()
  for (const id of edgeIds) {
    const e = graph.getEdgeAttributes(id) as GraphEdge
    if (isFrontierNode(graph, e.source)) continue
    const cur = best.get(e.source)
    if (!cur || PROV_RANK[e.provenance] > PROV_RANK[cur.provenance]) {
      best.set(e.source, e)
    }
  }
  return best
}

function bestEdgeByTarget(graph: NeatGraph, edgeIds: string[]): Map<string, GraphEdge> {
  const best = new Map<string, GraphEdge>()
  for (const id of edgeIds) {
    const e = graph.getEdgeAttributes(id) as GraphEdge
    if (isFrontierNode(graph, e.target)) continue
    const cur = best.get(e.target)
    if (!cur || PROV_RANK[e.provenance] > PROV_RANK[cur.provenance]) {
      best.set(e.target, e)
    }
  }
  return best
}

// Per-edge confidence is provenance × volume × recency × cleanliness.
//   * provenance gives a ceiling: OBSERVED 1.0, INFERRED 0.7, EXTRACTED 0.5,
//     STALE 0.3.
//   * volume: log-scaled span count, saturating quickly so 1 span ≈ 0.55 and
//     ~1k spans ≈ 1.0.
//   * recency: 1.0 within an hour; decays toward 0.5 by 24h, toward 0.3 past.
//   * cleanliness: error rate above ~10% pulls the score down — a flapping
//     edge with thousands of spans shouldn't outrank a clean low-traffic one.
// Bounded to [0, 1]. Walks of multiple edges multiply per-edge confidences.
const PROVENANCE_CEILING: Record<string, number> = {
  OBSERVED: 1.0,
  INFERRED: 0.7,
  EXTRACTED: 0.5,
  STALE: 0.3,
}

function volumeWeight(spanCount: number | undefined): number {
  if (!spanCount || spanCount <= 0) return 0.5
  // log10 saturating around ~1000 spans → ~1.0.
  const w = 0.5 + Math.log10(spanCount + 1) / 3
  return Math.min(1, w)
}

function recencyWeight(ageMs: number | undefined): number {
  if (ageMs === undefined) return 0.8
  const hour = 60 * 60 * 1000
  if (ageMs <= hour) return 1.0
  if (ageMs <= 24 * hour) {
    const t = (ageMs - hour) / (23 * hour)
    return 1.0 - 0.5 * t
  }
  return 0.3
}

function cleanlinessWeight(spanCount: number | undefined, errorCount: number | undefined): number {
  if (!spanCount || spanCount <= 0) return 1
  const rate = (errorCount ?? 0) / spanCount
  if (rate <= 0.01) return 1
  if (rate >= 0.5) return 0.3
  return 1 - rate * 1.4
}

export function confidenceForEdge(edge: GraphEdge, now = Date.now()): number {
  const ceiling = PROVENANCE_CEILING[edge.provenance] ?? 0.5

  // No runtime signal yet → the provenance ceiling is all we have. This keeps
  // EXTRACTED-only graphs returning the same coarse 0.3/0.5/0.7/1.0 ladder
  // they always have, while letting OBSERVED edges with real OTel data move
  // off the ceiling once ingest starts populating signal counters.
  const spanCount = edge.signal?.spanCount ?? edge.callCount
  const ageMs = edge.signal?.lastObservedAgeMs ?? lastObservedAge(edge, now)
  if (spanCount === undefined && ageMs === undefined && edge.signal === undefined) {
    return ceiling
  }

  const v = volumeWeight(spanCount)
  const r = recencyWeight(ageMs)
  const c = cleanlinessWeight(spanCount, edge.signal?.errorCount)
  return Math.max(0, Math.min(1, ceiling * v * r * c))
}

function lastObservedAge(edge: GraphEdge, now: number): number | undefined {
  if (!edge.lastObserved) return undefined
  const t = Date.parse(edge.lastObserved)
  if (!Number.isFinite(t)) return undefined
  return Math.max(0, now - t)
}

// Path-level confidence is the *product* of per-edge confidences (ADR-036).
// Each hop is independent evidence and uncertainty compounds — a 3-hop path
// of edges at confidence 0.8 each gives 0.512, not 0.8. Multiplying punishes
// long walks accordingly, which is the contract's intent: traversal should
// surface the cumulative trust the graph actually has, not the weakest link
// alone.
function confidenceFromMix(edges: GraphEdge[], now = Date.now()): number {
  if (edges.length === 0) return 1.0
  let product = 1
  for (const e of edges) {
    product *= confidenceForEdge(e, now)
  }
  return Math.max(0, Math.min(1, product))
}

interface Walk {
  path: string[]
  edges: GraphEdge[]
}

// DFS along incoming edges from start, depth-bounded. Returns the longest path
// reachable, picking best-provenance edges per neighbour pair so the walk
// reflects the system as the graph knows it most reliably.
function longestIncomingWalk(graph: NeatGraph, start: string, maxDepth: number): Walk {
  let best: Walk = { path: [start], edges: [] }
  const visited = new Set<string>([start])

  function step(node: string, path: string[], edges: GraphEdge[]): void {
    if (path.length > best.path.length) {
      best = { path: [...path], edges: [...edges] }
    }
    if (path.length - 1 >= maxDepth) return

    const incoming = bestEdgeBySource(graph, graph.inboundEdges(node))
    for (const [srcId, edge] of incoming) {
      if (visited.has(srcId)) continue
      visited.add(srcId)
      path.push(srcId)
      edges.push(edge)
      step(srcId, path, edges)
      path.pop()
      edges.pop()
      visited.delete(srcId)
    }
  }

  step(start, [start], [])
  return best
}

// Per-shape match result. Each shape walks the same incoming `walk.path` but
// looks for a different class of incompatibility. Adding a new shape (e.g. a
// future ConfigNode "missing required env var" rule) is one entry in
// `rootCauseShapes` plus its match function — no restructure to getRootCause.
interface RootCauseMatch {
  rootCauseNode: string
  rootCauseReason: string
  fixRecommendation?: string
}

type RootCauseShape = (
  graph: NeatGraph,
  origin: GraphNode,
  walk: Walk,
) => RootCauseMatch | null

// DatabaseNode origin → driver/engine compat (the original v0.1.x behavior,
// preserved verbatim). The walk ignores non-ServiceNodes; the first upstream
// service whose declared driver fails compat against the origin DB's
// (engine, engineVersion) wins.
function databaseRootCauseShape(
  graph: NeatGraph,
  origin: GraphNode,
  walk: Walk,
): RootCauseMatch | null {
  const targetDb = origin as DatabaseNode
  // Pairs that could possibly hit on this engine — narrowed once outside the
  // walk so we don't re-scan the matrix for every service we visit.
  const candidatePairs = compatPairs().filter((p) => p.engine === targetDb.engine)
  if (candidatePairs.length === 0) return null

  for (const id of walk.path) {
    // The compat carrier is a service: a ServiceNode resolves to itself, a
    // FileNode on the path resolves to its owning service via CONTAINS
    // (file-awareness.md §2). In a file-first graph the caller on the walk is
    // the FileNode that holds the CALLS edge, but the declared driver lives on
    // the service that owns it.
    const owner = resolveOwningService(graph, id)
    if (!owner) continue
    const { id: serviceId, svc } = owner
    const deps = svc.dependencies ?? {}
    for (const pair of candidatePairs) {
      const declared = deps[pair.driver]
      if (!declared) continue
      const result = checkCompatibility(
        pair.driver,
        declared,
        targetDb.engine,
        targetDb.engineVersion,
      )
      if (!result.compatible) {
        return {
          rootCauseNode: serviceId,
          rootCauseReason: result.reason ?? 'incompatible driver',
          ...(result.minDriverVersion
            ? {
                fixRecommendation: `Upgrade ${svc.name} ${pair.driver} driver to >= ${result.minDriverVersion}`,
              }
            : {}),
        }
      }
    }
  }
  return null
}

// ServiceNode origin → node-engine + package-conflict shapes from compat.ts.
// The check is over each ServiceNode along the incoming walk (the origin
// itself + any upstream callers): a node-engine constraint failing against
// the service's `engines.node`, or a package-conflict where a declared dep
// requires a peer at a higher version than the service has.
function serviceRootCauseShape(
  graph: NeatGraph,
  _origin: GraphNode,
  walk: Walk,
): RootCauseMatch | null {
  for (const id of walk.path) {
    // ServiceNode → itself; FileNode → owning service via CONTAINS
    // (file-awareness.md §2). The compat evidence (declared deps, node engine)
    // lives on the service, even when the caller on the walk is a file.
    const owner = resolveOwningService(graph, id)
    if (!owner) continue
    const { id: serviceId, svc } = owner
    const deps = svc.dependencies ?? {}
    const serviceNodeEngine = svc.nodeEngine

    for (const constraint of nodeEngineConstraints()) {
      const declared = deps[constraint.package]
      if (!declared) continue
      const result = checkNodeEngineConstraint(constraint, declared, serviceNodeEngine)
      if (!result.compatible && result.reason) {
        return {
          rootCauseNode: serviceId,
          rootCauseReason: result.reason,
          ...(result.requiredNodeVersion
            ? {
                fixRecommendation: `Bump ${svc.name}'s engines.node to >= ${result.requiredNodeVersion}`,
              }
            : {}),
        }
      }
    }

    for (const conflict of packageConflicts()) {
      const declared = deps[conflict.package]
      if (!declared) continue
      const requiredDeclared = deps[conflict.requires.name]
      const result = checkPackageConflict(conflict, declared, requiredDeclared)
      if (!result.compatible && result.reason) {
        return {
          rootCauseNode: serviceId,
          rootCauseReason: result.reason,
          fixRecommendation: `Upgrade ${svc.name}'s ${conflict.requires.name} to >= ${conflict.requires.minVersion}`,
        }
      }
    }
  }
  return null
}

// FileNode origin → resolve the file to its owning service (file-awareness.md
// §2) and run the service shape. In a file-first graph an error can land on a
// FileNode (the file that holds the failing CALLS edge); the incompatibility,
// if any, is still a property of the service that owns the file's declared
// dependencies. The owning service is folded into the origin's position so the
// service shape scans it alongside the upstream walk.
function fileRootCauseShape(
  graph: NeatGraph,
  origin: GraphNode,
  walk: Walk,
): RootCauseMatch | null {
  const owner = resolveOwningService(graph, origin.id)
  if (!owner) return null
  return serviceRootCauseShape(graph, owner.svc, walk)
}

// Dispatch by origin node type per ADR-037. Origin types not present here
// (InfraNode, ConfigNode, FrontierNode) cleanly return null — getRootCause
// needs an explicit shape to know what an "incompatibility" looks like for
// that origin, and those types don't have one yet.
const rootCauseShapes: Partial<Record<GraphNode['type'], RootCauseShape>> = {
  [NodeType.DatabaseNode]: databaseRootCauseShape,
  [NodeType.ServiceNode]: serviceRootCauseShape,
  [NodeType.FileNode]: fileRootCauseShape,
}

export function getRootCause(
  graph: NeatGraph,
  errorNodeId: string,
  errorEvent?: ErrorEvent,
): RootCauseResult | null {
  if (!graph.hasNode(errorNodeId)) return null
  const origin = graph.getNodeAttributes(errorNodeId) as GraphNode
  const shape = rootCauseShapes[origin.type]
  if (!shape) return null

  const walk = longestIncomingWalk(graph, errorNodeId, ROOT_CAUSE_MAX_DEPTH)
  const match = shape(graph, origin, walk)
  if (!match) return null

  const reason = errorEvent
    ? `${match.rootCauseReason} (observed error: ${errorEvent.errorMessage})`
    : match.rootCauseReason

  // Schema-validate before return (ADR-036, #139). A drift in the result
  // shape becomes a runtime throw at the call site rather than a silently
  // malformed payload reaching MCP / REST consumers.
  return RootCauseResultSchema.parse({
    rootCauseNode: match.rootCauseNode,
    rootCauseReason: reason,
    traversalPath: walk.path,
    edgeProvenances: walk.edges.map((e) => e.provenance),
    confidence: confidenceFromMix(walk.edges),
    fixRecommendation: match.fixRecommendation,
  })
}

// BFS along outgoing edges from origin. Records each reachable node with the
// shortest distance back to origin and the provenance of the edge that brought
// us to it. Best-provenance edge selection per pair mirrors getRootCause.
export function getBlastRadius(
  graph: NeatGraph,
  nodeId: string,
  maxDepth = BLAST_RADIUS_DEFAULT_DEPTH,
): BlastRadiusResult {
  if (!graph.hasNode(nodeId)) {
    return BlastRadiusResultSchema.parse({ origin: nodeId, affectedNodes: [], totalAffected: 0 })
  }

  // Each frame carries its full predecessor chain so the affected-node payload
  // can surface `path` (origin → ... → nodeId) and `confidence` (cascaded over
  // every edge along that path). The BFS visits each reachable node once on
  // its shortest-distance path; later frames at greater distance are dropped.
  interface Frame {
    nodeId: string
    distance: number
    path: string[]
    pathEdges: GraphEdge[]
  }

  const seen = new Map<string, BlastRadiusAffectedNode>()
  const queue: Frame[] = [{ nodeId, distance: 0, path: [nodeId], pathEdges: [] }]
  const enqueued = new Set<string>([nodeId])

  while (queue.length > 0) {
    const frame = queue.shift()!
    if (frame.distance > 0 && frame.pathEdges.length > 0) {
      const lastEdge = frame.pathEdges[frame.pathEdges.length - 1]!
      seen.set(frame.nodeId, {
        nodeId: frame.nodeId,
        distance: frame.distance,
        edgeProvenance: lastEdge.provenance,
        path: frame.path,
        confidence: confidenceFromMix(frame.pathEdges),
      })
    }
    if (frame.distance >= maxDepth) continue

    const outgoing = bestEdgeByTarget(graph, graph.outboundEdges(frame.nodeId))
    for (const [tgtId, edge] of outgoing) {
      if (enqueued.has(tgtId)) continue
      enqueued.add(tgtId)
      queue.push({
        nodeId: tgtId,
        distance: frame.distance + 1,
        path: [...frame.path, tgtId],
        pathEdges: [...frame.pathEdges, edge],
      })
    }
  }

  const affectedNodes = [...seen.values()].sort(
    (a, b) => a.distance - b.distance || a.nodeId.localeCompare(b.nodeId),
  )
  return BlastRadiusResultSchema.parse({
    origin: nodeId,
    affectedNodes,
    totalAffected: affectedNodes.length,
  })
}

// Default + max depth for transitive get_dependencies (issue #144). Default
// 3 keeps the output legible at the agent layer; the contract caps the
// caller-supplied value at 10 to prevent BFS blow-up on dense graphs.
export const TRANSITIVE_DEPENDENCIES_DEFAULT_DEPTH = 3
export const TRANSITIVE_DEPENDENCIES_MAX_DEPTH = 10

// Transitive get_dependencies (ADR-039 / #144). BFS outbound from origin to
// `depth` hops, returning a flat list with distance, edgeType, and provenance
// per dependency. Origin is never in the list. Direct-only consumers pass
// depth=1; the MCP get_dependencies tool defaults to 3.
//
// Reuses bestEdgeByTarget (FRONTIER filtered, PROV_RANK-best per pair) so
// dedup behavior matches the rest of traversal. Result is schema-validated
// before return per ADR-036 §Result schema validation.
export function getTransitiveDependencies(
  graph: NeatGraph,
  nodeId: string,
  depth: number = TRANSITIVE_DEPENDENCIES_DEFAULT_DEPTH,
): TransitiveDependenciesResult {
  if (!graph.hasNode(nodeId)) {
    return TransitiveDependenciesResultSchema.parse({
      origin: nodeId,
      depth,
      dependencies: [],
      total: 0,
    })
  }

  interface Frame {
    nodeId: string
    distance: number
    edge: GraphEdge | null
  }

  const seen = new Map<string, TransitiveDependency>()
  const queue: Frame[] = [{ nodeId, distance: 0, edge: null }]
  const enqueued = new Set<string>([nodeId])

  while (queue.length > 0) {
    const frame = queue.shift()!
    if (frame.distance > 0 && frame.edge) {
      seen.set(frame.nodeId, {
        nodeId: frame.nodeId,
        distance: frame.distance,
        edgeType: frame.edge.type,
        provenance: frame.edge.provenance,
      })
    }
    if (frame.distance >= depth) continue

    const outgoing = bestEdgeByTarget(graph, graph.outboundEdges(frame.nodeId))
    for (const [tgtId, edge] of outgoing) {
      if (enqueued.has(tgtId)) continue
      enqueued.add(tgtId)
      queue.push({ nodeId: tgtId, distance: frame.distance + 1, edge })
    }
  }

  const dependencies = [...seen.values()].sort(
    (a, b) => a.distance - b.distance || a.nodeId.localeCompare(b.nodeId),
  )
  return TransitiveDependenciesResultSchema.parse({
    origin: nodeId,
    depth,
    dependencies,
    total: dependencies.length,
  })
}
