import { createHash } from 'node:crypto'
import {
  GraphEdgeSchema,
  GraphNodeSchema,
  NodeType,
  PolicyFileSchema,
  Provenance,
  frontierEdgeId,
  serviceId,
  type EdgeTypeValue,
  type GraphNode,
  type PolicyViolation,
} from '@neat.is/types'
import { makeGraph, type NeatGraph } from '../graph.js'
import { extractFromDirectory } from './index.js'
import { evaluateAllPolicies } from '../policy.js'
import { getBlastRadius } from '../traverse.js'
import { stageFrontierEdge } from '../ingest.js'

// The sandbox candidate assessment behind the hidden `neat assess` verb
// (docs/contracts/candidate-assessment.md, SNIPER-ADR-005, #1359). Every graph
// here lives in this process only; nothing is written anywhere.

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

type IdSets = { nodes: string[]; edges: string[] }

export interface AssessmentVerdict {
  passed: boolean
  reason: AssessmentReason
  violations: {
    policyId: string
    onViolation: PolicyViolation['onViolation']
    ruleType: PolicyViolation['ruleType']
    nodeId?: string
    edgeId?: string
  }[]
  blastRadius: { nodes: string[]; files: number; services: number }
  graphDiff: { added: IdSets; removed: IdSets; changed: IdSets }
}

/** The ids staged under one candidate id. In memory only; never a schema field. */
export interface StagingLedger {
  candidateId: string
  added: IdSets
  removed: IdSets
  changed: IdSets
}

export function refusedAssessment(reason: AssessmentReason): AssessmentVerdict {
  return {
    passed: false,
    reason,
    violations: [],
    blastRadius: { nodes: [], files: 0, services: 0 },
    graphDiff: { added: { nodes: [], edges: [] }, removed: { nodes: [], edges: [] }, changed: { nodes: [], edges: [] } },
  }
}

class Refusal extends Error {
  constructor(readonly reason: AssessmentReason) { super(reason) }
}

// The daemon's `{nodes, edges}` wire shape, or a graphology snapshot's `{graph}`.
export function readBaseline(input: unknown): NeatGraph {
  if (!input || typeof input !== 'object') throw new Refusal('invalid-input')
  const envelope = input as Record<string, unknown>
  const snapshot = 'graph' in envelope
  const raw = snapshot ? envelope.graph : envelope
  if (!raw || typeof raw !== 'object') throw new Refusal('invalid-input')
  const { nodes, edges } = raw as Record<string, unknown>
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Refusal('invalid-input')
  const graph = makeGraph()
  for (const entry of nodes) {
    const wrapped = entry as { key?: unknown; attributes?: unknown }
    const parsed = GraphNodeSchema.safeParse(snapshot ? wrapped?.attributes : entry)
    if (!parsed.success) throw new Refusal('invalid-input')
    const node = parsed.data
    if ((snapshot && wrapped.key !== node.id) || graph.hasNode(node.id)) throw new Refusal('invalid-input')
    graph.addNode(node.id, node)
  }
  for (const entry of edges) {
    const wrapped = entry as { key?: unknown; source?: unknown; target?: unknown; attributes?: unknown }
    const parsed = GraphEdgeSchema.safeParse(snapshot ? wrapped?.attributes : entry)
    if (!parsed.success) throw new Refusal('invalid-input')
    const edge = parsed.data
    if (snapshot && (wrapped.key !== edge.id || wrapped.source !== edge.source || wrapped.target !== edge.target)) {
      throw new Refusal('invalid-input')
    }
    if (graph.hasEdge(edge.id) || !graph.hasNode(edge.source) || !graph.hasNode(edge.target)) throw new Refusal('invalid-input')
    graph.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, edge)
  }
  return graph
}

function serviceOf(node: GraphNode): string | undefined {
  if (node.type === NodeType.ServiceNode) return node.id
  const service = (node as { service?: unknown }).service
  return typeof service === 'string' ? serviceId(service) : undefined
}

// Scope (contract §3): the ServiceNode ids the candidate extracted. An EXTRACTED
// edge belongs to its source's service. A node is static-owned in scope when it
// names a scoped service and was not discovered from traffic; shared nodes
// (databases, infra, other services) are never removed, only their edges are.
function inScopeEdge(graph: NeatGraph, id: string, scope: Set<string>): boolean {
  const edge = graph.getEdgeAttributes(id)
  if (edge.provenance !== Provenance.EXTRACTED) return false
  const owner = serviceOf(graph.getNodeAttributes(edge.source))
  return owner !== undefined && scope.has(owner)
}

function inScopeStaticNodes(graph: NeatGraph, scope: Set<string>): Set<string> {
  const out = new Set<string>()
  graph.forEachNode((id, node) => {
    if (node.type === NodeType.ServiceNode) return
    const discoveredVia = (node as { discoveredVia?: unknown }).discoveredVia
    const owner = serviceOf(node)
    if (discoveredVia !== 'otel' && owner !== undefined && scope.has(owner)) out.add(id)
  })
  return out
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// Runtime-observed attributes a surviving node keeps when the candidate's
// declaration replaces the old one (contract §5). Nothing declarative is revived.
function preserveRuntimeAttributes(before: GraphNode, fresh: GraphNode): GraphNode {
  if (before.type === NodeType.ServiceNode && fresh.type === NodeType.ServiceNode) {
    return {
      ...fresh,
      ...(before.env !== undefined ? { env: before.env } : {}),
      ...(before.observedImage !== undefined ? { observedImage: before.observedImage } : {}),
      ...(before.observedReadyReplicas !== undefined ? { observedReadyReplicas: before.observedReadyReplicas } : {}),
      ...(before.discoveredVia === 'otel' || before.discoveredVia === 'merged' ? { discoveredVia: 'merged' as const } : {}),
    }
  }
  if (before.type === NodeType.InfraNode && fresh.type === NodeType.InfraNode) {
    const columns = new Map((fresh.columns ?? []).map((column) => [column.name, column]))
    for (const old of before.columns ?? []) {
      const runtime = old.provenances.filter((p) => p !== Provenance.EXTRACTED && p !== Provenance.FRONTIER)
      if (runtime.length === 0) continue
      const declared = columns.get(old.name)
      columns.set(old.name, {
        ...old,
        ...declared,
        provenances: [...new Set([...(declared?.provenances ?? []), ...runtime])].sort(),
        confidence: Math.max(old.confidence, declared?.confidence ?? 0),
        ...(old.sdkWrites ? { sdkWrites: [...new Set([...(declared?.sdkWrites ?? []), ...old.sdkWrites])].sort() } : {}),
      })
    }
    return columns.size > 0 ? { ...fresh, columns: [...columns.values()].sort((a, b) => a.name.localeCompare(b.name)) } : fresh
  }
  return fresh
}

/** Contract §3: the candidate's static delta against the settled graph, within scope. */
export function candidateDelta(settled: NeatGraph, candidate: NeatGraph): StagingLedger {
  const scope = new Set(candidate.filterNodes((_, n) => n.type === NodeType.ServiceNode))
  const settledStatic = inScopeStaticNodes(settled, scope)
  const added: IdSets = { nodes: [], edges: [] }
  const removed: IdSets = { nodes: [], edges: [] }
  const changed: IdSets = { nodes: [], edges: [] }
  candidate.forEachNode((id, node) => {
    if (!settled.hasNode(id)) added.nodes.push(id)
    else if (stable(preserveRuntimeAttributes(settled.getNodeAttributes(id), node)) !== stable(settled.getNodeAttributes(id))) changed.nodes.push(id)
  })
  for (const id of settledStatic) if (!candidate.hasNode(id)) removed.nodes.push(id)
  candidate.forEachEdge((id, edge) => {
    if (!settled.hasEdge(id)) added.edges.push(id)
    else if (stable(edge) !== stable(settled.getEdgeAttributes(id))) changed.edges.push(id)
  })
  settled.forEachEdge((id) => { if (inScopeEdge(settled, id, scope) && !candidate.hasEdge(id)) removed.edges.push(id) })
  for (const set of [added, removed, changed]) { set.nodes.sort(); set.edges.sort() }
  const candidateId = `candidate:${createHash('sha256').update(stable({ added, removed, changed })).digest('hex')}`
  return { candidateId, added, removed, changed }
}

/**
 * Contract §4: a copy of the settled graph with the candidate's added edges staged
 * as FRONTIER through the ingest proposal path, and its added nodes placed as plain
 * nodes. Removals and changes stay in the ledger; no settled fact is touched.
 */
export function stageCandidate(settled: NeatGraph, candidate: NeatGraph, ledger: StagingLedger): NeatGraph {
  const staged = settled.copy() as NeatGraph
  for (const id of ledger.added.nodes) {
    if (!staged.hasNode(id)) staged.addNode(id, candidate.getNodeAttributes(id))
  }
  for (const id of ledger.added.edges) {
    const edge = candidate.getEdgeAttributes(id)
    stageFrontierEdge(staged, edge.source, edge.target, edge.type as EdgeTypeValue)
  }
  return staged
}

/**
 * Contract §5: the surface promotion of this candidate would produce. Only the
 * candidate's staged FRONTIER edges graduate, to the EXTRACTED edges extraction
 * will write; foreign FRONTIER stays FRONTIER.
 */
export function promoteCandidate(staged: NeatGraph, candidate: NeatGraph, ledger: StagingLedger): NeatGraph {
  const promoted = staged.copy() as NeatGraph
  for (const id of ledger.added.edges) {
    const edge = candidate.getEdgeAttributes(id)
    const frontier = frontierEdgeId(edge.source, edge.target, edge.type)
    if (promoted.hasEdge(frontier)) promoted.dropEdge(frontier)
    promoted.addDirectedEdgeWithKey(id, edge.source, edge.target, edge)
  }
  for (const id of ledger.changed.edges) promoted.replaceEdgeAttributes(id, candidate.getEdgeAttributes(id))
  for (const id of ledger.removed.edges) if (promoted.hasEdge(id)) promoted.dropEdge(id)
  for (const id of ledger.removed.nodes) {
    const runtime = promoted.edges(id).some((e) => {
      const p = promoted.getEdgeAttributes(e).provenance
      return p === Provenance.OBSERVED || p === Provenance.INFERRED || p === Provenance.STALE
    })
    if (runtime) throw new Refusal('runtime-endpoint-removed')
    promoted.dropNode(id)
  }
  for (const id of ledger.changed.nodes) {
    promoted.replaceNodeAttributes(id, preserveRuntimeAttributes(promoted.getNodeAttributes(id), candidate.getNodeAttributes(id)))
  }
  return promoted
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

    const violations = evaluateAllPolicies(promoted, parsedPolicies.data.policies, { now: () => 0 })
      .map((v) => ({
        policyId: v.policyId,
        onViolation: v.onViolation,
        ruleType: v.ruleType,
        ...(v.subject.nodeId ? { nodeId: v.subject.nodeId } : {}),
        ...(v.subject.edgeId ? { edgeId: v.subject.edgeId } : {}),
      }))
      .sort((a, b) => stable(a).localeCompare(stable(b)))

    // Contract §6: the whole delta's reach, removed nodes read on the settled graph.
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
      blastRadius,
      graphDiff: { added: ledger.added, removed: ledger.removed, changed: ledger.changed },
    }
  } catch (error) {
    return refusedAssessment(error instanceof Refusal ? error.reason : 'invalid-input')
  }
}

