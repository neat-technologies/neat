import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import git from 'isomorphic-git'
import type { SecurityCard, SecurityFixAction } from '@neat.is/types'
import { applyAndReverify, applyFixAction } from '../src/security-apply.js'

// fix-apply (ADR-274): apply a card's fix.action to the manifest + lockfile, then
// re-verify with scan_diff. The pure edit is driven on temp-dir fixtures; the
// end-to-end re-verify runs the real scanDiffLocal on a git repo against a fake
// OSV, mirroring security-diff.test.ts.

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

// OSV stand-in: lodash's two advisories (GHSA-p6mc fixed 4.17.19, GHSA-35jh fixed 4.17.21).
const osv = (async (url: string, init?: RequestInit) => {
  if (url.endsWith('/v1/querybatch')) {
    const body = JSON.parse(String(init?.body)) as { queries: Array<{ package: { name: string } }> }
    const ids: Record<string, string[]> = { lodash: ['GHSA-35jh-r3h4-6jhm', 'GHSA-p6mc-m468-83gw'] }
    return new Response(JSON.stringify({ results: body.queries.map((q) => ({ vulns: (ids[q.package.name] ?? []).map((id) => ({ id })) })) }))
  }
  return new Response(JSON.stringify(rec(decodeURIComponent(url.split('/v1/vulns/')[1] ?? ''))))
}) as typeof fetch
const env = async () => ({ NEAT_HOME: await tmp('neat-apply-home-') })

function mkCard(over: {
  name?: string
  ecosystem?: string
  version?: string
  scope?: 'direct' | 'transitive'
  introducedBy?: string[]
  action?: SecurityFixAction | null
  advisory?: string
  to?: string
} = {}): SecurityCard {
  const name = over.name ?? 'lodash'
  const version = over.version ?? '4.17.15'
  const scope = over.scope ?? 'direct'
  const advisory = over.advisory ?? 'GHSA-35jh-r3h4-6jhm'
  const to = over.to ?? '4.17.21'
  const action: SecurityFixAction | undefined =
    over.action === null
      ? undefined
      : (over.action ?? { kind: 'bump-to-fixedIn', to, via: scope === 'transitive' ? (over.introducedBy ?? []) : [] })
  return {
    kind: 'security',
    id: `sec:${advisory}:dep:npm:${name}@${version}:service:shop`,
    service: 'shop',
    advisory: { id: advisory, aliases: [], summary: 's', severity: { label: 'high' }, cwe: [], modified: 'm', asOf: 'a' },
    dependency: { id: `dep:npm:${name}@${version}`, ecosystem: over.ecosystem ?? 'npm', name, version, scope, dev: false, introducedBy: over.introducedBy ?? [], manifest: { file: 'package-lock.json' } },
    fix: { fixedIn: [to], ...(action ? { action } : {}) },
    reachability: { level: 'imported', grain: 'package', grainSource: 'package', changedInFix: [], importers: [], path: null, observed: [], supporting: [], method: 'call-graph, no dataflow', limits: [] },
    coverage: { instrumented: 'no' },
    headline: 'h',
  }
}

const readJson = async (p: string) => JSON.parse(await fs.readFile(p, 'utf8'))
async function project(pkg: object, lock: object): Promise<string> {
  const dir = await tmp('neat-apply-')
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2))
  return dir
}
const lockWith = (name: string, version: string, extra: object = {}) => ({
  name: 'shop',
  lockfileVersion: 3,
  packages: { '': { name: 'shop' }, [`node_modules/${name}`]: { version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, integrity: 'sha512-old', ...extra } },
})

describe('applyFixAction (fix-apply)', () => {
  it('bumps a direct dependency: manifest spec (operator kept) + lockfile version', async () => {
    const dir = await project({ name: 'shop', dependencies: { lodash: '^4.17.15' } }, lockWith('lodash', '4.17.15'))
    const r = await applyFixAction(dir, mkCard())
    expect(r.applied).toBe(true)
    if (!r.applied) return
    expect(r.edits).toEqual([
      { file: 'package.json', change: 'manifest-spec', dependency: 'lodash', from: '^4.17.15', to: '^4.17.21' },
      { file: 'package-lock.json', change: 'lockfile-version', dependency: 'lodash', from: '4.17.15', to: '4.17.21' },
    ])
    expect((await readJson(path.join(dir, 'package.json'))).dependencies.lodash).toBe('^4.17.21')
    const node = (await readJson(path.join(dir, 'package-lock.json'))).packages['node_modules/lodash']
    expect(node.version).toBe('4.17.21')
    expect(node.integrity).toBeUndefined() // dropped so a real install refetches
    expect(node.resolved).toContain('lodash-4.17.21.tgz')
  })

  it('keeps a tilde / range operator and an exact pin', async () => {
    for (const [spec, want] of [['~4.17.15', '~4.17.21'], ['>=4.0.0', '>=4.17.21'], ['4.17.15', '4.17.21']] as const) {
      const dir = await project({ name: 'shop', dependencies: { lodash: spec } }, lockWith('lodash', '4.17.15'))
      await applyFixAction(dir, mkCard())
      expect((await readJson(path.join(dir, 'package.json'))).dependencies.lodash).toBe(want)
    }
  })

  it('pins a transitive dependency via npm overrides, not the parent', async () => {
    const dir = await project({ name: 'shop', dependencies: { 'some-parent': '^1.0.0' } }, lockWith('lodash', '4.17.15'))
    const r = await applyFixAction(dir, mkCard({ scope: 'transitive', introducedBy: ['some-parent@1.0.0'] }))
    expect(r.applied).toBe(true)
    if (!r.applied) return
    expect(r.edits[0]).toEqual({ file: 'package.json', change: 'manifest-override', dependency: 'lodash', from: '', to: '4.17.21' })
    expect((await readJson(path.join(dir, 'package.json'))).overrides).toEqual({ lodash: '4.17.21' })
    expect((await readJson(path.join(dir, 'package-lock.json'))).packages['node_modules/lodash'].version).toBe('4.17.21')
  })

  it('updates every copy of the package and handles a scoped name', async () => {
    const lock = {
      name: 'shop',
      lockfileVersion: 3,
      packages: {
        '': { name: 'shop' },
        'node_modules/@scope/pkg': { version: '1.0.0', resolved: 'r', integrity: 'i' },
        'node_modules/dep/node_modules/@scope/pkg': { version: '1.0.0' },
        'node_modules/@scope/pkg-extra': { version: '9.9.9' }, // must not match
      },
    }
    const dir = await project({ name: 'shop', dependencies: { '@scope/pkg': '^1.0.0' } }, lock)
    const r = await applyFixAction(dir, mkCard({ name: '@scope/pkg', version: '1.0.0', to: '1.2.0' }))
    expect(r.applied).toBe(true)
    const pkgs = (await readJson(path.join(dir, 'package-lock.json'))).packages
    expect(pkgs['node_modules/@scope/pkg'].version).toBe('1.2.0')
    expect(pkgs['node_modules/@scope/pkg'].resolved).toContain('pkg-1.2.0.tgz')
    expect(pkgs['node_modules/dep/node_modules/@scope/pkg'].version).toBe('1.2.0')
    expect(pkgs['node_modules/@scope/pkg-extra'].version).toBe('9.9.9') // untouched
  })

  it('does not apply a remove-or-replace (no deterministic target)', async () => {
    const dir = await project({ name: 'shop', dependencies: { lodash: '^4.17.15' } }, lockWith('lodash', '4.17.15'))
    const r = await applyFixAction(dir, mkCard({ action: { kind: 'remove-or-replace', reason: 'needs a major bump', majorTo: '5.0.0' } }))
    expect(r.applied).toBe(false)
    if (r.applied) return
    expect(r.reason).toMatch(/remove-or-replace/)
    // the files are untouched
    expect((await readJson(path.join(dir, 'package.json'))).dependencies.lodash).toBe('^4.17.15')
  })

  it('does not apply a non-npm ecosystem yet, or a card with no action', async () => {
    const dir = await project({ name: 'shop', dependencies: { lodash: '^4.17.15' } }, lockWith('lodash', '4.17.15'))
    expect((await applyFixAction(dir, mkCard({ ecosystem: 'PyPI' }))).applied).toBe(false)
    expect((await applyFixAction(dir, mkCard({ action: null }))).applied).toBe(false)
  })

  it('is a no-op when the dependency is already at the target', async () => {
    const dir = await project({ name: 'shop', dependencies: { lodash: '^4.17.21' } }, lockWith('lodash', '4.17.21'))
    const r = await applyFixAction(dir, mkCard())
    expect(r.applied).toBe(false)
    if (!r.applied) expect(r.reason).toMatch(/already at 4\.17\.21/)
  })
})

// ── end to end: apply, then scan_diff confirms the CVE is gone ────────────────

const repoLock = (version: string) => ({
  name: 'shop',
  lockfileVersion: 3,
  packages: { '': { name: 'shop', dependencies: { lodash: version } }, 'node_modules/lodash': { version, resolved: `https://registry.npmjs.org/lodash/-/lodash-${version}.tgz`, integrity: 'sha512-old' } },
})
async function repo(version: string): Promise<string> {
  const dir = path.join(await tmp('neat-apply-repo-'), 'shop')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'shop', main: 'app.js', dependencies: { lodash: version } }))
  await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify(repoLock(version)))
  await fs.writeFile(path.join(dir, 'app.js'), "const _ = require('lodash')\nmodule.exports = () => _.template('x')\n")
  await git.init({ fs: nodeFs, dir, defaultBranch: 'main' })
  for (const f of ['package.json', 'package-lock.json', 'app.js']) await git.add({ fs: nodeFs, dir, filepath: f })
  await git.commit({ fs: nodeFs, dir, message: 'base', author: { name: 't', email: 't@example.com', timestamp: 1700000000, timezoneOffset: 0 } })
  return dir
}

describe('applyAndReverify', () => {
  it('applies the bump and scan_diff confirms the CVE is gone and none introduced', async () => {
    const dir = await repo('4.17.15')
    const r = await applyAndReverify(dir, mkCard(), { fetchImpl: osv, env: await env() })
    expect(r.outcome.applied).toBe(true)
    expect(r.cleared).toBe(true)
    expect(r.reverify!.introduced).toEqual([])
    expect(r.reverify!.removed.map((e) => e.advisoryId).sort()).toEqual(['GHSA-35jh-r3h4-6jhm', 'GHSA-p6mc-m468-83gw'])
    // the fix really landed in the files
    expect((await readJson(path.join(dir, 'package-lock.json'))).packages['node_modules/lodash'].version).toBe('4.17.21')
  })

  it('reports not-cleared without re-verifying when the fix is not a deterministic bump', async () => {
    const dir = await repo('4.17.15')
    const r = await applyAndReverify(dir, mkCard({ action: { kind: 'remove-or-replace', reason: 'no fix' } }), { fetchImpl: osv, env: await env() })
    expect(r.outcome.applied).toBe(false)
    expect(r.cleared).toBeUndefined()
    expect(r.reverify).toBeUndefined()
  })
})
