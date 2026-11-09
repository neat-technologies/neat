import { z } from 'zod'

// The security card (ADR-274, docs/contracts/security-card.md): the work order for
// one known vulnerability in one service, parallel to the incident card. One card
// per (advisory, dependency version, service), composed purely from the graph and
// an advisory snapshot. Every claim carries its provenance.

// The reachability ladder (security-card.md §2): the highest step the evidence
// supports. `present` is context, never a finding.
export const ReachabilityLevelSchema = z.enum(['present', 'imported', 'reachable-static', 'reachable-observed'])
export type ReachabilityLevel = z.infer<typeof ReachabilityLevelSchema>

export const SecuritySeverityLabelSchema = z.enum(['critical', 'high', 'moderate', 'low', 'unknown'])
export type SecuritySeverityLabel = z.infer<typeof SecuritySeverityLabelSchema>

export const SecurityCardAdvisorySchema = z.object({
  id: z.string(),
  aliases: z.array(z.string()),
  summary: z.string(),
  severity: z.object({ label: SecuritySeverityLabelSchema, cvss: z.string().optional() }),
  cwe: z.array(z.string()),
  published: z.string().optional(),
  modified: z.string(),
  // When the advisory snapshot was taken (advisory-cache.md §3).
  asOf: z.string(),
})

export const SecurityCardDependencySchema = z.object({
  id: z.string(),
  ecosystem: z.string(),
  name: z.string(),
  version: z.string(),
  scope: z.enum(['direct', 'transitive']),
  dev: z.boolean(),
  introducedBy: z.array(z.string()),
  manifest: z.object({ file: z.string(), line: z.number().int().nonnegative().optional() }),
})

export const SecurityImporterSchema = z.object({
  file: z.string(),
  symbol: z.string().optional(),
  line: z.number().int().nonnegative(),
  // The names the import binds locally (dependency-inventory.md §4).
  bindings: z.array(z.string()).optional(),
  provenance: z.literal('EXTRACTED'),
})

export const SecurityReachabilitySchema = z.object({
  level: ReachabilityLevelSchema,
  grain: z.enum(['symbol', 'file', 'package']),
  grainSource: z.enum(['fix-diff', 'curated', 'package']),
  changedInFix: z.array(z.object({ symbol: z.string(), file: z.string(), namedInAdvisory: z.boolean() })),
  importers: z.array(SecurityImporterSchema),
  path: z
    .array(z.object({ from: z.string(), to: z.string(), provenance: z.enum(['EXTRACTED', 'OBSERVED', 'INFERRED']) }))
    .nullable(),
  observed: z.array(
    z.object({
      source: z.enum(['instrumentation-scope', 'stack-frame']),
      locus: z.string().optional(),
      at: z.string(),
      provenance: z.literal('OBSERVED'),
    }),
  ),
  supporting: z.array(z.object({ kind: z.literal('importer-observed'), symbol: z.string(), at: z.string() })),
  method: z.literal('call-graph, no dataflow'),
  limits: z.array(z.string()),
})

export const SecurityCardSchema = z.object({
  kind: z.literal('security'),
  id: z.string(),
  service: z.string(),
  advisory: SecurityCardAdvisorySchema,
  dependency: SecurityCardDependencySchema,
  fix: z.object({ fixedIn: z.array(z.string()).nullable() }),
  reachability: SecurityReachabilitySchema,
  coverage: z.object({ instrumented: z.enum(['yes', 'no', 'unknown']) }),
  headline: z.string(),
})
export type SecurityCard = z.infer<typeof SecurityCardSchema>
