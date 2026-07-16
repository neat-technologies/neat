import type {
  BlastRadiusAffectedNode,
  BlastRadiusResult,
  DatabaseNode,
  ErrorEvent,
  GraphEdge,
  GraphNode,
  ObservedDependenciesResult,
  RootCauseResult,
  ServiceNode,
  TransitiveDependenciesResult,
  TransitiveDependency,
} from '@neat.is/types'
import {
  BlastRadiusResultSchema,
  EdgeType,
  NodeType,
  ObservedDependenciesResultSchema,
  PROV_RANK,
  Provenance,
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
  incidents?: ErrorEvent[],
): RootCauseResult | null {
  if (!graph.hasNode(errorNodeId)) return null
  const origin = graph.getNodeAttributes(errorNodeId) as GraphNode
  const shape = rootCauseShapes[origin.type]

  if (shape) {
    const walk = longestIncomingWalk(graph, errorNodeId, ROOT_CAUSE_MAX_DEPTH)
    const match = shape(graph, origin, walk)
    if (match) {
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
  }

  // A service surfacing a failure may be the entry point of a cross-service
  // 500 that actually originates downstream. Nothing calls the entry service,
  // so the incoming walk above is empty — but its own OBSERVED CALLS edge to
  // the callee carries the failure. Follow that outbound failing CALLS chain to
  // the real culprit's handler before self-attributing the caller's mislabelled
  // CLIENT span (#589). Only null-returns here when no downstream call is
  // failing, i.e. the failure is in process at the origin.
  if (origin.type === NodeType.ServiceNode) {
    const crossService = crossServiceRootCause(graph, errorNodeId, incidents, errorEvent)
    if (crossService) return crossService
  }

  // No graph edge carried an incompatibility and no downstream call is failing —
  // but a service can fail in process (a 500 thrown inside its own handler)
  // without that failure ever crossing an edge, so the walk above sees a
  // healthy-looking node. The recorded incident store is the OBSERVED evidence
  // the graph can't carry: it localizes the failure to the file:line / route the
  // failing span captured. Consulting it here keeps root-cause useful for the
  // in-process case instead of reporting "healthy" over a pile of 500s (#584).
  return rootCauseFromIncidents(errorNodeId, incidents, errorEvent)
}

// OBSERVED-grade confidence for an incident-localized cause. The incident is a
// real captured runtime fact (where the failure surfaced), but it names the
// surface, not a proven upstream incompatibility — so it sits below an
// edge-walked compat result yet well above an EXTRACTED guess.
const INCIDENT_ROOT_CAUSE_CONFIDENCE = 0.6

// Match an incident to the queried node the same way the REST incident-history
// read does (api.ts): an exact affectedNode hit, or a service match when the
// node is the service the incident was recorded against. A file-grained
// affectedNode (file:<svc>:<path>) still matches the owning service this way.
function incidentMatchesNode(ev: ErrorEvent, nodeId: string): boolean {
  return ev.affectedNode === nodeId || ev.service === nodeId.replace(/^service:/, '')
}

// A failure localized to a node through the incident store: which node carries
// the cause, the human reason, the file the failure surfaced in (when the
// incident captured a `code.*` call site), and the derived fix.
interface IncidentLocalization {
  rootCauseNode: string
  rootCauseReason: string
  // The FileNode the failure surfaced in, present only when the incident
  // localized to a file grain. Callers walk node → file as a single OBSERVED
  // hop when this is set.
  fileNode?: string
  fixRecommendation?: string
}

// Pick the most recent incident affecting `nodeId` and localize the failure to
// the file:line / route it captured. Returns null when no incident touches the
// node. Shared by the in-process fallback and the cross-service chain (#589) so
// both describe a culprit's handler the same way.
function localizeFromIncidents(
  nodeId: string,
  incidents: ErrorEvent[] | undefined,
  errorEvent: ErrorEvent | undefined,
): IncidentLocalization | null {
  const pool = incidents && incidents.length > 0 ? incidents : errorEvent ? [errorEvent] : []
  const relevant = pool.filter((ev) => incidentMatchesNode(ev, nodeId))
  if (relevant.length === 0) return null

  // Most recent incident is the representative; ISO timestamps sort lexically.
  const latest = [...relevant].sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]!
  const attrs = latest.attributes ?? {}
  const filepath = typeof attrs['code.filepath'] === 'string' ? attrs['code.filepath'] : undefined
  const lineno = typeof attrs['code.lineno'] === 'number' ? attrs['code.lineno'] : undefined
  const route = typeof attrs['http.route'] === 'string' ? attrs['http.route'] : undefined
  const location = filepath ? `${filepath}${lineno !== undefined ? `:${lineno}` : ''}` : undefined

  // Count the incidents of *this* failure mode, not every incident on the node.
  // The reason names one message (`latest.errorMessage`); pairing it with the
  // node's total incident count reads as though that one error happened N times
  // when the node may be failing several different ways. Scope the count to the
  // records sharing this message so "3 recorded incidents" means three of the
  // failure the reason actually describes (issue #624).
  const sameMode = relevant.filter((ev) => ev.errorMessage === latest.errorMessage)
  const count = sameMode.length
  const tail = count > 1 ? ` (${count} recorded incidents)` : ' (1 recorded incident)'
  const reasonParts = [`${latest.service}: ${latest.errorMessage}`]
  if (location) reasonParts.push(`surfaced at ${location}`)
  const rootCauseReason = `${reasonParts.join(' — ')}${tail}`

  // When the incident localized to a file (affectedNode is a file id), name
  // that file as the root cause. The "edge" the caller walks is the captured
  // runtime attribution; OBSERVED is honest because the file came from a real
  // `code.*` on the failing span. Otherwise the cause sits on the node itself.
  const localizesToFile = latest.affectedNode !== nodeId && latest.affectedNode.startsWith('file:')
  const fileNode = localizesToFile ? latest.affectedNode : undefined

  const fixRecommendation = location
    ? `Inspect ${location}${route ? ` handling ${route}` : ''}`
    : route
      ? `Inspect ${latest.service}'s handler for ${route}`
      : undefined

  return {
    rootCauseNode: fileNode ?? nodeId,
    rootCauseReason,
    ...(fileNode ? { fileNode } : {}),
    ...(fixRecommendation ? { fixRecommendation } : {}),
  }
}

// Build a root-cause result from the recorded incident store when the graph
// walk found nothing. Localizes the failure to the queried node itself (or the
// file it surfaced in). Returns null when no incident touches the node — the
// honest "nothing to say" answer.
function rootCauseFromIncidents(
  nodeId: string,
  incidents: ErrorEvent[] | undefined,
  errorEvent: ErrorEvent | undefined,
): RootCauseResult | null {
  const loc = localizeFromIncidents(nodeId, incidents, errorEvent)
  if (!loc) return null

  const traversalPath = loc.fileNode ? [nodeId, loc.fileNode] : [nodeId]
  const edgeProvenances = loc.fileNode ? [Provenance.OBSERVED] : []

  return RootCauseResultSchema.parse({
    rootCauseNode: loc.rootCauseNode,
    rootCauseReason: loc.rootCauseReason,
    traversalPath,
    edgeProvenances,
    confidence: INCIDENT_ROOT_CAUSE_CONFIDENCE,
    ...(loc.fixRecommendation ? { fixRecommendation: loc.fixRecommendation } : {}),
  })
}

// A CALLS edge counts as failing when its OBSERVED signal recorded at least one
// error. This is the signal the cross-service chain follows: the caller's call
// to the callee returned a 5xx (#589).
function isFailingCallEdge(e: GraphEdge): boolean {
  return e.type === EdgeType.CALLS && (e.signal?.errorCount ?? 0) > 0
}

// Every node id that can originate an outbound CALLS edge on a service's behalf:
// the service itself, plus each FileNode it CONTAINS. A file-first graph anchors
// the caller's CALLS edge on the call-site file (file-awareness.md §4), so an
// entry service's failing call may hang off one of its files, not the bare
// service node.
function callSourcesForService(graph: NeatGraph, serviceId: string): string[] {
  const ids = [serviceId]
  for (const edgeId of graph.outboundEdges(serviceId)) {
    const e = graph.getEdgeAttributes(edgeId) as GraphEdge
    if (e.type !== EdgeType.CONTAINS) continue
    const tgt = graph.getNodeAttributes(e.target) as GraphNode
    if (tgt.type === NodeType.FileNode) ids.push(e.target)
  }
  return ids
}

// Did edge `e` to service `id` beat the current best failing call? Most recorded
// errors win; ties break on PROV_RANK, then target id — deterministic.
function failingCallDominates(
  e: GraphEdge,
  id: string,
  curEdge: GraphEdge,
  curId: string,
): boolean {
  const ec = e.signal?.errorCount ?? 0
  const cc = curEdge.signal?.errorCount ?? 0
  if (ec !== cc) return ec > cc
  if (PROV_RANK[e.provenance] !== PROV_RANK[curEdge.provenance]) {
    return PROV_RANK[e.provenance] > PROV_RANK[curEdge.provenance]
  }
  return id < curId
}

// The dominant failing outbound CALLS from a service: among the service's own
// edges and those of the files it owns, the failing CALLS edge to another
// service with the most recorded errors. Returns the next-hop service id and the
// edge, or null when no downstream call is failing — meaning the failure is in
// process here, not relayed from deeper.
function dominantFailingCall(
  graph: NeatGraph,
  serviceId: string,
  visited: Set<string>,
): { nextService: string; edge: GraphEdge } | null {
  let best: { nextService: string; edge: GraphEdge } | null = null
  for (const src of callSourcesForService(graph, serviceId)) {
    for (const edgeId of graph.outboundEdges(src)) {
      const e = graph.getEdgeAttributes(edgeId) as GraphEdge
      if (!isFailingCallEdge(e)) continue
      if (isFrontierNode(graph, e.target)) continue
      const owner = resolveOwningService(graph, e.target)
      if (!owner || visited.has(owner.id)) continue
      if (!best || failingCallDominates(e, owner.id, best.edge, best.nextService)) {
        best = { nextService: owner.id, edge: e }
      }
    }
  }
  return best
}

// Walk the failing CALLS chain outbound from an entry service to the deepest
// still-failing callee — the service whose own downstream calls are clean and
// whose handler therefore threw (#589). Returns the path of service ids, the
// failing edges along it, and the culprit, or null when nothing downstream is
// failing.
function followFailingCallChain(
  graph: NeatGraph,
  originServiceId: string,
  maxDepth: number,
): { path: string[]; edges: GraphEdge[]; culprit: string } | null {
  const path = [originServiceId]
  const edges: GraphEdge[] = []
  const visited = new Set<string>([originServiceId])
  let current = originServiceId

  for (let depth = 0; depth < maxDepth; depth++) {
    const hop = dominantFailingCall(graph, current, visited)
    if (!hop) break
    path.push(hop.nextService)
    edges.push(hop.edge)
    visited.add(hop.nextService)
    current = hop.nextService
  }

  if (edges.length === 0) return null
  return { path, edges, culprit: current }
}

// Localize a cross-service failure (#589). An entry ServiceNode surfaces a 500
// that originates downstream: follow the failing CALLS chain to the culprit and
// describe its handler, never the caller's mis-attributed CLIENT span. Returns
// null when no outbound call is failing — the failure is in process here and the
// caller falls through to the origin's own incident store.
function crossServiceRootCause(
  graph: NeatGraph,
  originId: string,
  incidents: ErrorEvent[] | undefined,
  errorEvent: ErrorEvent | undefined,
): RootCauseResult | null {
  const chain = followFailingCallChain(graph, originId, ROOT_CAUSE_MAX_DEPTH)
  if (!chain) return null

  const culprit = chain.culprit
  const path = [...chain.path]
  const edgeProvenances = chain.edges.map((e) => e.provenance)

  // Cross-service confidence cascades over the failing CALLS edges and the
  // incident-localization hop, so it lands below an edge-walked compat result.
  const baseConfidence = confidenceFromMix(chain.edges)
  const confidence = Math.max(0, Math.min(1, baseConfidence * INCIDENT_ROOT_CAUSE_CONFIDENCE))

  const loc = localizeFromIncidents(culprit, incidents, errorEvent)
  if (loc) {
    let rootCauseNode = culprit
    if (loc.fileNode) {
      path.push(loc.fileNode)
      edgeProvenances.push(Provenance.OBSERVED)
      rootCauseNode = loc.fileNode
    }
    return RootCauseResultSchema.parse({
      rootCauseNode,
      rootCauseReason: loc.rootCauseReason,
      traversalPath: path,
      edgeProvenances,
      confidence,
      ...(loc.fixRecommendation ? { fixRecommendation: loc.fixRecommendation } : {}),
    })
  }

  // No recorded incident for the culprit — still better than blaming the caller.
  // Name the culprit service and read the reason off the failing edge.
  const lastEdge = chain.edges[chain.edges.length - 1]!
  const errs = lastEdge.signal?.errorCount ?? 0
  const culpritName = culprit.replace(/^service:/, '')
  return RootCauseResultSchema.parse({
    rootCauseNode: culprit,
    rootCauseReason: `${culpritName} is failing downstream calls (${errs} observed error${errs === 1 ? '' : 's'})`,
    traversalPath: path,
    edgeProvenances,
    confidence,
    fixRecommendation: `Inspect ${culpritName}'s failing handler`,
  })
}

// BFS along *inbound* edges from origin — the origin's dependents, i.e. what
// breaks if the origin changes or fails (get-blast-radius.md, superseding
// ADR-038's outbound direction). An edge `A ──depends-on──▶ B` means A breaks
// when B changes, so the blast radius of B walks back along inbound edges to A
// and everything that transitively depends on it. For an inbound edge the
// neighbour is the edge's `source` (the dependent), so selection uses
// bestEdgeBySource — the same machinery getRootCause walks inbound with.
// Records each reachable dependent with the shortest distance back to origin
// and the provenance of the edge that brought us to it. A sink (a database,
// shared lib, leaf util) has no outbound edges but does have inbound ones, so
// this is what makes its blast radius non-empty.
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
      // Blast radius KEEPS CONTAINS: walked inbound, `file ◀─CONTAINS─ service`
      // means the service owns an affected file, so the service is genuinely in
      // the blast radius (file-awareness §36 — file-grained dependents plus the
      // owning service). Only get_dependencies filters CONTAINS (ADR-140), where
      // it's walked outbound and a service doesn't depend on its own files.
      seen.set(frame.nodeId, {
        nodeId: frame.nodeId,
        distance: frame.distance,
        edgeProvenance: lastEdge.provenance,
        path: frame.path,
        confidence: confidenceFromMix(frame.pathEdges),
      })
    }
    if (frame.distance >= maxDepth) continue

    const incoming = bestEdgeBySource(graph, graph.inboundEdges(frame.nodeId))
    for (const [srcId, edge] of incoming) {
      if (enqueued.has(srcId)) continue
      enqueued.add(srcId)
      queue.push({
        nodeId: srcId,
        distance: frame.distance + 1,
        path: [...frame.path, srcId],
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
    // Traverse THROUGH CONTAINS to reach a service's file-grained targets, but
    // never REPORT a CONTAINS edge as a dependency: a service doesn't depend on
    // its own files (file-awareness §36 refinement, ADR-140). The real target
    // reached via a genuine dependency edge downstream still surfaces.
    if (frame.distance > 0 && frame.edge && frame.edge.type !== EdgeType.CONTAINS) {
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

// Observed-only dependencies (issue #578). "What does this node actually call at
// runtime?" — its OBSERVED outbound edges, file-grained.
//
// The subtlety the previous edges-only query missed: the call-site processor
// lands OBSERVED CALLS on the FileNode that made the call, not on the owning
// ServiceNode (file-awareness §4). So a query that starts at a ServiceNode sees
// only its structural `CONTAINS` edges and reports "no runtime traffic," while
// the real dependency sits one hop away on a file it owns. When the origin is a
// ServiceNode we therefore also read the OBSERVED outbound of the FileNodes it
// `CONTAINS` and surface those file→target edges. This is not a service rollup
// (file-awareness §3): the edges stay file-grained with the owning file as the
// source; the service is only the grouping the query entered through.
//
// `observed` and `inboundObservedCount` separate two cases the old copy
// conflated: a pure receiver — a node runtime hits but which calls nothing
// downstream — has zero dependencies yet is plainly seen by OTel, so the caller
// must not ask "is OTel running?" at it. That question is honest only when there
// is no OBSERVED traffic at all and EXTRACTED outbound edges exist
// (`hasExtractedOutbound`).
export function getObservedDependencies(
  graph: NeatGraph,
  nodeId: string,
): ObservedDependenciesResult {
  if (!graph.hasNode(nodeId)) {
    return ObservedDependenciesResultSchema.parse({
      origin: nodeId,
      dependencies: [],
      observed: false,
      inboundObservedCount: 0,
      hasExtractedOutbound: false,
    })
  }

  const attrs = graph.getNodeAttributes(nodeId) as GraphNode

  // The origin plus, when it's a service, the files it owns — the set of nodes
  // whose OBSERVED edges belong to "what this thing does at runtime."
  const scope: string[] = [nodeId]
  if (attrs.type === NodeType.ServiceNode) {
    for (const edgeId of graph.outboundEdges(nodeId)) {
      const e = graph.getEdgeAttributes(edgeId) as GraphEdge
      if (e.type !== EdgeType.CONTAINS) continue
      const owned = graph.getNodeAttributes(e.target) as GraphNode
      if (owned.type === NodeType.FileNode) scope.push(e.target)
    }
  }

  const dependencies: GraphEdge[] = []
  const seenEdge = new Set<string>()
  let hasExtractedOutbound = false
  for (const src of scope) {
    for (const edgeId of graph.outboundEdges(src)) {
      const e = graph.getEdgeAttributes(edgeId) as GraphEdge
      // CONTAINS is structural ownership, never a runtime dependency.
      if (e.type === EdgeType.CONTAINS) continue
      if (e.provenance === Provenance.OBSERVED) {
        if (!seenEdge.has(e.id)) {
          seenEdge.add(e.id)
          dependencies.push(e)
        }
      } else if (e.provenance === Provenance.EXTRACTED) {
        hasExtractedOutbound = true
      }
    }
  }

  // Was this node (or a file it owns) seen receiving traffic? Counting OBSERVED
  // inbound edges is the pure-receiver signal — the "hit N times, calls nothing"
  // shape that must read differently from "never observed."
  let inboundObservedCount = 0
  for (const tgt of scope) {
    for (const edgeId of graph.inboundEdges(tgt)) {
      const e = graph.getEdgeAttributes(edgeId) as GraphEdge
      if (e.type === EdgeType.CONTAINS) continue
      if (e.provenance === Provenance.OBSERVED) inboundObservedCount += 1
    }
  }

  dependencies.sort(
    (a, b) =>
      a.target.localeCompare(b.target) ||
      a.source.localeCompare(b.source) ||
      a.id.localeCompare(b.id),
  )

  return ObservedDependenciesResultSchema.parse({
    origin: nodeId,
    dependencies,
    observed: dependencies.length > 0 || inboundObservedCount > 0,
    inboundObservedCount,
    hasExtractedOutbound,
  })
}
