import path from 'node:path'
import type { DependencyNode, GraphEdge, GraphNode } from '@neat.is/types'
import { EdgeType, NodeType, Provenance, isDependencySymbolId } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import type { DiscoveredService } from '../shared.js'
import { recordExtractionError } from '../errors.js'
import { dependencySymbolEdges, dependencySymbolGraph } from './extract.js'
import { locateInstalledSource } from './locate.js'
import { PackageExports } from './exports.js'
import { writeCallsIntoPackages, type PackageScope } from './calls-into.js'

export { dependencySymbolEdges, dependencySymbolGraph, resolveInPackage, type DependencyRef } from './extract.js'
export { DEFAULT_EXPORT, PackageExports, moduleExports, packageEntry, type ExportTarget } from './exports.js'
export { writeCallsIntoPackages, callsIntoPackages, collectPackageBindings, type PackageScope } from './calls-into.js'
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
  edgesRemoved: number
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
  const result: DependencySymbolsResult = { nodesAdded: 0, nodesRemoved: 0, edgesAdded: 0, edgesRemoved: 0, notLocated: [] }
  // npm packages whose code is now in the graph, for the first-party calls into them.
  const scopes = new Map<string, PackageScope>()
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
    let internal: GraphEdge[]
    try {
      internal = await dependencySymbolEdges(dep, located.files)
    } catch (err) {
      recordExtractionError('dependency symbols', path.join(depId, '(calls)'), err)
      internal = []
    }
    // The package's own edges among its symbols, replaced as a set: one from an
    // earlier pass that this pass doesn't mint again is dropped.
    const wantedEdges = new Set([...built.edges, ...internal].map((e) => e.id))
    const staleEdges: string[] = []
    for (const sym of graph.outNeighbors(depId).filter(isDependencySymbolId)) {
      graph.forEachOutEdge(sym, (id, attrs) => {
        if ((attrs as GraphEdge).provenance === Provenance.EXTRACTED && !wantedEdges.has(id)) staleEdges.push(id)
      })
    }
    for (const id of staleEdges) graph.dropEdge(id)
    result.edgesRemoved += staleEdges.length
    for (const edge of [...built.edges, ...internal]) {
      if (graph.hasEdge(edge.id)) graph.replaceEdgeAttributes(edge.id, edge)
      else {
        graph.addEdgeWithKey(edge.id, edge.source, edge.target, edge)
        result.edgesAdded++
      }
    }
    if (dep.ecosystem === 'npm') {
      const kinds = new Map(built.nodes.map((n) => [n.id, n.kind]))
      scopes.set(dep.name, {
        dep,
        exports: new PackageExports(located.manifest as never, located.files),
        kindOf: (sid) => kinds.get(sid) ?? null,
      })
    }
  }

  // First-party code calling into those packages' exports.
  const into = await writeCallsIntoPackages(graph, services, scopes)
  result.edgesAdded += into.edgesAdded
  result.edgesRemoved += into.edgesRemoved
  return result
}

/**
 * Remove a dependency version's extracted code: its SymbolNodes, and with them
 * every edge into or out of them (its CONTAINS and CALLS, and first-party calls
 * into it). The DependencyNode stays; only the code goes. For a version that no
 * longer matches an advisory, since code is extracted only for matched versions
 * (dependency-inventory.md §5). Returns the number of symbols removed.
 */
export function dropDependencyCode(graph: NeatGraph, depId: string): number {
  if (!graph.hasNode(depId)) return 0
  const symbols = graph.outNeighbors(depId).filter(isDependencySymbolId)
  for (const id of symbols) graph.dropNode(id)
  return symbols.length
}
