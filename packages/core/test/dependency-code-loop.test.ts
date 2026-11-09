import { describe, it, expect, afterEach, vi } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dependencyId, isDependencySymbolId } from '@neat.is/types'
import { makeGraph, type NeatGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { runDependencyCodeTick, startDependencyCodeLoop } from '../src/dependency-code-loop.js'

// The dependency-code loop (ADR-274, dependency-inventory.md §5): the graph holds
// the code of exactly the dependency versions that match a known advisory.

const FIX = path.join(__dirname, 'fixtures/osv')
const rec = (id: string) => JSON.parse(readFileSync(path.join(FIX, `${id}.json`), 'utf8'))
const dirs: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true })
})
async function tmp(prefix: string) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  dirs.push(d)
  return d
}

// OSV stand-in: lodash has its two advisories; nothing else has any.
const osv = (async (url: string, init?: RequestInit) => {
  if (url.endsWith('/v1/querybatch')) {
    const body = JSON.parse(String(init?.body)) as { queries: Array<{ package: { name: string } }> }
    const ids: Record<string, string[]> = { lodash: ['GHSA-35jh-r3h4-6jhm', 'GHSA-p6mc-m468-83gw'] }
    return new Response(JSON.stringify({ results: body.queries.map((q) => ({ vulns: (ids[q.package.name] ?? []).map((id) => ({ id })) })) }))
  }
  return new Response(JSON.stringify(rec(decodeURIComponent(url.split('/v1/vulns/')[1] ?? ''))))
}) as typeof fetch
const failing = (async () => {
  throw new Error('network down')
}) as typeof fetch

async function project(lodash: string): Promise<string> {
  const root = await tmp('neat-depcode-')
  const files: Record<string, unknown> = {
    'package.json': { name: 'shop', main: 'app.js', dependencies: { lodash, ms: '2.1.3' } },
    'package-lock.json': {
      name: 'shop',
      lockfileVersion: 3,
      packages: {
        '': { name: 'shop', dependencies: { lodash, ms: '2.1.3' } },
        'node_modules/lodash': { version: lodash },
        'node_modules/ms': { version: '2.1.3' },
      },
    },
    'app.js': "const _ = require('lodash')\nconst ms = require('ms')\nmodule.exports = () => _.template(ms('1s'))\n",
    'node_modules/lodash/package.json': { name: 'lodash', version: lodash },
    'node_modules/lodash/template.js': 'module.exports = function template(s) { return helper(s) }\nfunction helper(s) { return s }\n',
    'node_modules/ms/package.json': { name: 'ms', version: '2.1.3' },
    'node_modules/ms/index.js': 'module.exports = function ms(s) { return 1000 }\n',
  }
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(root, rel)
    await fs.mkdir(path.dirname(f), { recursive: true })
    await fs.writeFile(f, typeof body === 'string' ? body : JSON.stringify(body))
  }
  return root
}

async function graphOf(root: string): Promise<NeatGraph> {
  const g = makeGraph()
  await extractFromDirectory(g, root, { announce: false })
  return g
}
const codeOf = (g: NeatGraph, depId: string) => g.outNeighbors(depId).filter(isDependencySymbolId).sort()
const env = async () => ({ NEAT_HOME: await tmp('neat-depcode-home-') })

describe('runDependencyCodeTick', () => {
  it('extracts the code of matched versions only', async () => {
    const root = await project('4.17.15')
    const g = await graphOf(root)
    const r = await runDependencyCodeTick({ graph: g, projectDir: root, env: await env(), fetchImpl: osv })
    expect(r).toMatchObject({ advisories: 'osv', matched: 1, dropped: 0, notLocated: 0, errors: [] })
    expect(r.extracted).toBeGreaterThan(0)
    expect(codeOf(g, dependencyId('npm', 'lodash', '4.17.15')).length).toBeGreaterThan(0)
    expect(codeOf(g, dependencyId('npm', 'ms', '2.1.3'))).toEqual([]) // no advisory, no code
  })

  it('drops the code of a version that no longer matches, and leaves the graph as it was', async () => {
    const root = await project('4.17.15')
    const g = await graphOf(root)
    const e = await env()
    await runDependencyCodeTick({ graph: g, projectDir: root, env: e, fetchImpl: osv })
    const lodash = dependencyId('npm', 'lodash', '4.17.15')
    const had = codeOf(g, lodash).length
    // Same version, but the feed now says nothing affects it (a withdrawn advisory).
    const quiet = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/querybatch')) {
        const body = JSON.parse(String(init?.body)) as { queries: unknown[] }
        return new Response(JSON.stringify({ results: body.queries.map(() => ({ vulns: [] })) }))
      }
      return new Response('{}')
    }) as typeof fetch
    const r = await runDependencyCodeTick({ graph: g, projectDir: root, env: await env(), fetchImpl: quiet })
    expect(r).toMatchObject({ matched: 0, dropped: had, extracted: 0 })
    expect(codeOf(g, lodash)).toEqual([])
    expect(g.hasNode(lodash)).toBe(true) // the version stays; only its code goes
  })

  it('changes nothing when advisories are off, or the feed fails with nothing cached', async () => {
    const root = await project('4.17.15')
    const g = await graphOf(root)
    await runDependencyCodeTick({ graph: g, projectDir: root, env: await env(), fetchImpl: osv })
    const before = codeOf(g, dependencyId('npm', 'lodash', '4.17.15'))
    expect(before.length).toBeGreaterThan(0)

    const off = await runDependencyCodeTick({ graph: g, projectDir: root, env: { ...(await env()), NEAT_ADVISORIES: 'off' }, fetchImpl: osv })
    expect(off).toMatchObject({ advisories: 'disabled', matched: 0, dropped: 0 })
    // A fresh cache and a failing feed: the loader still hands back a snapshot,
    // empty, with the error. That is the path that must not read as "nothing matches".
    const down = await runDependencyCodeTick({ graph: g, projectDir: root, env: await env(), fetchImpl: failing })
    expect(down).toMatchObject({ advisories: 'osv', matched: 0, dropped: 0 })
    expect(down.errors).toEqual(['network down'])
    expect(codeOf(g, dependencyId('npm', 'lodash', '4.17.15'))).toEqual(before)
  })
})

describe('startDependencyCodeLoop', () => {
  it('never runs two passes at once, and stops', async () => {
    const root = await project('4.17.15')
    const g = await graphOf(root)
    const e = await env()
    let started = 0
    let release: () => void = () => {}
    const held = new Promise<void>((r) => (release = r))
    // The first pass blocks inside the advisory fetch until released.
    const gate = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/querybatch')) {
        started++
        await held
      }
      return osv(url, init)
    }) as typeof fetch
    const ticks: number[] = []
    const stop = startDependencyCodeLoop({
      project: 'shop',
      graph: g,
      projectDir: root,
      env: e,
      fetchImpl: gate,
      initialDelayMs: 5,
      intervalMs: 5,
      onTick: (r) => ticks.push(r.matched),
    })
    await vi.waitFor(() => expect(started).toBe(1), { timeout: 5000 })
    // Many intervals pass while the first is held: none starts a second pass.
    await new Promise((r) => setTimeout(r, 50))
    expect(started).toBe(1)
    release()
    await vi.waitFor(() => expect(ticks.length).toBeGreaterThanOrEqual(1), { timeout: 5000 })
    stop()
    const after = ticks.length
    await new Promise((r) => setTimeout(r, 50))
    expect(ticks.length).toBe(after)
    expect(ticks.every((m) => m === 1)).toBe(true)
  })

})
