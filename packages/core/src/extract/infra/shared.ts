import type { GraphEdge, InfraNode } from '@neat.is/types'
import { EdgeTypeValue, NodeType, Provenance, confidenceForExtracted, infraId } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { makeEdgeId } from '../shared.js'

// ADR-010 reserves the `infra:` prefix; the kind segment lets traversal and
// MCP tools sub-type without inventing a new top-level NodeType per source.
export function makeInfraNode(
  kind: string,
  name: string,
  provider = 'self',
  extras?: { region?: string },
): InfraNode {
  return {
    id: infraId(kind, name),
    type: NodeType.InfraNode,
    name,
    provider,
    kind,
    ...(extras?.region ? { region: extras.region } : {}),
  }
}

// Stable kind for an image string like "postgres:15-alpine" or "mysql:8".
// The image name itself ends up in the InfraNode `name` field; this function
// only classifies what the image *is*, so callers can group similar runtimes.
export function classifyImage(image: string): string {
  const lower = image.toLowerCase()
  const repo = lower.split(':')[0]!
  const last = repo.split('/').pop() ?? repo
  if (last.startsWith('postgres')) return 'postgres'
  if (last.startsWith('mysql') || last.startsWith('mariadb')) return 'mysql'
  if (last.startsWith('mongo')) return 'mongodb'
  if (last.startsWith('redis')) return 'redis'
  if (last.startsWith('rabbitmq')) return 'rabbitmq'
  if (last.startsWith('kafka') || last.includes('kafka')) return 'kafka'
  if (last.startsWith('memcached')) return 'memcached'
  return 'container'
}

// Best-effort 1-indexed line for a declared value in a config file's raw text —
// the same "read config as data" text search cloudflare.ts and terraform.ts use
// rather than a real AST.
export function lineContaining(raw: string, needle: string | undefined): number | undefined {
  if (!needle) return undefined
  const idx = raw.indexOf(needle)
  if (idx === -1) return undefined
  let line = 1
  for (let i = 0; i < idx; i++) if (raw[i] === '\n') line++
  return line
}

// One declared-resource InfraNode + an edge from the anchor (a ServiceNode or an
// entry FileNode). Idempotent; every edge carries evidence.file. Shared by the
// platform extractors (vercel/railway/supabase); cloudflare.ts predates this and
// keeps its own local copy. No self-loop when a resource id equals the anchor.
export function emitPlatformResourceEdge(
  graph: NeatGraph,
  anchorId: string,
  edgeType: EdgeTypeValue,
  kind: string,
  name: string,
  provider: string,
  evidenceFile: string,
  line?: number,
): { nodesAdded: number; edgesAdded: number } {
  let nodesAdded = 0
  let edgesAdded = 0
  const node = makeInfraNode(kind, name, provider)
  if (!graph.hasNode(node.id)) {
    graph.addNode(node.id, node)
    nodesAdded++
  }
  if (node.id === anchorId) return { nodesAdded, edgesAdded }
  const edgeId = makeEdgeId(anchorId, node.id, edgeType)
  if (!graph.hasEdge(edgeId)) {
    const edge: GraphEdge = {
      id: edgeId,
      source: anchorId,
      target: node.id,
      type: edgeType,
      provenance: Provenance.EXTRACTED,
      confidence: confidenceForExtracted('structural'),
      evidence: { file: evidenceFile, ...(line !== undefined ? { line } : {}) },
    }
    graph.addEdgeWithKey(edgeId, edge.source, edge.target, edge)
    edgesAdded++
  }
  return { nodesAdded, edgesAdded }
}
