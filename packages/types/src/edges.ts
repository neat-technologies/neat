import { z } from 'zod'
import { EdgeType, Provenance } from './constants.js'

export const ProvenanceSchema = z.enum([
  Provenance.EXTRACTED,
  Provenance.INFERRED,
  Provenance.OBSERVED,
  Provenance.STALE,
])

export const EdgeTypeSchema = z.enum([
  EdgeType.CALLS,
  EdgeType.DEPENDS_ON,
  EdgeType.CONNECTS_TO,
  EdgeType.CONFIGURED_BY,
  EdgeType.PUBLISHES_TO,
  EdgeType.CONSUMES_FROM,
  EdgeType.RUNS_ON,
  EdgeType.CONTAINS,
  EdgeType.IMPORTS,
])

// Static-extraction evidence for an EXTRACTED edge (ADR-029, contract #5).
// `file` is required — retire.ts keys ghost-edge cleanup off it. `line` and
// `snippet` are optional because the existing extractors (configs.ts,
// docker-compose.ts) record file-level evidence only; loosening lets those
// edges through ADR-061's response-shape validation without forcing the
// extractors to fabricate line numbers.
export const EdgeEvidenceSchema = z.object({
  file: z.string(),
  line: z.number().int().nonnegative().optional(),
  snippet: z.string().optional(),
  // HTTP shape of a recognised client call site (ADR-119). Present on a
  // client↔route CALLS edge so the edge records the method + path-template the
  // client named, alongside the file:line it named them at. Absent on every
  // other edge — a config or infra edge has no HTTP method.
  method: z.string().optional(),
  pathTemplate: z.string().optional(),
})
export type EdgeEvidence = z.infer<typeof EdgeEvidenceSchema>

// Runtime signal for per-edge confidence (γ #76). Populated by ingest. Three
// continuous numbers stand in for the previous coarse 0.3/0.5/0.7/1.0 ladder:
// how much traffic, how clean, and how recent.
export const EdgeSignalSchema = z.object({
  spanCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  lastObservedAgeMs: z.number().nonnegative().optional(),
})
export type EdgeSignal = z.infer<typeof EdgeSignalSchema>

// `confidence` is in [0, 1] and graded per provenance tier (ADR-066). Producers
// write it on every EXTRACTED and OBSERVED edge via the helpers in
// confidence.ts; flat coarse values (the old `0.5` / `1.0` shape) are a
// contract violation. The field stays `.optional()` for snapshot back-compat —
// older snapshots may carry edges without confidence and persist.ts loads them
// on the documented growth path (ADR-031).
export const GraphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  type: EdgeTypeSchema,
  provenance: ProvenanceSchema,
  confidence: z.number().min(0).max(1).optional(),
  lastObserved: z.string().datetime().optional(),
  callCount: z.number().int().nonnegative().optional(),
  evidence: EdgeEvidenceSchema.optional(),
  signal: EdgeSignalSchema.optional(),
  // OBSERVED grain (ADR-142): `file` when the edge originates from a source
  // file's call site (a `file:` source + `evidence`), `service` for the coarse
  // fallback where no call site was captured. Makes "service-grained only as a
  // labeled fallback" (connector gate #803) a stored, machine-readable fact
  // instead of a re-derivation from the source prefix. `.optional()` — EXTRACTED
  // edges and legacy snapshots carry none; an OBSERVED edge is backfilled on its
  // next observation.
  grain: z.enum(['file', 'service']).optional(),
})
export type GraphEdge = z.infer<typeof GraphEdgeSchema>
