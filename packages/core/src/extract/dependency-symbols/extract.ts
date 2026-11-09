import type { GraphEdge, SymbolNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  dependencyId,
  dependencySymbolId,
  extractedEdgeId,
} from '@neat.is/types'
import path from 'node:path'
import { isPackageSource, packageSymbols } from '../../advisories/fixdiff.js'
import { parseSource } from '../symbols.js'
import { resolveInPackage } from './resolve.js'
import { internalModuleCalls } from './internal-modules.js'
import { symbolEdgeParserFor, symbolEdgesOfFile, type SymbolEdgeContext } from '../symbol-edges.js'

export interface DependencyRef {
  ecosystem: string
  name: string
  version: string
}

// A dependency's own symbols as graph nodes (dependency-inventory.md §5). Pure:
// the package's files come in as a map of package-relative path → source, and
// nothing is read, fetched or executed. The symbol set is the fix-diff's
// (`packageSymbols`), so a changed symbol in an advisory's fix-diff and the
// SymbolNode in the graph are the same qualname in the same file.
//
// Each symbol is owned by its DependencyNode through a `dep ──CONTAINS──▶ symbol`
// edge. `service` carries the DependencyNode id: there is no first-party service
// to name, and a dependency id never matches a service name.
export function dependencySymbolGraph(
  dep: DependencyRef,
  files: Map<string, string>,
): { nodes: SymbolNode[]; edges: GraphEdge[] } {
  const owner = dependencyId(dep.ecosystem, dep.name, dep.version)
  const nodes: SymbolNode[] = []
  const edges: GraphEdge[] = []
  for (const s of packageSymbols(files)) {
    const id = dependencySymbolId(dep.ecosystem, dep.name, dep.version, s.file, s.qualname, s.disambiguator)
    nodes.push({
      id,
      type: NodeType.SymbolNode,
      kind: s.kind,
      qualname: s.qualname,
      span: { startLine: s.startLine, endLine: s.endLine },
      service: owner,
      relPath: s.file,
      discoveredVia: 'static',
    })
    const edgeId = extractedEdgeId(owner, id, EdgeType.CONTAINS)
    edges.push({
      id: edgeId,
      source: owner,
      target: id,
      type: EdgeType.CONTAINS,
      provenance: Provenance.EXTRACTED,
      confidence: confidenceForExtracted('structural'),
      // Package-relative: the file is in the package, not the repo.
      evidence: { file: s.file, line: s.startLine },
    })
  }
  return { nodes, edges }
}

// ── package-internal calls ──────────────────────────────────────────────────

export { resolveInPackage } from './resolve.js'

/**
 * A package's own CALLS / INHERITS / IMPLEMENTS edges among its symbols
 * (dependency-inventory.md §5), from the first-party producer's per-file core:
 * a target is a same-file definition or a named import resolved inside the
 * package, never a guess. Pure over the file map, JS/TS only.
 */
export async function dependencySymbolEdges(dep: DependencyRef, files: Map<string, string>): Promise<GraphEdge[]> {
  const { nodes } = dependencySymbolGraph(dep, files)
  const kinds = new Map(nodes.map((n) => [n.id, n.kind]))
  const paths = new Set([...files.keys()].filter(isPackageSource))
  const ctx: SymbolEdgeContext = {
    idFor: (relPath, qualname, d) => dependencySymbolId(dep.ecosystem, dep.name, dep.version, relPath, qualname, d),
    resolveImport: (specifier, from) => resolveInPackage(paths, specifier, from),
    kindOf: (sid) => kinds.get(sid) ?? null,
  }
  const out: GraphEdge[] = []
  const seen = new Set<string>()
  for (const relPath of [...paths].sort()) {
    const parser = symbolEdgeParserFor(path.posix.extname(relPath))
    if (!parser) continue
    const content = files.get(relPath)!
    for (const e of await symbolEdgesOfFile(parseSource(parser, content).rootNode, relPath, content, ctx)) {
      if (seen.has(e.id)) continue
      seen.add(e.id)
      out.push(e)
    }
  }
  // Calls between the package's modules through require / default / namespace
  // bindings, the CommonJS shape most npm packages use.
  const source = new Map([...files].filter(([p]) => paths.has(p)))
  for (const e of internalModuleCalls(dep, source, kinds)) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    out.push(e)
  }
  return out
}
