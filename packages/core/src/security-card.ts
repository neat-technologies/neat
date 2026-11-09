import type { DependencyNode, GraphEdge, GraphNode, SecurityCard, ServiceNode } from '@neat.is/types'
import { EdgeType, NodeType, Provenance, SecurityCardSchema, fileId, parseSymbolId, securityCardId } from '@neat.is/types'
import type { NeatGraph } from './graph.js'
import type { AdvisoryMatch, AdvisorySnapshot } from './advisories/match.js'
import { isTestPath } from './extract/shared.js'

// The security card (ADR-274, security-card.md). Pure composition: a function of
// the graph, one advisory match and the snapshot it came from. No I/O, no clock,
// no mutation, no model. The ladder goes as high as merged evidence supports
// today: `present` from DEPENDS_ON, `imported` from first-party IMPORTS edges.
// `reachable-static` (a CALLS path into the fix-diff's changed set) and
// `reachable-observed` (instrumentation scope, stack frames) need producers that
// haven't landed, so no card claims them yet.

type Importer = SecurityCard['reachability']['importers'][number]

function dependsOnEdge(graph: NeatGraph, serviceId: string, depId: string): GraphEdge | null {
  let found: GraphEdge | null = null
  graph.forEachOutEdge(serviceId, (_e, attrs, _s, target) => {
    const e = attrs as GraphEdge
    if (!found && target === depId && e.type === EdgeType.DEPENDS_ON) found = e
  })
  return found
}

// First-party files of this service that import the package (non-test), one per
// file, in file order.
function importersOf(graph: NeatGraph, serviceName: string, depId: string): Importer[] {
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

// Whether the service has ever spoken at runtime: any OBSERVED edge on the service
// node or on one of its files or symbols. With none, the card says the service
// isn't instrumented. With some, it can't yet say the package's own code is
// covered (that needs the observed producers), so it stays `unknown`.
function instrumented(graph: NeatGraph, serviceId: string, serviceName: string): 'no' | 'unknown' {
  const files = fileId(serviceName, '')
  const owned = (id: string) => id === serviceId || id.startsWith(files) || parseSymbolId(id)?.service === serviceName
  let seen = false
  graph.forEachEdge((_e, attrs, source, target) => {
    if (seen) return
    if ((attrs as GraphEdge).provenance === Provenance.OBSERVED && (owned(source) || owned(target))) seen = true
  })
  return seen ? 'unknown' : 'no'
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function headlineFor(card: Omit<SecurityCard, 'headline'>): string {
  const { dependency: d, advisory: a, reachability: r, fix, coverage } = card
  const pkg = `${d.name} ${d.version}`
  const adv = `${a.id}, ${a.severity.label}`
  const how = d.scope === 'direct' ? 'direct' : `transitive via ${d.introducedBy.join(', ') || 'an unknown parent'}`
  const dev = d.dev ? ', dev only' : ''
  const exposure =
    r.level === 'imported'
      ? `imported by ${plural(r.importers.length, 'file', 'files')} in ${card.service}; whether the vulnerable code is called is not yet analysed`
      : `in ${card.service}'s dependencies (${how}${dev}) but no first-party file imports it`
  const fixed = fix.fixedIn?.length ? `Fixed in ${fix.fixedIn.join(', ')}.` : 'No fixed release.'
  const runtime = coverage.instrumented === 'no' ? ' The service is not instrumented, so runtime use is unknown.' : ''
  return `${pkg} (${adv}) is ${exposure}. ${fixed}${runtime}`
}

/**
 * The card for one advisory match in one service, or null when the service
 * doesn't depend on that version or the advisory isn't in the snapshot.
 */
export function buildSecurityCard(
  graph: NeatGraph,
  match: AdvisoryMatch,
  snapshot: AdvisorySnapshot,
  serviceId: string,
): SecurityCard | null {
  const advisory = snapshot.advisories.find((a) => a.id === match.advisoryId)
  if (!advisory || !graph.hasNode(match.dependencyId) || !graph.hasNode(serviceId)) return null
  const dep = graph.getNodeAttributes(match.dependencyId) as GraphNode
  const svc = graph.getNodeAttributes(serviceId) as GraphNode
  if (dep.type !== NodeType.DependencyNode || svc.type !== NodeType.ServiceNode) return null
  const edge = dependsOnEdge(graph, serviceId, match.dependencyId)
  if (!edge) return null
  const depNode = dep as DependencyNode
  const serviceName = (svc as ServiceNode).name

  const importers = importersOf(graph, serviceName, match.dependencyId)
  const level = importers.length > 0 ? 'imported' : 'present'
  const limits: string[] = []
  if (level === 'imported') {
    limits.push('The call graph into and inside the package is not built yet, so reachability past the import is unknown.')
  }

  const card: Omit<SecurityCard, 'headline'> = {
    kind: 'security',
    id: securityCardId(advisory.id, match.dependencyId, serviceId),
    service: serviceName,
    advisory: {
      id: advisory.id,
      aliases: [...advisory.aliases],
      summary: advisory.summary,
      severity: { label: advisory.severity.label, ...(advisory.severity.cvss ? { cvss: advisory.severity.cvss } : {}) },
      cwe: [...advisory.cwe],
      ...(advisory.published ? { published: advisory.published } : {}),
      modified: advisory.modified,
      asOf: match.asOf,
    },
    dependency: {
      id: match.dependencyId,
      ecosystem: depNode.ecosystem,
      name: depNode.name,
      version: depNode.version,
      scope: edge.dependency?.scope ?? 'direct',
      dev: edge.dependency?.dev ?? false,
      introducedBy: [...(edge.dependency?.introducedBy ?? [])],
      manifest: { file: edge.evidence?.file ?? '', ...(edge.evidence?.line !== undefined ? { line: edge.evidence.line } : {}) },
    },
    fix: { fixedIn: match.fixedIn.length ? [...match.fixedIn] : null },
    reachability: {
      level,
      grain: 'package',
      grainSource: 'package',
      changedInFix: [],
      importers,
      path: null,
      observed: [],
      supporting: [],
      method: 'call-graph, no dataflow',
      limits,
    },
    coverage: { instrumented: instrumented(graph, serviceId, serviceName) },
  }
  return SecurityCardSchema.parse({ ...card, headline: headlineFor(card) })
}

/** One card per service that depends on the matched version, in service-id order. */
export function buildSecurityCards(graph: NeatGraph, match: AdvisoryMatch, snapshot: AdvisorySnapshot): SecurityCard[] {
  if (!graph.hasNode(match.dependencyId)) return []
  const services = new Set<string>()
  graph.forEachInEdge(match.dependencyId, (_e, attrs, source) => {
    if ((attrs as GraphEdge).type === EdgeType.DEPENDS_ON) services.add(source)
  })
  return [...services]
    .sort()
    .map((s) => buildSecurityCard(graph, match, snapshot, s))
    .filter((c): c is SecurityCard => c !== null)
}

const LEVEL_RANK: Record<SecurityCard['reachability']['level'], number> = {
  'reachable-observed': 3,
  'reachable-static': 2,
  imported: 1,
  present: 0,
}
const SEVERITY_RANK: Record<SecurityCard['advisory']['severity']['label'], number> = {
  critical: 4,
  high: 3,
  moderate: 2,
  low: 1,
  unknown: 0,
}

/** The highest ladder step among `cards`, or null for none. */
export function highestLevel(cards: SecurityCard[]): SecurityCard['reachability']['level'] | null {
  let best: SecurityCard['reachability']['level'] | null = null
  for (const c of cards) if (best === null || LEVEL_RANK[c.reachability.level] > LEVEL_RANK[best]) best = c.reachability.level
  return best
}

/**
 * Ranking (security-card.md §5): level, then severity, then direct before
 * transitive, then card id so the order is total. A new array; the input is
 * untouched. Callers keep `present` cards out of a findings list.
 */
export function rankSecurityCards(cards: SecurityCard[]): SecurityCard[] {
  return [...cards].sort(
    (a, b) =>
      LEVEL_RANK[b.reachability.level] - LEVEL_RANK[a.reachability.level] ||
      SEVERITY_RANK[b.advisory.severity.label] - SEVERITY_RANK[a.advisory.severity.label] ||
      (a.dependency.scope === b.dependency.scope ? 0 : a.dependency.scope === 'direct' ? -1 : 1) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}
