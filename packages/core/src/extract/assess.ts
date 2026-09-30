import GraphDefault from 'graphology'
import type { MultiDirectedGraph } from 'graphology'
import {
  GraphEdgeSchema,
  GraphNodeSchema,
  NodeType,
  PolicyFileSchema,
  Provenance,
  type GraphNode,
  type PolicyViolation,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import { extractFromDirectory } from './index.js'
import { computeGraphDiff } from '../diff.js'
import { evaluateAllPolicies } from '../policy.js'
import { getBlastRadius } from '../traverse.js'

const DetachedGraph = (
  GraphDefault as unknown as {
    MultiDirectedGraph: typeof MultiDirectedGraph
  }
).MultiDirectedGraph

export interface AssessmentInput {
  path: string
  baseline: unknown
  policies: unknown
  origin: string
  maxFiles: number
  maxServices: number
}

export interface AssessmentVerdict {
  passed: boolean
  reason:
    | 'passed'
    | 'invalid-input'
    | 'extraction-unavailable'
    | 'incomplete-extraction'
    | 'missing-origin'
    | 'runtime-endpoint-removed'
    | 'policy-block'
    | 'blast-radius-exceeded'
  violations: {
    policyId: string
    onViolation: PolicyViolation['onViolation']
    ruleType: PolicyViolation['ruleType']
    nodeId?: string
    edgeId?: string
  }[]
  blastRadius: { nodes: string[]; files: number; services: number }
  graphDiff: Record<'added' | 'removed' | 'changed', { nodes: string[]; edges: string[] }>
}

export function refusedAssessment(reason: AssessmentVerdict['reason']): AssessmentVerdict {
  return {
    passed: false,
    reason,
    violations: [],
    blastRadius: { nodes: [], files: 0, services: 0 },
    graphDiff: {
      added: { nodes: [], edges: [] },
      removed: { nodes: [], edges: [] },
      changed: { nodes: [], edges: [] },
    },
  }
}

function readBaseline(input: unknown): NeatGraph {
  if (!input || typeof input !== 'object') throw new Error('invalid baseline')
  const envelope = input as Record<string, unknown>
  const snapshot = 'graph' in envelope
  const raw = snapshot ? envelope.graph : envelope
  if (!raw || typeof raw !== 'object') throw new Error('invalid baseline')
  const { nodes, edges } = raw as Record<string, unknown>
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error('invalid baseline')
  const graph: NeatGraph = new DetachedGraph({ allowSelfLoops: false })
  for (const entry of nodes) {
    const wrapped = entry as { key?: unknown; attributes?: unknown }
    const node = GraphNodeSchema.parse(snapshot ? wrapped?.attributes : entry)
    if (snapshot && wrapped.key !== node.id) throw new Error('invalid node identity')
    if (graph.hasNode(node.id)) throw new Error('duplicate node identity')
    graph.addNode(node.id, node)
  }
  for (const entry of edges) {
    const wrapped = entry as {
      key?: unknown
      source?: unknown
      target?: unknown
      attributes?: unknown
    }
    const edge = GraphEdgeSchema.parse(snapshot ? wrapped?.attributes : entry)
    if (
      snapshot &&
      (wrapped.key !== edge.id || wrapped.source !== edge.source || wrapped.target !== edge.target)
    ) {
      throw new Error('invalid edge identity')
    }
    if (graph.hasEdge(edge.id)) throw new Error('duplicate edge identity')
    graph.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, edge)
  }
  return graph
}

function isStaticNode(graph: NeatGraph, node: GraphNode): boolean {
  if (node.type === NodeType.FileNode && node.discoveredVia !== 'otel') return true
  if (node.type === NodeType.SymbolNode && node.discoveredVia !== 'otel') return true
  return (
    graph
      .edges(node.id)
      .some((id) => graph.getEdgeAttributes(id).provenance === Provenance.EXTRACTED) ||
    ('discoveredVia' in node && node.discoveredVia === 'static')
  )
}

// Fresh declaration fields replace old declarations. Preserve only attributes
// whose schema explicitly identifies runtime observations; never revive an old
// owner/dependency/guard declaration that extraction no longer produces.
function preserveRuntimeAttributes(before: GraphNode, fresh: GraphNode): GraphNode {
  if (before.type === NodeType.ServiceNode && fresh.type === NodeType.ServiceNode) {
    return {
      ...fresh,
      ...(before.env !== undefined ? { env: before.env } : {}),
      ...(before.observedImage !== undefined ? { observedImage: before.observedImage } : {}),
      ...(before.observedReadyReplicas !== undefined
        ? { observedReadyReplicas: before.observedReadyReplicas }
        : {}),
      ...(before.discoveredVia === 'otel' || before.discoveredVia === 'merged'
        ? { discoveredVia: 'merged' as const }
        : {}),
    }
  }
  if (before.type === NodeType.InfraNode && fresh.type === NodeType.InfraNode) {
    const columns = new Map((fresh.columns ?? []).map((column) => [column.name, column]))
    for (const old of before.columns ?? []) {
      const runtime = old.provenances.filter(
        (provenance) => provenance !== Provenance.EXTRACTED && provenance !== Provenance.FRONTIER,
      )
      if (runtime.length === 0) continue
      const declared = columns.get(old.name)
      columns.set(old.name, {
        ...old,
        ...declared,
        provenances: [...new Set([...(declared?.provenances ?? []), ...runtime])].sort(),
        confidence: Math.max(old.confidence, declared?.confidence ?? 0),
        ...(old.sdkWrites
          ? { sdkWrites: [...new Set([...(declared?.sdkWrites ?? []), ...old.sdkWrites])].sort() }
          : {}),
      })
    }
    return columns.size > 0
      ? { ...fresh, columns: [...columns.values()].sort((a, b) => a.name.localeCompare(b.name)) }
      : fresh
  }
  return fresh
}

/** Local diagnostic only: all source and graph attributes stay in this process. */
export async function assessCheckout(input: AssessmentInput): Promise<AssessmentVerdict> {
  let baseline: NeatGraph
  let policies: ReturnType<typeof PolicyFileSchema.parse>['policies']
  try {
    if (
      !input.origin ||
      !input.path ||
      !Number.isSafeInteger(input.maxFiles) ||
      input.maxFiles < 1 ||
      !Number.isSafeInteger(input.maxServices) ||
      input.maxServices < 1
    )
      return refusedAssessment('invalid-input')
    baseline = readBaseline(input.baseline)
    policies = PolicyFileSchema.parse(input.policies).policies
    if (!baseline.hasNode(input.origin)) return refusedAssessment('missing-origin')
  } catch {
    return refusedAssessment('invalid-input')
  }

  const candidate: NeatGraph = new DetachedGraph({ allowSelfLoops: false })
  try {
    const extraction = await extractFromDirectory(candidate, input.path)
    if (extraction.extractionErrors > 0 || extraction.skippedFiles > 0) {
      return refusedAssessment('incomplete-extraction')
    }
  } catch {
    return refusedAssessment('extraction-unavailable')
  }

  const origin = baseline.getNodeAttributes(input.origin)
  if (
    (origin.type === NodeType.FileNode || origin.type === NodeType.SymbolNode) &&
    !candidate.hasNode(input.origin)
  ) {
    return refusedAssessment('missing-origin')
  }

  for (const id of baseline.nodes()) {
    const before = baseline.getNodeAttributes(id)
    if (candidate.hasNode(id)) {
      candidate.replaceNodeAttributes(
        id,
        preserveRuntimeAttributes(before, candidate.getNodeAttributes(id)),
      )
    } else if (!isStaticNode(baseline, before)) {
      candidate.addNode(id, before)
    }
  }
  for (const id of baseline.edges()) {
    const edge = baseline.getEdgeAttributes(id)
    if (edge.provenance === Provenance.EXTRACTED || edge.provenance === Provenance.FRONTIER)
      continue
    if (!candidate.hasNode(edge.source) || !candidate.hasNode(edge.target)) {
      return refusedAssessment('runtime-endpoint-removed')
    }
    candidate.addDirectedEdgeWithKey(id, edge.source, edge.target, edge)
  }
  if (!candidate.hasNode(input.origin)) return refusedAssessment('missing-origin')

  const diff = computeGraphDiff(candidate, { graph: baseline.export() }, '1970-01-01T00:00:00.000Z')
  const graphDiff: AssessmentVerdict['graphDiff'] = {
    added: {
      nodes: diff.added.nodes.map((node) => node.id).sort(),
      edges: diff.added.edges.map((edge) => edge.id).sort(),
    },
    removed: {
      nodes: diff.removed.nodes.map((node) => node.id).sort(),
      edges: diff.removed.edges.map((edge) => edge.id).sort(),
    },
    changed: {
      nodes: diff.changed.nodes.map((node) => node.id).sort(),
      edges: diff.changed.edges.map((edge) => edge.id).sort(),
    },
  }
  const violations = evaluateAllPolicies(candidate, policies, { now: () => 0 })
    .map((violation) => ({
      policyId: violation.policyId,
      onViolation: violation.onViolation,
      ruleType: violation.ruleType,
      ...(violation.subject.nodeId ? { nodeId: violation.subject.nodeId } : {}),
      ...(violation.subject.edgeId ? { edgeId: violation.subject.edgeId } : {}),
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const nodes = [
    input.origin,
    ...getBlastRadius(candidate, input.origin, candidate.order).affectedNodes.map(
      (node) => node.nodeId,
    ),
  ].sort()
  const blastRadius = {
    nodes,
    files: nodes.filter((id) => candidate.getNodeAttributes(id).type === NodeType.FileNode).length,
    services: nodes.filter((id) => candidate.getNodeAttributes(id).type === NodeType.ServiceNode)
      .length,
  }
  const reason = violations.some((violation) => violation.onViolation === 'block')
    ? 'policy-block'
    : blastRadius.files > input.maxFiles || blastRadius.services > input.maxServices
      ? 'blast-radius-exceeded'
      : 'passed'
  return { passed: reason === 'passed', reason, violations, blastRadius, graphDiff }
}
