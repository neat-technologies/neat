import path from 'node:path'
import type { GraphEdge } from '@neat.is/types'
import { EdgeType, Provenance, confidenceForExtracted } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { exists, makeEdgeId, readYaml, type DiscoveredService } from '../shared.js'
import { recordExtractionError } from '../errors.js'
import { classifyImage, makeInfraNode } from './shared.js'
import { declared } from '../declare.js'

interface ComposeService {
  image?: string
  build?: string | { context?: string }
  depends_on?: string[] | Record<string, unknown>
}

interface ComposeFile {
  services?: Record<string, ComposeService>
}

function dependsOnList(value: ComposeService['depends_on']): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value
  return Object.keys(value)
}

function serviceNameToServiceNode(
  name: string,
  services: DiscoveredService[],
): string | null {
  for (const s of services) {
    if (s.node.name === name || path.basename(s.dir) === name) return s.node.id
  }
  return null
}

// Project-level docker-compose.yml describes deployment topology. Each compose
// service that is *not* one of the discovered ServiceNodes becomes an
// InfraNode (databases, brokers, caches). depends_on lists become DEPENDS_ON
// edges from the dependent to its dependency, regardless of whether the
// endpoint is a ServiceNode or InfraNode — the edge itself is the deployment
// fact, not the role.
export async function addComposeInfra(
  graph: NeatGraph,
  scanPath: string,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  let nodesAdded = 0
  let edgesAdded = 0

  let composePath: string | null = null
  for (const name of ['docker-compose.yml', 'docker-compose.yaml']) {
    const abs = path.join(scanPath, name)
    if (await exists(abs)) {
      composePath = abs
      break
    }
  }
  if (!composePath) return { nodesAdded, edgesAdded }

  let compose: ComposeFile
  try {
    compose = await readYaml<ComposeFile>(composePath)
  } catch (err) {
    recordExtractionError(
      'infra docker-compose',
      path.relative(scanPath, composePath),
      err,
    )
    return { nodesAdded, edgesAdded }
  }
  if (!compose?.services) return { nodesAdded, edgesAdded }
  const evidenceFile = path.relative(scanPath, composePath).split(path.sep).join('/')

  const composeNameToNodeId = new Map<string, string>()
  for (const [composeName, svc] of Object.entries(compose.services)) {
    const matchedServiceId = serviceNameToServiceNode(composeName, services)
    if (matchedServiceId) {
      composeNameToNodeId.set(composeName, matchedServiceId)
      continue
    }
    const kind = svc.image ? classifyImage(svc.image) : 'container'
    const node = makeInfraNode(kind, composeName)
    declared(graph, 'node', node.id)
    if (!graph.hasNode(node.id)) {
      graph.addNode(node.id, node)
      nodesAdded++
    }
    composeNameToNodeId.set(composeName, node.id)
  }

  for (const [composeName, svc] of Object.entries(compose.services)) {
    const sourceId = composeNameToNodeId.get(composeName)
    if (!sourceId) continue
    for (const dep of dependsOnList(svc.depends_on)) {
      const targetId = composeNameToNodeId.get(dep)
      if (!targetId) continue
      const edgeId = makeEdgeId(sourceId, targetId, EdgeType.DEPENDS_ON)
      declared(graph, 'edge', edgeId)
      if (graph.hasEdge(edgeId)) continue
      // depends_on declaration from docker-compose.yml — structural deployment
      // fact, structural tier per ADR-066.
      const edge: GraphEdge = {
        id: edgeId,
        source: sourceId,
        target: targetId,
        type: EdgeType.DEPENDS_ON,
        provenance: Provenance.EXTRACTED,
        confidence: confidenceForExtracted('structural'),
        evidence: { file: evidenceFile },
      }
      graph.addEdgeWithKey(edgeId, edge.source, edge.target, edge)
      edgesAdded++
    }
  }

  return { nodesAdded, edgesAdded }
}
