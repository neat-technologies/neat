// Divergence — the thesis surface (ADR-060). A typed result describing
// places where what the code declares (EXTRACTED) doesn't match what
// production observed (OBSERVED). Five locked variants discriminated by
// `type`; new shapes require a successor ADR.
//
// The schema lives here because consumers across the stack (REST, MCP,
// CLI, future frontend) need to validate the wire shape against the same
// definition. Computation lives in packages/core/src/divergences.ts —
// pure functions over a NeatGraph; no I/O, no mutation.

import { z } from 'zod'
import { EdgeTypeSchema, GraphEdgeSchema, ProvenanceSchema } from './edges.js'

const commonFields = {
  source: z.string(),
  target: z.string(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  recommendation: z.string(),
}

// `missing-observed` / `missing-extracted` each carry one of two loci (ADR-157
// §4). The original edge locus: a declared edge with no observed twin (`edgeType`
// + `extracted`), or an observed edge with no declared twin (`edgeType` +
// `observed`). The column locus, added at column grain: a `sql-table` node
// declares a column production never touched (`missing-observed`), or production
// touched a column the schema never declared (`missing-extracted`), carried as
// `table` + `column`. The taxonomy does not grow a new variant — the same two
// reasons gain a column-grained locus (§4: "the same semantics … computed over
// column sets on one node") — so the edge fields and the column fields are each
// optional and mutually exclusive: consumers branch on which is present
// (`'column' in d`). `source`/`target` are the table node id on the column locus.
export const MissingObservedDivergenceSchema = z.object({
  type: z.literal('missing-observed'),
  ...commonFields,
  edgeType: EdgeTypeSchema.optional(),
  extracted: GraphEdgeSchema.optional(),
  // Column locus (ADR-157 §4): the `sql-table` node id and the declared-only column.
  table: z.string().optional(),
  column: z.string().optional(),
})
export type MissingObservedDivergence = z.infer<typeof MissingObservedDivergenceSchema>

export const MissingExtractedDivergenceSchema = z.object({
  type: z.literal('missing-extracted'),
  ...commonFields,
  edgeType: EdgeTypeSchema.optional(),
  observed: GraphEdgeSchema.optional(),
  // Column locus (ADR-157 §4): the `sql-table` node id and the observed-only column.
  table: z.string().optional(),
  column: z.string().optional(),
})
export type MissingExtractedDivergence = z.infer<typeof MissingExtractedDivergenceSchema>

// 'incompatible' = compat.json rule fires definitively.
// 'deprecated'   = compat.json deprecated-api rule fires.
// 'unknown'      = engine version present but no compat rule covers it.
export const CompatibilityVerdictSchema = z.enum(['incompatible', 'deprecated', 'unknown'])
export type CompatibilityVerdict = z.infer<typeof CompatibilityVerdictSchema>

export const VersionMismatchDivergenceSchema = z.object({
  type: z.literal('version-mismatch'),
  ...commonFields,
  extractedVersion: z.string(),
  observedVersion: z.string(),
  compatibility: CompatibilityVerdictSchema,
})
export type VersionMismatchDivergence = z.infer<typeof VersionMismatchDivergenceSchema>

export const HostMismatchDivergenceSchema = z.object({
  type: z.literal('host-mismatch'),
  ...commonFields,
  extractedHost: z.string(),
  observedHost: z.string(),
})
export type HostMismatchDivergence = z.infer<typeof HostMismatchDivergenceSchema>

// Free-shape reference to the compat.json rule that fired — kept as a plain
// record so the schema stays insulated from compat.ts's internal types. The
// `rule` field carries enough metadata to identify which rule + why.
export const CompatRuleRefSchema = z.object({
  kind: z.string(),
  reason: z.string(),
  package: z.string().optional(),
  driver: z.string().optional(),
  engine: z.string().optional(),
})
export type CompatRuleRef = z.infer<typeof CompatRuleRefSchema>

export const CompatViolationDivergenceSchema = z.object({
  type: z.literal('compat-violation'),
  ...commonFields,
  rule: CompatRuleRefSchema,
  observed: GraphEdgeSchema,
})
export type CompatViolationDivergence = z.infer<typeof CompatViolationDivergenceSchema>

// Symbol/field-grain divergence (ADR-215). The edge-triple detectors above ask
// "does a declared edge have an observed twin?"; this one asks a question the
// edge sets can't answer — where the code *declares access to a member the
// runtime object does not have*. That mismatch never shows up as a missing edge
// (the call the member sits behind is made, and observed); it surfaces only as a
// runtime error localized to the declaring `code.filepath`/`code.lineno`. This
// variant fuses an OBSERVED incident whose error content indicates a
// field/attribute/method/column mismatch with the EXTRACTED code location that
// declares the access, so `get_divergences` answers "where does declared
// disagree with observed" at symbol grain, not only edge grain.
//
// `mismatchKind` is the generic error *semantic* that classified it — one of a
// fixed, language/provider-neutral set (`missing-attribute`, `missing-field`,
// `missing-property`, `missing-column`, `undefined-method`); never a language,
// framework, or provider name (ADR-158 §6). `symbol` is the accessed member the
// runtime lacked, when the message names it. `location` is the declaring
// `file:line`. `source`/`target` are both the code node the incident localized
// to (a symbol or file node, else the owning service) so node scoping resolves
// it, mirroring the column locus. `provenance` is the finding's own grade —
// INFERRED, the stitch between the OBSERVED error and the EXTRACTED location.
export const SymbolMismatchKindSchema = z.enum([
  'missing-attribute',
  'missing-field',
  'missing-property',
  'missing-column',
  'undefined-method',
])
export type SymbolMismatchKind = z.infer<typeof SymbolMismatchKindSchema>

export const ObservedSymbolMismatchDivergenceSchema = z.object({
  type: z.literal('observed-symbol-mismatch'),
  ...commonFields,
  mismatchKind: SymbolMismatchKindSchema,
  symbol: z.string().optional(),
  location: z.string().optional(),
  provenance: ProvenanceSchema,
  // The OBSERVED incident this fuses — its id and the raw error text — so a
  // consumer can trace the finding back to the recorded failure.
  incidentId: z.string().optional(),
  errorMessage: z.string(),
  // How many recorded incidents share this (node, member, mismatch) — the
  // failure has usually fired more than once.
  incidentCount: z.number().int().positive().optional(),
})
export type ObservedSymbolMismatchDivergence = z.infer<
  typeof ObservedSymbolMismatchDivergenceSchema
>

export const DivergenceSchema = z.discriminatedUnion('type', [
  MissingObservedDivergenceSchema,
  MissingExtractedDivergenceSchema,
  VersionMismatchDivergenceSchema,
  HostMismatchDivergenceSchema,
  CompatViolationDivergenceSchema,
  ObservedSymbolMismatchDivergenceSchema,
])
export type Divergence = z.infer<typeof DivergenceSchema>

export const DivergenceResultSchema = z.object({
  divergences: z.array(DivergenceSchema),
  totalAffected: z.number().int().nonnegative(),
  // ISO8601 timestamp the result was computed at. Each call re-derives from
  // the live graph — there is no persisted divergence history.
  computedAt: z.string().datetime(),
})
export type DivergenceResult = z.infer<typeof DivergenceResultSchema>

// Locked set of divergence types. Consumers (REST query parser, CLI flag
// parser) validate the user-supplied filter against this enum.
export const DivergenceTypeSchema = z.enum([
  'missing-observed',
  'missing-extracted',
  'version-mismatch',
  'host-mismatch',
  'compat-violation',
  'observed-symbol-mismatch',
])
export type DivergenceType = z.infer<typeof DivergenceTypeSchema>
