import type { ReachabilityAnswer, SecurityScanResult, ServiceNode } from '@neat.is/types'
import { NodeType, Provenance, isDependencySymbolId, parseDependencySymbolId } from '@neat.is/types'
import type { NeatGraph } from './graph.js'
import { inventoryFromGraph, loadAdvisorySnapshot, matchAdvisories } from './advisories/index.js'
import type { AdvisoryMatch, InventoryItem } from './advisories/index.js'
import { buildSecurityCards, highestLevel, isImportedDependency, rankSecurityCards, reachPath, reconcileSecurityCards } from './security-card.js'

// The security scan behind the reachable-CVE surfaces (security-card.md §6):
// inventory from the graph, an advisory snapshot (the one I/O step, through the
// advisory cache), the pure matcher, then the pure card builder and ranking.

export interface ScanOptions {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  // Only cards for this service (its name or its node id).
  service?: string
  // Load the code of the advisory-matched dependency versions into `graph`
  // before the cards are built, reporting the versions with no installed copy.
  // Only a caller that owns the graph passes it: the one-shot `neat security`
  // verbs over their scratch graph (dependency-inventory.md §5). A read over the
  // daemon's graph leaves it out and reads what the dependency-code loop left.
  loadDependencyCode?: LoadDependencyCode
}

export type LoadDependencyCode = (graph: NeatGraph, dependencyIds: string[]) => Promise<{ notLocated: readonly string[] }>

/**
 * Run `load` for the matched versions (sorted, deduplicated), returning the set
 * with no installed copy. No loader, nothing matched: nothing to do.
 */
export async function loadMatchedCode(
  graph: NeatGraph,
  matches: readonly AdvisoryMatch[],
  load: LoadDependencyCode | undefined,
): Promise<Set<string>> {
  const ids = [...new Set(matches.map((m) => m.dependencyId))].sort()
  if (!load || ids.length === 0) return new Set()
  return new Set((await load(graph, ids)).notLocated)
}

// A service filter given as a node id (`service:shop`) or a bare name (`shop`),
// resolved to the name cards carry.
function serviceName(graph: NeatGraph, service: string): string {
  if (graph.hasNode(service)) {
    const node = graph.getNodeAttributes(service) as ServiceNode
    if (node.type === NodeType.ServiceNode) return node.name
  }
  return service
}

async function scan(graph: NeatGraph, inventory: InventoryItem[], opts: ScanOptions): Promise<SecurityScanResult> {
  const loaded = await loadAdvisorySnapshot(inventory, { ...opts, fixDiffFor: (i) => isImportedDependency(graph, i.dependencyId) })
  const base = { advisories: loaded.source, stale: loaded.stale, errors: loaded.errors, inventory: inventory.length }
  if (!loaded.snapshot) return { ...base, asOf: null, findings: [], context: [] }
  const snapshot = loaded.snapshot
  const matches = matchAdvisories(inventory, snapshot)
  const notInstalled = await loadMatchedCode(graph, matches, opts.loadDependencyCode)
  const cards = matches
    .flatMap((m) => buildSecurityCards(graph, m, snapshot, { notInstalled }))
    .filter((c) => !opts.service || c.service === serviceName(graph, opts.service))
  // One shared fix target per dependency across its advisories, so an agent bumps
  // once instead of once per CVE (ADR-274 fix loop).
  const ranked = rankSecurityCards(reconcileSecurityCards(cards, snapshot))
  return {
    ...base,
    asOf: snapshot.asOf,
    findings: ranked.filter((c) => c.reachability.level !== 'present'),
    context: ranked.filter((c) => c.reachability.level === 'present'),
  }
}

/** Every matched advisory in the project, findings ranked, `present` as context. */
export async function scanProjectCves(graph: NeatGraph, opts: ScanOptions = {}): Promise<SecurityScanResult> {
  return scan(graph, inventoryFromGraph(graph), opts)
}

/**
 * One package's answer: its cards and the highest level they reach. Matches the
 * package by name (PyPI names PEP 503-normalized), optionally pinned to a version
 * and an ecosystem. Only that package's versions are looked up.
 */
export async function isReachable(
  graph: NeatGraph,
  query: { package: string; version?: string; ecosystem?: string; symbol?: string },
  opts: ScanOptions = {},
): Promise<ReachabilityAnswer> {
  const norm = (eco: string, n: string) => (eco === 'PyPI' ? n.replace(/[-_.]+/g, '-').toLowerCase() : n)
  const inventory = inventoryFromGraph(graph).filter(
    (i) =>
      norm(i.ecosystem, i.name) === norm(i.ecosystem, query.package) &&
      (!query.version || i.version === query.version) &&
      (!query.ecosystem || i.ecosystem === query.ecosystem),
  )
  const result = await scan(graph, inventory, opts)
  const level = highestLevel([...result.findings, ...result.context])
  if (!query.symbol) {
    return { ...result, package: query.package, grain: 'dependency', reachable: result.findings.length > 0, level }
  }
  // Symbol grain: a call path from a depending service's code to a function of
  // that name in the package (its qualname, or the last segment of it).
  const symbol = query.symbol
  const want = opts.service ? serviceName(graph, opts.service) : undefined
  const limits: string[] = []
  let path: ReturnType<typeof reachPath> = null
  let sawCode = false
  for (const item of inventory) {
    const owned = graph.outNeighbors(item.dependencyId).filter(isDependencySymbolId)
    if (owned.length) sawCode = true
    const targets = new Set(
      owned.filter((n) => {
        const p = parseDependencySymbolId(n)
        return !!p && (p.qualname === symbol || p.qualname.endsWith(`.${symbol}`))
      }),
    )
    if (targets.size === 0) continue
    for (const svc of [...graph.inNeighbors(item.dependencyId)].sort()) {
      const node = graph.getNodeAttributes(svc) as ServiceNode
      if (node.type !== NodeType.ServiceNode || (want && node.name !== want)) continue
      path = reachPath(graph, node.name, item.dependencyId, targets)
      if (path) break
    }
    if (path) break
  }
  if (!path) {
    limits.push(
      !sawCode
        ? `The code of ${query.package} is not in the graph (it is extracted only for versions with a known advisory), so symbol reachability can't be answered.`
        : 'No EXTRACTED call path from first-party code reaches it. Calls on objects (method dispatch), dynamic requires and re-exports from other packages are not resolved, so this does not show it is unreachable.',
    )
  }
  return {
    ...result,
    package: query.package,
    grain: 'symbol',
    symbol,
    reachable: path !== null,
    level,
    ...(path ? { path: path.map((e) => ({ from: e.source, to: e.target, provenance: Provenance.EXTRACTED })) } : {}),
    ...(limits.length ? { limits } : {}),
  }
}
