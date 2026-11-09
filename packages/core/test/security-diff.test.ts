import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import git from 'isomorphic-git'
import { SecurityDiffSchema, type SecurityCard } from '@neat.is/types'
import { diffSecurityCards, scanDiffLocal } from '../src/security-diff.js'
import { buildApi } from '../src/api.js'
import { makeGraph } from '../src/graph.js'

// scan_diff (security-card.md §6): what a change introduced, removed and left in
// place, both sides judged against one advisory snapshot.

const FIX = path.join(__dirname, 'fixtures/osv')
const rec = (id: string) => JSON.parse(readFileSync(path.join(FIX, `${id}.json`), 'utf8'))
const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true })
})
async function tmp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  dirs.push(d)
  return d
}

// OSV stand-in: lodash's two advisories by name, the records from fixtures.
const osv = (async (url: string, init?: RequestInit) => {
  if (url.endsWith('/v1/querybatch')) {
    const body = JSON.parse(String(init?.body)) as { queries: Array<{ package: { name: string } }> }
    const ids: Record<string, string[]> = { lodash: ['GHSA-35jh-r3h4-6jhm', 'GHSA-p6mc-m468-83gw'] }
    return new Response(JSON.stringify({ results: body.queries.map((q) => ({ vulns: (ids[q.package.name] ?? []).map((id) => ({ id })) })) }))
  }
  return new Response(JSON.stringify(rec(decodeURIComponent(url.split('/v1/vulns/')[1] ?? ''))))
}) as typeof fetch

// ── the pure diff ───────────────────────────────────────────────────────────

function card(advisory: string, version: string, level: SecurityCard['reachability']['level'], service = 'shop', severity: 'high' | 'critical' = 'high'): SecurityCard {
  return {
    kind: 'security',
    id: `sec:${advisory}:dep:npm:lodash@${version}:service:${service}`,
    service,
    advisory: { id: advisory, aliases: [], summary: 's', severity: { label: severity }, cwe: [], modified: 'm', asOf: 'a' },
    dependency: { id: `dep:npm:lodash@${version}`, ecosystem: 'npm', name: 'lodash', version, scope: 'direct', dev: false, introducedBy: [], manifest: { file: 'package-lock.json' } },
    fix: { fixedIn: ['4.17.21'] },
    reachability: { level, grain: 'package', grainSource: 'package', changedInFix: [], importers: [], path: null, observed: [], supporting: [], method: 'call-graph, no dataflow', limits: [] },
    coverage: { instrumented: 'no' },
    headline: 'h',
  }
}
const ids = (es: { advisoryId: string; service: string }[]) => es.map((e) => `${e.advisoryId}@${e.service}`)

describe('diffSecurityCards', () => {
  it('sorts each advisory, package and service into exactly one bucket, across versions', () => {
    const before = [card('A', '4.17.15', 'imported'), card('B', '4.17.15', 'imported'), card('C', '4.17.15', 'present'), card('E', '4.17.15', 'imported', 'admin')]
    const after = [card('A', '4.17.20', 'imported'), card('D', '4.17.20', 'imported', 'shop', 'critical'), card('F', '4.17.20', 'present'), card('E', '4.17.20', 'present', 'admin')]
    const d = diffSecurityCards(before, after)
    expect(ids(d.stillPresent)).toEqual(['A@shop']) // a bump that stays affected
    expect(d.stillPresent[0]!.before!.dependency.version).toBe('4.17.15')
    expect(d.stillPresent[0]!.after!.dependency.version).toBe('4.17.20')
    expect(ids(d.introduced)).toEqual(['D@shop'])
    expect(ids(d.removed)).toEqual(['B@shop', 'E@admin']) // gone, and no longer imported
    expect(d.removed[1]!.after!.reachability.level).toBe('present')
    expect(ids(d.context.introduced)).toEqual(['F@shop'])
    expect(ids(d.context.removed)).toEqual(['C@shop'])
  })

  it('counts a lockfile-only package that becomes imported as introduced', () => {
    const d = diffSecurityCards([card('A', '1', 'present')], [card('A', '1', 'imported')])
    expect(ids(d.introduced)).toEqual(['A@shop'])
    expect(d.introduced[0]!.before!.reachability.level).toBe('present')
  })

  it('ranks each bucket by exposure, and is order-independent', () => {
    const after = [card('X', '1', 'imported', 'a', 'high'), card('Y', '1', 'imported', 'b', 'critical'), card('Z', '1', 'reachable-static', 'c', 'high')]
    const d1 = diffSecurityCards([], after)
    const d2 = diffSecurityCards([], [...after].reverse())
    expect(ids(d1.introduced)).toEqual(['Z@c', 'Y@b', 'X@a'])
    expect(JSON.stringify(d2)).toBe(JSON.stringify(d1))
  })
})

// ── end to end on a git repository ─────────────────────────────────────────

const lock = (version: string) => ({
  name: 'shop',
  lockfileVersion: 3,
  packages: { '': { name: 'shop', dependencies: { lodash: version } }, 'node_modules/lodash': { version } },
})

async function repo(version: string, appSource = "const _ = require('lodash')\nmodule.exports = () => _.template('x')\n"): Promise<string> {
  const dir = path.join(await tmp('neat-scan-diff-repo-'), 'shop')
  await fs.mkdir(dir, { recursive: true })
  await write(dir, version, appSource)
  await git.init({ fs: nodeFs, dir, defaultBranch: 'main' })
  await commit(dir, 'base')
  return dir
}
async function write(dir: string, version: string, appSource: string) {
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'shop', main: 'app.js', dependencies: { lodash: version } }))
  await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify(lock(version)))
  await fs.writeFile(path.join(dir, 'app.js'), appSource)
}
async function commit(dir: string, message: string) {
  for (const f of ['package.json', 'package-lock.json', 'app.js']) await git.add({ fs: nodeFs, dir, filepath: f })
  await git.commit({ fs: nodeFs, dir, message, author: { name: 't', email: 't@example.com', timestamp: 1700000000, timezoneOffset: 0 } })
}
const env = async () => ({ NEAT_HOME: await tmp('neat-scan-diff-home-') })

describe('scanDiffLocal', () => {
  it('a fix: bumping lodash to 4.17.21 removes both advisories and introduces none', async () => {
    const dir = await repo('4.17.15')
    await write(dir, '4.17.21', "const _ = require('lodash')\nmodule.exports = () => _.template('x')\n")
    const d = await scanDiffLocal(dir, { base: 'main' }, { fetchImpl: osv, env: await env() })
    expect(SecurityDiffSchema.parse(d)).toEqual(d)
    expect(d).toMatchObject({ advisories: 'osv', base: { ref: 'main', inventory: 1 }, head: { ref: 'working tree', inventory: 1 } })
    expect(d.introduced).toEqual([])
    expect(ids(d.removed).sort()).toEqual(['GHSA-35jh-r3h4-6jhm@shop', 'GHSA-p6mc-m468-83gw@shop'])
    expect(d.removed.every((e) => e.after === null && e.before!.dependency.version === '4.17.15')).toBe(true)
    expect(d.stillPresent).toEqual([])
  })

  it('a partial fix leaves the advisory 4.17.20 is still affected by in place', async () => {
    const dir = await repo('4.17.15')
    await write(dir, '4.17.20', "const _ = require('lodash')\nmodule.exports = () => _.template('x')\n")
    await commit(dir, 'bump')
    const d = await scanDiffLocal(dir, { base: 'HEAD~1', head: 'main' }, { fetchImpl: osv, env: await env() })
    expect(ids(d.removed)).toEqual(['GHSA-p6mc-m468-83gw@shop'])
    expect(ids(d.stillPresent)).toEqual(['GHSA-35jh-r3h4-6jhm@shop'])
    expect(d.stillPresent[0]!.after!.reachability.importers.map((i) => i.file)).toEqual(['app.js'])
  })

  it('a regression: a downgrade introduces them; removing the import makes them context', async () => {
    const dir = await repo('4.17.21')
    await write(dir, '4.17.15', "const _ = require('lodash')\nmodule.exports = () => _.template('x')\n")
    const worse = await scanDiffLocal(dir, { base: 'main' }, { fetchImpl: osv, env: await env() })
    expect(ids(worse.introduced).sort()).toEqual(['GHSA-35jh-r3h4-6jhm@shop', 'GHSA-p6mc-m468-83gw@shop'])

    await write(dir, '4.17.15', 'module.exports = () => 1\n')
    const unused = await scanDiffLocal(dir, { base: 'main' }, { fetchImpl: osv, env: await env() })
    expect(unused.introduced).toEqual([])
    expect(unused.context.introduced).toHaveLength(2)
  })

  it('is deterministic, leaves no scratch copies, and reports a ref git can not resolve', async () => {
    const dir = await repo('4.17.15')
    const root = await tmp('neat-scan-diff-scratch-')
    const e = await env()
    const a = await scanDiffLocal(dir, { base: 'main' }, { fetchImpl: osv, env: e, tmpRoot: root })
    const b = await scanDiffLocal(dir, { base: 'main' }, { fetchImpl: osv, env: e, tmpRoot: root })
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    expect(await fs.readdir(root)).toEqual([])
    await expect(scanDiffLocal(dir, { base: 'no-such-ref' }, { fetchImpl: osv, env: e })).rejects.toThrow()
  })
})

describe('REST: /graph/security/scan-diff', () => {
  it('requires base, answers disabled advisories, and 422s an unknown ref', async () => {
    const dir = await repo('4.17.15')
    const prev = process.env.NEAT_ADVISORIES
    process.env.NEAT_ADVISORIES = 'off'
    try {
      const app = await buildApi({ graph: makeGraph(), scanPath: dir })
      expect((await app.inject({ method: 'GET', url: '/graph/security/scan-diff' })).statusCode).toBe(400)
      const ok = await app.inject({ method: 'GET', url: '/graph/security/scan-diff?base=main' })
      expect(ok.statusCode).toBe(200)
      expect(ok.json()).toMatchObject({ advisories: 'disabled', introduced: [], removed: [] })
      expect((await app.inject({ method: 'GET', url: '/graph/security/scan-diff?base=nope' })).statusCode).toBe(422)
      await app.close()
    } finally {
      if (prev === undefined) delete process.env.NEAT_ADVISORIES
      else process.env.NEAT_ADVISORIES = prev
    }
  })
})
