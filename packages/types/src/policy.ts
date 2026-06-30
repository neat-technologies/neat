import { z } from 'zod'
import { ProvenanceSchema, EdgeTypeSchema } from './edges.js'
import { NodeTypeSchema } from './constants.js'

// Policy schema (ADR-042). Lives at <projectRoot>/policy.json. Loaded at
// startup and reloaded on file change. Five rule types, discriminated by
// `rule.type`. Adding a new rule type requires an ADR amendment plus a
// corresponding evaluator in the engine (ADR-043).

export const PolicySeveritySchema = z.enum(['info', 'warning', 'error', 'critical'])
export type PolicySeverity = z.infer<typeof PolicySeveritySchema>

export const PolicyActionSchema = z.enum(['log', 'alert', 'block'])
export type PolicyAction = z.infer<typeof PolicyActionSchema>

// rule.type === 'structural' — asserts the existence of an edge between
// node-type pairs. e.g. "every ServiceNode must have a CONNECTS_TO edge to a
// DatabaseNode."
export const StructuralRuleSchema = z.object({
  type: z.literal('structural'),
  // Node type the rule applies to. Every node of this type must satisfy the
  // edge requirement below.
  fromNodeType: NodeTypeSchema,
  // Required outbound edge type from each fromNodeType node.
  edgeType: EdgeTypeSchema,
  // Required target node type at the other end of the edge.
  toNodeType: NodeTypeSchema,
})
export type StructuralRule = z.infer<typeof StructuralRuleSchema>

// rule.type === 'compatibility' — re-runs `compat.ts` against current graph
// state. Catches OBSERVED-vs-EXTRACTED divergence: a service whose compat
// shape failed at extract time stays flagged on every evaluation.
export const CompatibilityRuleSchema = z.object({
  type: z.literal('compatibility'),
  // Optional kind narrowing. When omitted, all four compat shapes
  // (driver-engine, node-engine, package-conflict, deprecated-api) run.
  kind: z
    .enum(['driver-engine', 'node-engine', 'package-conflict', 'deprecated-api'])
    .optional(),
})
export type CompatibilityRule = z.infer<typeof CompatibilityRuleSchema>

// rule.type === 'provenance' — asserts that edges of a given type to a given
// target carry a specific provenance (or one of a set). e.g. "every CALLS
// edge to service:payments must have OBSERVED provenance."
export const ProvenanceRuleSchema = z.object({
  type: z.literal('provenance'),
  // Edge type the rule applies to.
  edgeType: EdgeTypeSchema,
  // Target node id (e.g. 'service:payments') that incoming edges of edgeType
  // must satisfy. Optional — when omitted, the rule runs against every edge
  // of edgeType regardless of target.
  targetNodeId: z.string().optional(),
  // Required provenance (single value or one-of). The audit fails if the
  // observed edge's provenance is not in this set.
  required: z.union([ProvenanceSchema, z.array(ProvenanceSchema).min(1)]),
})
export type ProvenanceRule = z.infer<typeof ProvenanceRuleSchema>

// rule.type === 'ownership' — every node of nodeType must declare an `owner`
// field. The field name lives on the node attributes; the rule fires when a
// node of the type doesn't carry it (or carries an empty string).
export const OwnershipRuleSchema = z.object({
  type: z.literal('ownership'),
  // Node type the rule applies to. ServiceNode is the common case; the
  // discriminator stays generic so future node types can opt in.
  nodeType: NodeTypeSchema,
  // Field name on the node attributes that must be non-empty. Defaults to
  // 'owner' if omitted.
  field: z.string().default('owner'),
})
export type OwnershipRule = z.infer<typeof OwnershipRuleSchema>

// rule.type === 'blast-radius' — no node of the given type may have more
// than `maxAffected` transitively-affected downstream nodes. Computed via
// getBlastRadius at evaluation time.
export const BlastRadiusRuleSchema = z.object({
  type: z.literal('blast-radius'),
  // Node type the rule applies to (ServiceNode is the common case).
  nodeType: NodeTypeSchema,
  // Cap on `totalAffected` from getBlastRadius. Inclusive — a node hitting
  // exactly this number passes; > maxAffected fails.
  maxAffected: z.number().int().positive(),
  // Depth to evaluate against. Defaults to the contract's blast-radius
  // default (10) when omitted.
  depth: z.number().int().positive().optional(),
})
export type BlastRadiusRule = z.infer<typeof BlastRadiusRuleSchema>

export const PolicyRuleSchema = z.discriminatedUnion('type', [
  StructuralRuleSchema,
  CompatibilityRuleSchema,
  ProvenanceRuleSchema,
  OwnershipRuleSchema,
  BlastRadiusRuleSchema,
])
export type PolicyRule = z.infer<typeof PolicyRuleSchema>

export const PolicySchema = z.object({
  // Unique within the file. Duplicates fail PolicyFileSchema.parse.
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  severity: PolicySeveritySchema,
  // When omitted, the engine derives a default from severity per ADR-044
  // (info→log, warning→alert, error→alert, critical→block).
  onViolation: PolicyActionSchema.optional(),
  rule: PolicyRuleSchema,
})
export type Policy = z.infer<typeof PolicySchema>

// Top-level shape of policy.json. version: z.literal(1) — bumping requires
// an ADR amendment per the schema-growth contract (ADR-031).
export const PolicyFileSchema = z
  .object({
    version: z.literal(1),
    policies: z.array(PolicySchema),
  })
  .superRefine((file, ctx) => {
    // id uniqueness is enforced at parse time, not at registry-add time.
    // Duplicates collapse silently otherwise — we'd evaluate the second one
    // and lose the first.
    const seen = new Set<string>()
    for (const [i, p] of file.policies.entries()) {
      if (seen.has(p.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['policies', i, 'id'],
          message: `duplicate policy id "${p.id}"`,
        })
      }
      seen.add(p.id)
    }
  })
export type PolicyFile = z.infer<typeof PolicyFileSchema>

// Emitted by the evaluator. Appended to policy-violations.ndjson.
// Deterministic id (per ADR-043) means re-evaluating the same graph + same
// policies produces the same violation ids; the writer skips duplicates.
// Hypothetical action for POST /policies/check (ADR-045). Each action shape
// names a candidate change to the graph; the engine simulates it and returns
// any violations that *would* result. MVP scope is the two action shapes
// below; new shapes need an ADR amendment.
export const HypotheticalActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('promote-frontier'),
    // The FrontierNode id that would be promoted.
    frontierId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('add-edge'),
    source: z.string().min(1),
    target: z.string().min(1),
    edgeType: EdgeTypeSchema,
    provenance: ProvenanceSchema,
  }),
])
export type HypotheticalAction = z.infer<typeof HypotheticalActionSchema>

// Body of POST /policies/check.
export const PoliciesCheckBodySchema = z.object({
  hypotheticalAction: HypotheticalActionSchema.optional(),
})
export type PoliciesCheckBody = z.infer<typeof PoliciesCheckBodySchema>

// Scope filter for the check_policies MCP tool. 'all' (default) returns
// every current violation; 'unresolved' is reserved for future resolution
// tracking and behaves like 'all' for the MVP; { policyId } narrows to one
// named policy.
export const CheckPoliciesScopeSchema = z.union([
  z.enum(['all', 'unresolved']),
  z.object({ policyId: z.string().min(1) }),
])
export type CheckPoliciesScope = z.infer<typeof CheckPoliciesScopeSchema>

// Soft guardrail (ADR-108 / policies-soft-guardrail.md). The launch form of
// "every agent stays inside the lines": policies INFORM, they never block. An
// ApplicablePolicy is one policy that governs the node an agent is working at —
// matched by a direct subject/region rule match (the node's type is the rule's
// subject, or the node sits one hop inside the rule's region). It is delivered
// as context, surfaced through check_policies; it carries no violation, no
// gate, no allowed/denied verdict. `match` records why it applies:
//   - 'subject' — the node is the rule's direct subject (its type is governed).
//   - 'region'  — the node sits one hop inside the rule's region (e.g. the
//                 target end of a structural edge, or a node on a governed edge).
// The far-away downstream-breaking invariants the full overlay would surface
// (ADR-105 §5) need the unbuilt policy overlay; this MVP matches one hop only.
export const ApplicablePolicySchema = z.object({
  policyId: z.string().min(1),
  policyName: z.string().min(1),
  description: z.string().optional(),
  severity: PolicySeveritySchema,
  // The action the post-launch kernel gate WOULD take (ADR-093) — resolved
  // from policy.onViolation or the severity default. Shown for awareness only;
  // the soft guardrail never acts on it.
  onViolation: PolicyActionSchema,
  ruleType: z.enum(['structural', 'compatibility', 'provenance', 'ownership', 'blast-radius']),
  match: z.enum(['subject', 'region']),
  // Human-readable reason the policy applies here — rides into agent context.
  reason: z.string().min(1),
})
export type ApplicablePolicy = z.infer<typeof ApplicablePolicySchema>

// Response shape of GET /policies/applicable.
export const ApplicablePoliciesResponseSchema = z.object({
  node: z.string().min(1),
  applicable: z.array(ApplicablePolicySchema),
})
export type ApplicablePoliciesResponse = z.infer<typeof ApplicablePoliciesResponseSchema>

export const PolicyViolationSchema = z.object({
  // ${policy.id}:${violation-context}. The violation-context is shape-
  // specific (e.g. nodeId for structural; edgeId for provenance).
  id: z.string().min(1),
  policyId: z.string().min(1),
  policyName: z.string().min(1),
  severity: PolicySeveritySchema,
  // Resolved at evaluation time — either the explicit policy.onViolation or
  // the severity-derived default per ADR-044.
  onViolation: PolicyActionSchema,
  ruleType: z.enum(['structural', 'compatibility', 'provenance', 'ownership', 'blast-radius']),
  subject: z
    .object({
      nodeId: z.string().optional(),
      edgeId: z.string().optional(),
      path: z.array(z.string()).optional(),
    })
    .refine(
      (s) => s.nodeId !== undefined || s.edgeId !== undefined || s.path !== undefined,
      { message: 'subject must carry at least one of nodeId, edgeId, path' },
    ),
  message: z.string().min(1),
  observedAt: z.string().datetime(),
})
export type PolicyViolation = z.infer<typeof PolicyViolationSchema>
