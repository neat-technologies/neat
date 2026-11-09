import type { ReachabilityAnswer, SecurityScanResult, ServiceNode } from '@neat.is/types'
import { NodeType } from '@neat.is/types'
import type { NeatGraph } from './graph.js'
import { inventoryFromGraph, loadAdvisorySnapshot, matchAdvisories } from './advisories/index.js'
import type { InventoryItem } from './advisories/index.js'
import { buildSecurityCards, highestLevel, rankSecurityCards } from './security-card.js'

// The security scan behind the reachable-CVE surfaces (security-card.md §6):
// inventory from the graph, an advisory snapshot (the one I/O step, through the
// advisory cache), the pure matcher, then the pure card builder and ranking.

export interface ScanOptions {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  // Only cards for this service (its name or its node id).
  service?: string
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
  const loaded = await loadAdvisorySnapshot(inventory, opts)
  const base = { advisories: loaded.source, stale: loaded.stale, errors: loaded.errors, inventory: inventory.length }
  if (!loaded.snapshot) return { ...base, asOf: null, findings: [], context: [] }
  const snapshot = loaded.snapshot
  const cards = matchAdvisories(inventory, snapshot)
    .flatMap((m) => buildSecurityCards(graph, m, snapshot))
    .filter((c) => !opts.service || c.service === serviceName(graph, opts.service))
  const ranked = rankSecurityCards(cards)
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
  query: { package: string; version?: string; ecosystem?: string },
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
  return {
    ...result,
    package: query.package,
    grain: 'dependency',
    reachable: result.findings.length > 0,
    level: highestLevel([...result.findings, ...result.context]),
  }
}
