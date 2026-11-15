import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  SecurityCardSchema,
  dependencyId,
  fileId,
  securityCardId,
  serviceId,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { matchAdvisories, normalizeOsv, inventoryFromGraph } from '../src/advisories/index.js'
import type { AdvisorySnapshot, OsvRecord } from '../src/advisories/index.js'
import { buildSecurityCard, buildSecurityCards, reconcileDepFixActions } from '../src/security-card.js'

// security-card.md: pure composition, the `present` and `imported` steps of the
// ladder, from a synthetic graph and real OSV records.

const FIX = path.join(__dirname, 'fixtures/osv')
const snapshot: AdvisorySnapshot = {
  asOf: '2026-11-09T00:00:00Z',
  advisories: ['GHSA-35jh-r3h4-6jhm', 'GHSA-p6mc-m468-83gw'].map((id) =>
    normalizeOsv(JSON.parse(readFileSync(path.join(FIX, `${id}.json`), 'utf8')) as OsvRecord),
  ),
}

const LODASH = dependencyId('npm', 'lodash', '4.17.15')

function edge(source: string, target: string, type: string, extra: Partial<GraphEdge> = {}): [string, GraphEdge] {
  const id = `${type}:${source}->${target}`
  return [id, { id, source, target, type, provenance: Provenance.EXTRACTED, confidence: 1, ...extra } as GraphEdge]
}

// shop imports lodash from two files (and a test); admin has it transitively and never imports it.
function graph(opts: { observedShop?: boolean } = {}): NeatGraph {
  const g = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false }) as NeatGraph
  for (const name of ['shop', 'admin']) {
    g.addNode(serviceId(name), { id: serviceId(name), type: NodeType.ServiceNode, name, language: 'javascript' } as GraphNode)
  }
  g.addNode(LODASH, {
    id: LODASH,
    type: NodeType.DependencyNode,
    name: 'lodash',
    ecosystem: 'npm',
    version: '4.17.15',
    purl: 'pkg:npm/lodash@4.17.15',
  } as GraphNode)
  const add = ([id, e]: [string, GraphEdge]) => {
    for (const n of [e.source, e.target]) if (!g.hasNode(n)) g.addNode(n, { id: n, type: NodeType.FileNode } as GraphNode)
    g.addEdgeWithKey(id, e.source, e.target, e)
  }
  add(edge(serviceId('shop'), LODASH, EdgeType.DEPENDS_ON, {
    evidence: { file: 'package-lock.json' },
    dependency: { scope: 'direct', dev: false, introducedBy: [] },
  }))
  add(edge(serviceId('admin'), LODASH, EdgeType.DEPENDS_ON, {
    evidence: { file: 'admin/package-lock.json' },
    dependency: { scope: 'transitive', dev: false, introducedBy: ['express'] },
  }))
  for (const [file, line, bindings] of [
    ['src/render.ts', 3, ['template']],
    ['src/merge.ts', 1, ['_']],
    ['src/render.test.ts', 1, ['_']],
  ] as const) {
    add(edge(fileId('shop', file), LODASH, EdgeType.IMPORTS, {
      evidence: { file, line, specifier: 'lodash', bindings: [...bindings] },
    }))
  }
  if (opts.observedShop) {
    add(edge(fileId('shop', 'src/render.ts'), serviceId('admin'), EdgeType.CALLS, { provenance: Provenance.OBSERVED }))
  }
  return g
}

const matchFor = (g: NeatGraph) => matchAdvisories(inventoryFromGraph(g), snapshot)

describe('security cards (security-card.md)', () => {
  it('matches both lodash advisories against 4.17.15', () => {
    expect(matchFor(graph()).map((m) => m.advisoryId)).toEqual(['GHSA-35jh-r3h4-6jhm', 'GHSA-p6mc-m468-83gw'])
  })

  it("reconciles a dependency's advisories to one shared fix target (the max clearing all)", () => {
    const g = graph()
    const cards = matchFor(g).flatMap((m) => buildSecurityCards(g, m, snapshot))
    const reconciled = reconcileDepFixActions(cards, snapshot)
    // lodash matches 4.17.21 and 4.17.19; every card bumps to 4.17.21, so an agent
    // bumps once, not once per CVE.
    for (const c of reconciled) {
      if (c.fix.action?.kind === 'bump-to-fixedIn') expect(c.fix.action.to).toBe('4.17.21')
    }
    // the shop (direct) card for the lower-fix advisory now targets the shared max.
    const p6mcShop = reconciled.find((c) => c.service === 'shop' && c.advisory.id === 'GHSA-p6mc-m468-83gw')!
    expect(p6mcShop.fix.action).toEqual({ kind: 'bump-to-fixedIn', to: '4.17.21', via: [] })
    // the admin (transitive) card shares the target but keeps its own via.
    const admin = reconciled.find((c) => c.service === 'admin')!
    expect(admin.fix.action).toEqual({ kind: 'bump-to-fixedIn', to: '4.17.21', via: ['express'] })
  })

  it('reconcile targets the lowest version the matcher clears, past a re-affected range', () => {
    // widget 2.0.0 matches advisory A (affected [2.0, 2.5) and again [2.8, 2.12))
    // and advisory B (affected [2.0, 2.10)). The max of the per-advisory minimal
    // fixes is 2.10.0, but that lands back inside A's second range; only 2.12.0
    // clears both, and the reconcile must find it by re-matching, not by the max.
    const osv = (id: string, events: { introduced?: string; fixed?: string }[]): OsvRecord => ({
      id,
      summary: id,
      modified: '2026-01-01T00:00:00Z',
      affected: [{ package: { name: 'widget', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events }] }],
    })
    const snap: AdvisorySnapshot = {
      asOf: '2026-11-09T00:00:00Z',
      advisories: [
        normalizeOsv(osv('CVE-A', [{ introduced: '2.0.0' }, { fixed: '2.5.0' }, { introduced: '2.8.0' }, { fixed: '2.12.0' }])),
        normalizeOsv(osv('CVE-B', [{ introduced: '2.0.0' }, { fixed: '2.10.0' }])),
      ],
    }
    const WIDGET = dependencyId('npm', 'widget', '2.0.0')
    const g = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false }) as NeatGraph
    g.addNode(serviceId('shop'), {
      id: serviceId('shop'),
      type: NodeType.ServiceNode,
      name: 'shop',
      language: 'javascript',
    } as GraphNode)
    g.addNode(WIDGET, {
      id: WIDGET,
      type: NodeType.DependencyNode,
      name: 'widget',
      ecosystem: 'npm',
      version: '2.0.0',
      purl: 'pkg:npm/widget@2.0.0',
    } as GraphNode)
    for (const [id, e] of [
      edge(serviceId('shop'), WIDGET, EdgeType.DEPENDS_ON, {
        evidence: { file: 'package-lock.json' },
        dependency: { scope: 'direct', dev: false, introducedBy: [] },
      }),
      edge(fileId('shop', 'src/app.ts'), WIDGET, EdgeType.IMPORTS, {
        evidence: { file: 'src/app.ts', line: 1, specifier: 'widget', bindings: ['widget'] },
      }),
    ]) {
      for (const n of [e.source, e.target]) if (!g.hasNode(n)) g.addNode(n, { id: n, type: NodeType.FileNode } as GraphNode)
      g.addEdgeWithKey(id, e.source, e.target, e)
    }

    const cards = matchAdvisories(inventoryFromGraph(g), snap).flatMap((m) => buildSecurityCards(g, m, snap))
    expect(cards.length).toBeGreaterThan(1)
    for (const c of reconcileDepFixActions(cards, snap)) {
      expect(c.fix.action).toEqual({ kind: 'bump-to-fixedIn', to: '2.12.0', via: [] })
    }
    // the max-of-minimals target (2.10.0) is still matched by CVE-A, which is why
    // the reconcile cannot just take it.
    const atMax = matchAdvisories([{ dependencyId: WIDGET, ecosystem: 'npm', name: 'widget', version: '2.10.0' }], snap)
    expect(atMax.map((m) => m.advisoryId)).toContain('CVE-A')
  })

  it('skips a candidate another advisory affects, even one that did not hit the installed version', () => {
    // gadget 2.0.0 matches A ([2.0, 2.5)) and B ([2.0, 2.11) and again [2.12, 2.14)).
    // 2.11.0 clears both of those, but advisory C affects [2.11, 2.12) and so is NOT
    // matched at the installed 2.0.0. Bumping to 2.11.0 would introduce C, so the
    // target must climb to 2.14.0, the lowest candidate the matcher finds clean.
    const osv = (id: string, events: { introduced?: string; fixed?: string }[]): OsvRecord => ({
      id,
      summary: id,
      modified: '2026-01-01T00:00:00Z',
      affected: [{ package: { name: 'gadget', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events }] }],
    })
    const snap: AdvisorySnapshot = {
      asOf: '2026-11-09T00:00:00Z',
      advisories: [
        normalizeOsv(osv('CVE-A', [{ introduced: '2.0.0' }, { fixed: '2.5.0' }])),
        normalizeOsv(osv('CVE-B', [{ introduced: '2.0.0' }, { fixed: '2.11.0' }, { introduced: '2.12.0' }, { fixed: '2.14.0' }])),
        normalizeOsv(osv('CVE-C', [{ introduced: '2.11.0' }, { fixed: '2.12.0' }])),
      ],
    }
    const GADGET = dependencyId('npm', 'gadget', '2.0.0')
    const g = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false }) as NeatGraph
    g.addNode(serviceId('shop'), {
      id: serviceId('shop'),
      type: NodeType.ServiceNode,
      name: 'shop',
      language: 'javascript',
    } as GraphNode)
    g.addNode(GADGET, {
      id: GADGET,
      type: NodeType.DependencyNode,
      name: 'gadget',
      ecosystem: 'npm',
      version: '2.0.0',
      purl: 'pkg:npm/gadget@2.0.0',
    } as GraphNode)
    for (const [id, e] of [
      edge(serviceId('shop'), GADGET, EdgeType.DEPENDS_ON, {
        evidence: { file: 'package-lock.json' },
        dependency: { scope: 'direct', dev: false, introducedBy: [] },
      }),
      edge(fileId('shop', 'src/app.ts'), GADGET, EdgeType.IMPORTS, {
        evidence: { file: 'src/app.ts', line: 1, specifier: 'gadget', bindings: ['gadget'] },
      }),
    ]) {
      for (const n of [e.source, e.target]) if (!g.hasNode(n)) g.addNode(n, { id: n, type: NodeType.FileNode } as GraphNode)
      g.addEdgeWithKey(id, e.source, e.target, e)
    }

    // C does not match the installed version, so it is not one of gadget's cards.
    const matched = matchAdvisories(inventoryFromGraph(g), snap).map((m) => m.advisoryId)
    expect(matched).toEqual(['CVE-A', 'CVE-B'])
    // but it does match 2.11.0, which is why that candidate must be skipped.
    const at211 = matchAdvisories([{ dependencyId: GADGET, ecosystem: 'npm', name: 'gadget', version: '2.11.0' }], snap)
    expect(at211.map((m) => m.advisoryId)).toContain('CVE-C')

    const cards = matchAdvisories(inventoryFromGraph(g), snap).flatMap((m) => buildSecurityCards(g, m, snap))
    for (const c of reconcileDepFixActions(cards, snap)) {
      expect(c.fix.action).toEqual({ kind: 'bump-to-fixedIn', to: '2.14.0', via: [] })
    }
  })

  it('an importing service gets an `imported` card with its non-test importers', () => {
    const g = graph()
    const match = matchFor(g).find((m) => m.advisoryId === 'GHSA-35jh-r3h4-6jhm')!
    const card = buildSecurityCard(g, match, snapshot, serviceId('shop'))!
    expect(SecurityCardSchema.parse(card)).toEqual(card)
    expect(card.id).toBe(securityCardId('GHSA-35jh-r3h4-6jhm', LODASH, serviceId('shop')))
    expect(card.reachability.level).toBe('imported')
    expect(card.reachability.importers).toEqual([
      { file: 'src/merge.ts', line: 1, bindings: ['_'], provenance: 'EXTRACTED' },
      { file: 'src/render.ts', line: 3, bindings: ['template'], provenance: 'EXTRACTED' },
    ])
    expect(card.fix.fixedIn).toEqual(['4.17.21'])
    // G2 fix loop: 4.17.15 -> 4.17.21 is a same-major, non-breaking bump.
    expect(card.fix.action).toEqual({ kind: 'bump-to-fixedIn', to: '4.17.21', via: [] })
    expect(card.headline).toContain('Bump to 4.17.21.')
    expect(card.advisory).toMatchObject({ id: 'GHSA-35jh-r3h4-6jhm', asOf: snapshot.asOf })
    expect(card.dependency).toMatchObject({ scope: 'direct', dev: false, manifest: { file: 'package-lock.json' } })
    expect(card.reachability).toMatchObject({ grain: 'package', grainSource: 'package', path: null, method: 'call-graph, no dataflow' })
    expect(card.reachability.limits).toHaveLength(1)
    expect(card.coverage.instrumented).toBe('no')
    expect(card.headline).toMatch(/^lodash 4\.17\.15 \(GHSA-35jh-r3h4-6jhm, high\) is imported by 2 files in shop/)
    expect(card.headline).toContain('Fixed in 4.17.21.')
    expect(card.headline).toContain('not instrumented')
    // verify-after-apply guidance (#1618): an actionable card names the back half of the fix loop,
    // scoped to the files that use the dependency, so a cleared scan is not mistaken for a done fix.
    expect(card.headline).toContain('run the tests covering the 2 files that import lodash')
    expect(card.headline).toContain('a cleared scan alone is not done')
  })

  it('a service that never imports it gets a `present` card, transitive parent named', () => {
    const g = graph()
    const match = matchFor(g)[0]!
    const card = buildSecurityCard(g, match, snapshot, serviceId('admin'))!
    expect(card.reachability.level).toBe('present')
    expect(card.reachability.importers).toEqual([])
    expect(card.reachability.limits).toEqual([])
    expect(card.dependency).toMatchObject({ scope: 'transitive', introducedBy: ['express'] })
    expect(card.headline).toContain("in admin's dependencies (transitive via express) but no first-party file imports it")
  })

  it('makes one card per depending service, and none for a service without the version', () => {
    const g = graph()
    const match = matchFor(g)[0]!
    expect(buildSecurityCards(g, match, snapshot).map((c) => [c.service, c.reachability.level])).toEqual([
      ['admin', 'present'],
      ['shop', 'imported'],
    ])
    g.addNode(serviceId('docs'), { id: serviceId('docs'), type: NodeType.ServiceNode, name: 'docs', language: 'javascript' } as GraphNode)
    expect(buildSecurityCard(g, match, snapshot, serviceId('docs'))).toBeNull()
    expect(buildSecurityCard(g, { ...match, advisoryId: 'GHSA-none' }, snapshot, serviceId('shop'))).toBeNull()
  })

  it('reads coverage as unknown once the service has spoken at runtime', () => {
    const g = graph({ observedShop: true })
    const card = buildSecurityCard(g, matchFor(g)[0]!, snapshot, serviceId('shop'))!
    expect(card.coverage.instrumented).toBe('unknown')
    expect(card.headline).not.toContain('not instrumented')
  })

  it('is pure: same inputs, same card, graph untouched', () => {
    const g = graph()
    const before = JSON.stringify(g.export())
    const match = matchFor(g)[0]!
    const a = buildSecurityCards(g, match, snapshot)
    const b = buildSecurityCards(g, match, snapshot)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(g.export())).toBe(before)
  })
})
