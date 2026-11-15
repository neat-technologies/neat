import type { GraphEdge, SecurityCard } from '@neat.is/types'
import {
  EdgeType,
  Provenance,
  dependencySymbolId,
  fileId,
  isDependencySymbolId,
  parseDependencySymbolId,
  parseSymbolId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import { isTestPath } from '../extract/shared.js'

// The reachability ladder over the graph (security-card.md §2): which services
// depend on and import a dependency, whether a service is instrumented, and the
// shortest EXTRACTED CALLS path from first-party code into the fix's changed
// symbols. Pure graph reads; no I/O, no mutation.

type Importer = SecurityCard['reachability']['importers'][number]

export function dependsOnEdge(graph: NeatGraph, serviceId: string, depId: string): GraphEdge | null {
  let found: GraphEdge | null = null
  graph.forEachOutEdge(serviceId, (_e, attrs, _s, target) => {
    const e = attrs as GraphEdge
    if (!found && target === depId && e.type === EdgeType.DEPENDS_ON) found = e
  })
  return found
}

// First-party files of this service that import the package (non-test), one per
// file, in file order.
export function importersOf(graph: NeatGraph, serviceName: string, depId: string): Importer[] {
  const prefix = fileId(serviceName, '')
  const out: Importer[] = []
  graph.forEachInEdge(depId, (_e, attrs, source) => {
    const e = attrs as GraphEdge
    if (e.type !== EdgeType.IMPORTS || e.provenance !== Provenance.EXTRACTED) return
    if (!source.startsWith(prefix)) return
    const file = e.evidence?.file ?? source.slice(prefix.length)
    if (isTestPath(file)) return
    out.push({
      file,
      line: e.evidence?.line ?? 0,
      ...(e.evidence?.bindings?.length ? { bindings: e.evidence.bindings } : {}),
      provenance: Provenance.EXTRACTED,
    })
  })
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
}

/**
 * Whether any service's own (non-test) code imports this dependency: the
 * packages whose findings can reach `imported` or above, and so the only ones a
 * fix-diff is built for (advisory-cache.md §4). The same edges importersOf reads,
 * across every service.
 */
export function isImportedDependency(graph: NeatGraph, depId: string): boolean {
  if (!graph.hasNode(depId)) return false
  let found = false
  graph.forEachInEdge(depId, (_e, attrs, source) => {
    if (found) return
    const e = attrs as GraphEdge
    if (e.type !== EdgeType.IMPORTS || e.provenance !== Provenance.EXTRACTED) return
    if (!isTestPath(e.evidence?.file ?? source)) found = true
  })
  return found
}

// Whether the service has ever spoken at runtime: any OBSERVED edge on the service
// node or on one of its files or symbols. With none, the card says the service
// isn't instrumented. With some, it can't yet say the package's own code is
// covered (that needs the observed producers), so it stays `unknown`.
export function instrumented(graph: NeatGraph, serviceId: string, serviceName: string): 'no' | 'unknown' {
  const files = fileId(serviceName, '')
  const owned = (id: string) => id === serviceId || id.startsWith(files) || parseSymbolId(id)?.service === serviceName
  let seen = false
  graph.forEachEdge((_e, attrs, source, target) => {
    if (seen) return
    if ((attrs as GraphEdge).provenance === Provenance.OBSERVED && (owned(source) || owned(target))) seen = true
  })
  return seen ? 'unknown' : 'no'
}

// The service's own code: one of its files, or a first-party symbol of it.
function isServiceCode(id: string, serviceName: string): boolean {
  if (id.startsWith(fileId(serviceName, ''))) return true
  return !isDependencySymbolId(id) && parseSymbolId(id)?.service === serviceName
}

/**
 * The shortest EXTRACTED CALLS path from the service's code into the package and
 * on to a changed symbol, or null. Multi-source BFS from the service's calls into
 * the package, then along the package's own calls only; ties break on edge id,
 * so the same graph always gives the same path.
 */
export function reachPath(graph: NeatGraph, serviceName: string, depId: string, targets: Set<string>): GraphEdge[] | null {
  const owned = new Set(graph.outNeighbors(depId).filter(isDependencySymbolId))
  const calls = (edges: string[]) =>
    edges
      .map((id) => graph.getEdgeAttributes(id) as GraphEdge)
      .filter((e) => e.type === EdgeType.CALLS && e.provenance === Provenance.EXTRACTED)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const parent = new Map<string, GraphEdge>()
  const queue: string[] = []
  for (const sym of [...owned].sort()) {
    for (const e of calls(graph.inboundEdges(sym))) {
      if (!isServiceCode(e.source, serviceName) || parent.has(sym)) continue
      parent.set(sym, e)
    }
  }
  // Entries in edge-id order, so the BFS frontier is deterministic.
  queue.push(...[...parent.entries()].sort(([, a], [, b]) => (a.id < b.id ? -1 : 1)).map(([n]) => n))
  const pathTo = (end: string): GraphEdge[] => {
    const hops: GraphEdge[] = []
    let cur = end
    for (;;) {
      const e = parent.get(cur)!
      hops.unshift(e)
      if (!owned.has(e.source)) return hops
      cur = e.source
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]!
    if (targets.has(cur)) return pathTo(cur)
    const next = calls(graph.outboundEdges(cur))
    // `new X()` lands on the class; constructing it runs X's constructor, whose
    // body holds the calls. That step is certain, so the walk takes it.
    const ctor = constructorOf(cur)
    if (ctor && owned.has(ctor) && !parent.has(ctor)) {
      parent.set(ctor, { id: `${cur}->${ctor}`, source: cur, target: ctor, type: EdgeType.CALLS, provenance: Provenance.EXTRACTED, confidence: 1 } as GraphEdge)
      queue.push(ctor)
    }
    for (const e of next) {
      if (!owned.has(e.target) || parent.has(e.target)) continue
      parent.set(e.target, e)
      queue.push(e.target)
    }
  }
  return null
}

// The constructor SymbolNode of a class SymbolNode, when it has one.
function constructorOf(id: string): string | null {
  const p = parseDependencySymbolId(id)
  if (!p) return null
  return dependencySymbolId(p.ecosystem, p.name, p.version, p.relPath, `${p.qualname}.constructor`)
}
