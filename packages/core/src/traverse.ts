import type {
  BlastRadiusAffectedNode,
  BlastRadiusResult,
  DatabaseNode,
  ErrorEvent,
  ExpandNeighbour,
  ExpandResult,
  GraphEdge,
  GraphNode,
  NodeClassification,
  NodeContext,
  ObservedDependenciesResult,
  RelatePath,
  RelateResult,
  RootCauseCandidate,
  RootCauseResult,
  ServiceNode,
  TransitiveDependenciesResult,
  TransitiveDependency,
} from '@neat.is/types'
import { codeFilepathOf, codeLinenoOf } from './ingest.js'
import {
  BlastRadiusResultSchema,
  EdgeType,
  ExpandResultSchema,
  NodeType,
  ObservedDependenciesResultSchema,
  PROV_RANK,
  Provenance,
  RelateResultSchema,
  RootCauseResultSchema,
  TransitiveDependenciesResultSchema,
  fileId,
  frontierEdgeId,
  parseSymbolId,
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
// `service ──CONTAINS──▶ file` edge (file-awareness.md §2); a SymbolNode
// resolves one containment level deeper, up the inbound CONTAINS chain
// `symbol ◀─CONTAINS─ file ◀─CONTAINS─ service` (file-awareness.md §3, ADR-158
// §7). In a file-first, symbol-deep graph the caller on the path is a File- or
// SymbolNode, but the dependency declaration lives on the service that owns it —
// the file or symbol stays on the traversal path, the service is only named as
// the compat carrier. Anything else has no service to resolve to. Returns the
// resolved ServiceNode's id + attributes, or null.
function resolveOwningService(
  graph: NeatGraph,
  nodeId: string,
): { id: string; svc: ServiceNode } | null {
  if (!graph.hasNode(nodeId)) return null
  const attrs = graph.getNodeAttributes(nodeId) as GraphNode
  if (attrs.type === NodeType.ServiceNode) {
    return { id: nodeId, svc: attrs as ServiceNode }
  }
  // A FileNode is owned by its service directly; a SymbolNode is owned by its
  // file, which is in turn owned by the service. Walk the inbound CONTAINS edge
  // either way — the owner is a ServiceNode for a file (return it), or a FileNode
  // for a symbol (resolve that file the same way, one hop further).
  if (attrs.type === NodeType.FileNode || attrs.type === NodeType.SymbolNode) {
    for (const edgeId of graph.inboundEdges(nodeId)) {
      const e = graph.getEdgeAttributes(edgeId) as GraphEdge
      if (e.type !== EdgeType.CONTAINS) continue
      const owner = graph.getNodeAttributes(e.source) as GraphNode
      if (owner.type === NodeType.ServiceNode) {
        return { id: e.source, svc: owner as ServiceNode }
      }
      if (owner.type === NodeType.FileNode) {
        return resolveOwningService(graph, e.source)
      }
    }
  }
  return null
}

// A FRONTIER edge is a staged surface (ADR-226), not part of the settled graph:
// it is never ranked (PROV_RANK has no FRONTIER entry) and never traversed — the
// edge-level twin of the node-level "stop at FrontierNodes" gating (Rule 3). Every
// ranking / traversal site skips it, so a proposal never contests a settled edge.
function isFrontierEdge(e: GraphEdge): boolean {
  return e.provenance === Provenance.FRONTIER
}

// FRONTIER is excluded from PROV_RANK (ADR-226): a staged surface never contests a
// settled edge, and every ranking site skips it via `isFrontierEdge`. This keeps
// the floor honest for the type system and as defence-in-depth — an unranked
// provenance sorts below STALE (PROVENANCE.md's `STALE ≥ FRONTIER`), so even a
// stray FRONTIER edge that slips a skip can never be picked as the best edge.
function rankOf(p: GraphEdge['provenance']): number {
  return p === Provenance.FRONTIER ? -1 : PROV_RANK[p]
}

// Multiple edges between the same pair coexist by provenance (EXTRACTED next to
// OBSERVED next to INFERRED). Traversal walks the system as the graph "sees it
// best", so for any neighbour pair we pick the highest-provenance edge.
// Edges connecting to FrontierNodes are skipped at the node level (ADR-068):
// FrontierNodes are unresolved peers, traversal terminates at them rather than
// pretending the path continues into unknown territory. FRONTIER-provenance edges
// are skipped at the edge level (ADR-226): a staged surface is not settled graph.
function bestEdgeBySource(graph: NeatGraph, edgeIds: string[]): Map<string, GraphEdge> {
  const best = new Map<string, GraphEdge>()
  for (const id of edgeIds) {
    const e = graph.getEdgeAttributes(id) as GraphEdge
    if (isFrontierNode(graph, e.source) || isFrontierEdge(e)) continue
    const cur = best.get(e.source)
    if (!cur || rankOf(e.provenance) > rankOf(cur.provenance)) {
      best.set(e.source, e)
    }
  }
  return best
}

function bestEdgeByTarget(graph: NeatGraph, edgeIds: string[]): Map<string, GraphEdge> {
  const best = new Map<string, GraphEdge>()
  for (const id of edgeIds) {
    const e = graph.getEdgeAttributes(id) as GraphEdge
    if (isFrontierNode(graph, e.target) || isFrontierEdge(e)) continue
    const cur = best.get(e.target)
    if (!cur || rankOf(e.provenance) > rankOf(cur.provenance)) {
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
  // A FRONTIER surface (ADR-226) is a proposal about a cause NEAT could not observe
  // — the least-trusted claim it makes, below STALE (which was at least once seen).
  FRONTIER: 0.2,
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

// SymbolNode origin → resolve the symbol to its owning service through the
// inbound CONTAINS chain (symbol ◀─CONTAINS─ file ◀─CONTAINS─ service,
// file-awareness.md §3 / ADR-158 §7) and run the service shape — one grain finer
// than the FileNode case. A failure can land on a SymbolNode (the function that
// holds the failing edge); the incompatibility, if any, is still a property of
// the service that owns the symbol's declared dependencies. The symbol stays the
// origin on the traversal path; the service is only the resolved carrier.
function symbolRootCauseShape(
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
// that origin, and those types don't have one yet. Adding the SymbolNode shape
// (ADR-158 §7) is one entry: symbols ride the same service-carrier resolution
// files do, one containment level deeper.
const rootCauseShapes: Partial<Record<GraphNode['type'], RootCauseShape>> = {
  [NodeType.DatabaseNode]: databaseRootCauseShape,
  [NodeType.ServiceNode]: serviceRootCauseShape,
  [NodeType.FileNode]: fileRootCauseShape,
  [NodeType.SymbolNode]: symbolRootCauseShape,
}

// Which branch of the single-verdict walk produced a seed. The navigation reads
// this so it never second-guesses an edge- or compat-backed cause (ADR-209): only
// an `incident` seed — the failure localized to the queried node itself, no causal
// edge walked — is a candidate for the STALE-chain fallback.
type LegacyCauseSource = 'compat' | 'cross-service' | 'incident'
interface TaggedRootCause {
  result: RootCauseResult
  source: LegacyCauseSource
}

// The single-verdict root cause (ADR-037 / ADR-114): the compat shape, the
// cross-service failing-CALLS chain, then the incident store. This is the seed
// the navigation classifies and, when the seed is a saturated/stale victim,
// overrides. Retained verbatim so the deprecation escape hatch (ADR-189,
// NEAT_RCA_NAVIGATION=0) returns exactly the pre-navigation result; the `source`
// tag rides alongside and is dropped for that escape hatch.
function legacyRootCause(
  graph: NeatGraph,
  errorNodeId: string,
  errorEvent?: ErrorEvent,
  incidents?: ErrorEvent[],
): TaggedRootCause | null {
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
      return {
        source: 'compat',
        result: RootCauseResultSchema.parse({
          rootCauseNode: match.rootCauseNode,
          rootCauseReason: reason,
          traversalPath: walk.path,
          edgeProvenances: walk.edges.map((e) => e.provenance),
          confidence: confidenceFromMix(walk.edges),
          fixRecommendation: match.fixRecommendation,
        }),
      }
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
    if (crossService) return { result: crossService, source: 'cross-service' }
  }

  // No graph edge carried an incompatibility and no downstream call is failing —
  // but a service can fail in process (a 500 thrown inside its own handler)
  // without that failure ever crossing an edge, so the walk above sees a
  // healthy-looking node. The recorded incident store is the OBSERVED evidence
  // the graph can't carry: it localizes the failure to the file:line / route the
  // failing span captured. Consulting it here keeps root-cause useful for the
  // in-process case instead of reporting "healthy" over a pile of 500s (#584).
  const incident = rootCauseFromIncidents(errorNodeId, incidents, errorEvent)
  return incident ? { result: incident, source: 'incident' } : null
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
  if (ev.affectedNode === nodeId) return true
  if (ev.service === nodeId.replace(/^service:/, '')) return true
  // A symbol-grained incident (ADR-191) also matches its owning FILE, so a
  // file-grained query still surfaces a failure the finer node localized —
  // querying the function returns the function, querying its file still hits.
  const sym = parseSymbolId(ev.affectedNode)
  if (sym && fileId(sym.service, sym.relPath) === nodeId) return true
  return false
}

// A failure localized to a node through the incident store: which node carries
// the cause, the human reason, the file the failure surfaced in (when the
// incident captured a `code.*` call site), and the derived fix.
interface IncidentLocalization {
  rootCauseNode: string
  rootCauseReason: string
  // The finer node the failure surfaced in — a FileNode, or one grain deeper the
  // SymbolNode `code.function` named (ADR-191) — present only when the incident
  // localized below the queried node. Callers walk node → finer node as a single
  // OBSERVED hop when this is set.
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
  // Read the call site through the shared dual-name helper (semconv ≥1.33 stable
  // names + the prior ones), so incident localization survives either generation.
  const filepath = codeFilepathOf(attrs)
  const lineno = codeLinenoOf(attrs)
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

  // When the incident localized to a finer node — a file, or one grain deeper the
  // SYMBOL the failing span named via `code.function` (ADR-191) — name that node
  // as the root cause, so a query at any grain descends to the exact function the
  // failure surfaced in. OBSERVED is honest: the node came from a real `code.*` on
  // the failing span. Otherwise the cause sits on the queried node itself.
  const localizesFiner =
    latest.affectedNode !== nodeId &&
    (latest.affectedNode.startsWith('file:') || latest.affectedNode.startsWith('symbol:'))
  const fileNode = localizesFiner ? latest.affectedNode : undefined

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
  return e.type === EdgeType.CALLS && !isFrontierEdge(e) && (e.signal?.errorCount ?? 0) > 0
}

// Every node id that can originate an outbound CALLS edge on a service's behalf:
// the service itself, each FileNode it CONTAINS, and each SymbolNode those files
// CONTAIN. A file-first graph anchors the caller's CALLS edge on the call-site
// file (file-awareness.md §4); one grain finer, an OBSERVED CALLS edge lands on
// the calling SymbolNode (ADR-158 §4), so an entry service's failing call may
// hang off a file it owns or a symbol that file owns, not the bare service node.
// Descending the two CONTAINS levels keeps the cross-service chain symbol-aware
// without the reasoning ever branching on grain.
function callSourcesForService(graph: NeatGraph, serviceId: string): string[] {
  const ids = [serviceId]
  for (const edgeId of graph.outboundEdges(serviceId)) {
    const e = graph.getEdgeAttributes(edgeId) as GraphEdge
    if (e.type !== EdgeType.CONTAINS) continue
    const tgt = graph.getNodeAttributes(e.target) as GraphNode
    if (tgt.type !== NodeType.FileNode) continue
    ids.push(e.target)
    for (const symEdgeId of graph.outboundEdges(e.target)) {
      const se = graph.getEdgeAttributes(symEdgeId) as GraphEdge
      if (se.type !== EdgeType.CONTAINS) continue
      const sym = graph.getNodeAttributes(se.target) as GraphNode
      if (sym.type === NodeType.SymbolNode) ids.push(se.target)
    }
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
  if (rankOf(e.provenance) !== rankOf(curEdge.provenance)) {
    return rankOf(e.provenance) > rankOf(curEdge.provenance)
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

// A CALLS edge whose live signal has gone quiet: STALE provenance (ADR-209). The
// topology was OBSERVED once and remains in the graph, but the error signal
// `isFailingCallEdge` reads is gone — a stale snapshot lost it — so the failing
// chain above finds nothing to follow even though the causal chain is still here.
function isStaleCallEdge(e: GraphEdge): boolean {
  return e.type === EdgeType.CALLS && e.provenance === Provenance.STALE
}

// Did stale edge `e` to service `id` beat the current best stale hop? There is no
// error signal left to rank on — that is exactly what went quiet — so rank by the
// last-observed call volume (the hotter known path is the likelier carrier), then
// target id, deterministic like `failingCallDominates`.
function staleCallDominates(e: GraphEdge, id: string, curEdge: GraphEdge, curId: string): boolean {
  const ev = e.signal?.spanCount ?? e.callCount ?? 0
  const cv = curEdge.signal?.spanCount ?? curEdge.callCount ?? 0
  if (ev !== cv) return ev > cv
  return id < curId
}

// The dominant STALE outbound CALLS from a service, used only as the fallback when
// no fresh failing chain exists (ADR-209). Among the service's own edges and those
// of the files/symbols it owns, take the best-provenance CALLS edge PER callee
// service first — so a callee reachable by any fresher (OBSERVED/INFERRED/
// EXTRACTED) edge is represented by that fresher edge — then keep only the callees
// whose best edge is STALE. That PROV_RANK gate is the "nothing fresher is
// reachable" guard: a target the graph still knows freshly is never walked stalely.
function dominantStaleCall(
  graph: NeatGraph,
  serviceId: string,
  visited: Set<string>,
): { nextService: string; edge: GraphEdge } | null {
  const bestByCallee = new Map<string, GraphEdge>()
  for (const src of callSourcesForService(graph, serviceId)) {
    for (const edgeId of graph.outboundEdges(src)) {
      const e = graph.getEdgeAttributes(edgeId) as GraphEdge
      if (e.type !== EdgeType.CALLS) continue
      if (isFrontierNode(graph, e.target) || isFrontierEdge(e)) continue
      const owner = resolveOwningService(graph, e.target)
      if (!owner || visited.has(owner.id)) continue
      const cur = bestByCallee.get(owner.id)
      if (!cur || rankOf(e.provenance) > rankOf(cur.provenance)) {
        bestByCallee.set(owner.id, e)
      }
    }
  }
  let best: { nextService: string; edge: GraphEdge } | null = null
  for (const [id, edge] of bestByCallee) {
    if (!isStaleCallEdge(edge)) continue
    if (!best || staleCallDominates(edge, id, best.edge, best.nextService)) {
      best = { nextService: id, edge }
    }
  }
  return best
}

// Walk the STALE CALLS chain outbound from a service to its deepest stale-only
// callee — the last node the last-observed topology still reaches (ADR-209). The
// stale analogue of `followFailingCallChain`: same shape, but each hop is a target
// the graph knows ONLY stalely, so the whole chain is a low-confidence, honestly-
// provenanced hypothesis rather than a signal-backed verdict. Returns null when no
// stale-only outbound CALLS exists — a node with only fresh or no downstream edges.
function followStaleCallChain(
  graph: NeatGraph,
  originServiceId: string,
  maxDepth: number,
): { path: string[]; edges: GraphEdge[]; culprit: string } | null {
  const path = [originServiceId]
  const edges: GraphEdge[] = []
  const visited = new Set<string>([originServiceId])
  let current = originServiceId

  for (let depth = 0; depth < maxDepth; depth++) {
    const hop = dominantStaleCall(graph, current, visited)
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
      inboundVolume: 0,
      window: 'lifetime',
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
  // shape that must read differently from "never observed." Alongside the count,
  // the node-level inbound block (ADR-190): inboundVolume sums those edges' call
  // counts (how hard production hits this node — distinct from the edge count),
  // and inboundLastObserved is the most-recent inbound observation (when it was
  // last hit), raw, so a consumer formats recency itself.
  let inboundObservedCount = 0
  let inboundVolume = 0
  let inboundLastObserved: string | undefined
  for (const tgt of scope) {
    for (const edgeId of graph.inboundEdges(tgt)) {
      const e = graph.getEdgeAttributes(edgeId) as GraphEdge
      if (e.type === EdgeType.CONTAINS) continue
      if (e.provenance === Provenance.OBSERVED) {
        inboundObservedCount += 1
        inboundVolume += e.callCount ?? e.signal?.spanCount ?? 1
        if (e.lastObserved && (!inboundLastObserved || e.lastObserved > inboundLastObserved)) {
          inboundLastObserved = e.lastObserved
        }
      }
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
    // The signal is cumulative, so the honest window label is "lifetime" (ADR-190).
    inboundVolume,
    window: 'lifetime',
    ...(inboundLastObserved ? { inboundLastObserved } : {}),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent-driven navigation (ADR-189): Expand, Relate, per-node classification, and
// the candidate set that turns getRootCause from one verdict into navigation.
// Composes the traversal primitives above — no new engine. Branches only on
// node.type / edge.type / provenance / signal, never a provider, platform,
// framework, or language name (traversal.md agnosticity invariant).
// ─────────────────────────────────────────────────────────────────────────────

// A node's outbound p95 counts as saturated above this absolute latency. Absolute,
// not baseline-relative — matching how the signal is read (ADR-190) and how
// PRAXIS's classifier consumes pre-thresholded alerts. A hardcoded contract
// constant like ROOT_CAUSE_MAX_DEPTH.
const SATURATION_P95_MS = 1000

// The node plus, when it is a service, the files it owns — the set whose edges
// belong to "what this thing does at runtime" (the scope getObservedDependencies
// walks). A service's runtime signal lands on its files (file-awareness.md §4).
function nodeScope(graph: NeatGraph, nodeId: string): string[] {
  const scope = [nodeId]
  if (!graph.hasNode(nodeId)) return scope
  const attrs = graph.getNodeAttributes(nodeId) as GraphNode
  if (attrs.type === NodeType.ServiceNode) {
    for (const edgeId of graph.outboundEdges(nodeId)) {
      const e = graph.getEdgeAttributes(edgeId) as GraphEdge
      if (e.type !== EdgeType.CONTAINS) continue
      const owned = graph.getNodeAttributes(e.target) as GraphNode
      if (owned.type === NodeType.FileNode) scope.push(e.target)
    }
  }
  return scope
}

// How many recorded incidents localize to this node — errors emitted here.
function incidentCountForNode(nodeId: string, incidents: ErrorEvent[] | undefined): number {
  if (!incidents || incidents.length === 0) return 0
  return incidents.filter((ev) => incidentMatchesNode(ev, nodeId)).length
}

// #1114 — the dependency edge types that count as a node's real outbound deps.
// Mirrors the monitor's OBSERVED_DEP_EDGE_TYPES: CALLS + the connection/queue
// families. CONTAINS ownership is not a dependency.
const DEP_EDGE_TYPES: ReadonlySet<string> = new Set([
  EdgeType.CALLS,
  EdgeType.CONNECTS_TO,
  EdgeType.PUBLISHES_TO,
  EdgeType.CONSUMES_FROM,
])

// #1114 — is this incident a gateway/TIMEOUT-class failure, the observable
// shadow of a downstream that hung and exported nothing? A 504 gateway timeout,
// a gRPC DEADLINE_EXCEEDED, an ETIMEDOUT / "timed out". Mirrors ADR-220's
// deadline-exceeded/timeout families (kept local to avoid a divergences↔traverse
// import cycle) and deliberately EXCLUDES the fast-fails (UNAVAILABLE /
// ECONNREFUSED / other 5xx) that export an erroring edge NEAT can root-cause.
const TIMEOUT_ERROR_PATTERNS: readonly RegExp[] = [
  /\bDEADLINE_EXCEEDED\b/i,
  /\bdeadline exceeded\b/i,
  /\bETIMEDOUT\b/i,
  /\btimed[\s-]?out\b/i,
  /\btimeout\b/i,
]
function isBoundaryTimeoutError(ev: ErrorEvent): boolean {
  if (ev.httpStatusCode === 504) return true
  const haystack = [ev.errorType, ev.exceptionType, ev.errorMessage]
    .filter((s): s is string => typeof s === 'string')
    .join(' \n ')
  return TIMEOUT_ERROR_PATTERNS.some((re) => re.test(haystack))
}

// The separated classification inputs for a node (ADR-189). Reads real edge +
// incident signal only — nothing synthesized (file-awareness.md §6).
export function nodeContext(
  graph: NeatGraph,
  nodeId: string,
  incidents?: ErrorEvent[],
  now = Date.now(),
): NodeContext {
  const scope = nodeScope(graph, nodeId)
  let errorsFromCallers = 0
  let inboundVolume = 0
  let outboundVolume = 0
  let outboundErrors = 0
  let latestInboundMs: number | undefined
  let latencyP95Ms: number | undefined
  let stale = false
  let observedErroringDownstream = false
  let hasOutboundDeps = false

  for (const n of scope) {
    if (!graph.hasNode(n)) continue
    for (const edgeId of graph.inboundEdges(n)) {
      const e = graph.getEdgeAttributes(edgeId) as GraphEdge
      if (e.type === EdgeType.CONTAINS) continue
      // A FRONTIER edge is a staged surface, not settled signal (ADR-226): it
      // carries no observed traffic and must not feed classification context.
      if (isFrontierEdge(e)) continue
      errorsFromCallers += e.signal?.errorCount ?? 0
      inboundVolume += e.callCount ?? e.signal?.spanCount ?? 0
      if (e.provenance === Provenance.STALE) stale = true
      const p95 = e.signal?.latencyMs?.p95
      if (p95 !== undefined) latencyP95Ms = Math.max(latencyP95Ms ?? 0, p95)
      if (e.lastObserved) {
        const t = Date.parse(e.lastObserved)
        if (Number.isFinite(t)) latestInboundMs = Math.max(latestInboundMs ?? 0, t)
      }
    }
    for (const edgeId of graph.outboundEdges(n)) {
      const e = graph.getEdgeAttributes(edgeId) as GraphEdge
      if (e.type === EdgeType.CONTAINS) continue
      if (isFrontierEdge(e)) continue
      outboundVolume += e.callCount ?? e.signal?.spanCount ?? 0
      if (e.type === EdgeType.CALLS) outboundErrors += e.signal?.errorCount ?? 0
      if (e.provenance === Provenance.STALE) stale = true
      if (DEP_EDGE_TYPES.has(e.type)) {
        hasOutboundDeps = true
        if ((e.signal?.errorCount ?? 0) > 0) observedErroringDownstream = true
      }
    }
  }

  const errorsEmittedHere = incidentCountForNode(nodeId, incidents) + outboundErrors
  const lastObservedAgeMs =
    latestInboundMs !== undefined ? Math.max(0, now - latestInboundMs) : undefined
  const boundaryTimeout = (incidents ?? []).some(
    (ev) => incidentMatchesNode(ev, nodeId) && isBoundaryTimeoutError(ev),
  )

  return {
    errorsEmittedHere,
    errorsFromCallers,
    callCount: inboundVolume,
    outboundVolume,
    ...(lastObservedAgeMs !== undefined ? { lastObservedAgeMs } : {}),
    ...(latencyP95Ms !== undefined ? { latencyP95Ms } : {}),
    stale,
    boundaryTimeout,
    observedErroringDownstream,
    hasOutboundDeps,
  }
}

function isSaturated(ctx: NodeContext): boolean {
  return ctx.latencyP95Ms !== undefined && ctx.latencyP95Ms >= SATURATION_P95_MS
}

// #1114 — a boundary timeout is the observable shadow of an unobservable
// downstream: a symptom, not the fault. It emits a timeout-class error, fronts a
// downstream (has outbound deps), no caller is erroring into it, and — the
// load-bearing guard — nothing it can see downstream is erroring. A fast-fail
// (scaled-to-0 UNAVAILABLE, ECONNREFUSED) exports an erroring edge, so
// `observedErroringDownstream` is true there and this does NOT fire — the
// existing walk keeps root-causing the real culprit. A hang exports nothing, so
// there is no erroring downstream edge and the boundary 504 is the only signal.
export function isBoundaryTimeoutSymptom(ctx: NodeContext): boolean {
  return (
    ctx.errorsEmittedHere > 0 &&
    ctx.boundaryTimeout === true &&
    ctx.errorsFromCallers === 0 &&
    ctx.hasOutboundDeps === true &&
    ctx.observedErroringDownstream !== true
  )
}

// #1123 — the "unreachable" shape: a node that RECEIVED calls which predominantly
// failed but produced NO telemetry of its own — no incidents, no outbound calls.
// It never served: the requests never reached a running handler (a startup
// failure, a crash before the first span, an unschedulable / unhealthy pod). Its
// failure is real and OBSERVED (the erroring inbound edges), but the CAUSE is not
// in the trace, so it must be named honestly ("unreachable, cause unobserved")
// rather than as a primary-failure that invites an agent to hunt a nonexistent
// code fault. A node that actually ran leaves a trace — an own incident, or an
// outbound call of its own — so `errorsEmittedHere === 0 && outboundVolume === 0`
// is what separates "never served" from "served and failed".
const UNREACHABLE_INBOUND_ERROR_RATE = 0.5
const UNREACHABLE_MIN_INBOUND = 3
function isUnreachableSeed(ctx: NodeContext): boolean {
  return (
    ctx.callCount >= UNREACHABLE_MIN_INBOUND &&
    ctx.errorsFromCallers > 0 &&
    ctx.errorsFromCallers >= UNREACHABLE_INBOUND_ERROR_RATE * ctx.callCount &&
    ctx.errorsEmittedHere === 0 &&
    ctx.outboundVolume === 0
  )
}

// Classify a node from its separated context (ADR-189). A node that emits errors
// of its own is a primary-failure — unless it is stale/saturated and absorbs at
// least as much failure as it emits, i.e. it is drowning in load, a symptom; or
// it is a boundary timing out on an unobservable downstream (#1114). A node with
// errors arriving but none emitted is a downstream symptom. No signal → unrelated.
export function classifyNode(ctx: NodeContext): NodeClassification {
  if (ctx.errorsEmittedHere > 0) {
    if ((ctx.stale || isSaturated(ctx)) && ctx.errorsFromCallers >= ctx.errorsEmittedHere) {
      return 'symptom-only'
    }
    if (isBoundaryTimeoutSymptom(ctx)) return 'symptom-only'
    return 'primary-failure'
  }
  // #1123 — received failing calls but produced nothing of its own: never served.
  if (isUnreachableSeed(ctx)) return 'unreachable'
  if (ctx.errorsFromCallers > 0) return 'symptom-only'
  return 'unrelated'
}

// The seed is a saturated/stale victim — a starved downstream node the load hit,
// not the fault. When it is, navigation walks up to the load origin instead of
// naming it (ADR-189): errors arrive, the node emits no more than it receives,
// and it has gone stale or saturated.
function isVictimSeed(ctx: NodeContext): boolean {
  return (
    ctx.errorsFromCallers > 0 &&
    (ctx.stale || isSaturated(ctx)) &&
    ctx.errorsEmittedHere <= ctx.errorsFromCallers
  )
}

// Generic connection-failure phrases that mark a node's failure as an outbound
// one in its own incident text — a name-resolution failure, a refused or reset
// connection, an "unable to connect", a lookup that never resolved. These are
// error *semantics*, never provider or datastore names: the reasoning core never
// learns what any particular data store is (traversal.md agnosticity), only that
// the node reported it could not reach something downstream. Matched
// case-insensitively against the incident's message / type / stacktrace.
const OUTBOUND_CONNECTION_FAILURE_PATTERNS = [
  'name resolution',
  'resolve host',
  'getaddrinfo',
  'enotfound',
  'connection refused',
  'econnrefused',
  'connection reset',
  'econnreset',
  'able to connect',
  'failed to connect',
  'cannot connect',
  'could not connect',
  'unable to connect',
  'connection timed out',
  'etimedout',
  'no route to host',
  'host unreachable',
  'network is unreachable',
  'connection closed',
]

// Does this incident's own error text read as a failure to reach an outbound
// dependency (a datastore connection, a name lookup, a downstream call) rather
// than an in-process throw? The fallback signal when the outbound edge carries
// no error count of its own — the connection died before a span could record it,
// so the edge looks clean while the incident holds the real story.
function incidentTextIndicatesOutboundFailure(ev: ErrorEvent): boolean {
  const haystack = [ev.errorMessage, ev.errorType, ev.exceptionType, ev.exceptionStacktrace]
    .filter((s): s is string => typeof s === 'string')
    .join(' ')
    .toLowerCase()
  return OUTBOUND_CONNECTION_FAILURE_PATTERNS.some((p) => haystack.includes(p))
}

// Does the node fail because of its OWN outbound dependency rather than the load
// hitting it? A downstream edge that recorded errors — a CALLS to another service
// OR a CONNECTS_TO a datastore — means the fault originates in a dependency this
// node drives, so the victim → load-origin move must not bury it behind the
// traffic source (#1075). Scans every outbound edge type, not just CALLS:
// isFailingCallEdge is CALLS-only, so a datastore auth/connection failure riding
// a CONNECTS_TO edge would otherwise be invisible to the victim gate. When the
// seed came from the incident store and carries no failing outbound edge (the
// connection died before a span landed), its error text is the fallback signal —
// an outbound connection failure in the message counts the same as a failing edge.
function hasFailingOutbound(
  graph: NeatGraph,
  nodeId: string,
  seedSource: LegacyCauseSource,
  incidents: ErrorEvent[] | undefined,
): boolean {
  for (const n of nodeScope(graph, nodeId)) {
    if (!graph.hasNode(n)) continue
    for (const edgeId of graph.outboundEdges(n)) {
      const e = graph.getEdgeAttributes(edgeId) as GraphEdge
      if (e.type === EdgeType.CONTAINS) continue
      if ((e.signal?.errorCount ?? 0) > 0) return true
    }
  }
  if (seedSource === 'incident' && incidents) {
    for (const ev of incidents) {
      if (incidentMatchesNode(ev, nodeId) && incidentTextIndicatesOutboundFailure(ev)) return true
    }
  }
  return false
}

// The grain of a node, for a Relate path annotation.
function grainOf(graph: NeatGraph, nodeId: string): string {
  if (!graph.hasNode(nodeId)) return 'unknown'
  const t = (graph.getNodeAttributes(nodeId) as GraphNode).type
  if (t === NodeType.ServiceNode) return 'service'
  if (t === NodeType.FileNode) return 'file'
  if (t === NodeType.SymbolNode) return 'symbol'
  return t
}

interface FoundPath {
  nodes: string[]
  edges: GraphEdge[]
}

// Shortest directed path from `from` to `to`, depth-bounded, in one direction.
// 'up' walks inbound (bestEdgeBySource — callers/dependents), 'down' walks
// outbound (bestEdgeByTarget — callees/dependencies): the same PROV_RANK-best,
// FRONTIER-terminating primitives the rest of traversal uses, deterministic in
// neighbour order. Returns null when `to` is unreachable within maxDepth — a
// depth-bounded absence, honestly.
function findPath(
  graph: NeatGraph,
  from: string,
  to: string,
  direction: 'up' | 'down',
  maxDepth: number,
): FoundPath | null {
  if (!graph.hasNode(from) || !graph.hasNode(to)) return null
  if (from === to) return { nodes: [from], edges: [] }

  interface Frame {
    nodeId: string
    depth: number
    nodes: string[]
    edges: GraphEdge[]
  }
  const queue: Frame[] = [{ nodeId: from, depth: 0, nodes: [from], edges: [] }]
  const enqueued = new Set<string>([from])

  while (queue.length > 0) {
    const frame = queue.shift()!
    if (frame.depth >= maxDepth) continue
    const best =
      direction === 'up'
        ? bestEdgeBySource(graph, graph.inboundEdges(frame.nodeId))
        : bestEdgeByTarget(graph, graph.outboundEdges(frame.nodeId))
    const neighbours = [...best.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    for (const [nid, edge] of neighbours) {
      if (nid === to) return { nodes: [...frame.nodes, nid], edges: [...frame.edges, edge] }
      if (enqueued.has(nid)) continue
      enqueued.add(nid)
      queue.push({
        nodeId: nid,
        depth: frame.depth + 1,
        nodes: [...frame.nodes, nid],
        edges: [...frame.edges, edge],
      })
    }
  }
  return null
}

const EMPTY_CONTEXT: NodeContext = {
  errorsEmittedHere: 0,
  errorsFromCallers: 0,
  callCount: 0,
  outboundVolume: 0,
  stale: false,
}

// Expand(node, up | down) — one bidirectional neighbourhood step (ADR-189).
// `up` = inbound (callers/dependents), `down` = outbound (callees/dependencies).
// Returns the stepped node's own classification + context and its immediate
// runtime neighbours', so a caller navigates one legible hop at a time.
export function expandNode(
  graph: NeatGraph,
  nodeId: string,
  direction: 'up' | 'down',
  incidents?: ErrorEvent[],
  now = Date.now(),
): ExpandResult {
  if (!graph.hasNode(nodeId)) {
    return ExpandResultSchema.parse({
      origin: nodeId,
      direction,
      node: { id: nodeId, classification: 'unrelated', context: EMPTY_CONTEXT },
      neighbours: [],
    })
  }
  const ctx = nodeContext(graph, nodeId, incidents, now)
  const best =
    direction === 'up'
      ? bestEdgeBySource(graph, graph.inboundEdges(nodeId))
      : bestEdgeByTarget(graph, graph.outboundEdges(nodeId))
  const neighbours: ExpandNeighbour[] = []
  for (const [nid, edge] of best) {
    // CONTAINS is structural ownership, not a runtime caller/callee.
    if (edge.type === EdgeType.CONTAINS) continue
    const nctx = nodeContext(graph, nid, incidents, now)
    neighbours.push({
      node: nid,
      edgeType: edge.type,
      provenance: edge.provenance,
      classification: classifyNode(nctx),
      context: nctx,
    })
  }
  neighbours.sort((a, b) => a.node.localeCompare(b.node))
  return ExpandResultSchema.parse({
    origin: nodeId,
    direction,
    node: { id: nodeId, classification: classifyNode(ctx), context: ctx },
    neighbours,
  })
}

// Relate(a, b) — pairwise directed link-confirmation (ADR-189). Searches both
// ways but labels the direction it found, preferring a→b (cause→symptom). Each
// path carries per-hop provenance + grain and a carriesSignal summary — whether
// the failure runs end to end. No path within maxDepth → related: false with the
// honest "no path within N hops" note, never "unrelated."
export function relate(
  graph: NeatGraph,
  a: string,
  b: string,
  maxDepth = ROOT_CAUSE_MAX_DEPTH,
): RelateResult {
  const buildPath = (fp: FoundPath): RelatePath => ({
    nodes: fp.nodes,
    edgeTypes: fp.edges.map((e) => e.type),
    provenance: fp.edges.map((e) => e.provenance),
    grain: fp.nodes.map((n) => grainOf(graph, n)),
    // The failure runs end to end when every hop carries error / latency / alert
    // signal — that is what turns reachability into cause-confirmation.
    carriesSignal:
      fp.edges.length > 0 &&
      fp.edges.every(
        (e) =>
          (e.signal?.errorCount ?? 0) > 0 ||
          e.signal?.latencyMs !== undefined ||
          e.signal?.anomalous !== undefined,
      ),
  })

  if (!graph.hasNode(a) || !graph.hasNode(b)) {
    return RelateResultSchema.parse({
      a,
      b,
      related: false,
      direction: null,
      paths: [],
      note: !graph.hasNode(a) ? `node not found: ${a}` : `node not found: ${b}`,
    })
  }

  // a→b means a is upstream (its outbound chain reaches b); b→a means b is
  // upstream (a's inbound chain reaches b).
  const down = findPath(graph, a, b, 'down', maxDepth)
  const up = findPath(graph, a, b, 'up', maxDepth)

  if (!down && !up) {
    return RelateResultSchema.parse({
      a,
      b,
      related: false,
      direction: null,
      paths: [],
      note: `no path within ${maxDepth} hops`,
    })
  }

  const paths: RelatePath[] = []
  const direction: 'a->b' | 'b->a' = down ? 'a->b' : 'b->a'
  if (down) paths.push(buildPath(down))
  if (up) paths.push(buildPath(up))

  // Grain gap: a and b are both finer than service, but the connecting path only
  // links through a service-grain hop — the fine link was never observed, so the
  // coarser path is returned and the gap flagged (file-awareness.md §6).
  const endpointsFine = grainOf(graph, a) !== 'service' && grainOf(graph, b) !== 'service'
  const grainGap = endpointsFine && paths[0]!.grain.some((g) => g === 'service')

  return RelateResultSchema.parse({
    a,
    b,
    related: true,
    direction,
    paths,
    ...(grainGap ? { grainGap: true } : {}),
  })
}

// The load origin feeding a saturated/stale subgraph: among the nodes upstream of
// the alert (its inbound-reachable dependents, the get_blast_radius set), the pure
// source — nothing observed drives it — that itself drives the most outbound
// volume. This is the topology move ADR-189 names ("walk up to the highest-volume
// feeder"), selected by graph shape, never by a provider or service name.
function findLoadOrigin(
  graph: NeatGraph,
  alertNodeId: string,
  incidents: ErrorEvent[] | undefined,
  now: number,
): { node: string; ctx: NodeContext } | null {
  const upstream = getBlastRadius(graph, alertNodeId).affectedNodes.map((n) => n.nodeId)
  let best: { node: string; ctx: NodeContext; isSource: boolean } | null = null
  for (const nid of upstream) {
    if (nid === alertNodeId) continue
    const ctx = nodeContext(graph, nid, incidents, now)
    if (ctx.outboundVolume === 0) continue // drives nothing — not a feeder
    const isSource = ctx.callCount === 0 // nothing observed calls it — a pure driver
    const better =
      !best ||
      (isSource !== best.isSource
        ? isSource
        : ctx.outboundVolume !== best.ctx.outboundVolume
          ? ctx.outboundVolume > best.ctx.outboundVolume
          : nid < best.node)
    if (better) best = { node: nid, ctx, isSource }
  }
  return best ? { node: best.node, ctx: best.ctx } : null
}

// An OBSERVED-grade ceiling on the promoted load origin's confidence. The cause is
// inferred from several converging runtime signals rather than one captured
// incident, so it earns a high but never-certain score — honest for a multi-signal
// OBSERVED inference, which never claims 1.0.
const LOAD_ORIGIN_CONFIDENCE_CEILING = 0.9

// Confidence for the promoted load origin (ADR-189), graded by the strength of the
// separated evidence the navigation already computed — the ADR-189 classification
// inputs and the ADR-190 latency signal — rather than a flat floor. Each
// corroborating signal lifts it toward the OBSERVED ceiling: a clean cause/symptom
// split (errors arrive from the victim's callers, none originate there), the victim
// gone STALE under load, its inbound latency saturated, and the volume of load the
// origin drives. Bounded [0, LOAD_ORIGIN_CONFIDENCE_CEILING].
function loadOriginConfidence(originCtx: NodeContext, seedCtx: NodeContext): number {
  // The core signal: how cleanly the victim reads as a symptom. Errors arrive from
  // its callers, and none (a clean split) — or fewer (a partial one) — originate
  // locally.
  const cleanSplit = seedCtx.errorsFromCallers > 0 && seedCtx.errorsEmittedHere === 0
  const partialSplit = seedCtx.errorsFromCallers > seedCtx.errorsEmittedHere

  let evidence = 0
  evidence += cleanSplit ? 0.45 : partialSplit ? 0.2 : 0
  evidence += seedCtx.stale ? 0.2 : 0
  evidence += isSaturated(seedCtx) ? 0.15 : 0
  // A high-volume driver is a stronger load origin than a trickle. volumeWeight maps
  // a call/span count into [0.5, 1]; rescale its headroom into [0, 0.2].
  evidence += (volumeWeight(originCtx.outboundVolume) - 0.5) * 0.4

  // An anchor keeps a single signal from ever reading as certainty; the evidence
  // then climbs toward the ceiling. isVictimSeed already guarantees real victim
  // signal (errors from callers, plus STALE or saturation) before we reach here.
  const anchor = 0.45
  const confidence = anchor + Math.min(1, evidence) * (LOAD_ORIGIN_CONFIDENCE_CEILING - anchor)
  return Math.max(0, Math.min(LOAD_ORIGIN_CONFIDENCE_CEILING, confidence))
}

// Human display name for a node id inside a reason sentence — strips the `type:`
// prefix the same way the cross-service reason does.
function displayNameOf(nodeId: string): string {
  return nodeId.replace(/^[a-z]+:/, '')
}

// getRootCause (ADR-189): navigation over the fused graph. Seeds from the single
// verdict (legacyRootCause), classifies that seed, and — when the seed is a
// saturated/stale victim — walks up to the load origin instead of naming the
// victim. Returns a ranked candidate set with per-node classification + evidence
// alongside the legacy verdict fields, which stay populated (candidates[0] is the
// top cause and rootCauseNode tracks it) for one deprecation cycle.
// NEAT_RCA_NAVIGATION=0 (or opts.navigation === false) returns the pre-navigation
// single verdict verbatim.
export function getRootCause(
  graph: NeatGraph,
  errorNodeId: string,
  errorEvent?: ErrorEvent,
  incidents?: ErrorEvent[],
  opts?: { navigation?: boolean; now?: number },
): RootCauseResult | null {
  const tagged = legacyRootCause(graph, errorNodeId, errorEvent, incidents)
  if (!tagged) return null
  const navigation = opts?.navigation ?? process.env.NEAT_RCA_NAVIGATION !== '0'
  if (!navigation) return tagged.result
  return enrichWithNavigation(graph, errorNodeId, tagged, incidents, opts?.now ?? Date.now())
}

// #1114 — the failing request's route, from the boundary's own incident. Used to
// narrow the structural walk to the declared edge that serves THAT route, not the
// boundary's whole fan-out.
function boundaryIncidentRoute(
  nodeId: string,
  incidents: ErrorEvent[] | undefined,
): string | undefined {
  for (const ev of incidents ?? []) {
    if (!incidentMatchesNode(ev, nodeId)) continue
    const r =
      ev.attributes?.['http.route'] ?? ev.attributes?.['http.target'] ?? ev.attributes?.['url.path']
    if (typeof r === 'string' && r.length > 0) return r
  }
  return undefined
}

// A node's DECLARED (EXTRACTED) outbound dependency callees, each with the route
// its declared edge serves when the extractor captured one. Declared, because a
// hang leaves no observed edge — the declared call graph is the only path left.
function declaredOutboundCallees(
  graph: NeatGraph,
  nodeId: string,
): Array<{ target: string; route?: string }> {
  const byTarget = new Map<string, { target: string; route?: string }>()
  for (const n of nodeScope(graph, nodeId)) {
    if (!graph.hasNode(n)) continue
    for (const edgeId of graph.outboundEdges(n)) {
      const e = graph.getEdgeAttributes(edgeId) as GraphEdge
      if (!DEP_EDGE_TYPES.has(e.type)) continue
      if (e.provenance !== Provenance.EXTRACTED) continue
      if (e.target === nodeId || byTarget.has(e.target)) continue
      const route = e.evidence?.pathTemplate
      byTarget.set(
        e.target,
        route !== undefined ? { target: e.target, route } : { target: e.target },
      )
    }
  }
  return [...byTarget.values()]
}

function normalizeRoute(s: string): string {
  return s.replace(/\/+$/, '').toLowerCase()
}
function routeMatches(declared: string, incident: string): boolean {
  const a = normalizeRoute(declared)
  const b = normalizeRoute(incident)
  return a === b || a.startsWith(b) || b.startsWith(a)
}

// The single declared (EXTRACTED) callee a node serves for a route, or null when
// the route doesn't narrow to one (or the node declares nothing). The first
// unobservable hop on the declared serving path.
function firstDeclaredCallee(
  graph: NeatGraph,
  node: string,
  route: string | undefined,
): string | null {
  const callees = declaredOutboundCallees(graph, node)
  if (callees.length === 0) return null
  const narrowed =
    route !== undefined
      ? callees.filter((c) => c.route !== undefined && routeMatches(c.route, route))
      : callees
  const chosen = narrowed.length === 1 ? narrowed[0]! : callees.length === 1 ? callees[0]! : null
  return chosen ? chosen.target : null
}

// The OBSERVED outbound next-services of a node (the runtime dependency families,
// not CONTAINS). Used to cross ONE observed hop when an infra boundary declares
// nothing for the failing route — the observed layer reached the next service even
// though the hung culprit beyond it exported no span.
function observedOutboundNextServices(graph: NeatGraph, nodeId: string): string[] {
  const targets = new Set<string>()
  for (const n of nodeScope(graph, nodeId)) {
    if (!graph.hasNode(n)) continue
    for (const edgeId of graph.outboundEdges(n)) {
      const e = graph.getEdgeAttributes(edgeId) as GraphEdge
      if (!DEP_EDGE_TYPES.has(e.type)) continue
      if (e.provenance !== Provenance.OBSERVED) continue
      if (e.target !== nodeId) targets.add(e.target)
    }
  }
  return [...targets]
}

// #1114b / ADR-226 — the unobservable hop the hang sensor stages a FRONTIER surface
// on: the edge NEAT reached toward but cannot see because its far end hung. Route-
// driven — resolve the failing route (from the boundary's incident) against the
// boundary's OWN declared callees; when the boundary declares nothing for that
// route (an infra proxy like frontend-proxy), cross ONE observed hop into the next
// service and resolve there. The crossing is taken only when exactly one observed
// next-service yields a resolving declared callee — never a fan-out, never an
// observed healthy branch mistaken for the hang path. Returns the hop
// `{ source, target }` to stage, or null (honest-coarse — propose nothing).
export function resolveHangHop(
  graph: NeatGraph,
  boundaryNode: string,
  incidents: ErrorEvent[] | undefined,
): { source: string; target: string; route?: string } | null {
  const route = boundaryIncidentRoute(boundaryNode, incidents)
  // 1) the boundary's own declared first callee.
  const own = firstDeclaredCallee(graph, boundaryNode, route)
  if (own) {
    return route !== undefined
      ? { source: boundaryNode, target: own, route }
      : { source: boundaryNode, target: own }
  }
  // 2) cross one observed hop; resolve the route at the single observed next-service.
  const resolved = observedOutboundNextServices(graph, boundaryNode)
    .map((n) => ({ source: n, target: firstDeclaredCallee(graph, n, route) }))
    .filter((r): r is { source: string; target: string } => r.target !== null)
  if (resolved.length === 1) {
    const hop = resolved[0]!
    return route !== undefined ? { ...hop, route } : hop
  }
  return null
}

// ADR-226 — read the staged FRONTIER surface for a boundary-timeout hang: the hop
// the sensor staged (hang-sensor.ts), located by the same resolver and confirmed to
// exist as a FRONTIER edge in the graph. Returns the proposed culprit (the surface's
// target) + route, or null when no surface is staged — honest-coarse (the sensor
// hasn't seen this hang yet, or nothing resolved). The reader reads the surface; it
// does not re-invent a cause the graph does not carry.
function stagedHangProposal(
  graph: NeatGraph,
  boundaryNode: string,
  incidents: ErrorEvent[] | undefined,
): { node: string; route?: string } | null {
  const hop = resolveHangHop(graph, boundaryNode, incidents)
  if (!hop) return null
  if (!graph.hasEdge(frontierEdgeId(hop.source, hop.target, EdgeType.CALLS))) return null
  return hop.route !== undefined ? { node: hop.target, route: hop.route } : { node: hop.target }
}

// The single declared (EXTRACTED) callee a node serves for a route, or null when
// the route doesn't narrow to one (or the node declares nothing). The first
// unobservable hop on the declared serving path.
function firstDeclaredCallee(
  graph: NeatGraph,
  node: string,
  route: string | undefined,
): string | null {
  const callees = declaredOutboundCallees(graph, node)
  if (callees.length === 0) return null
  const narrowed =
    route !== undefined
      ? callees.filter((c) => c.route !== undefined && routeMatches(c.route, route))
      : callees
  const chosen = narrowed.length === 1 ? narrowed[0]! : callees.length === 1 ? callees[0]! : null
  return chosen ? chosen.target : null
}

// The OBSERVED outbound next-services of a node (the runtime dependency families,
// not CONTAINS). Used to cross ONE observed hop when an infra boundary declares
// nothing for the failing route — the observed layer reached the next service even
// though the hung culprit beyond it exported no span.
function observedOutboundNextServices(graph: NeatGraph, nodeId: string): string[] {
  const targets = new Set<string>()
  for (const n of nodeScope(graph, nodeId)) {
    if (!graph.hasNode(n)) continue
    for (const edgeId of graph.outboundEdges(n)) {
      const e = graph.getEdgeAttributes(edgeId) as GraphEdge
      if (!DEP_EDGE_TYPES.has(e.type)) continue
      if (e.provenance !== Provenance.OBSERVED) continue
      if (e.target !== nodeId) targets.add(e.target)
    }
  }
  return [...targets]
}

// #1114b / ADR-226 — the unobservable hop the hang sensor stages a FRONTIER surface
// on: the edge NEAT reached toward but cannot see because its far end hung. Route-
// driven — resolve the failing route (from the boundary's incident) against the
// boundary's OWN declared callees; when the boundary declares nothing for that
// route (an infra proxy like frontend-proxy), cross ONE observed hop into the next
// service and resolve there. The crossing is taken only when exactly one observed
// next-service yields a resolving declared callee — never a fan-out, never an
// observed healthy branch mistaken for the hang path. Returns the hop
// `{ source, target }` to stage, or null (honest-coarse — propose nothing).
export function resolveHangHop(
  graph: NeatGraph,
  boundaryNode: string,
  incidents: ErrorEvent[] | undefined,
): { source: string; target: string; route?: string } | null {
  const route = boundaryIncidentRoute(boundaryNode, incidents)
  // 1) the boundary's own declared first callee.
  const own = firstDeclaredCallee(graph, boundaryNode, route)
  if (own) {
    return route !== undefined
      ? { source: boundaryNode, target: own, route }
      : { source: boundaryNode, target: own }
  }
  // 2) cross one observed hop; resolve the route at the single observed next-service.
  const resolved = observedOutboundNextServices(graph, boundaryNode)
    .map((n) => ({ source: n, target: firstDeclaredCallee(graph, n, route) }))
    .filter((r): r is { source: string; target: string } => r.target !== null)
  if (resolved.length === 1) {
    const hop = resolved[0]!
    return route !== undefined ? { ...hop, route } : hop
  }
  return null
}

function enrichWithNavigation(
  graph: NeatGraph,
  errorNodeId: string,
  tagged: TaggedRootCause,
  incidents: ErrorEvent[] | undefined,
  now: number,
): RootCauseResult {
  const legacy = tagged.result
  const seedNode = legacy.rootCauseNode
  const seedCtx = graph.hasNode(seedNode) ? nodeContext(graph, seedNode, incidents, now) : null
  const lastProv = legacy.edgeProvenances[legacy.edgeProvenances.length - 1]
  const candidates: RootCauseCandidate[] = []

  // The dead-end the STALE-chain fallback exists to fix (ADR-209): the single
  // verdict localized the failure to the queried node itself (`source === 'incident'`,
  // no causal edge walked), yet a STALE-only outbound CALLS chain runs downstream —
  // the topology is still in the graph, only its live signal went quiet. Walking
  // nothing and naming the queried node hands the agent the symptom. `isVictimSeed`
  // (errors arriving) takes precedence; a compat / cross-service seed is never
  // second-guessed; a genuinely isolated node (no stale chain) stays primary-failure.
  const deadEndOnSymptom =
    tagged.source === 'incident' &&
    seedNode === errorNodeId &&
    legacy.traversalPath.length === 1
  const staleChain =
    deadEndOnSymptom && !(seedCtx && isVictimSeed(seedCtx))
      ? followStaleCallChain(graph, errorNodeId, ROOT_CAUSE_MAX_DEPTH)
      : null

  // The seed reads as a saturated/stale victim by its inbound signal alone, but
  // that gate never looks downstream (#1075). Before demoting it to a symptom and
  // promoting the load origin, check whether the seed genuinely fails because of
  // its OWN outbound dependency — a failing CONNECTS_TO datastore, a failing
  // downstream call, or an incident whose text is an outbound connection failure.
  // When it does, the load-origin verdict would bury the real cause behind the
  // traffic source, so keep the seed. We check the seed, not the queried node: in
  // a genuine cross-service overload the queried entry relays load down a failing
  // CALLS chain to the starved victim, so its own outbound is failing by design —
  // it is the seed (the victim itself) that must have no downstream fault for the
  // load-origin move to be right.
  const seedFailsOutbound =
    seedCtx !== null && hasFailingOutbound(graph, seedNode, tagged.source, incidents)

  if (seedCtx && isVictimSeed(seedCtx) && !seedFailsOutbound) {
    // The seed is a starved/saturated downstream victim — do not name it. Walk up
    // to the load origin and lead with that.
    const origin = findLoadOrigin(graph, errorNodeId, incidents, now)
    const staleNote = seedCtx.stale ? '; it has gone STALE under load' : ''
    const satNote = isSaturated(seedCtx)
      ? `; its inbound p95 ${Math.round(seedCtx.latencyP95Ms!)}ms is saturated`
      : ''
    if (origin) {
      // Lead the headline reason with the causal relation, not the raw call count:
      // the named origin is the fault *because* it overloads the subgraph, and the
      // alerting node is its downstream symptom (errors arrive from callers, none
      // originate there). The volume is corroborating evidence, so it comes last.
      const originName = displayNameOf(origin.node)
      const seedName = displayNameOf(seedNode)
      candidates.push({
        node: origin.node,
        classification: 'primary-failure',
        reason: `${originName} is the root cause: it overloads the failing subgraph, and the alerting node ${seedName} is a downstream symptom, not the fault — errors reach ${seedName} from its callers (${seedCtx.errorsFromCallers}), none originate there${staleNote}${satNote}. ${originName} is the upstream source driving that load (${origin.ctx.outboundVolume} observed outbound calls).`,
        context: origin.ctx,
        confidence: loadOriginConfidence(origin.ctx, seedCtx),
        provenance: Provenance.OBSERVED,
      })
    }
    candidates.push({
      node: seedNode,
      classification: 'symptom-only',
      reason: `Errors arrive from callers (${seedCtx.errorsFromCallers}) but none originate here${staleNote}${satNote} — a downstream victim of load, not the fault.`,
      context: seedCtx,
      confidence: Math.min(legacy.confidence, 0.4),
      ...(lastProv ? { provenance: lastProv } : {}),
    })
  } else if (seedCtx && isUnreachableSeed(seedCtx)) {
    // #1123 — the seed is a target that received calls which predominantly failed
    // but produced no telemetry of its own: no incidents, no outbound calls. It
    // never served — it is unreachable. Name it as such, and say the cause is NOT
    // in the trace (a startup failure, a crash before the first span, or an
    // unschedulable / unhealthy pod), so an agent inspects deploy state / logs
    // instead of hunting a nonexistent code fault here. The unreachability is
    // OBSERVED; only the WHY is unknown — kept honest-coarse, never fabricated.
    const name = displayNameOf(seedNode)
    candidates.push({
      node: seedNode,
      classification: 'unreachable',
      reason: `${name} is unreachable: its callers' requests fail (${seedCtx.errorsFromCallers} erroring inbound calls) and it produced no telemetry of its own — no server spans, no outbound calls — so it never served. The failure is observed, but its cause is not in the trace: a startup failure, a crash before the first span, or an unschedulable / unhealthy pod. Inspect ${name}'s deploy state and logs — there is no code fault to find in the graph here.`,
      context: seedCtx,
      confidence: legacy.confidence,
      provenance: Provenance.OBSERVED,
    })
  } else if (seedCtx && isBoundaryTimeoutSymptom(seedCtx)) {
    // #1114 / ADR-226 — the seed is a boundary that timed out on an unobservable
    // downstream. Its timeout is the only span that exported; the real culprit hung
    // and emitted nothing, so there is no observed edge to walk and no settled cause
    // to name. The settled verdict LEADS: the boundary is candidates[0] and the
    // rootCauseNode, a symptom. BELOW it, when the hang sensor has staged a FRONTIER
    // surface on the unobservable hop, read it back and surface the proposed culprit
    // at FRONTIER provenance — a claim outside the settled graph, ranked below every
    // settled cause, a hypothesis to graduate (it turns OBSERVED when the service
    // recovers) or cull. Never laundered as a settled INFERRED cause. No surface
    // staged → honest-coarse: name no cause, say it is downstream and unobserved.
    const seedName = displayNameOf(seedNode)
    const proposal = stagedHangProposal(graph, seedNode, incidents)
    const routeNote = proposal?.route ? ` serving ${proposal.route}` : ''
    // Settled verdict first: the boundary is the symptom, and the rootCauseNode.
    candidates.push({
      node: seedNode,
      classification: 'symptom-only',
      reason: proposal
        ? `${seedName} timed out waiting on a downstream that hung and exported no span — a boundary reporting an upstream fault, not the fault itself. The cause is unobservable; NEAT proposes the staged FRONTIER surface below, a hypothesis to confirm, not an observed cause.`
        : `${seedName} timed out but nothing it can see downstream is erroring — the cause is downstream and unobserved (the culprit hung and exported no span). No FRONTIER surface${routeNote} is staged, so no cause is proposed; inspect ${seedName}'s declared downstream and restore instrumentation.`,
      context: seedCtx,
      confidence: Math.min(legacy.confidence, 0.3),
      ...(lastProv ? { provenance: lastProv } : {}),
    })
    // The staged surface, read back as a FRONTIER proposal, ranked below the symptom.
    if (proposal) {
      const causeName = displayNameOf(proposal.node)
      candidates.push({
        node: proposal.node,
        classification: 'primary-failure',
        reason: `${causeName} is the proposed hang cause (FRONTIER — a hypothesis, not observed): the boundary ${seedName} only timed out waiting and the culprit hung without exporting a span, so NEAT staged a FRONTIER surface on the unobservable hop${routeNote}. It graduates to OBSERVED when ${causeName} comes back; until then, inspect it / restore instrumentation to confirm, or it is culled.`,
        context: nodeContext(graph, proposal.node, incidents, now),
        confidence: Math.min(legacy.confidence, PROVENANCE_CEILING.FRONTIER!),
        provenance: Provenance.FRONTIER,
      })
    }
  } else if (staleChain) {
    // Stale-only causal chain (ADR-209). Fresh signal has gone quiet, but the
    // last-observed topology still traces from the symptom down to a deepest
    // stale-only callee. Lead with that callee as a low-confidence, STALE-
    // provenanced hypothesis — honest about the uncertainty — instead of naming
    // the symptom with no edges walked. The seed becomes the surface it is.
    const culprit = staleChain.culprit
    const culpritName = displayNameOf(culprit)
    const seedName = displayNameOf(seedNode)
    // Confidence rides the STALE ceiling (≤ 0.3) through confidenceFromMix — the
    // provenance itself caps how far it can climb, so the number reads as the low
    // trust it is without a hand-set floor.
    const staleConfidence = confidenceFromMix(staleChain.edges, now)
    candidates.push({
      node: culprit,
      classification: 'primary-failure',
      reason: `${culpritName} is the stale-derived root cause (low confidence): live telemetry for this subgraph has gone quiet, but the last-observed topology traces the failure surfacing at ${seedName} downstream through a STALE call chain to ${culpritName}. Provenance is STALE, so confidence is capped low — restore instrumentation and re-run to confirm before acting.`,
      context: nodeContext(graph, culprit, incidents, now),
      confidence: staleConfidence,
      provenance: Provenance.STALE,
    })
    candidates.push({
      node: seedNode,
      classification: 'symptom-only',
      reason: `The failure surfaced here, but the only causal chain the graph still holds is STALE and runs downstream — ${seedName} is the surface of a stale-traced failure, not a proven origin.`,
      context: seedCtx ?? EMPTY_CONTEXT,
      confidence: Math.min(legacy.confidence, PROVENANCE_CEILING.STALE!),
      ...(lastProv ? { provenance: lastProv } : {}),
    })
  } else {
    // The seed originates the failure (or its node isn't in the graph — an
    // incident-only localization). Confirm it as the primary cause.
    candidates.push({
      node: seedNode,
      classification: 'primary-failure',
      reason: legacy.rootCauseReason,
      context: seedCtx ?? EMPTY_CONTEXT,
      confidence: legacy.confidence,
      ...(lastProv ? { provenance: lastProv } : {}),
    })
  }

  const top = candidates[0]!
  // The legacy verdict tracks the top candidate so old consumers get the fixed
  // answer too; when the top is the promoted origin, retrace the path up to it so
  // traversalPath still ends at rootCauseNode (get-root-cause.md invariant).
  let traversalPath = legacy.traversalPath
  let edgeProvenances = legacy.edgeProvenances
  if (staleChain && top.node === staleChain.culprit) {
    // The stale chain already IS the origin → ... → culprit path, walked outbound;
    // use it verbatim so traversalPath ends at the named cause and every hop's
    // STALE provenance is on the path (get-root-cause.md invariant).
    traversalPath = staleChain.path
    edgeProvenances = staleChain.edges.map((e) => e.provenance)
  } else if (top.node !== seedNode) {
    const path = findPath(graph, errorNodeId, top.node, 'up', ROOT_CAUSE_MAX_DEPTH)
    if (path) {
      traversalPath = path.nodes
      edgeProvenances = path.edges.map((e) => e.provenance)
    } else {
      traversalPath = [errorNodeId, top.node]
      edgeProvenances = [top.provenance ?? Provenance.OBSERVED]
    }
  }

  // fixRecommendation has to name the node we hand back as rootCauseNode (top),
  // not the downstream victim the legacy verdict walked to.
  const fixRecommendation = fixRecommendationForTop(top, seedNode, legacy)

  return RootCauseResultSchema.parse({
    rootCauseNode: top.node,
    rootCauseReason: top.reason,
    traversalPath,
    edgeProvenances,
    confidence: top.confidence,
    ...(fixRecommendation ? { fixRecommendation } : {}),
    candidates,
  })
}

// The fix recommendation must point at whichever node getRootCause returns as
// rootCauseNode — the top candidate — never at a symptom-only victim. When the
// seed is itself the primary failure, the legacy verdict already derived a
// recommendation aimed at it, so keep it. When navigation promoted an upstream
// load origin (the seed turned out to be a starved symptom-only victim), the
// legacy recommendation still targets that victim, so rebuild it to name the
// overloading source. A symptom-only top — the case where no load origin was
// found — is sent to its inbound load, never to its own handler.
function fixRecommendationForTop(
  top: RootCauseCandidate,
  seedNode: string,
  legacy: RootCauseResult,
): string | undefined {
  if (top.classification === 'primary-failure' && top.node === seedNode) {
    return legacy.fixRecommendation
  }
  const name = top.node.replace(/^service:/, '')
  // ADR-226 — a boundary that timed out is a symptom-only top whose cause is
  // unobservable. It is not a load victim, so it never gets the inbound-load
  // wording; send the agent to the FRONTIER surface proposed in the candidates.
  if (top.classification === 'symptom-only' && top.context.boundaryTimeout === true) {
    return `${name} timed out waiting on a downstream that hung and exported no span — the cause is unobservable from traces. Inspect the FRONTIER surface NEAT staged on the unobservable hop (see candidates); it graduates to OBSERVED when that service recovers. Restore instrumentation on that path to confirm, rather than treating ${name} as the fault.`
  }
  // A stale-derived promotion (ADR-209) isn't an overload — the signal simply went
  // quiet — so it gets its own recommendation, never the throttle-the-load wording.
  if (top.provenance === Provenance.STALE) {
    return `Live telemetry for this path has gone quiet; the last-observed topology traces the failure downstream to ${name}. Restore instrumentation (or re-run with live traces) to confirm, then inspect ${name}.`
  }
  if (top.classification === 'primary-failure') {
    return `Reduce or throttle the load from ${name} (or scale the saturated downstream capacity it drives) — the failure originates at this overloading source, not the starved callee.`
  }
  return `${name} is a saturated/starved downstream victim; investigate its inbound load and upstream callers, not its own handler.`
}
