import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import * as nodeFs from 'node:fs'
import git from 'isomorphic-git'
import { SerializedGraphSchema } from '@neat.is/types'
import { getGraph, resetGraph, type NeatGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import {
  beginSourceExtraction,
  finishSourceExtraction,
  invalidateSourceBaseline,
  readSourceBaseline,
} from '../src/extract/source-baseline.js'
import { runRepoSyncPass, startRepoSync } from '../src/connectors/hosted-repos.js'
import { mergeSnapshot } from '../src/ingest.js'
import { SCHEMA_VERSION, type PersistedGraph } from '../src/persist.js'
import { buildApi } from '../src/api.js'

const source = { repository: 'acme/app', sha: 'a'.repeat(40) }
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  resetGraph()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function materialize(root: string) {
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'app', version: '1.0.0' }),
  )
  await writeFile(path.join(root, 'index.js'), 'export function fix() { return 1; }\n')
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'neat-source-baseline-'))
  roots.push(root)
  await materialize(root)
  const graph = getGraph()
  await extractFromDirectory(graph, root, { sourceCommit: source })
  expect(readSourceBaseline(graph)).toEqual({ status: 'ready', ...source })
  return { root, graph }
}
const repo = (name = 'app', syncStatus = 'syncing') => ({
  owner: 'acme',
  name,
  syncStatus,
  defaultBranch: 'main',
  cloneUrl: `https://x-access-token:SECRET@github.com/acme/${name}.git`,
})
async function sync(
  graph: NeatGraph,
  rows: unknown,
  options: { failList?: boolean; failClone?: boolean; sha?: string; onClone?: (url: string) => void } = {},
) {
  return runRepoSyncPass({
    graph,
    project: 'default',
    deps: {
      cpUrl: 'https://cp',
      projectId: 'prj_1',
      daemonToken: 'TOKEN',
      fetchImpl: (async (_url, init) =>
        init?.method === 'POST'
          ? new Response('{}')
          : new Response(JSON.stringify(rows), {
              status: options.failList ? 500 : 200,
            })) as typeof fetch,
    },
    cloneRepo: async (_url, _ref, dir) => {
      options.onClone?.(_url)
      if (options.failClone) throw new Error('SECRET')
      await materialize(dir)
      return options.sha
    },
  })
}

describe('hosted source baseline', () => {
  it('re-extracts a CP-synced repository after each daemon restart', async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) =>
      new Response(JSON.stringify(init?.method === 'POST' ? {} : [repo('app', 'synced')]))) as typeof fetch
    let clones = 0
    const cloneRepo = async (_url: string, _ref: string | undefined, dir: string) => {
      clones++
      await materialize(dir)
      return source.sha
    }
    const start = async () => {
      const graph = getGraph()
      expect(readSourceBaseline(graph)).toEqual({ status: 'unverified' })
      const sync = await startRepoSync({
        graph,
        project: 'default',
        deps: { cpUrl: 'https://cp', projectId: 'prj_1', daemonToken: 'TOKEN', fetchImpl },
        cloneRepo,
        intervalMs: 60_000,
      })
      await sync.settled()
      expect(graph.order).toBeGreaterThan(0)
      expect(readSourceBaseline(graph)).toEqual({ status: 'ready', ...source })
      sync()
    }
    await start()
    resetGraph() // A new daemon process begins without process-local source evidence.
    await start()
    expect(clones).toBe(2)
  })

  it('retries an incomplete boot extraction despite a terminal CP status', async () => {
    const statuses: string[] = []
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        statuses.push((JSON.parse(String(init.body)) as { syncStatus: string }).syncStatus)
        return new Response('{}')
      }
      return new Response(JSON.stringify([repo('app', 'synced')]))
    }) as typeof fetch
    let clones = 0
    const graph = getGraph()
    const sync = await startRepoSync({
      graph,
      project: 'default',
      deps: { cpUrl: 'https://cp', projectId: 'prj_1', daemonToken: 'TOKEN', fetchImpl },
      cloneRepo: async (_url, _ref, dir) => {
        clones++
        await materialize(dir)
        if (clones === 1) await writeFile(path.join(dir, 'generated.min.js'), 'const x=1\n')
        return source.sha
      },
      intervalMs: 60_000,
    })
    try {
      await sync.settled()
      expect(readSourceBaseline(graph).status).toBe('unavailable')
      expect(sync.syncNow().lastPass).toMatchObject({ listed: true, synced: 0, failed: 1 })
      expect(statuses.at(-1)).toBe('failed')

      await sync.settled() // The second pass still forces a CP-synced repo.
      expect(clones).toBe(2)
      expect(readSourceBaseline(graph)).toEqual({ status: 'ready', ...source })
      expect(statuses.at(-1)).toBe('synced')

      sync.syncNow()
      await sync.settled()
      expect(clones).toBe(2) // The boot obligation is now complete.
    } finally {
      sync()
    }
  })

  it('is source-free, copied on reads, isolated by graph, and absent from graph exports', async () => {
    const { graph } = await fixture()
    const copy = readSourceBaseline(graph)
    if (copy.status === 'ready') copy.sha = 'b'.repeat(40)
    expect(readSourceBaseline(graph)).toEqual({ status: 'ready', ...source })
    expect(readSourceBaseline(getGraph('other'))).toEqual({ status: 'unverified' })
    expect(JSON.stringify(graph.export())).not.toContain(source.sha)
    resetGraph()
    expect(readSourceBaseline(getGraph())).toEqual({ status: 'unverified' })
  })

  it('invalidates before another static extraction, even if the new pass fails', async () => {
    const { root, graph } = await fixture()
    const promise = extractFromDirectory(graph, root)
    expect(readSourceBaseline(graph)).toEqual({ status: 'unverified' })
    await promise
    expect(readSourceBaseline(graph)).toEqual({ status: 'unverified' })
    await writeFile(path.join(root, 'package.json'), '{malformed')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await extractFromDirectory(graph, root, { sourceCommit: source })
    expect(readSourceBaseline(graph).status).not.toBe('ready')
    warn.mockRestore()
  })

  it('refuses invalid commits and incomplete extraction or deliberately skipped source', async () => {
    const { root, graph } = await fixture()
    await extractFromDirectory(graph, root, { sourceCommit: { ...source, sha: 'main' } })
    expect(readSourceBaseline(graph)).toEqual({ status: 'unverified' })
    for (const result of [
      { extractionErrors: 1, skippedFiles: 0 },
      { extractionErrors: 0, skippedFiles: 1 },
    ]) {
      const generation = beginSourceExtraction(graph, source)
      finishSourceExtraction(graph, generation, source, result)
      expect(readSourceBaseline(graph)).toEqual({ status: 'unavailable' })
    }
  })

  it('prevents overlapping source passes and snapshot merges from restoring a stale claim', async () => {
    const { graph } = await fixture()
    const first = beginSourceExtraction(graph, source)
    const second = beginSourceExtraction(graph, { ...source, sha: 'b'.repeat(40) })
    finishSourceExtraction(graph, second, source, { extractionErrors: 0, skippedFiles: 0 })
    finishSourceExtraction(graph, first, source, { extractionErrors: 0, skippedFiles: 0 })
    expect(readSourceBaseline(graph)).toEqual({ status: 'unavailable' })
    const third = beginSourceExtraction(graph, source)
    invalidateSourceBaseline(graph)
    finishSourceExtraction(graph, third, source, { extractionErrors: 0, skippedFiles: 0 })
    expect(readSourceBaseline(graph).status).not.toBe('ready')
    const fresh = beginSourceExtraction(graph, source)
    finishSourceExtraction(graph, fresh, source, { extractionErrors: 0, skippedFiles: 0 })
    expect(readSourceBaseline(graph).status).toBe('ready')
    mergeSnapshot(graph, {
      schemaVersion: SCHEMA_VERSION,
      extractedAt: new Date().toISOString(),
      graph: { nodes: [], edges: [] },
    } as PersistedGraph)
    expect(readSourceBaseline(graph)).toEqual({ status: 'unverified' })
  })

  it('exposes readiness on both graph routes and keeps the bearer gate', async () => {
    const { graph } = await fixture()
    const app = await buildApi({ graph, authToken: 'READ_TOKEN' })
    try {
      expect((await app.inject({ method: 'GET', url: '/graph' })).statusCode).toBe(401)
      for (const url of ['/graph', '/projects/default/graph']) {
        const response = await app.inject({
          method: 'GET',
          url,
          headers: { authorization: 'Bearer READ_TOKEN' },
        })
        expect(response.statusCode).toBe(200)
        expect(response.json().sourceBaseline).toEqual({ status: 'ready', ...source })
        expect(SerializedGraphSchema.parse(response.json()).sourceBaseline).toEqual({
          status: 'ready',
          ...source,
        })
      }
    } finally {
      await app.close()
    }
  })

  it('uses the actual clone revision and never trusts remembered synced status on a fresh graph', async () => {
    const graph = getGraph()
    await sync(graph, [repo('app', 'synced')])
    expect(readSourceBaseline(graph)).toEqual({ status: 'unverified' })
    await sync(graph, [repo()], { sha: source.sha })
    expect(readSourceBaseline(graph)).toEqual({ status: 'ready', ...source })
    await sync(graph, [repo('app', 'synced')])
    expect(readSourceBaseline(graph)).toEqual({ status: 'ready', ...source })
    await sync(graph, [repo('other', 'synced')])
    expect(readSourceBaseline(graph).status).not.toBe('ready')
  })

  it('resolves real Git HEAD in the default clone adapter rather than treating a branch as a commit', async () => {
    let commit = ''
    const clone = vi.spyOn(git, 'clone').mockImplementation(async (options) => {
      await materialize(options.dir)
      await git.init({ fs: nodeFs, dir: options.dir, defaultBranch: 'main' })
      for (const filepath of ['package.json', 'index.js']) {
        await git.add({ fs: nodeFs, dir: options.dir, filepath })
      }
      commit = await git.commit({
        fs: nodeFs,
        dir: options.dir,
        message: 'Synthetic fixture',
        author: {
          name: 'Fixture',
          email: 'fixture@example.invalid',
          timestamp: 1,
          timezoneOffset: 0,
        },
      })
    })
    const graph = getGraph()
    await runRepoSyncPass({
      graph,
      project: 'default',
      deps: {
        cpUrl: 'https://cp',
        projectId: 'prj_1',
        daemonToken: 'TOKEN',
        fetchImpl: (async (_url, init) =>
          new Response(JSON.stringify(init?.method === 'POST' ? {} : [repo()]))) as typeof fetch,
      },
    })
    expect(commit).toMatch(/^[0-9a-f]{40}$/)
    expect(readSourceBaseline(graph)).toEqual({
      status: 'ready',
      repository: source.repository,
      sha: commit,
    })
    expect(clone.mock.calls[0]![0].url).toBe('https://github.com/acme/app.git')
  })

  it('refuses missing SHA, ambiguous repository ownership, failed passes, and unreadable lists', async () => {
    const { graph } = await fixture()
    await sync(graph, [repo()])
    expect(readSourceBaseline(graph).status).not.toBe('ready')
    await sync(graph, [repo(), repo('other')], { sha: source.sha })
    expect(readSourceBaseline(graph)).toEqual({ status: 'unavailable' })
    await sync(graph, [repo()], { failClone: true })
    expect(readSourceBaseline(graph)).toEqual({ status: 'unavailable' })
    await sync(graph, [repo()], { failList: true })
    expect(readSourceBaseline(graph)).toEqual({ status: 'unavailable' })
    await sync(graph, {})
    expect(readSourceBaseline(graph)).toEqual({ status: 'unavailable' })
    await sync(graph, [null])
    expect(readSourceBaseline(graph)).toEqual({ status: 'unavailable' })
    await sync(graph, [{ ...repo(), cloneUrl: 'https://github.com/other/repository.git' }], {
      sha: source.sha,
    })
    expect(readSourceBaseline(graph)).toEqual({ status: 'unavailable' })
    await sync(graph, [])
    expect(readSourceBaseline(graph)).toEqual({ status: 'unverified' })
    expect(JSON.stringify(readSourceBaseline(graph))).not.toMatch(/SECRET|TOKEN|cloneUrl/)
  })

  it('syncs a valid row despite an unfamiliar sibling and keeps source evidence unavailable', async () => {
    const { graph } = await fixture()
    const cloned: string[] = []
    const listed = await sync(graph, [repo('new', 'queued'), repo('app')], {
      sha: source.sha,
      onClone: url => cloned.push(url),
    })
    expect(listed).toBe(true)
    expect(cloned).toHaveLength(1)
    expect(cloned[0]).toContain('/acme/app.git')
    expect(readSourceBaseline(graph)).toEqual({ status: 'unavailable' })
  })
})
