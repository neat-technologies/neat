import { z } from 'zod'
import { ProvenanceSchema, EdgeTypeSchema, GraphEdgeSchema } from './edges.js'

// Per-node classification inputs, kept separate so a caller can classify a node
// without re-deriving anything (ADR-189). Every field reads real edge / incident
// signal — never synthesized (file-awareness.md §6).
export const NodeContextSchema = z.object({
  // Errors originating at this node: incidents localized here plus its own
  // outbound CALLS that fail. A node that emits errors is a candidate cause.
  errorsEmittedHere: z.number().int().nonnegative(),
  // Errors arriving from callers: the inbound edges' errorCount. Errors arriving
  // with none emitted here is the victim signature.
  errorsFromCallers: z.number().int().nonnegative(),
  // Inbound call volume through the node — how hard production hits it.
  callCount: z.number().int().nonnegative(),
  // Outbound call volume — how hard this node drives its own dependencies. A
  // pure driver of load (high out, no in) is where an overload originates.
  outboundVolume: z.number().int().nonnegative(),
  // Staleness: ms since the node was last observed. A stale node under inbound
  // load is a starved victim, not a cause.
  lastObservedAgeMs: z.number().nonnegative().optional(),
  // Saturation: the worst inbound p95 latency (ms), from ADR-190. High absolute
  // latency with low error emission reads as saturated.
  latencyP95Ms: z.number().nonnegative().optional(),
  // Is the node fed by STALE edges — did it stop responding?
  stale: z.boolean(),
})
export type NodeContext = z.infer<typeof NodeContextSchema>

// The classification a node earns from its separated context: the failure
// originates here (primary-failure), it is a downstream victim of a failure
// elsewhere (symptom-only), or no failure signal touches it (unrelated). Realises
// PRAXIS's complete / discard alongside the Expand / Relate moves.
export const NodeClassificationSchema = z.enum([
  'primary-failure',
  'symptom-only',
  'unrelated',
])
export type NodeClassification = z.infer<typeof NodeClassificationSchema>

// One ranked candidate cause: the node, its classification, the human-readable
// evidence, the separated context that classification rests on, a per-node
// confidence, and the provenance of the edge that reached it.
export const RootCauseCandidateSchema = z.object({
  node: z.string(),
  classification: NodeClassificationSchema,
  reason: z.string(),
  context: NodeContextSchema,
  confidence: z.number().min(0).max(1),
  provenance: ProvenanceSchema.optional(),
})
export type RootCauseCandidate = z.infer<typeof RootCauseCandidateSchema>

export const RootCauseResultSchema = z.object({
  rootCauseNode: z.string(),
  rootCauseReason: z.string(),
  traversalPath: z.array(z.string()),
  edgeProvenances: z.array(ProvenanceSchema),
  confidence: z.number().min(0).max(1),
  fixRecommendation: z.string().optional(),
  // Agent-driven navigation (ADR-189): the ranked candidate set with per-node
  // classification + evidence. `candidates[0]` is the top-ranked cause and the
  // legacy `rootCauseNode` above tracks it. Optional growth (ADR-031); present
  // by default, the legacy verdict fields stay populated for one deprecation
  // cycle. A saturated downstream victim classifies `symptom-only` here and the
  // ranking walks up to the load origin instead of naming the victim.
  candidates: z.array(RootCauseCandidateSchema).optional(),
})
export type RootCauseResult = z.infer<typeof RootCauseResultSchema>

// One directed path Relate found between two nodes, annotated per hop so a
// caller sees not just that a path exists but whether it carries the failure.
export const RelatePathSchema = z.object({
  // origin → ... → target, the node ids along the path.
  nodes: z.array(z.string()).min(2),
  // The edge type of each hop (length = nodes.length - 1).
  edgeTypes: z.array(EdgeTypeSchema),
  // The provenance of each hop.
  provenance: z.array(ProvenanceSchema),
  // The grain of each node on the path ('service' | 'file' | 'symbol' | other
  // node type), so a cross-grain descent is legible.
  grain: z.array(z.string()),
  // Does the failure run end to end — errorCount / latency / anomalous on every
  // hop? A signal-carrying path turns reachability into cause-confirmation.
  carriesSignal: z.boolean(),
})
export type RelatePath = z.infer<typeof RelatePathSchema>

// Relate(a, b) — the pairwise link-confirmation move (ADR-189). Directed: it
// searches both ways but labels the direction it found. When no path exists
// within maxDepth it returns related: false with the honest "no path within N
// hops" note — a depth-bounded absence, not proven independence.
export const RelateResultSchema = z.object({
  a: z.string(),
  b: z.string(),
  related: z.boolean(),
  direction: z.enum(['a->b', 'b->a']).nullable(),
  paths: z.array(RelatePathSchema),
  // True when only a coarser-grain link is in evidence than a and b's own grain
  // — the fine link was never observed, so the coarser one is returned and the
  // gap flagged rather than a finer link synthesized (file-awareness.md §6).
  grainGap: z.boolean().optional(),
  // The terminal-honesty label when related is false.
  note: z.string().optional(),
})
export type RelateResult = z.infer<typeof RelateResultSchema>

// One neighbour returned by an Expand step.
export const ExpandNeighbourSchema = z.object({
  node: z.string(),
  edgeType: EdgeTypeSchema,
  provenance: ProvenanceSchema,
  classification: NodeClassificationSchema,
  context: NodeContextSchema,
})
export type ExpandNeighbour = z.infer<typeof ExpandNeighbourSchema>

// Expand(node, up | down) — one bidirectional neighbourhood step (ADR-189).
// `up` walks inbound (toward callers/dependents), `down` walks outbound (toward
// callees/dependencies), both over the depth-bounded, PROV_RANK-best primitives
// traversal.md governs. Returns the stepped node's own classification + context
// and its immediate neighbours', so a caller navigates one legible hop at a time.
export const ExpandResultSchema = z.object({
  origin: z.string(),
  direction: z.enum(['up', 'down']),
  node: z.object({
    id: z.string(),
    classification: NodeClassificationSchema,
    context: NodeContextSchema,
  }),
  neighbours: z.array(ExpandNeighbourSchema),
})
export type ExpandResult = z.infer<typeof ExpandResultSchema>

export const BlastRadiusAffectedNodeSchema = z.object({
  nodeId: z.string(),
  // Distance from the origin in BFS hops. The origin itself is never in
  // affectedNodes, so distance 0 has no meaning — the BFS at traverse.ts
  // already skips frame 0. Tightening to positive() locks that invariant
  // mechanically (ADR-038, issue #138).
  distance: z.number().int().positive(),
  edgeProvenance: ProvenanceSchema,
  // path: origin → ... → nodeId. Length === distance + 1. Surfaced from the
  // BFS predecessor chain so consumers don't have to reconstruct it from
  // distance + the graph (ADR-038, issue #137).
  path: z.array(z.string()).min(2),
  // confidence: confidenceFromMix(...edgesAlongPath). Multiplicative cascade —
  // each hop is independent evidence and uncertainty compounds. ADR-036.
  confidence: z.number().min(0).max(1),
})
export type BlastRadiusAffectedNode = z.infer<typeof BlastRadiusAffectedNodeSchema>

export const BlastRadiusResultSchema = z.object({
  origin: z.string(),
  affectedNodes: z.array(BlastRadiusAffectedNodeSchema),
  totalAffected: z.number().int().nonnegative(),
})
export type BlastRadiusResult = z.infer<typeof BlastRadiusResultSchema>

// Transitive get_dependencies (issue #144). Flat list with distance, edge
// type, and provenance per dependency. Sibling shape to BlastRadius but
// thinner — no path tracking, no confidence cascade. Use cases live in the
// MCP get_dependencies tool ("what does X depend on, transitively?").
export const TransitiveDependencySchema = z.object({
  nodeId: z.string(),
  // Distance from the origin in BFS hops. The origin itself is never in
  // dependencies, so distance is positive (>= 1).
  distance: z.number().int().positive(),
  // Type of the edge that brought traversal to this node (CALLS,
  // CONNECTS_TO, DEPENDS_ON, etc.).
  edgeType: EdgeTypeSchema,
  // Provenance of that edge.
  provenance: ProvenanceSchema,
})
export type TransitiveDependency = z.infer<typeof TransitiveDependencySchema>

export const TransitiveDependenciesResultSchema = z.object({
  origin: z.string(),
  depth: z.number().int().positive(),
  dependencies: z.array(TransitiveDependencySchema),
  total: z.number().int().nonnegative(),
})
export type TransitiveDependenciesResult = z.infer<typeof TransitiveDependenciesResultSchema>

// Observed-only dependencies (issue #578). "What does this node actually call
// at runtime?" — the OBSERVED outbound edges, file-grained. When the queried
// node is a ServiceNode the real runtime CALLS originate from the FileNodes it
// owns (the call-site processor lands OBSERVED edges on files, not the service
// root), so the query walks one hop through `service ──CONTAINS──▶ file` and
// surfaces those file→target edges. This is not a service rollup
// (file-awareness §3): the edges stay file-grained, with the owning file as the
// edge source — the service is just the grouping we entered through.
//
// `observed` / `inboundObservedCount` separate "no outbound deps" from "never
// observed": a pure receiver (hit at runtime but calls nothing downstream) has
// zero dependencies yet is very much seen by OTel, so the consumer must not say
// "is OTel running?" at it. `hasExtractedOutbound` gates that question to the
// genuine no-runtime-traffic case.
export const ObservedDependenciesResultSchema = z.object({
  origin: z.string(),
  // OBSERVED outbound edges (CALLS/CONNECTS_TO/etc.), file-grained. Structural
  // CONTAINS ownership is never listed here — it is not a runtime dependency.
  dependencies: z.array(GraphEdgeSchema),
  // Did OTel see this node (or a file it owns) at all — as caller or callee?
  // Distinguishes a pure receiver from a node runtime has never touched.
  observed: z.boolean(),
  // Count of OBSERVED inbound edges into the node (and its owned files). A
  // non-zero count with zero dependencies is the pure-receiver signal.
  inboundObservedCount: z.number().int().nonnegative(),
  // Are there EXTRACTED outbound edges but no OBSERVED ones? Only then is
  // "static deps exist but no runtime traffic — is OTel running?" the honest note.
  hasExtractedOutbound: z.boolean(),
  // Node-level *inbound* traffic block (ADR-190): how hard and how recently
  // production hits THIS node, sourced from its inbound OBSERVED edges — the
  // "served N× in {window}, last seen {age}" story the navigation reads and
  // neat-action renders. `inboundVolume` is the summed inbound-edge count
  // (distinct from `inboundObservedCount`, the number of inbound edges).
  // `window` labels the count ("7d" | "lifetime") so a consumer never renders a
  // window the data doesn't have; the cumulative signal is "lifetime" today.
  // `inboundLastObserved` is when production last called this node, raw ISO8601
  // and never pre-formatted — absent when there is no inbound observation.
  // All three are optional growth (ADR-031); the producer emits `inboundVolume`
  // and `window` together, `inboundLastObserved` when there is inbound traffic.
  inboundVolume: z.number().int().nonnegative().optional(),
  window: z.enum(['7d', 'lifetime']).optional(),
  inboundLastObserved: z.string().datetime().optional(),
})
export type ObservedDependenciesResult = z.infer<typeof ObservedDependenciesResultSchema>
