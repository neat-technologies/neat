import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EdgeType, NodeType, Provenance } from '@neat.is/types'
import { MARKER } from '@neat.is/action/src/graph.mjs'
import { extractFromDirectory } from '../src/extract.js'
import { makeGraph, resetGraph, getGraph, type NeatGraph } from '../src/graph.js'
import { Projects, pathsForProject } from '../src/projects.js'
import { buildApi } from '../src/api.js'
import {
  changedPathsBetween,
  createPrVerdictRunner,
  parsePrVerdictRequest,
  PrVerdictError,
  type PrVerdictRequest,
} from '../src/pr-verdict.js'

// ADR-235 — the PR verdict computed in the daemon. A pull request's base and
// head are cloned, each extracted into a scratch graph, diffed with the Action's
// own code, and the OBSERVED half read from the project's live graph; the route
// returns the comment the Action would post.

const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const request = (over: Partial<PrVerdictRequest> = {}): PrVerdictRequest => ({
  owner: 'acme',
  name: 'shop',
  baseSha: BASE,
  headSha: HEAD,
  cloneUrl: 'https://x-access-token:ghs_secret123@github.com/acme/shop.git',
  ...over,
})

const dirs: string[] = []
afterEach(async () => {
  resetGraph()
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true })
})

async function tmp(prefix: string): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
  dirs.push(d)
  return d
}

const pkg = JSON.stringify({ name: 'shop-api', version: '1.0.0', dependencies: { express: '^4', pg: '^8' } })
const BASE_TREE: Record<string, string> = {
  'package.json': pkg,
  'src/index.js':
    "const express=require('express');const db=require('./db');const app=express();" +
    "app.get('/orders',async(q,r)=>r.json(await db.orders()));app.get('/health',(q,r)=>r.send('ok'));app.listen(3000)",
  'src/db.js':
    "const {Pool}=require('pg');const p=new Pool({host:'db.internal',database:'shop'});exports.orders=()=>p.query('select * from orders')",
}
// The PR: drops the /orders route and the db module.
const HEAD_TREE: Record<string, string> = {
  'package.json': pkg,
  'src/index.js':
    "const express=require('express');const app=express();app.get('/health',(q,r)=>r.send('ok'));app.listen(3000)",
}

async function write(dir: string, files: Record<string, string>): Promise<void> {
  for (const [f, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true })
    await fs.writeFile(path.join(dir, f), c)
  }
}

/** A clone that lays down the fixture for whichever commit was asked for, and records what it was given. */
function fixtureClone(log: Array<{ url: string; sha: string }> = []) {
  return async (url: string, sha: string, dest: string): Promise<void> => {
    log.push({ url, sha })
    await write(dest, sha === BASE ? BASE_TREE : HEAD_TREE)
  }
}

/** The project as production sees it: the base extracted, and real traffic into GET /orders. */
async function liveGraph(): Promise<NeatGraph> {
  const g = makeGraph()
  const dir = await tmp('neat-pr-live-')
  await write(dir, BASE_TREE)
  await extractFromDirectory(g, dir)
  g.addNode('service:web', { id: 'service:web', type: NodeType.ServiceNode, name: 'web', language: 'javascript' })
  g.addEdgeWithKey('CALLS:observed:web->orders', 'service:web', 'route:shop-api:GET /orders', {
    id: 'CALLS:observed:web->orders',
    source: 'service:web',
    target: 'route:shop-api:GET /orders',
    type: EdgeType.CALLS,
    provenance: Provenance.OBSERVED,
    callCount: 1200,
    lastObserved: new Date().toISOString(),
  })
  return g
}

describe('createPrVerdictRunner', () => {
  it('renders the Action’s verdict, with the removed route flagged as an observed break', async () => {
    const live = await liveGraph()
    const before = JSON.stringify(live.export())
    const clones: Array<{ url: string; sha: string }> = []
    const tmpRoot = await tmp('neat-pr-root-')
    const run = createPrVerdictRunner({ cloneCommit: fixtureClone(clones), tmpRoot })

    const v = await run(request({ changedFiles: ['src/index.js', 'src/db.js'] }), { liveGraph: live })

    expect(v.marker).toBe(MARKER)
    expect(v.body).toContain(MARKER)
    expect(v.body).toContain('GET /orders')
    expect(v.body).toContain('🔴')
    expect(v.observedBreaks).toBeGreaterThanOrEqual(1)
    // Changed files are matched against head's FileNodes: db.js is deleted, so only index.js counts.
    expect(v.changedFiles).toBe(1)
    expect(v.base).toMatchObject({ sha: BASE })
    expect(v.head).toMatchObject({ sha: HEAD })
    expect(v.base.nodes).toBeGreaterThan(v.head.nodes)

    // Both commits, by SHA, from the URL given.
    expect(clones.map((c) => c.sha)).toEqual([BASE, HEAD])
    expect(clones.every((c) => c.url === request().cloneUrl)).toBe(true)
    // The live graph was only read.
    expect(JSON.stringify(live.export())).toBe(before)
    // Nothing left on disk.
    expect(await fs.readdir(tmpRoot)).toEqual([])
  })

  it('says nothing is at risk when the PR touches nothing production runs', async () => {
    const live = await liveGraph()
    // Head identical to base apart from a comment: no node added or removed.
    const run = createPrVerdictRunner({
      cloneCommit: async (_u, sha, dest) =>
        write(dest, sha === BASE ? BASE_TREE : { ...BASE_TREE, 'README.md': '# shop' }),
    })
    const v = await run(request(), { liveGraph: live })
    expect(v.observedBreaks).toBe(0)
    expect(v.body).not.toContain('🔴')
  })

  it('falls back to comparing the two trees when no changed-files list is sent', async () => {
    const run = createPrVerdictRunner({ cloneCommit: fixtureClone() })
    const v = await run(request(), { liveGraph: await liveGraph() })
    // index.js changed and is still in head; db.js is gone, so it maps to no head FileNode.
    expect(v.changedFiles).toBe(1)
  })

  it('returns the schema issues on a bad body', () => {
    const err = (() => {
      try {
        parsePrVerdictRequest({ ...request(), baseSha: 'abc' })
      } catch (e) {
        return e as PrVerdictError
      }
    })()!
    expect(err.status).toBe(400)
    expect(JSON.stringify(err.details)).toContain('baseSha')
  })

  it('refuses a second verdict while one is running', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const run = createPrVerdictRunner({
      cloneCommit: async (u, sha, dest) => {
        await gate
        await fixtureClone()(u, sha, dest)
      },
    })
    const live = await liveGraph()
    const first = run(request(), { liveGraph: live })
    const second = await run(request(), { liveGraph: live }).catch((e) => e)
    expect(second).toBeInstanceOf(PrVerdictError)
    expect((second as PrVerdictError).status).toBe(429)
    release()
    await expect(first).resolves.toMatchObject({ marker: MARKER })
    // And it frees up afterwards.
    await expect(run(request(), { liveGraph: live })).resolves.toMatchObject({ marker: MARKER })
  })

  it('answers 504 when a clone stalls, then frees itself and removes the checkouts', async () => {
    // A fetch that never returns — the case that used to hold the runner busy until restart.
    const tmpRoot = await tmp('neat-pr-root-')
    const run = createPrVerdictRunner({
      timeoutMs: 100,
      tmpRoot,
      cloneCommit: () => new Promise<void>(() => {}),
    })
    const live = await liveGraph()
    const err = (await run(request(), { liveGraph: live }).catch((e) => e)) as PrVerdictError
    expect(err.status).toBe(504)
    // The work stopped at the same deadline: no checkout left, and the next request is served, not refused.
    await expect.poll(async () => (await fs.readdir(tmpRoot)).length, { timeout: 5_000 }).toBe(0)
    const next = (await run(request(), { liveGraph: live }).catch((e) => e)) as PrVerdictError
    expect(next.status).toBe(504)
  })

  it('extracts quietly, under the repo as its source', async () => {
    const calls: Array<Record<string, unknown> | undefined> = []
    const run = createPrVerdictRunner({
      cloneCommit: fixtureClone(),
      extract: (async (g: NeatGraph, dir: string, opts?: Record<string, unknown>) => {
        calls.push(opts)
        return extractFromDirectory(g, dir, opts)
      }) as never,
    })
    await run(request(), { liveGraph: await liveGraph() })
    expect(calls).toEqual([
      { source: 'acme/shop', announce: false },
      { source: 'acme/shop', announce: false },
    ])
  })

  it('names the stage that failed and never echoes the token', async () => {
    const run = createPrVerdictRunner({
      cloneCommit: async (url, sha) => {
        if (sha === HEAD) throw new Error(`could not fetch ${url}`)
      },
    })
    const err = (await run(request(), { liveGraph: makeGraph() }).catch((e) => e)) as PrVerdictError
    expect(err.status).toBe(422)
    expect(err.stage).toBe('clone-head')
    expect(err.message).not.toContain('ghs_secret123')
    expect(err.message).toContain('x-access-token:***@')
  })
})

describe('parsePrVerdictRequest', () => {
  const body = (over: Record<string, unknown> = {}) => ({ ...request(), ...over })
  const status = (b: unknown): number | 'ok' => {
    try {
      parsePrVerdictRequest(b)
      return 'ok'
    } catch (e) {
      return (e as PrVerdictError).status
    }
  }

  it('accepts a well-formed request', () => {
    expect(parsePrVerdictRequest(body({ changedFiles: ['a.ts'], tone: 'professional' }))).toMatchObject({
      owner: 'acme',
      name: 'shop',
      changedFiles: ['a.ts'],
      tone: 'professional',
    })
  })

  it('holds the clone URL to https github.com and the repo named', () => {
    expect(status(body({ cloneUrl: 'http://github.com/acme/shop.git' }))).toBe(400)
    expect(status(body({ cloneUrl: 'https://evil.example/acme/shop.git' }))).toBe(400)
    expect(status(body({ cloneUrl: 'https://github.com:8443/acme/shop.git' }))).toBe(400)
    expect(status(body({ cloneUrl: 'https://github.com/acme/other.git' }))).toBe(400)
    expect(status(body({ cloneUrl: 'file:///etc/passwd' }))).toBe(400)
    expect(status(body({ cloneUrl: 'https://github.com/acme/shop' }))).toBe('ok')
  })

  it('wants full SHAs and plain names', () => {
    expect(status(body({ baseSha: 'abc123' }))).toBe(400)
    expect(status(body({ headSha: 'B'.repeat(40) }))).toBe(400)
    expect(status(body({ owner: '../etc' }))).toBe(400)
    expect(status(body({ name: '' }))).toBe(400)
    expect(status(body({ tone: 'shouty' }))).toBe(400)
    expect(status(body({ changedFiles: 'src/a.ts' }))).toBe(400)
    expect(status(null)).toBe(400)
    expect(status([])).toBe(400)
  })
})

describe('changedPathsBetween', () => {
  it('lists added, removed and changed files, and ignores .git and node_modules', async () => {
    const a = await tmp('neat-pr-a-')
    const b = await tmp('neat-pr-b-')
    await write(a, { 'same.js': '1', 'changed.js': '1', 'gone.js': '1', '.git/HEAD': 'x', 'node_modules/m/i.js': '1' })
    await write(b, { 'same.js': '1', 'changed.js': '2', 'new.js': '1', '.git/HEAD': 'y', 'node_modules/m/i.js': '2' })
    expect(await changedPathsBetween(a, b)).toEqual(['changed.js', 'gone.js', 'new.js'])
  })
})

describe('POST /pr-verdict', () => {
  async function app(opts: Partial<Parameters<typeof buildApi>[0]> = {}) {
    const dir = await tmp('neat-pr-api-')
    const registry = new Projects()
    registry.set('shop', { paths: pathsForProject('shop', dir) })
    getGraph('shop').mergeNode('service:shop-api', {
      id: 'service:shop-api',
      type: NodeType.ServiceNode,
      name: 'shop-api',
      language: 'javascript',
    })
    return buildApi({ projects: registry, ...opts })
  }

  it('returns the verdict for the project', async () => {
    let seen: { project?: string; graph?: NeatGraph } = {}
    const a = await app({
      prVerdict: async (_req, ctx) => {
        seen = { graph: ctx.liveGraph }
        return {
          marker: MARKER,
          body: 'verdict',
          base: { sha: BASE, nodes: 5, edges: 5 },
          head: { sha: HEAD, nodes: 3, edges: 2 },
          changedFiles: 2,
          observedBreaks: 1,
          divergences: 0,
          durationMs: 10,
        }
      },
    })
    const res = await a.inject({ method: 'POST', url: '/projects/shop/pr-verdict', payload: request() })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ project: 'shop', marker: MARKER, body: 'verdict', observedBreaks: 1 })
    expect(seen.graph).toBe(getGraph('shop'))
    await a.close()
  })

  it('maps the runner’s refusals to their status, with Retry-After on 429', async () => {
    const refuse = (status: 422 | 429 | 504) =>
      app({
        prVerdict: async () => {
          throw new PrVerdictError('no', status, status === 422 ? 'extract-head' : undefined)
        },
      })
    for (const s of [422, 429, 504] as const) {
      const a = await refuse(s)
      const res = await a.inject({ method: 'POST', url: '/projects/shop/pr-verdict', payload: request() })
      expect(res.statusCode).toBe(s)
      if (s === 422) expect(res.json()).toMatchObject({ stage: 'extract-head', project: 'shop' })
      if (s === 429) expect(res.headers['retry-after']).toBe('30')
      await a.close()
    }
  })

  it('is 400 for a bad body, 404 for a project it doesn’t host, 401 without the token', async () => {
    let calls = 0
    const counting = async () => {
      calls++
      throw new Error('should not run')
    }
    const a = await app({ prVerdict: counting, authToken: 'daemon-token', publicRead: true })
    const auth = { authorization: 'Bearer daemon-token' }
    expect((await a.inject({ method: 'POST', url: '/projects/shop/pr-verdict', payload: request() })).statusCode).toBe(401)
    expect(
      (await a.inject({ method: 'POST', url: '/projects/shop/pr-verdict', headers: auth, payload: { owner: 'acme' } }))
        .statusCode,
    ).toBe(400)
    expect(
      (await a.inject({ method: 'POST', url: '/projects/ghost/pr-verdict', headers: auth, payload: request() }))
        .statusCode,
    ).toBe(404)
    expect(calls).toBe(0)
    await a.close()
  })
})
