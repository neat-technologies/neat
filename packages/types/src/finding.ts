// The findings ledger row (ADR-279, docs/contracts/finding-triggers.md §3) and the
// payload of the tenth bus event, `finding` (§5). A row records that a qualifying
// finding (a divergence, a reachable vulnerability) was first present at a commit.
// It carries ids and kinds only: no reason, locus, evidence, message or source. A
// reader that needs what the finding says asks the graph.
//
// Every schema here is strict, so a row with a field outside the contract's list
// fails to parse instead of passing through.

import { z } from 'zod'
import { DivergenceTypeSchema } from './divergence.js'

export const FindingKindSchema = z.enum(['divergence', 'vulnerability'])
export type FindingKind = z.infer<typeof FindingKindSchema>

const FindingId = z.string().regex(/^[0-9a-f]{64}$/)
const CommitSha = z.string().regex(/^[0-9a-f]{40}$/)

const presentFields = {
  // The no-regression gate's finding id (ADR-277), a lowercase sha256 hex digest.
  findingId: FindingId,
  kind: FindingKindSchema,
  // A node id in the live graph: the declaring side of a divergence, the
  // depending service of a vulnerability.
  affectedNode: z.string().min(1).max(1024),
  // The repository that declares the affected node, and its `ready` baseline commit.
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(256),
  sha: CommitSha,
  firstSeenAt: z.string().datetime(),
  // A divergence row names its type; a vulnerability row names its advisory.
  divergenceType: DivergenceTypeSchema.optional(),
  advisoryId: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/).optional(),
}

// A finding first present at a commit. This is the row a trigger is made of.
export const FindingPresentRowSchema = z.object(presentFields).strict()
export type FindingPresentRow = z.infer<typeof FindingPresentRowSchema>

// A finding that was already present when the ledger started. It is in the ledger
// and never leaves the daemon: not on the bus, not on the trigger stream.
export const FindingBaselineRowSchema = z.object({ ...presentFields, baseline: z.literal(true) }).strict()
export type FindingBaselineRow = z.infer<typeof FindingBaselineRowSchema>

// A finding recorded as present that is no longer present.
export const FindingClearedRowSchema = z
  .object({
    findingId: FindingId,
    kind: FindingKindSchema,
    sha: CommitSha,
    clearedAt: z.string().datetime(),
    cleared: z.literal(true),
  })
  .strict()
export type FindingClearedRow = z.infer<typeof FindingClearedRowSchema>

// Any row of findings.ndjson.
export const FindingRowSchema = z.union([FindingBaselineRowSchema, FindingClearedRowSchema, FindingPresentRowSchema])
export type FindingRow = z.infer<typeof FindingRowSchema>

// What the `finding` bus event and the trigger stream carry: a ledger row that is
// not a baseline row.
export const FindingEventPayloadSchema = z.union([FindingClearedRowSchema, FindingPresentRowSchema])
export type FindingEventPayload = z.infer<typeof FindingEventPayloadSchema>
