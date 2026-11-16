import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { GraphEdge } from '@neat.is/types'
import { EdgeType, Provenance, confidenceForExtracted } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { exists, makeEdgeId, type DiscoveredService } from '../shared.js'
import { recordExtractionError } from '../errors.js'
import { makeInfraNode } from './shared.js'
import { ensureFileNode, toPosix } from '../calls/shared.js'
import { declared } from '../declare.js'

interface DockerfileFacts {
  image: string | null
  // Ports declared with `EXPOSE`, in declaration order, deduped. Each one is a
  // network endpoint the container listens on — the structural answer to "what
  // is this service reachable at".
  ports: number[]
  // The trimmed `ENTRYPOINT` / `CMD` line that names the process the container
  // runs. Carried as edge evidence so the entrypoint is queryable instead of
  // being a silent fact only the Dockerfile knows.
  entrypoint: string | null
}

// Read the runtime-shaping instructions out of a Dockerfile in one pass:
//
//   - FROM   → the runtime image. Multi-stage builds report the *runtime* image
//              (the last FROM that isn't `scratch` / a stage alias).
//   - EXPOSE → the ports the container listens on (`EXPOSE 8080 9090`,
//              `EXPOSE 8080/tcp`).
//   - CMD / ENTRYPOINT → the process the container runs. ENTRYPOINT wins when
//              both are present, matching Docker's precedence.
function readDockerfile(content: string): DockerfileFacts {
  let image: string | null = null
  const ports: number[] = []
  let cmd: string | null = null
  let entrypoint: string | null = null
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (/^from\s+/i.test(line)) {
      const candidate = line.split(/\s+/)[1]
      if (candidate && candidate.toLowerCase() !== 'scratch') image = candidate
    } else if (/^expose\s+/i.test(line)) {
      for (const token of line.split(/\s+/).slice(1)) {
        const port = Number.parseInt(token.split('/')[0]!, 10)
        if (Number.isInteger(port) && !ports.includes(port)) ports.push(port)
      }
    } else if (/^entrypoint\s+/i.test(line)) {
      entrypoint = line
    } else if (/^cmd\s+/i.test(line)) {
      cmd = line
    }
  }
  return { image, ports, entrypoint: entrypoint ?? cmd }
}

// For each ServiceNode that has a Dockerfile in its dir, emit a
// `infra:container-image:<image>` InfraNode and a RUNS_ON edge from the
// service to the image.
export async function addDockerfileRuntimes(
  graph: NeatGraph,
  services: DiscoveredService[],
  scanPath: string,
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  let nodesAdded = 0
  let edgesAdded = 0

  for (const service of services) {
    const dockerfilePath = path.join(service.dir, 'Dockerfile')
    if (!(await exists(dockerfilePath))) continue
    let content: string
    try {
      content = await fs.readFile(dockerfilePath, 'utf8')
    } catch (err) {
      recordExtractionError(
        'infra dockerfile',
        path.relative(scanPath, dockerfilePath),
        err,
      )
      continue
    }
    const facts = readDockerfile(content)
    if (!facts.image) continue

    const node = makeInfraNode('container-image', facts.image)
    declared(graph, 'node', node.id)
    if (!graph.hasNode(node.id)) {
      graph.addNode(node.id, node)
      nodesAdded++
    }

    // file-awareness §1 — the Dockerfile IS the file that declares the runtime;
    // anchor the infra edges on a FileNode for it, not on the service. The file
    // node is service-scoped, so two services that both `FROM node:20` keep
    // distinct entrypoints and exposed ports instead of colliding on the shared
    // image node.
    const relDockerfile = toPosix(path.relative(service.dir, dockerfilePath))
    const evidenceFile = toPosix(path.relative(scanPath, dockerfilePath))
    const { fileNodeId, nodesAdded: fn, edgesAdded: fe } = ensureFileNode(
      graph,
      service.pkg.name,
      service.node.id,
      relDockerfile,
    )
    nodesAdded += fn
    edgesAdded += fe

    // RUNS_ON carries the runtime image, and — when the Dockerfile declares one
    // — the entrypoint/CMD line as evidence.snippet, so the process the
    // container runs is queryable instead of a silent fact.
    const edgeId = makeEdgeId(fileNodeId, node.id, EdgeType.RUNS_ON)
    declared(graph, 'edge', edgeId)
    if (!graph.hasEdge(edgeId)) {
      const edge: GraphEdge = {
        id: edgeId,
        source: fileNodeId,
        target: node.id,
        type: EdgeType.RUNS_ON,
        provenance: Provenance.EXTRACTED,
        confidence: confidenceForExtracted('structural'),
        evidence: {
          file: evidenceFile,
          ...(facts.entrypoint ? { snippet: facts.entrypoint.slice(0, 120) } : {}),
        },
      }
      graph.addEdgeWithKey(edgeId, edge.source, edge.target, edge)
      edgesAdded++
    }

    // Each EXPOSE port becomes an `infra:port:<n>` node the Dockerfile
    // CONNECTS_TO — the structural answer to "what is this service reachable
    // at". Without this, a declared listener is a fact only the Dockerfile
    // knows; with it, the port is a first-class node the topology can reach.
    for (const port of facts.ports) {
      const portNode = makeInfraNode('port', String(port))
      declared(graph, 'node', portNode.id)
      if (!graph.hasNode(portNode.id)) {
        graph.addNode(portNode.id, portNode)
        nodesAdded++
      }
      const portEdgeId = makeEdgeId(fileNodeId, portNode.id, EdgeType.CONNECTS_TO)
      declared(graph, 'edge', portEdgeId)
      if (graph.hasEdge(portEdgeId)) continue
      const portEdge: GraphEdge = {
        id: portEdgeId,
        source: fileNodeId,
        target: portNode.id,
        type: EdgeType.CONNECTS_TO,
        provenance: Provenance.EXTRACTED,
        confidence: confidenceForExtracted('structural'),
        evidence: { file: evidenceFile, snippet: `EXPOSE ${port}` },
      }
      graph.addEdgeWithKey(portEdgeId, portEdge.source, portEdge.target, portEdge)
      edgesAdded++
    }
  }

  return { nodesAdded, edgesAdded }
}
