import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  ApplicablePolicy,
  GraphEdge,
  GraphNode,
  Policy,
  PolicyAction,
  PolicyFile,
  PolicyRule,
  PolicySeverity,
  PolicyViolation,
  ServiceNode,
} from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  PolicyFileSchema,
} from '@neat.is/types'
import type { NeatGraph } from './graph.js'
import { DEFAULT_PROJECT } from './graph.js'
import {
  checkCompatibility,
  checkDeprecatedApi,
  checkNodeEngineConstraint,
  checkPackageConflict,
  compatPairs,
  deprecatedApis,
  nodeEngineConstraints,
  packageConflicts,
} from './compat.js'
import { emitNeatEvent } from './events.js'
import { getBlastRadius } from './traverse.js'

// Policy evaluation engine (ADR-043). The entry point evaluateAllPolicies is
// pure: same graph + same policies → same violations. Per-rule-type dispatch
// via the policyEvaluators table. Adding a new rule type means one new
// evaluator entry plus the schema entry in @neat.is/types/policy.ts.
//
// Deterministic violation ids per ADR-043: ${policy.id}:${context}. The
// context is shape-specific (nodeId, edgeId, or composite). The
// policy-violations.ndjson writer skips on duplicate ids.

export interface EvaluationContext {
  // Wall-clock provider. Tests pin this; production uses Date.now.
  now: () => number
}

interface RuleEvaluatorArgs<T extends PolicyRule = PolicyRule> {
  graph: NeatGraph
  policy: Policy
  rule: T
  ctx: EvaluationContext
}

type RuleEvaluator<T extends PolicyRule = PolicyRule> = (
  args: RuleEvaluatorArgs<T>,
) => PolicyViolation[]

// Severity-driven default action per ADR-044.
const DEFAULT_ACTION_BY_SEVERITY: Record<PolicySeverity, PolicyAction> = {
  info: 'log',
  warning: 'alert',
  error: 'alert',
  critical: 'block',
}

export function resolveOnViolation(policy: Policy): PolicyAction {
  return policy.onViolation ?? DEFAULT_ACTION_BY_SEVERITY[policy.severity]
}

function makeViolation(
  policy: Policy,
  rule: PolicyRule,
  contextSuffix: string,
  message: string,
  subject: PolicyViolation['subject'],
  ctx: EvaluationContext,
): PolicyViolation {
  return {
    id: `${policy.id}:${contextSuffix}`,
    policyId: policy.id,
    policyName: policy.name,
    severity: policy.severity,
    onViolation: resolveOnViolation(policy),
    ruleType: rule.type,
    subject,
    message,
    observedAt: new Date(ctx.now()).toISOString(),
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Per-rule-type evaluators
// ──────────────────────────────────────────────────────────────────────────

const evaluateStructural: RuleEvaluator<Extract<PolicyRule, { type: 'structural' }>> = ({
  graph,
  policy,
  rule,
  ctx,
}) => {
  const violations: PolicyViolation[] = []
  graph.forEachNode((id, attrs) => {
    const a = attrs as GraphNode
    if (a.type !== rule.fromNodeType) return
    let satisfied = false
    for (const edgeId of graph.outboundEdges(id)) {
      const e = graph.getEdgeAttributes(edgeId) as GraphEdge
      if (e.type !== rule.edgeType) continue
      const target = graph.getNodeAttributes(e.target) as GraphNode
      // FrontierNodes are unresolved peers (ADR-068) — skip; the rule
      // counts edges that resolve to a real typed node only.
      if (target.type === NodeType.FrontierNode) continue
      if (target.type === rule.toNodeType) {
        satisfied = true
        break
      }
    }
    if (!satisfied) {
      violations.push(
        makeViolation(
          policy,
          rule,
          id,
          `${rule.fromNodeType} ${id} has no ${rule.edgeType} edge to a ${rule.toNodeType}`,
          { nodeId: id },
          ctx,
        ),
      )
    }
  })
  return violations
}

const evaluateOwnership: RuleEvaluator<Extract<PolicyRule, { type: 'ownership' }>> = ({
  graph,
  policy,
  rule,
  ctx,
}) => {
  const violations: PolicyViolation[] = []
  graph.forEachNode((id, attrs) => {
    const a = attrs as GraphNode & Record<string, unknown>
    if (a.type !== rule.nodeType) return
    const value = a[rule.field]
    if (typeof value !== 'string' || value.length === 0) {
      violations.push(
        makeViolation(
          policy,
          rule,
          id,
          `${rule.nodeType} ${id} is missing required field "${rule.field}"`,
          { nodeId: id },
          ctx,
        ),
      )
    }
  })
  return violations
}

const evaluateProvenance: RuleEvaluator<Extract<PolicyRule, { type: 'provenance' }>> = ({
  graph,
  policy,
  rule,
  ctx,
}) => {
  const required = Array.isArray(rule.required) ? new Set(rule.required) : new Set([rule.required])
  const violations: PolicyViolation[] = []
  graph.forEachEdge((edgeId, attrs) => {
    const e = attrs as GraphEdge
    if (e.type !== rule.edgeType) return
    if (rule.targetNodeId && e.target !== rule.targetNodeId) return
    if (!required.has(e.provenance)) {
      const requiredList = [...required].join(' | ')
      violations.push(
        makeViolation(
          policy,
          rule,
          edgeId,
          `${rule.edgeType} edge ${edgeId} has provenance ${e.provenance}; required ${requiredList}`,
          { edgeId },
          ctx,
        ),
      )
    }
  })
  return violations
}

const evaluateBlastRadius: RuleEvaluator<Extract<PolicyRule, { type: 'blast-radius' }>> = ({
  graph,
  policy,
  rule,
  ctx,
}) => {
  const violations: PolicyViolation[] = []
  const depth = rule.depth
  graph.forEachNode((id, attrs) => {
    const a = attrs as GraphNode
    if (a.type !== rule.nodeType) return
    const result = depth !== undefined ? getBlastRadius(graph, id, depth) : getBlastRadius(graph, id)
    if (result.totalAffected > rule.maxAffected) {
      violations.push(
        makeViolation(
          policy,
          rule,
          id,
          `${rule.nodeType} ${id} has blast radius ${result.totalAffected} > ${rule.maxAffected}`,
          { nodeId: id, path: [id] },
          ctx,
        ),
      )
    }
  })
  return violations
}

const evaluateCompatibility: RuleEvaluator<Extract<PolicyRule, { type: 'compatibility' }>> = ({
  graph,
  policy,
  rule,
  ctx,
}) => {
  const violations: PolicyViolation[] = []
  // Iterate every ServiceNode and re-run the compat shapes the static
  // extractor runs at extract time. Catches OBSERVED-vs-EXTRACTED divergence:
  // a service whose dep manifest changed since the last extract gets re-flagged
  // here on every evaluation cycle.
  const wantsKind = (kind: NonNullable<typeof rule.kind>): boolean =>
    rule.kind === undefined || rule.kind === kind

  graph.forEachNode((svcId, attrs) => {
    const a = attrs as GraphNode
    if (a.type !== NodeType.ServiceNode) return
    const svc = a as ServiceNode
    const deps = svc.dependencies ?? {}

    if (wantsKind('driver-engine')) {
      // Walk every CONNECTS_TO edge from this service to a DatabaseNode,
      // then run the driver-engine compat for each (driver, declared, engine,
      // engineVersion) tuple.
      for (const edgeId of graph.outboundEdges(svcId)) {
        const e = graph.getEdgeAttributes(edgeId) as GraphEdge
        if (e.type !== EdgeType.CONNECTS_TO) continue
        const dbAttrs = graph.getNodeAttributes(e.target) as GraphNode
        // FrontierNodes are unresolved peers (ADR-068) — skip; compat
        // checking needs a typed DatabaseNode.
        if (dbAttrs.type === NodeType.FrontierNode) continue
        if (dbAttrs.type !== NodeType.DatabaseNode) continue
        const db = dbAttrs as { engine: string; engineVersion: string }
        for (const pair of compatPairs()) {
          if (pair.engine !== db.engine) continue
          const declared = deps[pair.driver]
          if (!declared) continue
          const result = checkCompatibility(pair.driver, declared, db.engine, db.engineVersion)
          if (!result.compatible && result.reason) {
            violations.push(
              makeViolation(
                policy,
                rule,
                `${svcId}:driver-engine:${pair.driver}@${declared}:${db.engine}@${db.engineVersion}`,
                result.reason,
                { nodeId: svcId, edgeId },
                ctx,
              ),
            )
          }
        }
      }
    }

    if (wantsKind('node-engine')) {
      const serviceNodeRange = svc.nodeEngine
      for (const constraint of nodeEngineConstraints()) {
        const declared = deps[constraint.package]
        if (!declared) continue
        const result = checkNodeEngineConstraint(constraint, declared, serviceNodeRange)
        if (!result.compatible && result.reason) {
          violations.push(
            makeViolation(
              policy,
              rule,
              `${svcId}:node-engine:${constraint.package}@${declared}`,
              result.reason,
              { nodeId: svcId },
              ctx,
            ),
          )
        }
      }
    }

    if (wantsKind('package-conflict')) {
      for (const conflict of packageConflicts()) {
        const declared = deps[conflict.package]
        if (!declared) continue
        const requiredDeclared = deps[conflict.requires.name]
        const result = checkPackageConflict(conflict, declared, requiredDeclared)
        if (!result.compatible && result.reason) {
          violations.push(
            makeViolation(
              policy,
              rule,
              `${svcId}:package-conflict:${conflict.package}@${declared}`,
              result.reason,
              { nodeId: svcId },
              ctx,
            ),
          )
        }
      }
    }

    if (wantsKind('deprecated-api')) {
      for (const dep of deprecatedApis()) {
        const declared = deps[dep.package]
        if (!declared) continue
        const result = checkDeprecatedApi(dep, declared)
        if (!result.compatible && result.reason) {
          violations.push(
            makeViolation(
              policy,
              rule,
              `${svcId}:deprecated-api:${dep.package}@${declared}`,
              result.reason,
              { nodeId: svcId },
              ctx,
            ),
          )
        }
      }
    }
  })

  return violations
}

const policyEvaluators: { [K in PolicyRule['type']]: RuleEvaluator<Extract<PolicyRule, { type: K }>> } = {
  structural: evaluateStructural,
  ownership: evaluateOwnership,
  provenance: evaluateProvenance,
  'blast-radius': evaluateBlastRadius,
  compatibility: evaluateCompatibility,
}

// ──────────────────────────────────────────────────────────────────────────
// Public entry point
// ──────────────────────────────────────────────────────────────────────────

// Block-action gating for FrontierNode promotion (ADR-044 §block, MVP scope).
// Runs the policy evaluator and returns the subset of block-action violations
// that mention the candidate FrontierNode. Callers (ingest.ts
// promoteFrontierNodes) check `allowed` before rewiring; when false, the
// promotion is skipped and the violations surface through the standard
// policy-violations.ndjson channel.
//
// Block scope is tightly bounded per the contract: FrontierNode promotion
// only. Other gating points (deploy, codemod, OTel auto-create) need their
// own ADRs before this function expands.
export function canPromoteFrontier(
  graph: NeatGraph,
  frontierId: string,
  policies: Policy[],
  ctx: EvaluationContext,
): { allowed: boolean; violations: PolicyViolation[] } {
  if (policies.length === 0) return { allowed: true, violations: [] }
  const all = evaluateAllPolicies(graph, policies, ctx)
  const blocking = all.filter((v) => {
    if (v.onViolation !== 'block') return false
    return (
      v.subject.nodeId === frontierId ||
      v.subject.path?.includes(frontierId) === true
    )
  })
  return { allowed: blocking.length === 0, violations: blocking }
}

export function evaluateAllPolicies(
  graph: NeatGraph,
  policies: Policy[],
  ctx: EvaluationContext,
): PolicyViolation[] {
  const out: PolicyViolation[] = []
  for (const policy of policies) {
    const evaluator = policyEvaluators[policy.rule.type] as RuleEvaluator
    const violations = evaluator({ graph, policy, rule: policy.rule, ctx })
    for (const v of violations) out.push(v)
  }
  return out
}

// ──────────────────────────────────────────────────────────────────────────
// Soft guardrail — applicable-policy selection (ADR-108)
// ──────────────────────────────────────────────────────────────────────────

// The launch form of "every agent stays inside the lines": policies INFORM,
// they never block. selectApplicablePolicies answers "which policies govern the
// node I'm about to edit?" so the rules can ride into the agent's context.
//
// Matching is a DIRECT subject/region match, NOT a graph traversal:
//   - subject — the node's type is the rule's declared subject (the rule
//     governs every node of that type).
//   - region — the node sits one hop inside the rule's region: the target end
//     of a structural edge, the database a compat rule reaches across a
//     CONNECTS_TO, or a node sitting on an edge a provenance rule governs.
//
// The full version surfaces far-away downstream-breaking invariants through
// the policy overlay's blast-radius injection (ADR-105 §5). That overlay is
// unbuilt; this MVP deliberately stops at one hop. It never evaluates a
// violation and never returns a verdict — surfacing a policy is not gating it.
export function selectApplicablePolicies(
  graph: NeatGraph,
  policies: Policy[],
  nodeId: string,
): ApplicablePolicy[] {
  // Without the node in the graph there's no type to match against, so we
  // can't decide applicability. A not-yet-created node (a brand-new edit) is
  // exactly the case the unbuilt overlay would handle; here we return empty
  // rather than guess.
  if (!graph.hasNode(nodeId)) return []
  const node = graph.getNodeAttributes(nodeId) as GraphNode
  const out: ApplicablePolicy[] = []
  for (const policy of policies) {
    const m = matchPolicyToNode(graph, policy, nodeId, node)
    if (!m) continue
    out.push({
      policyId: policy.id,
      policyName: policy.name,
      ...(policy.description !== undefined ? { description: policy.description } : {}),
      severity: policy.severity,
      onViolation: resolveOnViolation(policy),
      ruleType: policy.rule.type,
      match: m.match,
      reason: m.reason,
    })
  }
  return out
}

interface PolicyMatch {
  match: ApplicablePolicy['match']
  reason: string
}

function requiredProvenanceList(required: string | readonly string[]): string {
  // required is ProvenanceRule['required'] — a single value or a non-empty
  // array. Normalize to a readable "A | B" string.
  if (Array.isArray(required)) return required.join(' | ')
  return String(required)
}

function nodeTouchesEdgeType(
  graph: NeatGraph,
  nodeId: string,
  edgeType: string,
  requiredOtherEnd?: string,
): boolean {
  const incident = [...graph.outboundEdges(nodeId), ...graph.inboundEdges(nodeId)]
  for (const edgeId of incident) {
    const e = graph.getEdgeAttributes(edgeId) as GraphEdge
    if (e.type !== edgeType) continue
    // A provenance rule with a targetNodeId only governs edges that touch that
    // target. Without one, any edge of the type counts.
    if (requiredOtherEnd === undefined) return true
    if (e.source === requiredOtherEnd || e.target === requiredOtherEnd) return true
  }
  return false
}

function matchPolicyToNode(
  graph: NeatGraph,
  policy: Policy,
  nodeId: string,
  node: GraphNode,
): PolicyMatch | null {
  const rule = policy.rule
  switch (rule.type) {
    case 'structural': {
      if (node.type === rule.fromNodeType) {
        return {
          match: 'subject',
          reason: `every ${rule.fromNodeType} must have a ${rule.edgeType} edge to a ${rule.toNodeType}`,
        }
      }
      // The target end is one hop inside the rule's region — editing it can
      // make a sibling fromNodeType pass or fail the rule.
      if (node.type === rule.toNodeType) {
        return {
          match: 'region',
          reason: `${rule.fromNodeType} nodes must reach a ${rule.toNodeType} like this one via a ${rule.edgeType} edge`,
        }
      }
      return null
    }
    case 'ownership': {
      if (node.type === rule.nodeType) {
        return {
          match: 'subject',
          reason: `every ${rule.nodeType} must declare a non-empty "${rule.field}" field`,
        }
      }
      return null
    }
    case 'blast-radius': {
      if (node.type === rule.nodeType) {
        return {
          match: 'subject',
          reason: `no ${rule.nodeType} may exceed a blast radius of ${rule.maxAffected}${rule.depth !== undefined ? ` at depth ${rule.depth}` : ''}`,
        }
      }
      return null
    }
    case 'compatibility': {
      const kindLabel = rule.kind ?? 'all compat shapes'
      // The evaluator iterates every ServiceNode, so a ServiceNode is the
      // direct subject.
      if (node.type === NodeType.ServiceNode) {
        return {
          match: 'subject',
          reason: `this service's dependencies are compatibility-checked (${kindLabel})`,
        }
      }
      // A DatabaseNode one CONNECTS_TO hop from a service is in the region of
      // the driver-engine shape — its engine version feeds that check.
      const reachesDriverEngine = rule.kind === undefined || rule.kind === 'driver-engine'
      if (
        reachesDriverEngine &&
        node.type === NodeType.DatabaseNode &&
        nodeTouchesEdgeType(graph, nodeId, EdgeType.CONNECTS_TO)
      ) {
        return {
          match: 'region',
          reason: 'services connecting to this database have their driver/engine compatibility checked against it',
        }
      }
      return null
    }
    case 'provenance': {
      const requiredList = requiredProvenanceList(rule.required)
      // The named target is the direct subject — every governed edge points at
      // it.
      if (rule.targetNodeId !== undefined && nodeId === rule.targetNodeId) {
        return {
          match: 'subject',
          reason: `every ${rule.edgeType} edge into ${rule.targetNodeId} must carry ${requiredList} provenance`,
        }
      }
      // Otherwise the node is in the region if it sits on a governed edge.
      if (nodeTouchesEdgeType(graph, nodeId, rule.edgeType, rule.targetNodeId)) {
        return {
          match: 'region',
          reason:
            rule.targetNodeId !== undefined
              ? `this node sits on a ${rule.edgeType} edge to ${rule.targetNodeId}, which must carry ${requiredList} provenance`
              : `this node sits on a ${rule.edgeType} edge, which must carry ${requiredList} provenance`,
        }
      }
      return null
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Loader
// ──────────────────────────────────────────────────────────────────────────

// Reads <projectRoot>/policy.json. Returns [] when the file doesn't exist —
// a project without policies is a perfectly fine state. Failures to parse
// throw with the Zod error so the daemon surfaces malformed files loudly
// instead of silently dropping rules.
export async function loadPolicyFile(policyPath: string): Promise<Policy[]> {
  let raw: string
  try {
    raw = await fs.readFile(policyPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const json = JSON.parse(raw) as unknown
  const file: PolicyFile = PolicyFileSchema.parse(json)
  return file.policies
}

// ──────────────────────────────────────────────────────────────────────────
// Append-only ndjson writer with id-based dedup
// ──────────────────────────────────────────────────────────────────────────

// Keeps an in-memory Set of seen violation ids so re-evaluation cycles don't
// produce duplicate ndjson lines. The set hydrates from disk on first append
// — startups that load an existing log don't lose dedup state.
export class PolicyViolationsLog {
  private readonly path: string
  private readonly project: string
  private seen: Set<string> | null = null

  constructor(logPath: string, project: string = DEFAULT_PROJECT) {
    this.path = logPath
    this.project = project
  }

  async append(v: PolicyViolation): Promise<boolean> {
    if (!this.seen) await this.hydrate()
    if (this.seen!.has(v.id)) return false
    this.seen!.add(v.id)
    await fs.mkdir(path.dirname(this.path), { recursive: true })
    await fs.appendFile(this.path, JSON.stringify(v) + '\n', 'utf8')
    // Emit policy-violation only on first sighting (post-dedup) so SSE
    // consumers don't see the same violation again on every evaluation
    // cycle (ADR-051 #2).
    emitNeatEvent({
      type: 'policy-violation',
      project: this.project,
      payload: { violation: v },
    })
    return true
  }

  async readAll(): Promise<PolicyViolation[]> {
    try {
      const raw = await fs.readFile(this.path, 'utf8')
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as PolicyViolation)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }

  private async hydrate(): Promise<void> {
    this.seen = new Set()
    const existing = await this.readAll()
    for (const v of existing) this.seen.add(v.id)
  }
}
