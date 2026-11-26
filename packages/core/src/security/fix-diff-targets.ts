import type { DependencyNode } from '@neat.is/types'
import { dependencySymbolId } from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import type { FixDiff } from '../advisories/fixdiff.js'

// Resolving an advisory's fix-diff to the installed version's graph nodes
// (security-card.md §2b): the symbols a fix changed, as the SymbolNodes a reach
// path can aim at. Pure.

// A qualname's base name: no `~N` disambiguator and no `obj.` qualifier, so
// `template~0` (a rollup build's `function template`) and `_.template` (an older
// IIFE build's `_.template = function`) name the same thing.
export function baseSymbolName(qualname: string): string {
  return qualname.replace(/~\d+$/, '').split('.').pop() ?? qualname
}

// The symbols the fix changed, as this installed version's SymbolNodes. A symbol
// new in the fixed release isn't in an affected version and can't be a target.
// One with no exact node here (the package was restructured between the
// installed version and the fix pair) resolves by base name within its file,
// but only when the advisory names it.
export function changedTargets(graph: NeatGraph, dep: DependencyNode, fixDiff: FixDiff): Set<string> {
  const out = new Set<string>()
  const byName: { file: string; name: string }[] = []
  for (const c of fixDiff.changed) {
    if (c.status === 'new') continue
    const id = dependencySymbolId(dep.ecosystem, dep.name, dep.version, c.file, c.symbol)
    if (graph.hasNode(id)) out.add(id)
    else if (c.namedInAdvisory) byName.push({ file: c.file, name: baseSymbolName(c.symbol) })
  }
  if (byName.length === 0) return out
  // `<prefix><file>#<qualname>[~N]` for every symbol of this installed version.
  const prefix = dependencySymbolId(dep.ecosystem, dep.name, dep.version, '', '').slice(0, -1)
  const wanted = new Map<string, Set<string>>()
  for (const { file, name } of byName) {
    const names = wanted.get(file) ?? new Set<string>()
    names.add(name)
    wanted.set(file, names)
  }
  graph.forEachNode((id) => {
    if (!id.startsWith(prefix)) return
    const rest = id.slice(prefix.length)
    const hash = rest.indexOf('#')
    if (hash < 0) return
    const names = wanted.get(rest.slice(0, hash))
    if (names?.has(baseSymbolName(rest.slice(hash + 1)))) out.add(id)
  })
  return out
}
