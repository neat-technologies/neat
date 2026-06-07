import type { NeatGraph } from '../graph.js'
import type { DiscoveredService } from './shared.js'
import { ensureFileNode, walkSourceFiles, toPosix } from './calls/shared.js'
import path from 'node:path'

// Phase 1 — unconditional file enumeration (ADR-092, file-awareness.md §1).
// Walks every source file matching SERVICE_FILE_EXTENSIONS within each service
// and emits a FileNode + service ──CONTAINS──▶ file edge, regardless of whether
// any call pattern fires from the file later.
export async function addFiles(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  let nodesAdded = 0
  let edgesAdded = 0

  for (const service of services) {
    const filePaths = await walkSourceFiles(service.dir)
    for (const filePath of filePaths) {
      const relPath = toPosix(path.relative(service.dir, filePath))
      const { nodesAdded: n, edgesAdded: e } = ensureFileNode(
        graph,
        service.pkg.name,
        service.node.id,
        relPath,
      )
      nodesAdded += n
      edgesAdded += e
    }
  }

  return { nodesAdded, edgesAdded }
}
