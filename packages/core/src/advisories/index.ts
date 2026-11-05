import type { DependencyNode, GraphNode } from '@neat.is/types'
import { NodeType } from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import type { InventoryItem } from './match.js'

export { foldAliases, normalizeOsv } from './normalize.js'
export type { Advisory, AffectedPackage, OsvRecord, SeverityLabel } from './normalize.js'
export { matchAdvisories } from './match.js'
export type { AdvisoryMatch, AdvisorySnapshot, InventoryItem } from './match.js'
export { advisorySource, loadAdvisorySnapshot, OSV_API } from './source.js'
export type { AdvisorySource, SnapshotResult } from './source.js'

// The project's resolved dependencies, as the matcher reads them. One item per
// DependencyNode: the node is per version, so services sharing a version share it.
export function inventoryFromGraph(graph: NeatGraph): InventoryItem[] {
  const out: InventoryItem[] = []
  graph.forEachNode((id, attrs) => {
    const a = attrs as GraphNode
    if (a.type !== NodeType.DependencyNode) return
    const d = a as DependencyNode
    out.push({ dependencyId: id, ecosystem: d.ecosystem, name: d.name, version: d.version })
  })
  return out.sort((x, y) => x.dependencyId.localeCompare(y.dependencyId))
}
