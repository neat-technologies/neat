import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import git from 'isomorphic-git'
import type { SecurityCard, SecurityFixAction } from '@neat.is/types'
import { applyAndReverify, applyFixAction, applyFixes } from '../src/security-apply.js'

// fix-apply (ADR-274): apply a card's fix.action to the manifest, regenerate the
// lockfile, then re-verify with scan_diff. The manifest edit is unit-tested with
// the lock regeneration injected (no npm); the installable-fix tests run real npm
// to prove the written lockfile is `npm ci`-installable and clears the CVE.

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
function regenSpy() {
  const calls: string[] = []
  return { calls, fn: async (d: string) => void calls.push(d) }
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
const lockWith = (name: string, version: string) => ({
  name: 'shop',
  lockfileVersion: 3,
  packages: { '': { name: 'shop' }, [`node_modules/${name}`]: { version } },
})

describe('applyFixAction (manifest edit)', () => {
  it('bumps a direct dependency spec and regenerates the lockfile', async () => {
    const dir = await project({ name: 'shop', dependencies: { lodash: '^4.17.15' } }, lockWith('lodash', '4.17.15'))
    const regen = regenSpy()
    const r = await applyFixAction(dir, mkCard(), { regenerateLock: regen.fn })
    expect(r.applied).toBe(true)
    if (!r.applied) return
    expect(r.edits).toEqual([
      { file: 'package.json', change: 'manifest-spec', dependency: 'lodash', from: '^4.17.15', to: '^4.17.21' },
      { file: 'package-lock.json', change: 'lockfile-regenerated', dependency: 'lodash', from: '4.17.15', to: '4.17.21' },
    ])
    expect((await readJson(path.join(dir, 'package.json'))).dependencies.lodash).toBe('^4.17.21')
    expect(regen.calls).toEqual([dir]) // npm would run in the manifest directory
  })

  it('keeps a tilde / range operator and an exact pin', async () => {
    for (const [spec, want] of [['~4.17.15', '~4.17.21'], ['>=4.0.0', '>=4.17.21'], ['4.17.15', '4.17.21']] as const) {
      const dir = await project({ name: 'shop', dependencies: { lodash: spec } }, lockWith('lodash', '4.17.15'))
      await applyFixAction(dir, mkCard(), { regenerateLock: async () => {} })
      expect((await readJson(path.join(dir, 'package.json'))).dependencies.lodash).toBe(want)
    }
  })

  it('pins a transitive dependency via npm overrides, not the parent', async () => {
    const dir = await project({ name: 'shop', dependencies: { 'some-parent': '^1.0.0' } }, lockWith('lodash', '4.17.15'))
    const regen = regenSpy()
    const r = await applyFixAction(dir, mkCard({ scope: 'transitive', introducedBy: ['some-parent@1.0.0'] }), { regenerateLock: regen.fn })
    expect(r.applied).toBe(true)
    if (!r.applied) return
    expect(r.edits[0]).toEqual({ file: 'package.json', change: 'manifest-override', dependency: 'lodash', from: '', to: '4.17.21' })
    expect((await readJson(path.join(dir, 'package.json'))).overrides).toEqual({ lodash: '4.17.21' })
    expect(regen.calls).toHaveLength(1)
  })

  it('does not apply (and never runs npm) for remove-or-replace, non-npm, or no action', async () => {
    const dir = await project({ name: 'shop', dependencies: { lodash: '^4.17.15' } }, lockWith('lodash', '4.17.15'))
    for (const card of [
      mkCard({ action: { kind: 'remove-or-replace', reason: 'needs a major bump', majorTo: '5.0.0' } }),
      mkCard({ ecosystem: 'PyPI' }),
      mkCard({ action: null }),
    ]) {
      const regen = regenSpy()
      const r = await applyFixAction(dir, card, { regenerateLock: regen.fn })
      expect(r.applied).toBe(false)
      expect(regen.calls).toEqual([])
    }
    // the breaking fix is named in the reason, and nothing is written
    const r = await applyFixAction(dir, mkCard({ action: { kind: 'remove-or-replace', reason: 'needs a major bump', majorTo: '5.0.0' } }), { regenerateLock: async () => {} })
    if (!r.applied) expect(r.reason).toMatch(/5\.0\.0/)
    expect((await readJson(path.join(dir, 'package.json'))).dependencies.lodash).toBe('^4.17.15')
  })

  it('is a no-op (no npm) when the dependency is already at the target', async () => {
    const dir = await project({ name: 'shop', dependencies: { lodash: '^4.17.21' } }, lockWith('lodash', '4.17.21'))
    const regen = regenSpy()
    const r = await applyFixAction(dir, mkCard(), { regenerateLock: regen.fn })
    expect(r.applied).toBe(false)
    if (!r.applied) expect(r.reason).toMatch(/already at 4\.17\.21/)
    expect(regen.calls).toEqual([])
  })
})

describe('applyFixes (per dependency, deduped)', () => {
  it('dedups several cards of one dependency to a single apply', async () => {
    const dir = await project({ name: 'shop', dependencies: { lodash: '^4.17.15' } }, lockWith('lodash', '4.17.15'))
    const regen = regenSpy()
    const res = await applyFixes(dir, [mkCard({ advisory: 'A' }), mkCard({ advisory: 'B' }), mkCard({ advisory: 'A' })], { regenerateLock: regen.fn })
    expect(res).toHaveLength(1)
    expect(res[0]!.dependencyId).toBe('dep:npm:lodash@4.17.15')
    expect(res[0]!.outcome.applied).toBe(true)
    expect(regen.calls).toHaveLength(1)
  })

  it('applies each distinct dependency once', async () => {
    const lock = { name: 'shop', lockfileVersion: 3, packages: { '': { name: 'shop' }, 'node_modules/lodash': { version: '4.17.15' }, 'node_modules/minimist': { version: '1.2.0' } } }
    const dir = await project({ name: 'shop', dependencies: { lodash: '^4.17.15', minimist: '^1.2.0' } }, lock)
    const regen = regenSpy()
    const res = await applyFixes(dir, [mkCard(), mkCard({ name: 'minimist', version: '1.2.0', to: '1.2.6' })], { regenerateLock: regen.fn })
    expect(res.map((r) => r.dependencyId).sort()).toEqual(['dep:npm:lodash@4.17.15', 'dep:npm:minimist@1.2.0'])
    expect(res.every((r) => r.outcome.applied)).toBe(true)
    expect(regen.calls).toHaveLength(2)
    expect((await readJson(path.join(dir, 'package.json'))).dependencies).toEqual({ lodash: '^4.17.21', minimist: '^1.2.6' })
  })
})

// ── installable fix: real npm regeneration, npm ci, and scan_diff ────────────

async function realRepo(spec: string): Promise<string> {
  const dir = path.join(await tmp('neat-apply-real-'), 'shop')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'shop', main: 'app.js', dependencies: { lodash: spec } }, null, 2))
  await fs.writeFile(path.join(dir, 'app.js'), "const _ = require('lodash')\nmodule.exports = () => _.template('x')\n")
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'ignore' })
  await git.init({ fs: nodeFs, dir, defaultBranch: 'main' })
  for (const f of ['package.json', 'package-lock.json', 'app.js']) await git.add({ fs: nodeFs, dir, filepath: f })
  await git.commit({ fs: nodeFs, dir, message: 'base', author: { name: 't', email: 't@example.com', timestamp: 1700000000, timezoneOffset: 0 } })
  return dir
}

describe('installable fix (real npm)', () => {
  it('writes a lockfile that npm ci installs at the fixed version', async () => {
    const dir = await realRepo('4.17.15')
    const r = await applyFixAction(dir, mkCard())
    expect(r.applied).toBe(true)
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'ignore' })
    expect((await readJson(path.join(dir, 'node_modules/lodash/package.json'))).version).toBe('4.17.21')
  }, 180000)

  it('apply then scan_diff confirms the CVE is gone and none introduced', async () => {
    const dir = await realRepo('4.17.15')
    const r = await applyAndReverify(dir, mkCard(), { fetchImpl: osv, env: await env() })
    expect(r.outcome.applied).toBe(true)
    expect(r.cleared).toBe(true)
    expect(r.reverify!.introduced).toEqual([])
    expect(r.reverify!.removed.map((e) => e.advisoryId).sort()).toEqual(['GHSA-35jh-r3h4-6jhm', 'GHSA-p6mc-m468-83gw'])
  }, 180000)
})
