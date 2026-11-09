import type { DependencyNode, GraphEdge, GraphNode, SecurityCard, SecurityFixAction, ServiceNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  SecurityCardSchema,
  dependencySymbolId,
  fileId,
  isDependencySymbolId,
  parseDependencySymbolId,
  parseSymbolId,
  securityCardId,
} from '@neat.is/types'
import type { FixDiff } from './advisories/fixdiff.js'
import type { NeatGraph } from './graph.js'
import type { AdvisoryMatch, AdvisorySnapshot } from './advisories/match.js'
import { matchAdvisories } from './advisories/match.js'
import { isTestPath } from './extract/shared.js'
import { fixActionFor, rigorousFixAction } from './advisories/fix-action.js'

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

// ── reachable-static (security-card.md §2) ─────────────────────────────────

type PathHop = NonNullable<SecurityCard['reachability']['path']>[number]

// The symbols the fix changed, as this installed version's SymbolNodes. A symbol
// new in the fixed release isn't in an affected version, and one whose file or
// name moved since has no node here; neither can be a target.
function changedTargets(graph: NeatGraph, dep: DependencyNode, fixDiff: FixDiff): Set<string> {
  const out = new Set<string>()
  for (const c of fixDiff.changed) {
    if (c.status === 'new') continue
    const id = dependencySymbolId(dep.ecosystem, dep.name, dep.version, c.file, c.symbol)
    if (graph.hasNode(id)) out.add(id)
  }
  return out
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

function shortName(id: string): string {
  const dep = parseDependencySymbolId(id)
  if (dep) return `${dep.qualname} (${dep.relPath})`
  const sym = parseSymbolId(id)
  if (sym) return `${sym.qualname} (${sym.relPath})`
  return id.replace(/^file:[^:]+:/, '')
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function describeFixAction(
  action: SecurityFixAction | undefined,
  scope: 'direct' | 'transitive',
  name: string,
): string {
  if (!action) return ''
  if (action.kind === 'remove-or-replace') {
    return action.majorTo
      ? ` No non-breaking bump: a breaking fix exists at ${action.majorTo}, else remove or replace.`
      : ' No safe bump: remove or replace.'
  }
  if (scope === 'direct') return ` Bump to ${action.to}.`
  // A transitive dependency can't be bumped at its own version. Bumping the
  // parent only helps if the parent's range admits the fixed version, which the
  // graph doesn't know, so an override is the reliable move.
  if (action.via.length) return ` Bump ${action.via.join(', ')} if its range allows, else override ${name} to ${action.to}.`
  return ` Override ${name} to ${action.to} (transitive, parent unknown).`
}

function headlineFor(card: Omit<SecurityCard, 'headline'>): string {
  const { dependency: d, advisory: a, reachability: r, fix, coverage } = card
  const pkg = `${d.name} ${d.version}`
  const adv = `${a.id}, ${a.severity.label}`
  const how = d.scope === 'direct' ? 'direct' : `transitive via ${d.introducedBy.join(', ') || 'an unknown parent'}`
  const dev = d.dev ? ', dev only' : ''
  let exposure: string
  if (r.level === 'reachable-static' && r.path?.length) {
    const first = r.path[0]!
    const last = r.path[r.path.length - 1]!
    exposure =
      `reachable from ${card.service}: ${shortName(first.from)} calls ${shortName(first.to)}` +
      (r.path.length > 1 ? `, which reaches ${shortName(last.to)}` : '') +
      `, changed in the fix release (${plural(r.path.length, 'call', 'calls')}, no dataflow claimed)`
  } else if (r.level === 'imported') {
    exposure =
      r.grainSource === 'fix-diff'
        ? `imported by ${plural(r.importers.length, 'file', 'files')} in ${card.service}, but no call path to code changed in the fix was found`
        : `imported by ${plural(r.importers.length, 'file', 'files')} in ${card.service}; whether the vulnerable code is called is not yet analysed`
  } else exposure = `in ${card.service}'s dependencies (${how}${dev}) but no first-party file imports it`
  const fixed = fix.fixedIn?.length ? `Fixed in ${fix.fixedIn.join(', ')}.` : 'No fixed release.'
  const runtime = coverage.instrumented === 'no' ? ' The service is not instrumented, so runtime use is unknown.' : ''
  return `${pkg} (${adv}) is ${exposure}. ${fixed}${describeFixAction(fix.action, d.scope, d.name)}${runtime}`
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
  const fixDiff = advisory.fixDiff
  const codeInGraph = graph.outNeighbors(match.dependencyId).some(isDependencySymbolId)
  const targets = fixDiff && codeInGraph ? changedTargets(graph, depNode, fixDiff) : new Set<string>()
  const hops = importers.length > 0 && targets.size > 0 ? reachPath(graph, serviceName, match.dependencyId, targets) : null
  const level = hops ? 'reachable-static' : importers.length > 0 ? 'imported' : 'present'
  const limits: string[] = []
  if (level === 'imported') {
    if (!fixDiff) limits.push('The fix release has not been diffed, so there is no changed code to reach; reachability past the import is unknown.')
    else if (!codeInGraph) limits.push("The package's own code is not in the graph, so reachability past the import is unknown.")
    else if (targets.size === 0) limits.push('None of the code the fix changed exists under the same file and name in the installed version.')
    else {
      limits.push(
        'No call path from first-party code to code changed in the fix was found. Calls on objects (method dispatch), dynamic requires, re-exports from other packages and calls made from templates are not resolved, so this does not show the code is unreachable.',
      )
    }
  }
  const path: PathHop[] | null = hops
    ? hops.map((e) => ({ from: e.source, to: e.target, provenance: Provenance.EXTRACTED }))
    : null

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
    fix: {
      fixedIn: match.fixedIn.length ? [...match.fixedIn] : null,
      // Base action for this one advisory; reconcileDepFixActions aggregates a
      // dependency's advisories into one shared target over the full card set.
      action: fixActionFor({
        fixedInByAdvisory: [match.fixedIn],
        installed: depNode.version,
        ecosystem: depNode.ecosystem,
        scope: edge.dependency?.scope ?? 'direct',
        introducedBy: [...(edge.dependency?.introducedBy ?? [])],
      }),
    },
    reachability: {
      level,
      grain: fixDiff ? 'symbol' : 'package',
      grainSource: fixDiff ? 'fix-diff' : 'package',
      changedInFix: (fixDiff?.changed ?? []).map((c) => ({ symbol: c.symbol, file: c.file, namedInAdvisory: c.namedInAdvisory })),
      importers,
      path,
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

/**
 * Give every card for a dependency the same fix action (ADR-274 fix loop). When a
 * dependency matches several advisories whose fixed releases differ (lodash
 * 4.17.19 and 4.17.21), each card's `fix.action.to` becomes the one version that
 * clears all of them, so an agent bumps once rather than once per CVE. Pure, run
 * over the whole scan where every advisory for a dependency is present; `via` and
 * scope stay per-card (per service), only the target is shared.
 *
 * The target is the lowest fixed release the matcher, re-run at that version
 * against `snapshot`, clears of every one of the dependency's advisories. That
 * is stricter than the highest of the per-advisory minimal fixes, which can land
 * back inside an advisory's later affected range when the advisory re-affects one
 * (affected [1.0, 1.5) and [1.8, 2.0)); re-matching catches it.
 */
export function reconcileDepFixActions(cards: SecurityCard[], snapshot: AdvisorySnapshot): SecurityCard[] {
  const byDep = new Map<string, SecurityCard[]>()
  for (const c of cards) {
    const group = byDep.get(c.dependency.id)
    if (group) group.push(c)
    else byDep.set(c.dependency.id, [c])
  }
  return cards.map((c) => {
    const group = byDep.get(c.dependency.id)!
    if (group.length <= 1) return c
    // The dependency's distinct advisories, and every fixed release they list.
    const advisoryIds = new Set(group.map((g) => g.advisory.id))
    const candidates = group.flatMap((g) => g.fix.fixedIn ?? [])
    // A bump clears the dependency only when the matcher, re-run at that version,
    // matches none of its advisories. Catches a re-affected range a max-of-minimals
    // target would miss.
    const clears = (version: string): boolean =>
      matchAdvisories(
        [{ dependencyId: c.dependency.id, ecosystem: c.dependency.ecosystem, name: c.dependency.name, version }],
        snapshot,
      ).every((m) => !advisoryIds.has(m.advisoryId))
    const action = rigorousFixAction({
      candidates,
      installed: c.dependency.version,
      ecosystem: c.dependency.ecosystem,
      scope: c.dependency.scope,
      introducedBy: [...c.dependency.introducedBy],
      clears,
    })
    return { ...c, fix: { ...c.fix, action } }
  })
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
