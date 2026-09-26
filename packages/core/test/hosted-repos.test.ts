import { describe, it, expect, vi } from 'vitest'
import type { NeatGraph } from '../src/graph.js'
import {
  runRepoSyncPass,
  startRepoSync,
  maybeStartRepoSync,
  type HostedRepoSyncDeps,
  type CloneRepo,
} from '../src/connectors/hosted-repos.js'

// A graph sentinel — every pass injects the extractor, so the real graph is never touched; identity is all
// the assertions need.
const graph = { sentinel: 'graph' } as unknown as NeatGraph

const deps = (fetchImpl: typeof fetch): HostedRepoSyncDeps => ({
  cpUrl: 'https://cp.example',
  projectId: 'prj_1',
  daemonToken: 'daemon-token',
  fetchImpl,
})

interface RepoRow {
  owner: string
  name: string
  defaultBranch: string
  cloneUrl: string
  expiresAt?: string | null
  syncStatus?: string
}

const repo = (over: Partial<RepoRow> = {}): RepoRow => ({
  owner: 'octo',
  name: 'app',
  defaultBranch: 'main',
  cloneUrl: 'https://x-access-token:tok-123@github.com/octo/app.git',
  syncStatus: 'syncing',
  ...over,
})

/** A fetch double that answers the two /internal routes and records every status POST. */
function makeFetch(repos: RepoRow[], opts: { listFails?: boolean; failFirstNLists?: number } = {}) {
  const statusPosts: Array<{ url: string; body: Record<string, unknown>; auth?: string }> = []
  let listCalls = 0
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization
    if (method === 'GET' && url.endsWith('/repos')) {
      listCalls += 1
      if (opts.listFails || listCalls <= (opts.failFirstNLists ?? 0)) return new Response('boom', { status: 500 })
      return new Response(JSON.stringify(repos), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (method === 'POST' && url.includes('/repos/') && url.endsWith('/status')) {
      statusPosts.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown>, auth })
      return new Response('{}', { status: 200 })
    }
    return new Response('unexpected', { status: 404 })
  }) as unknown as typeof fetch
  return { fetchImpl, statusPosts }
}

describe('runRepoSyncPass — clone + extract + report', () => {
  it('clones each bound repo, extracts it into the graph, and reports synced', async () => {
    const { fetchImpl, statusPosts } = makeFetch([repo()])
    const cloneRepo = vi.fn<Parameters<CloneRepo>, ReturnType<CloneRepo>>(async () => {})
    const extract = vi.fn(async () => ({ nodesAdded: 42, edgesAdded: 17 }) as never)

    await runRepoSyncPass({
      deps: deps(fetchImpl),
      graph,
      project: 'default',
      cloneRepo,
      extract,
      now: () => 1_000,
    })

    // cloned with the CP's tokenized URL + default branch, into a temp dir
    expect(cloneRepo).toHaveBeenCalledOnce()
    const [url, ref, dir] = cloneRepo.mock.calls[0]
    expect(url).toBe('https://x-access-token:tok-123@github.com/octo/app.git')
    expect(ref).toBe('main')
    expect(typeof dir).toBe('string')
    // extracted the SAME dir into the SAME graph
    expect(extract).toHaveBeenCalledWith(graph, dir)
    // reported synced with a lastSyncAt from the injected clock
    expect(statusPosts).toHaveLength(1)
    expect(statusPosts[0].url).toBe('https://cp.example/internal/projects/prj_1/repos/octo/app/status')
    expect(statusPosts[0].body).toEqual({
      syncStatus: 'synced',
      detail: 'extracted 42 nodes, 17 edges',
      lastSyncAt: new Date(1_000).toISOString(),
    })
  })

  it('pulls the repo list from the right URL, daemon-authed', async () => {
    const { fetchImpl } = makeFetch([])
    await runRepoSyncPass({ deps: deps(fetchImpl), graph, project: 'default' })
    const getCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).endsWith('/repos'),
    )!
    expect(getCall[0]).toBe('https://cp.example/internal/projects/prj_1/repos')
    expect((getCall[1].headers as Record<string, string>).authorization).toBe('Bearer daemon-token')
  })

  it('reports failed with a token-scrubbed detail when the clone fails — and never extracts', async () => {
    const { fetchImpl, statusPosts } = makeFetch([repo()])
    const cloneRepo = vi.fn<Parameters<CloneRepo>, ReturnType<CloneRepo>>(async () => {
      throw new Error('fatal: could not read from https://x-access-token:tok-123@github.com/octo/app.git')
    })
    const extract = vi.fn(async () => ({}) as never)
    const onError = vi.fn()

    await runRepoSyncPass({ deps: deps(fetchImpl), graph, project: 'default', cloneRepo, extract, onError })

    expect(extract).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    expect(statusPosts).toHaveLength(1)
    expect(statusPosts[0].body.syncStatus).toBe('failed')
    const detail = String(statusPosts[0].body.detail)
    expect(detail).toContain('x-access-token:***@')
    expect(detail).not.toContain('tok-123')
  })

  it('syncs only repos still awaiting a pass — skips terminal synced/failed', async () => {
    const { fetchImpl, statusPosts } = makeFetch([
      repo({ name: 'a', syncStatus: 'syncing' }),
      repo({ name: 'b', syncStatus: 'synced' }),
      repo({ name: 'c', syncStatus: 'failed' }),
      repo({ name: 'd', syncStatus: undefined }),
    ])
    const cloneRepo = vi.fn<Parameters<CloneRepo>, ReturnType<CloneRepo>>(async () => {})
    const extract = vi.fn(async () => ({}) as never)

    await runRepoSyncPass({ deps: deps(fetchImpl), graph, project: 'default', cloneRepo, extract })

    // a (syncing) + d (absent) only
    expect(cloneRepo).toHaveBeenCalledTimes(2)
    expect(statusPosts.map((p) => p.url)).toEqual([
      'https://cp.example/internal/projects/prj_1/repos/octo/a/status',
      'https://cp.example/internal/projects/prj_1/repos/octo/d/status',
    ])
  })

  it('syncAll re-syncs a terminal repo — the boot pass on a fresh, empty instance (#1215)', async () => {
    const { fetchImpl, statusPosts } = makeFetch([
      repo({ name: 'a', syncStatus: 'synced' }),
      repo({ name: 'b', syncStatus: 'failed' }),
    ])
    const cloneRepo = vi.fn<Parameters<CloneRepo>, ReturnType<CloneRepo>>(async () => {})
    const extract = vi.fn(async () => ({}) as never)

    await runRepoSyncPass(
      { deps: deps(fetchImpl), graph, project: 'default', cloneRepo, extract },
      { syncAll: true },
    )

    // Both terminal repos are cloned + extracted despite their status.
    expect(cloneRepo).toHaveBeenCalledTimes(2)
    expect(statusPosts.map((p) => p.url)).toEqual([
      'https://cp.example/internal/projects/prj_1/repos/octo/a/status',
      'https://cp.example/internal/projects/prj_1/repos/octo/b/status',
    ])
  })

  it('returns true on a readable list and false when the list read fails', async () => {
    const ok = makeFetch([repo()])
    expect(
      await runRepoSyncPass({
        deps: deps(ok.fetchImpl),
        graph,
        project: 'default',
        cloneRepo: async () => {},
        extract: async () => ({}) as never,
      }),
    ).toBe(true)

    const bad = makeFetch([repo()], { listFails: true })
    expect(await runRepoSyncPass({ deps: deps(bad.fetchImpl), graph, project: 'default' })).toBe(false)
  })

  it('clones the default branch when the CP omits defaultBranch (ref undefined)', async () => {
    const { fetchImpl } = makeFetch([repo({ defaultBranch: undefined })])
    const cloneRepo = vi.fn<Parameters<CloneRepo>, ReturnType<CloneRepo>>(async () => {})
    const extract = vi.fn(async () => ({}) as never)
    await runRepoSyncPass({ deps: deps(fetchImpl), graph, project: 'default', cloneRepo, extract })
    expect(cloneRepo.mock.calls[0][1]).toBeUndefined()
    expect(extract).toHaveBeenCalledOnce()
  })

  it('a control-plane list failure skips the pass without cloning', async () => {
    const { fetchImpl, statusPosts } = makeFetch([repo()], { listFails: true })
    const cloneRepo = vi.fn<Parameters<CloneRepo>, ReturnType<CloneRepo>>(async () => {})
    const onSkip = vi.fn()

    await runRepoSyncPass({ deps: deps(fetchImpl), graph, project: 'default', cloneRepo, onSkip })

    expect(cloneRepo).not.toHaveBeenCalled()
    expect(statusPosts).toHaveLength(0)
    expect(onSkip).toHaveBeenCalledWith('(all)', expect.stringContaining('repo list unreadable'))
  })
})

describe('startRepoSync / maybeStartRepoSync', () => {
  it('runs a boot pass and stops cleanly', async () => {
    const { fetchImpl } = makeFetch([repo()])
    const cloneRepo = vi.fn<Parameters<CloneRepo>, ReturnType<CloneRepo>>(async () => {})
    const extract = vi.fn(async () => ({}) as never)

    const stop = await startRepoSync({
      deps: deps(fetchImpl),
      graph,
      project: 'default',
      cloneRepo,
      extract,
      intervalMs: 60_000,
    })
    await vi.waitFor(() => expect(cloneRepo).toHaveBeenCalledOnce())
    stop()
  })

  it('boot pass re-syncs a terminal repo, then later passes leave it alone (#1215)', async () => {
    // A restarted instance: its bound repo is 'synced' on the CP but this process holds no graph.
    const { fetchImpl } = makeFetch([repo({ syncStatus: 'synced' })])
    const cloneRepo = vi.fn<Parameters<CloneRepo>, ReturnType<CloneRepo>>(async () => {})
    const extract = vi.fn(async () => ({}) as never)

    const stop = await startRepoSync({
      deps: deps(fetchImpl),
      graph,
      project: 'default',
      cloneRepo,
      extract,
      intervalMs: 20,
    })
    // Boot pass syncs the 'synced' repo anyway (syncAll).
    await vi.waitFor(() => expect(cloneRepo).toHaveBeenCalledOnce())
    // Give several intervals; later passes revert to the status gate and skip the terminal repo.
    await new Promise((r) => setTimeout(r, 120))
    expect(cloneRepo).toHaveBeenCalledOnce()
    stop()
  })

  it('a CP that fails at boot keeps sync-all armed for the recovering pass (#1215)', async () => {
    // First /repos read fails; the terminal repo must still be synced once the CP recovers, not skipped.
    const { fetchImpl } = makeFetch([repo({ syncStatus: 'synced' })], { failFirstNLists: 1 })
    const cloneRepo = vi.fn<Parameters<CloneRepo>, ReturnType<CloneRepo>>(async () => {})
    const extract = vi.fn(async () => ({}) as never)

    const stop = await startRepoSync({
      deps: deps(fetchImpl),
      graph,
      project: 'default',
      cloneRepo,
      extract,
      intervalMs: 20,
    })
    // Boot pass couldn't read the list (no clone); the next pass reads it and, still armed, clones the repo.
    await vi.waitFor(() => expect(cloneRepo).toHaveBeenCalledOnce())
    stop()
  })

  it('is a no-op on a local daemon (hosted env absent) — never touches the control plane', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const stop = await maybeStartRepoSync({ graph, project: 'default', env: {}, fetchImpl })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(typeof stop).toBe('function')
    stop()
  })
})
