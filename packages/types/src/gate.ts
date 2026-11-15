// The pre-merge no-regression gate verdict (ADR-277). A structured result computed on a
// pull request: four conditions, each pass | fail | unknown, plus a parallel list of
// findings a PR-Sniper run can target (Deniz 2026-11-15). It is additive to the rendered
// verdict comment, and it is Sniper's work-order input, so the finding fields carry
// identifiers and loci only, never messages or snippets.
//
// Observed-break findings are a Sniper target but NOT a gate condition, so they ride the
// findings list and never affect `passed`.

import { z } from 'zod'
import { ProvenanceSchema } from './edges.js'

export const GateConditionNameSchema = z.enum(['blast-radius', 'tests', 'no-new-divergence', 'security'])
export type GateConditionName = z.infer<typeof GateConditionNameSchema>

export const GateStatusSchema = z.enum(['pass', 'fail', 'unknown'])
export type GateStatus = z.infer<typeof GateStatusSchema>

export const GateConditionSchema = z.object({
  name: GateConditionNameSchema,
  status: GateStatusSchema,
  // One line of human-facing evidence for the status (e.g. "2 new divergences",
  // "advisories disabled", "4 files, 1 service within ceiling 50/10").
  detail: z.string(),
})
export type GateCondition = z.infer<typeof GateConditionSchema>

export const GateFindingKindSchema = z.enum(['vulnerability', 'divergence', 'observed-break'])
export type GateFindingKind = z.infer<typeof GateFindingKindSchema>

export const GateFindingLocusSchema = z.object({
  // Repo-relative on the head tree, forward slashes, never absolute, no ".." segments.
  file: z.string(),
  line: z.number().int().nonnegative().optional(),
  symbol: z.string().optional(),
})
export type GateFindingLocus = z.infer<typeof GateFindingLocusSchema>

export const GateFindingSchema = z.object({
  // A deterministic lowercase sha256 hex digest. Stable across re-runs of one head SHA, and
  // across later head SHAs while the same issue persists, so a fix-PR can be deduped on it.
  findingId: z.string().regex(/^[0-9a-f]{64}$/),
  kind: GateFindingKindSchema,
  // A node id in the head graph: the side to edit (divergence), the importing service or
  // file (vulnerability), or the broken node (observed-break).
  affectedNode: z.string(),
  // The code locus on the head tree, or null when none is known (never guessed).
  locus: GateFindingLocusSchema.nullable(),
  // The provenance of the evidence that carries the finding.
  provenance: ProvenanceSchema,
  // Vulnerability findings only: the advisory, and its fixed version when known.
  advisoryId: z.string().optional(),
  fixedIn: z.string().optional(),
})
export type GateFinding = z.infer<typeof GateFindingSchema>

export const NoRegressionGateVerdictSchema = z.object({
  // The four conditions, always all present.
  conditions: z.array(GateConditionSchema),
  // Targetable findings, parallel to the conditions. observed-break entries ride here but
  // never affect `passed`.
  findings: z.array(GateFindingSchema),
  // True only when every condition is `pass`; any unknown or fail makes it false
  // (fail-closed). Whether a false verdict blocks a merge is the action's opt-in (G4).
  passed: z.boolean(),
})
export type NoRegressionGateVerdict = z.infer<typeof NoRegressionGateVerdictSchema>

// Inputs the gate cannot compute from the two graphs: the repo's test outcome (absent makes
// the tests condition `unknown`) and the blast-radius ceiling. Supplied by the caller (the
// action's workflow job, a host's check run).
export const GateInputSchema = z.object({
  tests: z.enum(['pass', 'fail']).optional(),
  blastRadius: z
    .object({ maxFiles: z.number().int().positive(), maxServices: z.number().int().positive() })
    .optional(),
})
export type GateInput = z.infer<typeof GateInputSchema>
