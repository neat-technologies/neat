import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ConfigNode, GraphEdge } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  configId,
  confidenceForExtracted,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import {
  IGNORED_DIRS,
  isConfigFile,
  isPythonVenvDir,
  makeEdgeId,
  type DiscoveredService,
} from './shared.js'
import { ensureFileNode, toPosix } from './calls/shared.js'

// Walk a service directory and collect every config file path
// (yaml/yml + .env-shaped). We deliberately stop at file paths here so nothing
// in this module reads file contents — .env files routinely carry secrets
// (ADR-016).
export async function walkConfigFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        if (await isPythonVenvDir(full)) continue
        await walk(full)
      } else if (entry.isFile() && isConfigFile(entry.name).match) {
        out.push(full)
      }
    }
  }
  await walk(dir)
  return out
}

// Phase 3 — turn each config file into a ConfigNode with a CONFIGURED_BY edge
// from its owning service.
export async function addConfigNodes(
  graph: NeatGraph,
  services: DiscoveredService[],
  scanPath: string,
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  let nodesAdded = 0
  let edgesAdded = 0
  for (const service of services) {
    const configFiles = await walkConfigFiles(service.dir)
    for (const file of configFiles) {
      const relPath = path.relative(scanPath, file)
      const node: ConfigNode = {
        id: configId(relPath),
        type: NodeType.ConfigNode,
        name: path.basename(file),
        path: relPath,
        fileType: isConfigFile(path.basename(file)).fileType,
      }
      if (!graph.hasNode(node.id)) {
        graph.addNode(node.id, node)
        nodesAdded++
      }
      // file-awareness §1 — the config file IS the relationship origin.
      // ensureFileNode creates the FileNode + CONTAINS edge so CONFIGURED_BY
      // lands file-grained rather than service-level.
      const relToService = toPosix(path.relative(service.dir, file))
      const { fileNodeId, nodesAdded: fn, edgesAdded: fe } = ensureFileNode(
        graph,
        service.pkg.name,
        service.node.id,
        relToService,
      )
      nodesAdded += fn
      edgesAdded += fe
      const edge: GraphEdge = {
        id: makeEdgeId(fileNodeId, node.id, EdgeType.CONFIGURED_BY),
        source: fileNodeId,
        target: node.id,
        type: EdgeType.CONFIGURED_BY,
        provenance: Provenance.EXTRACTED,
        confidence: confidenceForExtracted('structural'),
        evidence: { file: relPath.split(path.sep).join('/') },
      }
      if (!graph.hasEdge(edge.id)) {
        graph.addEdgeWithKey(edge.id, edge.source, edge.target, edge)
        edgesAdded++
      }
    }
  }
  return { nodesAdded, edgesAdded }
}
