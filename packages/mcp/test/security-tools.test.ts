import { describe, it, expect } from 'vitest'
import type { ReachabilityAnswer, SecurityCard, SecurityDiff, SecurityScanResult } from '@neat.is/types'
import { HttpError, type HttpClient } from '../src/client.js'
import { getReachableCves, isReachableTool, scanDiff } from '../src/tools.js'

// get_reachable_cves / is_reachable over the REST surface (security-card.md §6).

function clientFor(map: Record<string, unknown>): { client: HttpClient; paths: string[] } {
  const paths: string[] = []
  return {
    paths,
    client: {
      async get<T>(p: string): Promise<T> {
        paths.push(p)
        if (p in map) return map[p] as T
        throw new HttpError(404, `404 on ${p}`)
      },
    },
  }
}

const card = (over: Partial<SecurityCard['reachability']> = {}, scope: 'direct' | 'transitive' = 'direct'): SecurityCard => ({
  kind: 'security',
  id: 'sec:GHSA-35jh-r3h4-6jhm:dep:npm:lodash@4.17.15:service:shop',
  service: 'shop',
  advisory: {
    id: 'GHSA-35jh-r3h4-6jhm',
    aliases: ['CVE-2021-23337'],
    summary: 'Command Injection in lodash',
    severity: { label: 'high' },
    cwe: ['CWE-77'],
    modified: '2024-01-01T00:00:00Z',
    asOf: '2026-11-09T00:00:00Z',
  },
  dependency: {
    id: 'dep:npm:lodash@4.17.15',
    ecosystem: 'npm',
    name: 'lodash',
    version: '4.17.15',
    scope,
    dev: false,
    introducedBy: scope === 'transitive' ? ['express'] : [],
    manifest: { file: 'package-lock.json' },
  },
  fix: {
    fixedIn: ['4.17.21'],
    action: { kind: 'bump-to-fixedIn', to: '4.17.21', via: scope === 'transitive' ? ['express'] : [] },
  },
  reachability: {
    level: 'imported',
    grain: 'package',
    grainSource: 'package',
    changedInFix: [],
    importers: [{ file: 'src/render.ts', line: 2, bindings: ['template'], provenance: 'EXTRACTED' }],
    path: null,
    observed: [],
    supporting: [],
    method: 'call-graph, no dataflow',
    limits: ['The call graph into and inside the package is not built yet, so reachability past the import is unknown.'],
    ...over,
  },
  coverage: { instrumented: 'no' },
  headline: 'lodash 4.17.15 (GHSA-35jh-r3h4-6jhm, high) is imported by 1 file in shop; whether the vulnerable code is called is not yet analysed. Fixed in 4.17.21.',
})

const scan = (findings: SecurityCard[], context: SecurityCard[] = []): SecurityScanResult => ({
  advisories: 'osv',
  asOf: '2026-11-09T00:00:00Z',
  stale: 0,
  errors: [],
  inventory: 120,
  findings,
  context,
})

describe('get_reachable_cves', () => {
  it('lists each finding with advisory, package@version, fix and importing files, and names the source', async () => {
    const { client, paths } = clientFor({
      '/projects/shop/graph/security/reachable-cves?service=shop': scan([card()], [card({ level: 'present', importers: [], limits: [] }, 'transitive')]),
    })
    const text = (await getReachableCves(client, { project: 'shop', service: 'shop' })).content[0]!.text
    expect(paths).toEqual(['/projects/shop/graph/security/reachable-cves?service=shop'])
    expect(text).toContain('1 known vulnerability in imported dependencies')
    expect(text).toContain('[imported] GHSA-35jh-r3h4-6jhm (CVE-2021-23337) high: lodash@4.17.15 in shop (direct)')
    expect(text).toContain('fixed in: 4.17.21')
    expect(text).toContain('fix: bump lodash to 4.17.21')
    expect(text).toContain('imported at: src/render.ts:2 {template}')
    expect(text).toContain('1 more matched advisory is in dependencies nothing imports')
    expect(text).toContain('osv.dev (package names and versions were sent there)')
    expect(text).toContain('provenance: EXTRACTED')
  })

  it('says when nothing imported is vulnerable, and never calls disabled advisories clean', async () => {
    const none = clientFor({ '/graph/security/reachable-cves': scan([]) })
    expect((await getReachableCves(none.client, {})).content[0]!.text).toContain('No known-vulnerable dependency is imported by first-party code across 120 resolved packages')
    const off = clientFor({ '/graph/security/reachable-cves': { ...scan([]), advisories: 'disabled', asOf: null } })
    const text = (await getReachableCves(off.client, {})).content[0]!.text
    expect(text).toContain('Advisories are disabled')
    expect(text).toContain('not a clean result')
  })
})

describe('is_reachable', () => {
  const answer = (over: Partial<ReachabilityAnswer>): ReachabilityAnswer => ({
    ...scan([card()]),
    package: 'lodash',
    grain: 'dependency',
    reachable: true,
    level: 'imported',
    ...over,
  })

  it('answers at dependency grain, true when an affected version is imported', async () => {
    const { client, paths } = clientFor({ '/graph/security/is-reachable?package=lodash': answer({}) })
    const text = (await isReachableTool(client, { package: 'lodash' })).content[0]!.text
    expect(paths).toEqual(['/graph/security/is-reachable?package=lodash'])
    expect(text).toMatch(/^reachable: true \(dependency grain\)/)
    expect(text).toContain('whether the vulnerable function itself is called is not analysed yet')
    expect(text).toContain('imported at: src/render.ts:2')
  })

  it('is false for a lockfile-only package, an unmatched version, or one not in the project', async () => {
    const lockOnly = clientFor({
      '/graph/security/is-reachable?package=lodash': answer({ reachable: false, level: 'present', findings: [], context: [card({ level: 'present', importers: [] })] }),
    })
    expect((await isReachableTool(lockOnly.client, { package: 'lodash' })).content[0]!.text).toMatch(/^reachable: false \(dependency grain\).*no first-party file imports it/)
    const fixed = clientFor({
      '/graph/security/is-reachable?package=lodash&version=4.17.21': answer({ reachable: false, level: null, findings: [], inventory: 1 }),
    })
    expect((await isReachableTool(fixed.client, { package: 'lodash', version: '4.17.21' })).content[0]!.text).toContain('No known advisory matches')
    const absent = clientFor({
      '/graph/security/is-reachable?package=express': answer({ package: 'express', reachable: false, level: null, findings: [], inventory: 0 }),
    })
    expect((await isReachableTool(absent.client, { package: 'express' })).content[0]!.text).toContain("not among this project's resolved dependencies")
  })

  it('declines symbol grain without calling the daemon', async () => {
    const { client, paths } = clientFor({})
    const text = (await isReachableTool(client, { package: 'lodash', symbol: 'template' })).content[0]!.text
    expect(text).toContain('Symbol-level reachability is not supported yet')
    expect(paths).toEqual([])
  })
})

describe('scan_diff', () => {
  const diff = (over: Partial<SecurityDiff>): SecurityDiff => ({
    advisories: 'osv',
    asOf: '2026-11-09T00:00:00Z',
    stale: 0,
    errors: [],
    base: { ref: 'main', inventory: 120 },
    head: { ref: 'working tree', inventory: 120 },
    introduced: [],
    removed: [],
    stillPresent: [],
    context: { introduced: [], removed: [] },
    ...over,
  })
  const e = (before: SecurityCard | null, after: SecurityCard | null) => ({
    advisoryId: 'GHSA-35jh-r3h4-6jhm', ecosystem: 'npm', package: 'lodash', service: 'shop', before, after,
  })
  const at = (v: string) => ({ ...card(), dependency: { ...card().dependency, version: v } })

  it('leads with what the change introduced, then lists each bucket with versions on both sides', async () => {
    const { client, paths } = clientFor({
      '/graph/security/scan-diff?base=main': diff({ removed: [e(at('4.17.15'), null)], stillPresent: [e(at('4.17.15'), at('4.17.20'))] }),
    })
    const text = (await scanDiff(client, { base: 'main' })).content[0]!.text
    expect(paths).toEqual(['/graph/security/scan-diff?base=main'])
    expect(text).toMatch(/^working tree introduces no known vulnerability in imported dependencies, removes 1 and leaves 1 in place, against main\./)
    expect(text).toContain('Both sides were judged against the same advisories.')
    expect(text).toContain('Removed:')
    expect(text).toContain('Still present:')
    expect(text).toContain('lodash@4.17.20 (4.17.15 → 4.17.20)')
  })

  it('counts introductions, and says disabled advisories are not a clean result', async () => {
    const worse = clientFor({ '/graph/security/scan-diff?base=main&head=feature': diff({ head: { ref: 'feature', inventory: 121 }, introduced: [e(null, card())] }) })
    expect((await scanDiff(worse.client, { base: 'main', head: 'feature' })).content[0]!.text).toMatch(/^feature introduces 1 known vulnerability in imported dependencies/)
    const off = clientFor({ '/graph/security/scan-diff?base=main': diff({ advisories: 'disabled', asOf: null }) })
    expect((await scanDiff(off.client, { base: 'main' })).content[0]!.text).toContain('not a clean result')
  })
})
