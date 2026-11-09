import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  ReachabilityAnswerSchema,
  SecurityCardSchema,
  SecurityScanResultSchema,
  dependencyId,
  fileId,
  serviceId,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { isReachable, scanProjectCves } from '../src/security-scan.js'
import { rankSecurityCards } from '../src/security-card.js'
import { buildApi } from '../src/api.js'

// The scan behind get_reachable_cves / is_reachable (security-card.md §5, §6):
// inventory → snapshot (through a stand-in for OSV) → match → cards → ranking.

const FIX = path.join(__dirname, 'fixtures/osv')
const rec = (id: string) => JSON.parse(readFileSync(path.join(FIX, `${id}.json`), 'utf8'))

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true })
})
async function env(extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-sec-'))
  dirs.push(home)
  return { NEAT_HOME: home, ...extra }
}

// OSV stand-in: querybatch answers by package name, /v1/vulns serves the fixture.
function fakeOsv(byName: Record<string, string[]>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/querybatch')) {
      const body = JSON.parse(String(init?.body)) as { queries: Array<{ package: { name: string } }> }
      return new Response(
        JSON.stringify({ results: body.queries.map((q) => ({ vulns: (byName[q.package.name] ?? []).map((id) => ({ id })) })) }),
      )
    }
    return new Response(JSON.stringify(rec(decodeURIComponent(url.split('/v1/vulns/')[1] ?? ''))))
  }) as typeof fetch
}
const osv = fakeOsv({
  lodash: ['GHSA-35jh-r3h4-6jhm', 'GHSA-p6mc-m468-83gw'],
  jinja2: ['PYSEC-2019-217'],
})

const JINJA = dependencyId('PyPI', 'jinja2', '2.10')

// shop imports lodash; api (python) depends on jinja2 but never imports it.
function graph(lodashVersion = '4.17.15'): NeatGraph {
  const LODASH = dependencyId('npm', 'lodash', lodashVersion)
  const g = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false }) as NeatGraph
  const node = (id: string, attrs: Record<string, unknown>) => g.addNode(id, { id, ...attrs } as GraphNode)
  node(serviceId('shop'), { type: NodeType.ServiceNode, name: 'shop', language: 'javascript' })
  node(serviceId('api'), { type: NodeType.ServiceNode, name: 'api', language: 'python' })
  node(LODASH, { type: NodeType.DependencyNode, name: 'lodash', ecosystem: 'npm', version: lodashVersion, purl: `pkg:npm/lodash@${lodashVersion}` })
  node(JINJA, { type: NodeType.DependencyNode, name: 'jinja2', ecosystem: 'PyPI', version: '2.10', purl: 'pkg:pypi/jinja2@2.10' })
  node(fileId('shop', 'src/render.ts'), { type: NodeType.FileNode })
  const edge = (source: string, target: string, type: string, extra: Partial<GraphEdge>) => {
    const id = `${type}:${source}->${target}`
    g.addEdgeWithKey(id, source, target, { id, source, target, type, provenance: Provenance.EXTRACTED, confidence: 1, ...extra } as GraphEdge)
  }
  edge(serviceId('shop'), LODASH, EdgeType.DEPENDS_ON, { evidence: { file: 'package-lock.json' }, dependency: { scope: 'direct', dev: false, introducedBy: [] } })
  edge(serviceId('api'), JINJA, EdgeType.DEPENDS_ON, { evidence: { file: 'requirements.txt' }, dependency: { scope: 'direct', dev: false, introducedBy: [] } })
  edge(fileId('shop', 'src/render.ts'), LODASH, EdgeType.IMPORTS, { evidence: { file: 'src/render.ts', line: 2, specifier: 'lodash', bindings: ['template'] } })
  return g
}

describe('scanProjectCves', () => {
  it('ranks imported findings and keeps lockfile-only matches as context', async () => {
    const r = await scanProjectCves(graph(), { fetchImpl: osv, env: await env() })
    expect(SecurityScanResultSchema.parse(r)).toEqual(r)
    expect(r.advisories).toBe('osv')
    expect(r.inventory).toBe(2)
    expect(r.asOf).not.toBeNull()
    expect(r.findings.map((c) => [c.advisory.id, c.service, c.reachability.level])).toEqual([
      // both lodash advisories are imported and both high: card id breaks the tie
      ['GHSA-35jh-r3h4-6jhm', 'shop', 'imported'],
      ['GHSA-p6mc-m468-83gw', 'shop', 'imported'],
    ])
    expect(r.context.map((c) => [c.advisory.id, c.service, c.reachability.level])).toEqual([['PYSEC-2019-217', 'api', 'present']])
  })

  it('scopes to one service by name or node id', async () => {
    const e = await env()
    for (const service of ['api', serviceId('api')]) {
      const r = await scanProjectCves(graph(), { fetchImpl: osv, env: e, service })
      expect(r.findings).toEqual([])
      expect(r.context.map((c) => c.service)).toEqual(['api'])
    }
  })

  it('says advisories are disabled rather than reporting a clean scan', async () => {
    const r = await scanProjectCves(graph(), { fetchImpl: osv, env: await env({ NEAT_ADVISORIES: 'off' }) })
    expect(r).toMatchObject({ advisories: 'disabled', asOf: null, findings: [], context: [] })
  })
})

describe('isReachable (dependency grain)', () => {
  it('is true for an imported vulnerable package, false for one only in the lockfile', async () => {
    const e = await env()
    const lodash = await isReachable(graph(), { package: 'lodash' }, { fetchImpl: osv, env: e })
    expect(ReachabilityAnswerSchema.parse(lodash)).toEqual(lodash)
    expect(lodash).toMatchObject({ package: 'lodash', grain: 'dependency', reachable: true, level: 'imported' })
    expect(lodash.findings).toHaveLength(2)

    const jinja = await isReachable(graph(), { package: 'Jinja2' }, { fetchImpl: osv, env: e })
    expect(jinja).toMatchObject({ reachable: false, level: 'present', inventory: 1 })
  })

  it('reads a package absent from the inventory, or another version, as unmatched', async () => {
    const e = await env()
    expect(await isReachable(graph(), { package: 'express' }, { fetchImpl: osv, env: e })).toMatchObject({ reachable: false, level: null, inventory: 0 })
    expect(await isReachable(graph(), { package: 'lodash', version: '4.17.21' }, { fetchImpl: osv, env: e })).toMatchObject({ inventory: 0, level: null })
  })

  it('flips to false once the fix lands: the fixed version matches no advisory', async () => {
    const r = await isReachable(graph('4.17.21'), { package: 'lodash' }, { fetchImpl: osv, env: await env() })
    expect(r).toMatchObject({ reachable: false, level: null, inventory: 1 })
  })
})

describe('rankSecurityCards', () => {
  it('orders level, then severity, then direct before transitive', async () => {
    const r = await scanProjectCves(graph(), { fetchImpl: osv, env: await env() })
    const base = r.findings[1]!
    const card = (level: string, label: string, scope: string, id: string) =>
      SecurityCardSchema.parse({
        ...base,
        id,
        advisory: { ...base.advisory, severity: { label } },
        dependency: { ...base.dependency, scope },
        reachability: { ...base.reachability, level },
      })
    const ranked = rankSecurityCards([
      card('present', 'critical', 'direct', 'a'),
      card('imported', 'low', 'direct', 'b'),
      card('imported', 'high', 'transitive', 'c'),
      card('imported', 'high', 'direct', 'd'),
      card('reachable-observed', 'low', 'transitive', 'e'),
    ])
    expect(ranked.map((c) => c.id)).toEqual(['e', 'd', 'c', 'b', 'a'])
  })
})

describe('REST: /graph/security/*', () => {
  it('answers disabled advisories, refuses a missing package, and takes a symbol', async () => {
    const prev = process.env.NEAT_ADVISORIES
    process.env.NEAT_ADVISORIES = 'off'
    try {
      const app = await buildApi({ graph: graph(), scanPath: os.tmpdir() })
      const scan = await app.inject({ method: 'GET', url: '/graph/security/reachable-cves' })
      expect(scan.statusCode).toBe(200)
      expect(scan.json()).toMatchObject({ advisories: 'disabled', findings: [] })
      const one = await app.inject({ method: 'GET', url: '/graph/security/is-reachable?package=lodash' })
      expect(one.json()).toMatchObject({ advisories: 'disabled', package: 'lodash', grain: 'dependency', reachable: false })
      expect((await app.inject({ method: 'GET', url: '/graph/security/is-reachable' })).statusCode).toBe(400)
      const sym = await app.inject({ method: 'GET', url: '/graph/security/is-reachable?package=lodash&symbol=template' })
      expect(sym.statusCode).toBe(200)
      expect(sym.json()).toMatchObject({ grain: 'symbol', symbol: 'template', reachable: false })
      const scoped = await app.inject({ method: 'GET', url: '/projects/default/graph/security/reachable-cves' })
      expect(scoped.statusCode).toBe(200)
      await app.close()
    } finally {
      if (prev === undefined) delete process.env.NEAT_ADVISORIES
      else process.env.NEAT_ADVISORIES = prev
    }
  })
})
