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
  cloneUrl: `https://x-access-token:tok-123@github.com/octo/${over.name ?? 'app'}.git`,
  syncStatus: 'syncing',
  ...over,
})

/** A fetch double that answers the two /internal routes and records every status POST. */
function makeFetch(repos: RepoRow[], opts: { listFails?: boolean } = {}) {
  const statusPosts: Array<{ url: string; body: Record<string, unknown>; auth?: string }> = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization
    if (method === 'GET' && url.endsWith('/repos')) {
      if (opts.listFails) return new Response('boom', { status: 500 })
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
    // extracted the SAME dir into the SAME graph, naming the repo as the source
    // so the retire sweep stays inside it (ADR-233). The clone dir can't be that
    // token: it's mkdtemp'd per pass and removed afterwards, so by the next
    // pass's sweep it doesn't exist.
    expect(extract).toHaveBeenCalledWith(graph, dir, { source: 'octo/app' })
    // reported syncing while it ran, then synced with a lastSyncAt from the injected clock (#1215)
    expect(statusPosts).toHaveLength(2)
    expect(statusPosts[0].body).toEqual({ syncStatus: 'syncing', detail: 'cloning' })
    expect(statusPosts[1].url).toBe('https://cp.example/internal/projects/prj_1/repos/octo/app/status')
    expect(statusPosts[1].body).toEqual({
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
    // syncing first (best-effort), then failed with a token-scrubbed detail (#1215)
    expect(statusPosts).toHaveLength(2)
    expect(statusPosts[0].body.syncStatus).toBe('syncing')
    expect(statusPosts[1].body.syncStatus).toBe('failed')
    const detail = String(statusPosts[1].body.detail)
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

    // a (syncing) + d (absent) only — b (synced) + c (failed) are terminal for a non-boot pass.
    expect(cloneRepo).toHaveBeenCalledTimes(2)
    // Each synced repo posts syncing→terminal now; the distinct repos touched are still just a and d.
    const touched = [...new Set(statusPosts.map((p) => p.url))]
    expect(touched).toEqual([
      'https://cp.example/internal/projects/prj_1/repos/octo/a/status',
      'https://cp.example/internal/projects/prj_1/repos/octo/d/status',
    ])
  })

  it('the boot pass (forceResync) re-extracts a repo the CP still calls synced (#1215)', async () => {
    // The reported bug: a fresh instance reads the CP's `synced` (from a past instance) and skips the repo,
    // so the tenant stays at 0 nodes. The boot pass must clone + extract it anyway.
    const { fetchImpl, statusPosts } = makeFetch([repo({ syncStatus: 'synced' })])
    const cloneRepo = vi.fn<Parameters<CloneRepo>, ReturnType<CloneRepo>>(async () => {})
    const extract = vi.fn(async () => ({ nodesAdded: 5, edgesAdded: 2 }) as never)

    await runRepoSyncPass({ deps: deps(fetchImpl), graph, project: 'default', cloneRepo, extract, forceResync: true })

    expect(cloneRepo).toHaveBeenCalledOnce()
    expect(extract).toHaveBeenCalledOnce()
    expect(statusPosts.at(-1)!.body.syncStatus).toBe('synced')
  })

  it('without forceResync a CP-synced repo is left alone — the steady-state rule still holds', async () => {
    const { fetchImpl, statusPosts } = makeFetch([repo({ syncStatus: 'synced' })])
    const cloneRepo = vi.fn<Parameters<CloneRepo>, ReturnType<CloneRepo>>(async () => {})
    await runRepoSyncPass({ deps: deps(fetchImpl), graph, project: 'default', cloneRepo })
    expect(cloneRepo).not.toHaveBeenCalled()
    expect(statusPosts).toHaveLength(0)
  })

  it('reports whether it reached the CP, so the boot resync can hold open past a list failure (#1215)', async () => {
    const ok = makeFetch([repo({ syncStatus: 'synced' })]).fetchImpl
    expect(
      await runRepoSyncPass({
        deps: deps(ok),
        graph,
        project: 'default',
        cloneRepo: vi.fn<Parameters<CloneRepo>, ReturnType<CloneRepo>>(async () => {}),
        extract: vi.fn(async () => ({}) as never),
        forceResync: true,
      }),
    ).toBe(true)
    const failed = makeFetch([repo()], { listFails: true }).fetchImpl
    expect(await runRepoSyncPass({ deps: deps(failed), graph, project: 'default' })).toBe(false)
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
  it('keeps boot resync pending after a failed clone even when CP changes status to failed', async () => {
    const rows = [repo({ syncStatus: 'synced' })]
    const { fetchImpl } = makeFetch(rows)
    let attempts = 0
    const cloneRepo: CloneRepo = async () => {
      attempts++
      if (attempts === 1) throw new Error('transient clone failure')
    }
    const sync = await startRepoSync({
      deps: deps(fetchImpl),
      graph,
      project: 'default',
      cloneRepo,
      extract: vi.fn(async () => ({}) as never),
      intervalMs: 60_000,
    })
    try {
      await sync.settled()
      rows[0]!.syncStatus = 'failed'
      expect(sync.syncNow().lastPass).toMatchObject({ listed: true, synced: 0, failed: 1 })
      await sync.settled()
      expect(attempts).toBe(2)
      sync.syncNow()
      await sync.settled()
      expect(attempts).toBe(2)
    } finally {
      sync()
    }
  })

  it('a row it does not recognise never holds the boot resync open for the others', async () => {
    const rows = [repo({ syncStatus: 'synced' }), { ...repo({ name: 'web' }), syncStatus: 'paused' }]
    const { fetchImpl } = makeFetch(rows as never)
    const cloneRepo = vi.fn<Parameters<CloneRepo>, ReturnType<CloneRepo>>(async () => {})
    const sync = await startRepoSync({
      deps: deps(fetchImpl),
      graph,
      project: 'default',
      cloneRepo,
      extract: vi.fn(async () => ({}) as never),
      intervalMs: 60_000,
    })
    try {
      await sync.settled()
      for (let pass = 0; pass < 3; pass++) {
        sync.syncNow()
        await sync.settled()
      }
      expect(cloneRepo).toHaveBeenCalledTimes(1)
    } finally {
      sync()
    }
  })

  it('retries a failed clone alone, not every repo', async () => {
    const rows = [repo({ syncStatus: 'synced' }), repo({ name: 'web', syncStatus: 'synced' })]
    const { fetchImpl } = makeFetch(rows)
    const cloned: string[] = []
    const cloneRepo: CloneRepo = async (url) => {
      cloned.push(url.includes('/web.git') ? 'web' : 'app')
      if (url.includes('/web.git')) throw new Error('gone')
    }
    const sync = await startRepoSync({
      deps: deps(fetchImpl),
      graph,
      project: 'default',
      cloneRepo,
      extract: vi.fn(async () => ({}) as never),
      intervalMs: 60_000,
    })
    try {
      await sync.settled()
      sync.syncNow()
      await sync.settled()
      expect(cloned).toEqual(['app', 'web', 'web'])
    } finally {
      sync()
    }
  })

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

  it('is a no-op on a local daemon (hosted env absent) — never touches the control plane', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const stop = await maybeStartRepoSync({ graph, project: 'default', env: {}, fetchImpl })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(typeof stop).toBe('function')
    stop()
  })
})

// #1293 — the loop ran at boot and every five minutes and nothing could ask it to go sooner, so a bind, a
// Resync or a push waited for the timer — or forever on a tenant that had scaled to zero. `syncNow` is the
// trigger the daemon's `repo-sync` route calls.
describe('startRepoSync — syncNow', () => {
  const named = (name: string): RepoRow =>
    repo({ name, cloneUrl: `https://x-access-token:tok-123@github.com/octo/${name}.git` })

  /** A clone that blocks until released, so a test can act while a pass is in flight. */
  function gatedClone() {
    const gates: Array<() => void> = []
    const cloned: string[] = []
    const cloneRepo: CloneRepo = (url) =>
      new Promise<void>((resolve) => {
        cloned.push(url.replace(/^.*github\.com\//, ''))
        gates.push(resolve)
      })
    return { cloneRepo, cloned, releaseNext: () => gates.shift()?.() }
  }
  const listCalls = (fetchImpl: typeof fetch): number =>
    (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      ([url, init]) => String(url).endsWith('/repos') && ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET',
    ).length

  it('starts a pass straight away when none is running, and reports the last one', async () => {
    const { fetchImpl } = makeFetch([repo()])
    const cloneRepo = vi.fn<Parameters<CloneRepo>, ReturnType<CloneRepo>>(async () => {})
    const extract = vi.fn(async () => ({ nodesAdded: 3, edgesAdded: 2 }) as never)
    const sync = await startRepoSync({
      deps: deps(fetchImpl),
      graph,
      project: 'default',
      cloneRepo,
      extract,
      intervalMs: 60_000,
    })
    await sync.settled()
    expect(listCalls(fetchImpl)).toBe(1)

    const res = sync.syncNow()
    expect(res.status).toBe('started')
    expect(res.lastPass).toMatchObject({ listed: true, synced: 1, failed: 0 })
    await sync.settled()
    // The timer is a minute out — the second list read is the trigger's.
    expect(listCalls(fetchImpl)).toBe(2)
    sync()
  })

  it('queues one follow-up behind a running pass, and the follow-up re-reads the list', async () => {
    const repos = [named('first')]
    const { fetchImpl } = makeFetch(repos)
    const { cloneRepo, cloned, releaseNext } = gatedClone()
    const extract = vi.fn(async () => ({}) as never)
    const sync = await startRepoSync({
      deps: deps(fetchImpl),
      graph,
      project: 'default',
      cloneRepo,
      extract,
      intervalMs: 60_000,
    })
    await vi.waitFor(() => expect(cloned).toEqual(['octo/first.git']))

    // A repo is bound while the boot pass is mid-clone. The running pass has already read the list, so it
    // can't see it — joining that pass would miss the repo the request was about.
    repos.push(named('second'))
    expect(sync.syncNow().status).toBe('queued')
    expect(sync.syncNow().status).toBe('queued')
    expect(sync.syncNow().status).toBe('queued')

    // Let each clone through as it comes. The follow-up takes `first` again (the fake control plane still
    // lists it as syncing) and then the repo bound mid-pass.
    const drain = setInterval(releaseNext, 5)
    try {
      await vi.waitFor(() => expect(cloned).toContain('octo/second.git'))
      await sync.settled()
    } finally {
      clearInterval(drain)
    }
    expect(cloned).toEqual(['octo/first.git', 'octo/first.git', 'octo/second.git'])
    // Three requests during one pass made one follow-up, not three.
    expect(listCalls(fetchImpl)).toBe(2)
    sync()
  })

  it('counts a failed repo without stopping the pass', async () => {
    const { fetchImpl } = makeFetch([named('bad'), named('good')])
    const cloneRepo: CloneRepo = async (url) => {
      if (url.includes('/bad.git')) throw new Error('clone refused')
    }
    const sync = await startRepoSync({
      deps: deps(fetchImpl),
      graph,
      project: 'default',
      cloneRepo,
      extract: vi.fn(async () => ({}) as never),
      intervalMs: 60_000,
    })
    await sync.settled()
    expect(sync.syncNow().lastPass).toMatchObject({ listed: true, synced: 1, failed: 1 })
    await sync.settled()
    sync()
  })

  it('has no trigger on a local daemon', async () => {
    const stop = await maybeStartRepoSync({ graph, project: 'default', env: {} })
    expect(stop.syncNow).toBeUndefined()
  })
})
