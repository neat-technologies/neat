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
import { buildSecurityCard, buildSecurityCards } from '../src/security-card.js'

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
