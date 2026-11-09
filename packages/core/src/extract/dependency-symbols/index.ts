import path from 'node:path'
import type { DependencyNode, GraphEdge, GraphNode } from '@neat.is/types'
import { EdgeType, NodeType, isDependencySymbolId } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import type { DiscoveredService } from '../shared.js'
import { recordExtractionError } from '../errors.js'
import { dependencySymbolGraph } from './extract.js'
import { locateInstalledSource } from './locate.js'

export { dependencySymbolGraph, type DependencyRef } from './extract.js'
export {
  findPythonDistribution,
  locateInstalledSource,
  pythonTopLevelModules,
  type LocatedSource,
  type PythonDistribution,
} from './locate.js'

export interface DependencySymbolsResult {
  nodesAdded: number
  nodesRemoved: number
  edgesAdded: number
  // Dependencies asked for whose installed copy wasn't found (or didn't match the
  // version). Their symbols from an earlier pass stay: the ids are version-pinned,
  // so they still describe that version.
  notLocated: string[]
}

// Dependency code extraction (ADR-274, dependency-inventory.md §5). Only for the
// dependency versions given, which are the advisory-matched ones: extraction cost
// is bounded by matched packages, never by the lockfile. The caller runs the
// matcher; this phase does no network and no matching, so it is deterministic over
// what's on disk.
//
// For each version it reads the installed copy, mints its symbols owned by the
// DependencyNode, and replaces that version's symbol set from earlier passes.
//
// Not an `addX` pipeline producer (static-extraction.md): those take only
// (graph, services, scanPath), and this one needs the matched set, which can't be
// read off the graph because advisories never enter it (advisory-cache.md §5).
// When matching runs inside extraction, a producer wraps this with the matcher.
export async function extractDependencyCode(
  graph: NeatGraph,
  services: DiscoveredService[],
  scanPath: string,
  dependencyIds: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<DependencySymbolsResult> {
  const result: DependencySymbolsResult = { nodesAdded: 0, nodesRemoved: 0, edgesAdded: 0, notLocated: [] }
  const dirOf = new Map(services.map((s) => [s.node.id, s.dir]))

  for (const depId of [...new Set(dependencyIds)].sort()) {
    if (!graph.hasNode(depId)) continue
    const dep = graph.getNodeAttributes(depId) as DependencyNode
    if (dep.type !== NodeType.DependencyNode) continue

    // Search from every service that depends on this version.
    const searchFrom: string[] = []
    graph.forEachInEdge(depId, (_e, attrs, source) => {
      if ((attrs as GraphEdge).type !== EdgeType.DEPENDS_ON) return
      const dir = dirOf.get(source)
      if (dir) searchFrom.push(dir)
    })
    if (searchFrom.length === 0) searchFrom.push(scanPath)
    searchFrom.sort()

    let located
    try {
      located = await locateInstalledSource(dep, searchFrom, scanPath, env)
    } catch (err) {
      recordExtractionError('dependency symbols', depId, err)
      continue
    }
    if (!located) {
      result.notLocated.push(depId)
      continue
    }

    let built
    try {
      built = dependencySymbolGraph(dep, located.files)
    } catch (err) {
      recordExtractionError('dependency symbols', path.join(depId, '(source)'), err)
      continue
    }

    const wanted = new Set(built.nodes.map((n) => n.id))
    const previous: string[] = []
    graph.forEachOutNeighbor(depId, (n) => {
      if (isDependencySymbolId(n)) previous.push(n)
    })
    for (const id of previous) {
      if (wanted.has(id)) continue
      graph.dropNode(id)
      result.nodesRemoved++
    }
    for (const node of built.nodes) {
      if (graph.hasNode(node.id)) graph.replaceNodeAttributes(node.id, node as GraphNode)
      else {
        graph.addNode(node.id, node as GraphNode)
        result.nodesAdded++
      }
    }
    for (const edge of built.edges) {
      if (graph.hasEdge(edge.id)) graph.replaceEdgeAttributes(edge.id, edge)
      else {
        graph.addEdgeWithKey(edge.id, edge.source, edge.target, edge)
        result.edgesAdded++
      }
    }
  }
  return result
}
