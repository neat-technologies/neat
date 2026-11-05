import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  foldAliases,
  matchAdvisories,
  normalizeOsv,
  type InventoryItem,
  type OsvRecord,
} from '../src/advisories/index.js'

// Advisory normalization, alias folding and matching (ADR-274, advisory-cache.md
// §1 and §3), against real OSV records saved under fixtures/osv.

const FIX = path.join(__dirname, 'fixtures/osv')
const rec = (id: string) => JSON.parse(readFileSync(path.join(FIX, `${id}.json`), 'utf8')) as OsvRecord
const adv = (id: string) => normalizeOsv(rec(id))
const item = (ecosystem: string, name: string, version: string): InventoryItem => ({
  dependencyId: `dep:${ecosystem}:${name}@${version}`,
  ecosystem,
  name,
  version,
})

describe('normalize', () => {
  it('keeps severity, CWE, fix references, and Go curated symbols', () => {
    const lodash = adv('GHSA-35jh-r3h4-6jhm')
    expect(lodash.aliases).toContain('CVE-2021-23337')
    expect(lodash.severity.label).toBe('high')
    expect(lodash.severity.cvss).toMatch(/^CVSS:3/)
    expect(lodash.cwe).toContain('CWE-94')

    const go = adv('GO-2022-0969')
    const stdlib = go.affected.find((a) => a.name === 'stdlib')!
    expect(stdlib.symbols).toContain('net/http.Server.Serve')
  })
})

describe('alias folding', () => {
  it('a GHSA and a PYSEC for one issue become one advisory under the GHSA id', () => {
    const folded = foldAliases([adv('PYSEC-2019-217'), adv('GHSA-462w-v97r-4m45')])
    expect(folded).toHaveLength(1)
    expect(folded[0]!.id).toBe('GHSA-462w-v97r-4m45')
    expect(folded[0]!.aliases).toEqual(['CVE-2019-10906', 'PYSEC-2019-217'])
  })

  it('unrelated advisories stay separate', () => {
    expect(foldAliases([adv('GHSA-35jh-r3h4-6jhm'), adv('GHSA-p6mc-m468-83gw')])).toHaveLength(2)
  })
})

describe('matching', () => {
  const snapshot = {
    asOf: '2026-11-05T00:00:00.000Z',
    advisories: foldAliases(
      ['GHSA-35jh-r3h4-6jhm', 'GHSA-p6mc-m468-83gw', 'GHSA-h75v-3vvj-5mfj', 'GHSA-462w-v97r-4m45', 'PYSEC-2019-217', 'GO-2022-0969'].map(adv),
    ),
  }
  const ids = (it: InventoryItem) => matchAdvisories([it], snapshot).map((m) => m.advisoryId)

  it('npm: semver ranges, with the fixed versions', () => {
    expect(ids(item('npm', 'lodash', '4.17.15'))).toEqual(['GHSA-35jh-r3h4-6jhm', 'GHSA-p6mc-m468-83gw'])
    expect(ids(item('npm', 'lodash', '4.17.19'))).toEqual(['GHSA-35jh-r3h4-6jhm'])
    expect(ids(item('npm', 'lodash', '4.17.21'))).toEqual([])
    const [m] = matchAdvisories([item('npm', 'lodash', '4.17.20')], snapshot)
    expect(m).toMatchObject({ advisoryId: 'GHSA-35jh-r3h4-6jhm', fixedIn: ['4.17.21'], asOf: snapshot.asOf })
  })

  it('npm: a package named only in another package entry is not matched', () => {
    expect(ids(item('npm', 'lodash.template', '4.5.0'))).toEqual(['GHSA-35jh-r3h4-6jhm'])
    expect(ids(item('npm', 'express', '4.17.1'))).toEqual([])
  })

  it('PyPI: exact version membership, folded to one advisory per issue', () => {
    expect(ids(item('PyPI', 'jinja2', '3.1.3'))).toEqual(['GHSA-h75v-3vvj-5mfj'])
    expect(ids(item('PyPI', 'jinja2', '3.1.4'))).toEqual([])
    // GHSA-462w and PYSEC-2019-217 are one issue: one match, not two. (2.10 is
    // also in GHSA-h75v's affected versions: every release before 3.1.4.)
    expect(ids(item('PyPI', 'jinja2', '2.10'))).toEqual(['GHSA-462w-v97r-4m45', 'GHSA-h75v-3vvj-5mfj'])
    expect(ids(item('PyPI', 'Jinja2', '2.10'))).toEqual(['GHSA-462w-v97r-4m45', 'GHSA-h75v-3vvj-5mfj'])
  })

  it('Go: multiple introduced/fixed spans, including prerelease bounds', () => {
    expect(ids(item('Go', 'stdlib', '1.18.5'))).toEqual(['GO-2022-0969'])
    expect(ids(item('Go', 'stdlib', '1.18.6'))).toEqual([])
    expect(ids(item('Go', 'stdlib', '1.19.0'))).toEqual(['GO-2022-0969'])
    expect(ids(item('Go', 'stdlib', '1.19.1'))).toEqual([])
  })

  it('is pure: same input, same output, input untouched', () => {
    const inv = [item('npm', 'lodash', '4.17.15'), item('PyPI', 'jinja2', '3.1.3')]
    const before = JSON.stringify({ inv, snapshot })
    expect(matchAdvisories(inv, snapshot)).toEqual(matchAdvisories(inv, snapshot))
    expect(JSON.stringify({ inv, snapshot })).toBe(before)
  })
})

describe('inventoryFromGraph', () => {
  it('reads one item per DependencyNode and nothing else', async () => {
    const { MultiDirectedGraph } = await import('graphology')
    const { NodeType, dependencyId } = await import('@neat.is/types')
    const { inventoryFromGraph } = await import('../src/advisories/index.js')
    const g = new MultiDirectedGraph() as never as Parameters<typeof inventoryFromGraph>[0]
    const id = dependencyId('npm', 'lodash', '4.17.15')
    g.addNode('service:api', { id: 'service:api', type: NodeType.ServiceNode, name: 'api', language: 'javascript' } as never)
    g.addNode(id, { id, type: NodeType.DependencyNode, name: 'lodash', ecosystem: 'npm', version: '4.17.15', purl: 'pkg:npm/lodash@4.17.15' } as never)
    expect(inventoryFromGraph(g)).toEqual([{ dependencyId: id, ecosystem: 'npm', name: 'lodash', version: '4.17.15' }])
  })
})
