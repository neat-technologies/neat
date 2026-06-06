import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { GraphEdge } from '@neat.is/types'
import { EdgeType, Provenance, confidenceForExtracted } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { exists, makeEdgeId, type DiscoveredService } from '../shared.js'
import { recordExtractionError } from '../errors.js'
import { makeInfraNode } from './shared.js'
import { ensureFileNode, toPosix } from '../calls/shared.js'

// Pull the first non-`scratch` `FROM` line out of a Dockerfile, ignoring
// multi-stage `as` aliases. Returns the image including tag (e.g. `node:20`,
// `python:3.11-slim`). Multi-stage builds report the *runtime* image — the
// last FROM that isn't aliasing a previous stage.
function runtimeImage(content: string): string | null {
  const lines = content.split('\n')
  let last: string | null = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (!/^from\s+/i.test(line)) continue
    const tokens = line.split(/\s+/)
    const image = tokens[1]
    if (!image || image.toLowerCase() === 'scratch') continue
    last = image
  }
  return last
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
    const image = runtimeImage(content)
    if (!image) continue

    const node = makeInfraNode('container-image', image)
    if (!graph.hasNode(node.id)) {
      graph.addNode(node.id, node)
      nodesAdded++
    }

    // file-awareness §1 — the Dockerfile IS the file that declares the runtime;
    // anchor the RUNS_ON edge on a FileNode for it, not on the service.
    const relDockerfile = toPosix(path.relative(service.dir, dockerfilePath))
    const { fileNodeId, nodesAdded: fn, edgesAdded: fe } = ensureFileNode(
      graph,
      service.pkg.name,
      service.node.id,
      relDockerfile,
    )
    nodesAdded += fn
    edgesAdded += fe
    const edgeId = makeEdgeId(fileNodeId, node.id, EdgeType.RUNS_ON)
    if (!graph.hasEdge(edgeId)) {
      const edge: GraphEdge = {
        id: edgeId,
        source: fileNodeId,
        target: node.id,
        type: EdgeType.RUNS_ON,
        provenance: Provenance.EXTRACTED,
        confidence: confidenceForExtracted('structural'),
        evidence: {
          file: toPosix(path.relative(scanPath, dockerfilePath)),
        },
      }
      graph.addEdgeWithKey(edgeId, edge.source, edge.target, edge)
      edgesAdded++
    }
  }

  return { nodesAdded, edgesAdded }
}
