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

// The fix loop (G2, security-card.md §4): a purely-computed remediation for the
// matched advisory. `bump-to-fixedIn` when the earliest fixed release above the
// installed version is a same-major (non-breaking) bump; `via` names the direct
// parent(s) to bump or override for a transitive dependency, empty for a direct
// one. `remove-or-replace` when there is no non-breaking bump (no fixed release,
// or only a major one) and the move is an app-layer mitigation.
export const SecurityFixActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bump-to-fixedIn'), to: z.string(), via: z.array(z.string()) }),
  z.object({ kind: z.literal('remove-or-replace'), reason: z.string() }),
])
export type SecurityFixAction = z.infer<typeof SecurityFixActionSchema>

export const SecurityCardSchema = z.object({
  kind: z.literal('security'),
  id: z.string(),
  service: z.string(),
  advisory: SecurityCardAdvisorySchema,
  dependency: SecurityCardDependencySchema,
  // `action` is additive and optional pending Deniz's lock on the §4 shape
  // (filed via orch); buildSecurityCard always sets it.
  fix: z.object({ fixedIn: z.array(z.string()).nullable(), action: SecurityFixActionSchema.optional() }),
  reachability: SecurityReachabilitySchema,
  coverage: z.object({ instrumented: z.enum(['yes', 'no', 'unknown']) }),
  headline: z.string(),
})
export type SecurityCard = z.infer<typeof SecurityCardSchema>

// What a security scan read from (advisory-cache.md §2). `disabled` means
// NEAT_ADVISORIES=off: a surface says "advisories disabled", never "no
// vulnerabilities".
export const AdvisorySourceSchema = z.enum(['mirror', 'osv', 'disabled'])

// GET /graph/security/reachable-cves (security-card.md §5, §6). `findings` are
// the ranked cards at `imported` or above; `present` cards are context, never
// findings, and come back separately.
export const SecurityScanResultSchema = z.object({
  advisories: AdvisorySourceSchema,
  asOf: z.string().nullable(),
  // Packages served from a cache past its refresh because the refresh failed.
  stale: z.number().int().nonnegative(),
  errors: z.array(z.string()),
  // DependencyNodes checked.
  inventory: z.number().int().nonnegative(),
  findings: z.array(SecurityCardSchema),
  context: z.array(SecurityCardSchema),
})
export type SecurityScanResult = z.infer<typeof SecurityScanResultSchema>

// GET /graph/security/is-reachable: one package's answer. `reachable` is
// dependency-grain: true when a known-vulnerable version of the package is
// imported by first-party code (`level` at `imported` or above). It doesn't say
// the vulnerable function is called; symbol grain waits for the CALLS cross
// (security-card.md §2). `level` is the highest step any card reaches, null when
// no advisory matches the package or it isn't in the inventory.
export const ReachabilityAnswerSchema = SecurityScanResultSchema.extend({
  package: z.string(),
  grain: z.literal('dependency'),
  reachable: z.boolean(),
  level: ReachabilityLevelSchema.nullable(),
})
export type ReachabilityAnswer = z.infer<typeof ReachabilityAnswerSchema>
