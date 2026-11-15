import type { DependencyNode } from '@neat.is/types'
import { dependencySymbolId } from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import type { FixDiff } from '../advisories/fixdiff.js'

// Resolving an advisory's fix-diff to the installed version's graph nodes
// (security-card.md §2): the symbols a fix changed, as the SymbolNodes a reach
// path can aim at. Pure.

// The symbols the fix changed, as this installed version's SymbolNodes. A symbol
// new in the fixed release isn't in an affected version, and one whose file or
// name moved since has no node here; neither can be a target.
export function changedTargets(graph: NeatGraph, dep: DependencyNode, fixDiff: FixDiff): Set<string> {
  const out = new Set<string>()
  for (const c of fixDiff.changed) {
    if (c.status === 'new') continue
    const id = dependencySymbolId(dep.ecosystem, dep.name, dep.version, c.file, c.symbol)
    if (graph.hasNode(id)) out.add(id)
  }
  return out
}
