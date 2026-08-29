import { z } from 'zod'
import { ProvenanceSchema } from './edges.js'
import type { ErrorEvent } from './events.js'

// The incident card (ADR-221) — one self-sufficient work order composed on every
// incident, so an agent reads its context instead of grepping for it. Every field
// is composed from queries that already ship (root cause, blast radius, applicable
// policies, node divergence) fused with the incident record; nothing here is
// newly computed. The card is zero-fabrication with calibrated provenance: a
// missing locus is null, a missing cause is null, and each chain hop carries its
// own provenance rather than a single flattened confidence. See
// docs/contracts/incident-card.md.

// The kind of failure that recorded the incident. Mirrors the ErrorEvent
// producers in ingest.ts: an exception (OTel status-error or an exception-only
// worker span), a 5xx response, a coalesced 4xx burst, an attribute-carried
// gRPC/HTTP status error (issue #1065), or a connector poll failure (ADR-185).
export const IncidentKindSchema = z.enum([
  'exception',
  '5xx',
  '4xx-burst',
  'status-error',
  'connector',
])
export type IncidentKind = z.infer<typeof IncidentKindSchema>

// One hop on the incident's causal chain — the node plus the annotations that
// say how much to trust the link into it (the same per-hop grain/provenance/
// signal RelatePath carries, ADR-189), so an agent reads not just the path but
// which links are OBSERVED fact and which are INFERRED stitch.
export const IncidentChainHopSchema = z.object({
  node: z.string(),
  // 'service' | 'file' | 'symbol' | 'table' | 'column' | … — the node's own grain.
  grain: z.string(),
  // The edge INTO this hop from the previous one, when cheaply known.
  edgeType: z.string().optional(),
  provenance: ProvenanceSchema,
  carriesSignal: z.boolean().optional(),
})
export type IncidentChainHop = z.infer<typeof IncidentChainHopSchema>

// The declaring code location the fix edits, recovered from the incident's
// code.filepath/code.lineno (ADR-215/216). Null on the card — never fabricated —
// when the span carried no code locus and no stacktrace frame resolved to a
// FileNode; the card then lands at the coarsest grain it can stand behind.
export const IncidentLocusSchema = z.object({
  file: z.string(),
  lineStart: z.number().int().optional(),
  lineEnd: z.number().int().optional(),
  symbol: z.string().optional(),
  service: z.string().optional(),
  provenance: ProvenanceSchema,
})
export type IncidentLocus = z.infer<typeof IncidentLocusSchema>

// The root-cause reading folded into the card: the ranked cause, its chain, and
// the honest classification (a saturated downstream victim is 'symptom-only',
// not dressed as a cause — ADR-189). Null when no cause could be reached (e.g. a
// STALE-only upstream); the incident still ships, the diagnosis is absent, not
// invented.
export const IncidentRootCauseSchema = z.object({
  node: z.string(),
  classification: z.string().optional(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
  fix: z.string().nullable().optional(),
  chain: z.array(IncidentChainHopSchema),
})
export type IncidentRootCause = z.infer<typeof IncidentRootCauseSchema>

// A trimmed blast-radius reading: the total plus the nearest affected nodes, so
// an agent sees what a fix at the locus would reach before it edits.
export const IncidentBlastRadiusSchema = z.object({
  totalAffected: z.number().int().nonnegative(),
  nearest: z.array(
    z.object({
      node: z.string(),
      distance: z.number().int().nonnegative(),
      provenance: ProvenanceSchema,
    }),
  ),
})
export type IncidentBlastRadius = z.infer<typeof IncidentBlastRadiusSchema>

// A governing policy the agent should honor at this node (the soft guardrail,
// ADR-108) and any code↔runtime divergence already standing here.
export const IncidentPolicySchema = z.object({
  policyName: z.string(),
  severity: z.string(),
  message: z.string().optional(),
})
export type IncidentPolicy = z.infer<typeof IncidentPolicySchema>

export const IncidentDivergenceSchema = z.object({
  type: z.string(),
  summary: z.string(),
})
export type IncidentDivergence = z.infer<typeof IncidentDivergenceSchema>

// The incident card — one self-sufficient work order (ADR-221). Additive schema
// growth (schema.md, ADR-031): a new exported schema, no shape change to any
// existing one.
export const IncidentCardSchema = z.object({
  kind: z.literal('incident'),
  id: z.string(),
  // ISO8601 — the incident's own time.
  at: z.string(),
  incidentKind: IncidentKindSchema,
  service: z.string(),
  affectedNode: z.string(),
  message: z.string(),
  exceptionType: z.string().optional(),
  httpStatusCode: z.number().int().optional(),
  // Coalesced burst size (ErrorEvent.incidentCount).
  count: z.number().int().positive().optional(),
  window: z.object({ first: z.string(), last: z.string() }).optional(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  locus: IncidentLocusSchema.nullable(),
  rootCause: IncidentRootCauseSchema.nullable(),
  blastRadius: IncidentBlastRadiusSchema.optional(),
  policies: z.array(IncidentPolicySchema).optional(),
  divergence: z.array(IncidentDivergenceSchema).optional(),
  // The rendered one-line sentence — a human/loose-LLM read over the structured
  // body, never the wire format.
  headline: z.string(),
})
export type IncidentCard = z.infer<typeof IncidentCardSchema>

// The lean SSE payload for the ninth event type (ADR-221): a trigger, not the
// context. The monitor reads GET /graph/incident-card/:affectedNode?errorId=<id>
// for the full card. Kept small on purpose — the bus carries the fact that an
// incident happened; the card is a REST read.
export const IncidentEventPayloadSchema = z.object({
  incidentId: z.string(),
  affectedNode: z.string(),
  service: z.string(),
  incidentKind: IncidentKindSchema,
  at: z.string(),
})
export type IncidentEventPayload = z.infer<typeof IncidentEventPayloadSchema>

// Classify a stored ErrorEvent into its IncidentKind. One place so the event
// producer (ingest.ts) and the card assembler (goodybag.ts) agree. Reads only
// the record's own fields — no graph, no I/O.
export function incidentKindOf(ev: ErrorEvent): IncidentKind {
  const et = ev.errorType
  if (et === 'grpc-failure') return 'status-error'
  if (et === 'http-failure') {
    return ev.incidentCount && ev.incidentCount > 1 ? '4xx-burst' : '5xx'
  }
  // A connector failure (ADR-185) carries a stable non-http/grpc classifier.
  if (et) return 'connector'
  // No errorType — an exception-status span or an exception-only worker span.
  return 'exception'
}
