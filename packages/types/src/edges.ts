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
  EdgeType.INHERITS,
  EdgeType.IMPLEMENTS,
  EdgeType.REFERENCES,
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
  // How a datastore host was recovered (ADR-213). `config` when the host came
  // from an env var / IConfiguration key / config file — the deployment's real
  // target; `literal` when it was read from a hardcoded string literal in
  // source. The divergence ranker reads this to tell a genuine declared store
  // from a hardcoded fault-injection / flag-gated probe: a `literal` host
  // production never observed, sitting beside a `config`-driven store of the
  // same engine on the same service, is a dead alternate whose missing-observed
  // is dampened rather than surfaced as a real gap. Present only on datastore
  // CONNECTS_TO edges from a recogniser that distinguishes the two; absent on
  // every other edge.
  hostSource: z.enum(['literal', 'config']).optional(),
  // Reconstruction fidelity of a client↔route match (ADR-219). `approximate` is
  // true when the client URL could not be fully reconstructed from source — an
  // interpolation sat in a load-bearing position and was not statically
  // resolvable — so the resolved target rests on shape, not literal evidence.
  // `reason` names why. Present only on a `reconstructed-approximate` CALLS
  // candidate the route matcher graded below the precision floor; absent on a
  // fully-resolved match and on every other edge.
  approximate: z.boolean().optional(),
  reason: z.string().optional(),
})
export type EdgeEvidence = z.infer<typeof EdgeEvidenceSchema>

// Latency percentiles derived from span duration (ADR-190). `p95` is the
// saturation signal the navigation reads to tell a failing cause from a
// downstream victim; `p50` is context. In milliseconds.
export const LatencyMsSchema = z.object({
  p50: z.number().nonnegative(),
  p95: z.number().nonnegative(),
})
export type LatencyMs = z.infer<typeof LatencyMsSchema>

// A pre-thresholded alert an external monitor already fired against the edge
// (ADR-190). NEAT records the fact — `{ source, rule }`, or a bare boolean — it
// never computes its own baseline, keeping the signal absolute.
export const EdgeAnomalySchema = z.union([
  z.object({ source: z.string(), rule: z.string() }),
  z.boolean(),
])
export type EdgeAnomaly = z.infer<typeof EdgeAnomalySchema>

// Runtime signal for per-edge confidence (γ #76). Populated by ingest. Three
// continuous numbers stand in for the previous coarse 0.3/0.5/0.7/1.0 ladder:
// how much traffic, how clean, and how recent.
export const EdgeSignalSchema = z.object({
  spanCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  lastObservedAgeMs: z.number().nonnegative().optional(),
  // Per-edge latency (ADR-190). `latencyMs` is derived at each observation from
  // `latencyHist`, a bounded log-linear (HDR-style) histogram — a sparse
  // bucket→count map, never raw durations — maintained by upsertObservedEdge via
  // latency-digest.ts. Both are `.optional()` growth (ADR-031): a legacy edge and
  // a connector edge without a provider latency carry neither and read honestly
  // absent. `latencyHist` is the ingest accumulator `latencyMs` is read from;
  // consumers read `latencyMs`.
  latencyMs: LatencyMsSchema.optional(),
  latencyHist: z.record(z.string(), z.number().int().nonnegative()).optional(),
  // A pre-thresholded external alert riding on the edge (ADR-190). Optional and
  // empty until an alert source is wired.
  anomalous: EdgeAnomalySchema.optional(),
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
