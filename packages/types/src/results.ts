import { z } from 'zod'
import { ProvenanceSchema, EdgeTypeSchema, GraphEdgeSchema } from './edges.js'

export const RootCauseResultSchema = z.object({
  rootCauseNode: z.string(),
  rootCauseReason: z.string(),
  traversalPath: z.array(z.string()),
  edgeProvenances: z.array(ProvenanceSchema),
  confidence: z.number().min(0).max(1),
  fixRecommendation: z.string().optional(),
})
export type RootCauseResult = z.infer<typeof RootCauseResultSchema>

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
})
export type ObservedDependenciesResult = z.infer<typeof ObservedDependenciesResultSchema>
