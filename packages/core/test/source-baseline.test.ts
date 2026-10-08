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
  readSourceBaselines,
} from '../src/extract/source-baseline.js'
import { runRepoSyncPass, startRepoSync } from '../src/connectors/hosted-repos.js'
import { mergeSnapshot } from '../src/ingest.js'
import { SCHEMA_VERSION, type PersistedGraph } from '../src/persist.js'
import { buildApi } from '../src/api.js'

const source = { repository: 'acme/app', sha: 'a'.repeat(40) }
const ready = { status: 'ready', ...source }
const unavailable = (repository = source.repository) => ({ status: 'unavailable', repository })
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  resetGraph()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function materialize(root: string, name = 'app') {
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name, version: '1.0.0' }),
  )
  await writeFile(path.join(root, 'index.js'), 'export function fix() { return 1; }\n')
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'neat-source-baseline-'))
  roots.push(root)
  await materialize(root)
  const graph = getGraph()
  await extractFromDirectory(graph, root, { source: source.repository, sourceCommit: source })
  expect(readSourceBaselines(graph)).toEqual([ready])
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
  options: {
    failList?: boolean
    failClone?: boolean
    sha?: string
    onClone?: (url: string) => void
    service?: (url: string) => string
  } = {},
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
      await materialize(dir, options.service?.(_url) ?? 'app')
      return options.sha
    },
  })
}

describe('hosted source baselines', () => {
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
      expect(readSourceBaselines(graph)).toEqual([])
      const sync = await startRepoSync({
        graph,
        project: 'default',
        deps: { cpUrl: 'https://cp', projectId: 'prj_1', daemonToken: 'TOKEN', fetchImpl },
        cloneRepo,
        intervalMs: 60_000,
      })
      await sync.settled()
      expect(graph.order).toBeGreaterThan(0)
      expect(readSourceBaselines(graph)).toEqual([ready])
      sync()
    }
    await start()
    resetGraph() // A new daemon process begins without process-local source evidence.
    await start()
    expect(clones).toBe(2)
  })

  it('keeps an incomplete boot extraction unavailable without re-cloning the same commit', async () => {
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
        await writeFile(path.join(dir, 'generated.min.js'), 'const x=1\n')
        return source.sha
      },
      intervalMs: 60_000,
    })
    try {
      await sync.settled()
      expect(clones).toBe(1)
      expect(readSourceBaselines(graph)).toEqual([unavailable()])
      expect(statuses.at(-1)).toBe('synced')
      for (let pass = 0; pass < 3; pass++) {
        sync.syncNow()
        await sync.settled()
      }
      expect(clones).toBe(1) // The same commit would extract the same way; the next push re-queues it.
      expect(readSourceBaselines(graph)).toEqual([unavailable()])
    } finally {
      sync()
    }
  })

  it('are source-free, copied on reads, isolated by graph, and absent from graph exports', async () => {
    const { graph } = await fixture()
    const copy = readSourceBaselines(graph)
    if (copy[0]?.status === 'ready') copy[0].sha = 'b'.repeat(40)
    expect(readSourceBaselines(graph)).toEqual([ready])
    expect(readSourceBaselines(getGraph('other'))).toEqual([])
    expect(JSON.stringify(graph.export())).not.toContain(source.sha)
    resetGraph()
    expect(readSourceBaselines(getGraph())).toEqual([])
  })

  it('drops every entry before an extraction scoped to no repo, even if that pass fails', async () => {
    const { root, graph } = await fixture()
    const promise = extractFromDirectory(graph, root)
    expect(readSourceBaselines(graph)).toEqual([unavailable()])
    await promise
    expect(readSourceBaselines(graph)).toEqual([unavailable()])
    await writeFile(path.join(root, 'package.json'), '{malformed')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await extractFromDirectory(graph, root, { source: source.repository, sourceCommit: source })
    expect(readSourceBaselines(graph)).toEqual([unavailable()])
    warn.mockRestore()
  })

  it('refuses invalid commits, a commit for another repo, and incomplete or skipped source', async () => {
    const { root, graph } = await fixture()
    await extractFromDirectory(graph, root, {
      source: source.repository,
      sourceCommit: { ...source, sha: 'main' },
    })
    expect(readSourceBaselines(graph)).toEqual([unavailable()])
    await extractFromDirectory(graph, root, {
      source: source.repository,
      sourceCommit: { ...source, repository: 'acme/other' },
    })
    expect(readSourceBaselines(graph)).toEqual([unavailable()])
    for (const result of [
      { extractionErrors: 1, skippedFiles: 0 },
      { extractionErrors: 0, skippedFiles: 1 },
    ]) {
      const generation = beginSourceExtraction(graph, source.repository, source)
      finishSourceExtraction(graph, generation, source.repository, source, result)
      expect(readSourceBaselines(graph)).toEqual([unavailable()])
    }
  })

  it('prevents superseded passes and snapshot merges from restoring a stale claim', async () => {
    const { graph } = await fixture()
    const first = beginSourceExtraction(graph, source.repository, source)
    const second = beginSourceExtraction(graph, source.repository, { ...source, sha: 'b'.repeat(40) })
    finishSourceExtraction(graph, first, source.repository, source, { extractionErrors: 0, skippedFiles: 0 })
    expect(readSourceBaselines(graph)).toEqual([{ status: 'syncing', repository: source.repository }])
    finishSourceExtraction(graph, second, source.repository, { ...source, sha: 'b'.repeat(40) }, {
      extractionErrors: 0,
      skippedFiles: 0,
    })
    expect(readSourceBaselines(graph)).toEqual([{ ...ready, sha: 'b'.repeat(40) }])
    const third = beginSourceExtraction(graph, source.repository, source)
    invalidateSourceBaseline(graph)
    finishSourceExtraction(graph, third, source.repository, source, { extractionErrors: 0, skippedFiles: 0 })
    expect(readSourceBaselines(graph)).toEqual([unavailable()])
    const fresh = beginSourceExtraction(graph, source.repository, source)
    finishSourceExtraction(graph, fresh, source.repository, source, { extractionErrors: 0, skippedFiles: 0 })
    expect(readSourceBaselines(graph)).toEqual([ready])
    mergeSnapshot(graph, {
      schemaVersion: SCHEMA_VERSION,
      extractedAt: new Date().toISOString(),
      graph: { nodes: [], edges: [] },
    } as PersistedGraph)
    expect(readSourceBaselines(graph)).toEqual([unavailable()])
  })

  it('lets queued passes run in turn without marking each other conflicted', async () => {
    const { root, graph } = await fixture()
    const next = { ...source, sha: 'b'.repeat(40) }
    await Promise.all([
      extractFromDirectory(graph, root, { source: source.repository, sourceCommit: source }),
      extractFromDirectory(graph, root, { source: source.repository, sourceCommit: next }),
    ])
    expect(readSourceBaselines(graph)).toEqual([{ ...ready, sha: next.sha }])
  })

  it('exposes the list on both graph routes and keeps the bearer gate', async () => {
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
        expect(response.json().sourceBaselines).toEqual([ready])
        expect(SerializedGraphSchema.parse(response.json()).sourceBaselines).toEqual([ready])
      }
    } finally {
      await app.close()
    }
  })

  it('uses the actual clone revision and never trusts remembered synced status on a fresh graph', async () => {
    const graph = getGraph()
    await sync(graph, [repo('app', 'synced')])
    expect(readSourceBaselines(graph)).toEqual([])
    await sync(graph, [repo()], { sha: source.sha })
    expect(readSourceBaselines(graph)).toEqual([ready])
    await sync(graph, [repo('app', 'synced')])
    expect(readSourceBaselines(graph)).toEqual([ready])
    await sync(graph, [repo('other', 'synced')])
    expect(readSourceBaselines(graph)).toEqual([])
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
    expect(readSourceBaselines(graph)).toEqual([{ ...ready, sha: commit }])
    expect(clone.mock.calls[0]![0].url).toBe('https://github.com/acme/app.git')
  })

  it('keeps one entry per bound repo and refuses missing SHAs, failed clones and unreadable lists', async () => {
    const graph = getGraph()
    const service = (url: string) => (url.includes('/other.git') ? 'other' : 'app')
    await sync(graph, [repo(), repo('other')], { sha: source.sha, service })
    expect(readSourceBaselines(graph)).toEqual([
      ready,
      { status: 'ready', repository: 'acme/other', sha: source.sha },
    ])
    await sync(graph, [repo(), repo('other', 'synced')])
    expect(readSourceBaselines(graph)).toEqual([
      unavailable(),
      { status: 'ready', repository: 'acme/other', sha: source.sha },
    ])
    await sync(graph, [repo(), repo('other', 'synced')], { failClone: true })
    expect(readSourceBaselines(graph).map((entry) => entry.status)).toEqual(['unavailable', 'ready'])
    await sync(graph, [repo('app', 'synced'), repo('other', 'failed')])
    expect(readSourceBaselines(graph)).toEqual([unavailable(), unavailable('acme/other')])
    await sync(graph, [repo()], { sha: source.sha })
    expect(readSourceBaselines(graph)).toEqual([ready])
    await sync(graph, [repo()], { failList: true })
    expect(readSourceBaselines(graph)).toEqual([unavailable()])
    await sync(graph, [repo()], { sha: source.sha })
    await sync(graph, {})
    expect(readSourceBaselines(graph)).toEqual([unavailable()])
    await sync(graph, [{ ...repo(), cloneUrl: 'https://github.com/other/repository.git' }], {
      sha: source.sha,
    })
    expect(readSourceBaselines(graph)).toEqual([])
    await sync(graph, [])
    expect(readSourceBaselines(graph)).toEqual([])
    expect(JSON.stringify(readSourceBaselines(graph))).not.toMatch(/SECRET|TOKEN|cloneUrl/)
  })

  it('refuses both repos when they share a service name, since their nodes are shared', async () => {
    const graph = getGraph()
    await sync(graph, [repo(), repo('other')], { sha: source.sha })
    expect(readSourceBaselines(graph)).toEqual([unavailable(), unavailable('acme/other')])
  })

  it('syncs a valid row beside an unfamiliar one and keeps its own evidence', async () => {
    const graph = getGraph()
    const cloned: string[] = []
    const listed = await sync(graph, [repo('new', 'queued'), repo('app')], {
      sha: source.sha,
      onClone: (url) => cloned.push(url),
    })
    expect(listed).toBe(true)
    expect(cloned).toHaveLength(1)
    expect(cloned[0]).toContain('/acme/app.git')
    expect(readSourceBaselines(graph)).toEqual([ready])
  })
})
