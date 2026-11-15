import type { DependencyNode, GraphEdge, GraphNode, SecurityCard, ServiceNode } from '@neat.is/types'
import { EdgeType, NodeType, Provenance, SecurityCardSchema, isDependencySymbolId, securityCardId } from '@neat.is/types'
import type { NeatGraph } from './graph.js'
import type { AdvisoryMatch, AdvisorySnapshot } from './advisories/match.js'
import { fixActionFor } from './advisories/fix-action.js'
import { changedTargets } from './security/fix-diff-targets.js'
import { dependsOnEdge, importersOf, instrumented, reachPath } from './security/reachability.js'
import { headlineFor } from './security/presentation.js'

// The reachability ladder, fix-diff target resolution, headline and ranking each
// live in ./security/*; the fix-action compute is in ./advisories/fix-action. The
// public names stay reachable from here, re-exported below, so callers import them
// from './security-card.js' as before.
export { isImportedDependency, reachPath } from './security/reachability.js'
export { highestLevel, rankSecurityCards } from './security/presentation.js'

// The security card (ADR-274, security-card.md). Pure composition: a function of
// the graph, one advisory match and the snapshot it came from. No I/O, no clock,
// no mutation, no model. The ladder goes as high as merged evidence supports
// today: `present` from DEPENDS_ON, `imported` from first-party IMPORTS edges.
// `reachable-static` (a CALLS path into the fix-diff's changed set) and
// `reachable-observed` (instrumentation scope, stack frames) need producers that
// haven't landed, so no card claims them yet.

type PathHop = NonNullable<SecurityCard['reachability']['path']>[number]

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
