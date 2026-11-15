import { NodeType, PolicyFileSchema, type PolicyViolation } from '@neat.is/types'
import { makeGraph, type NeatGraph } from './graph.js'
import { extractFromDirectory } from './extract/index.js'
import {
  StagingRefusal,
  candidateDelta,
  promoteCandidate,
  readBaseline,
  stageCandidate,
  type IdSets,
  type StagingLedger,
} from './extract/candidate-stage.js'
import { evaluateAllPolicies } from './policy.js'
import { getBlastRadius } from './traverse.js'

// The evaluation half of the sandbox candidate assessment behind the hidden
// `neat assess` verb (docs/contracts/candidate-assessment.md §7, SNIPER-ADR-005,
// #1359). The graphs it reads are the in-memory copies extract/candidate-stage.ts
// builds; nothing is written anywhere and nothing reaches a daemon.

export interface AssessmentInput {
  path: string
  baseline: unknown
  policies: unknown
  origin: string
  maxFiles: number
  maxServices: number
}

export type AssessmentReason =
  | 'passed'
  | 'invalid-input'
  | 'extraction-unavailable'
  | 'incomplete-extraction'
  | 'missing-origin'
  | 'runtime-endpoint-removed'
  | 'policy-block'
  | 'blast-radius-exceeded'

export interface AssessmentViolation {
  policyId: string
  onViolation: PolicyViolation['onViolation']
  ruleType: PolicyViolation['ruleType']
  nodeId?: string
  edgeId?: string
}

export interface AssessmentVerdict {
  passed: boolean
  reason: AssessmentReason
  /** Introduced or touched by the candidate. A `block` here fails the assessment. */
  violations: AssessmentViolation[]
  /** Already in the baseline and left alone by the candidate. Reported, never counted. */
  preexistingViolations: AssessmentViolation[]
  blastRadius: { nodes: string[]; files: number; services: number }
  graphDiff: { added: IdSets; removed: IdSets; changed: IdSets }
}

export function refusedAssessment(reason: AssessmentReason): AssessmentVerdict {
  return {
    passed: false,
    reason,
    violations: [],
    preexistingViolations: [],
    blastRadius: { nodes: [], files: 0, services: 0 },
    graphDiff: { added: { nodes: [], edges: [] }, removed: { nodes: [], edges: [] }, changed: { nodes: [], edges: [] } },
  }
}

function project(v: PolicyViolation): AssessmentViolation {
  return {
    policyId: v.policyId,
    onViolation: v.onViolation,
    ruleType: v.ruleType,
    ...(v.subject.nodeId ? { nodeId: v.subject.nodeId } : {}),
    ...(v.subject.edgeId ? { edgeId: v.subject.edgeId } : {}),
  }
}

// A violation's identity across the settled and promoted evaluations.
function identity(v: AssessmentViolation): string {
  return JSON.stringify([v.policyId, v.ruleType, v.nodeId ?? null, v.edgeId ?? null])
}

function byIdentity(a: AssessmentViolation, b: AssessmentViolation): number {
  return identity(a).localeCompare(identity(b))
}

/**
 * Contract §7: a violation counts when the candidate introduced it (absent from
 * the settled evaluation) or touched it (its subject is in the delta). Anything
 * else on the promoted copy was already there and left alone: reported only.
 */
export function classifyViolations(
  settled: AssessmentViolation[],
  promoted: AssessmentViolation[],
  ledger: StagingLedger,
): { violations: AssessmentViolation[]; preexistingViolations: AssessmentViolation[] } {
  const before = new Set(settled.map(identity))
  const deltaNodes = new Set([...ledger.added.nodes, ...ledger.removed.nodes, ...ledger.changed.nodes])
  const deltaEdges = new Set([...ledger.added.edges, ...ledger.removed.edges, ...ledger.changed.edges])
  const violations: AssessmentViolation[] = []
  const preexistingViolations: AssessmentViolation[] = []
  const seen = new Set<string>()
  for (const v of promoted) {
    const key = identity(v)
    if (seen.has(key)) continue
    seen.add(key)
    const touched = (v.nodeId !== undefined && deltaNodes.has(v.nodeId)) || (v.edgeId !== undefined && deltaEdges.has(v.edgeId))
    if (!before.has(key) || touched) violations.push(v)
    else preexistingViolations.push(v)
  }
  return { violations: violations.sort(byIdentity), preexistingViolations: preexistingViolations.sort(byIdentity) }
}

function reach(graph: NeatGraph, id: string, into: Set<string>): void {
  if (!graph.hasNode(id)) return
  into.add(id)
  for (const node of getBlastRadius(graph, id, graph.order).affectedNodes) into.add(node.nodeId)
}

/** Local diagnostic only: all source and graph attributes stay in this process. */
export async function assessCheckout(input: AssessmentInput): Promise<AssessmentVerdict> {
  try {
    if (!input.origin || !input.path || !Number.isSafeInteger(input.maxFiles) || input.maxFiles < 1 ||
      !Number.isSafeInteger(input.maxServices) || input.maxServices < 1) return refusedAssessment('invalid-input')
    const settled = readBaseline(input.baseline)
    const parsedPolicies = PolicyFileSchema.safeParse(input.policies)
    if (!parsedPolicies.success) return refusedAssessment('invalid-input')
    if (!settled.hasNode(input.origin)) return refusedAssessment('missing-origin')

    const candidate = makeGraph()
    try {
      const extraction = await extractFromDirectory(candidate, input.path)
      if (extraction.extractionErrors > 0 || extraction.skippedFiles > 0) return refusedAssessment('incomplete-extraction')
    } catch {
      return refusedAssessment('extraction-unavailable')
    }
    const origin = settled.getNodeAttributes(input.origin)
    if ((origin.type === NodeType.FileNode || origin.type === NodeType.SymbolNode) && !candidate.hasNode(input.origin)) {
      return refusedAssessment('missing-origin')
    }

    const ledger = candidateDelta(settled, candidate)
    const staged = stageCandidate(settled, candidate, ledger)
    const promoted = promoteCandidate(staged, candidate, ledger)

    const policies = parsedPolicies.data.policies
    const { violations, preexistingViolations } = classifyViolations(
      evaluateAllPolicies(settled, policies, { now: () => 0 }).map(project),
      evaluateAllPolicies(promoted, policies, { now: () => 0 }).map(project),
      ledger,
    )

    // Contract §7: the whole delta's reach, removed nodes read on the settled graph.
    const blast = new Set<string>([input.origin])
    reach(promoted, input.origin, blast)
    for (const id of [...ledger.added.nodes, ...ledger.changed.nodes]) reach(promoted, id, blast)
    for (const id of [...ledger.added.edges, ...ledger.changed.edges]) {
      const edge = candidate.getEdgeAttributes(id)
      reach(promoted, edge.source, blast)
      reach(promoted, edge.target, blast)
    }
    for (const id of ledger.removed.nodes) reach(settled, id, blast)
    for (const id of ledger.removed.edges) {
      const edge = settled.getEdgeAttributes(id)
      reach(settled, edge.source, blast)
      reach(settled, edge.target, blast)
    }
    const nodes = [...blast].sort()
    const typeOf = (id: string) => (promoted.hasNode(id) ? promoted : settled).getNodeAttributes(id).type
    const blastRadius = {
      nodes,
      files: nodes.filter((id) => typeOf(id) === NodeType.FileNode).length,
      services: nodes.filter((id) => typeOf(id) === NodeType.ServiceNode).length,
    }

    const reason: AssessmentReason = violations.some((v) => v.onViolation === 'block')
      ? 'policy-block'
      : blastRadius.files > input.maxFiles || blastRadius.services > input.maxServices
        ? 'blast-radius-exceeded'
        : 'passed'
    return {
      passed: reason === 'passed',
      reason,
      violations,
      preexistingViolations,
      blastRadius,
      graphDiff: { added: ledger.added, removed: ledger.removed, changed: ledger.changed },
    }
  } catch (error) {
    return refusedAssessment(error instanceof StagingRefusal ? error.reason : 'invalid-input')
  }
}
