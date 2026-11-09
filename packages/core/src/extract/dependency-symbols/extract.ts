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
import { packageSymbols } from '../../advisories/fixdiff.js'

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
