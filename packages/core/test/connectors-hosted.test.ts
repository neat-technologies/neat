import { describe, it, expect, vi } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode } from '@neat.is/types'
import {
  startConnectorPollLoop,
  type ConnectorContext,
  type ObservedConnector,
  type ObservedSignal,
  type ResolveConnectorTarget,
} from '../src/connectors/index.js'
import {
  createHostedCredentialSource,
  maybeStartHostedConnectors,
  startHostedConnectors,
  type HostedConnectorDeps,
} from '../src/connectors/hosted.js'
import type { NeatGraph } from '../src/graph.js'

const flush = () => new Promise((r) => setTimeout(r, 5))
const newGraph = (): NeatGraph => new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
const nullResolve: ResolveConnectorTarget = () => null

// A fake connector that records the credentials each poll() was handed — enough to prove the loop refreshed
// them, without any real provider call.
class RecordingConnector implements ObservedConnector {
  readonly provider = 'fake'
  readonly seen: Record<string, unknown>[] = []
  async poll(ctx: ConnectorContext): Promise<ObservedSignal[]> {
    this.seen.push(ctx.credentials)
    return []
  }
}

const deps = (fetchImpl: typeof fetch): HostedConnectorDeps => ({
  cpUrl: 'https://cp.example',
  projectId: 'prj_1',
  daemonToken: 'daemon-auth-token',
  fetchImpl,
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe('startConnectorPollLoop — refreshCredentials seam (hosted profile)', () => {
  it('polls with the freshly-resolved credential, not the static ctx.credentials', async () => {
    const connector = new RecordingConnector()
    const stop = startConnectorPollLoop(
      connector,
      { projectDir: '/repo', credentials: { stale: true } },
      newGraph(),
      nullResolve,
      { intervalMs: 3_600_000, refreshCredentials: async () => ({ managementToken: 'fresh-token' }) },
    )
    await flush()
    stop()
    expect(connector.seen).toEqual([{ managementToken: 'fresh-token' }])
  })

  it('skips the poll when the broker fails — never runs a poll on an absent credential', async () => {
    const connector = new RecordingConnector()
    const onError = vi.fn()
    const stop = startConnectorPollLoop(
      connector,
      { projectDir: '/repo', credentials: {} },
      newGraph(),
      nullResolve,
      {
        intervalMs: 3_600_000,
        onError,
        refreshCredentials: async () => {
          throw new Error('control plane 401')
        },
      },
    )
    await flush()
    stop()
    expect(connector.seen).toHaveLength(0)
    expect(onError).toHaveBeenCalledOnce()
  })

  it('leaves ctx.credentials untouched in the local profile (no refresher)', async () => {
    const connector = new RecordingConnector()
    const stop = startConnectorPollLoop(
      connector,
      { projectDir: '/repo', credentials: { local: 'creds' } },
      newGraph(),
      nullResolve,
      { intervalMs: 3_600_000 },
    )
    await flush()
    stop()
    expect(connector.seen).toEqual([{ local: 'creds' }])
  })
})

describe('createHostedCredentialSource', () => {
  it('maps a Supabase access token to managementToken and caches it until near expiry', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        provider: 'supabase',
        accessToken: 'at1',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ) as unknown as typeof fetch
    const source = createHostedCredentialSource('supabase', deps(fetchImpl))

    expect(await source()).toEqual({ managementToken: 'at1' })
    expect(await source()).toEqual({ managementToken: 'at1' })
    // Cached — the second call didn't hit the control plane again.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce()
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://cp.example/internal/projects/prj_1/connections/supabase/credential')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer daemon-auth-token')
  })

  it('refetches when the cached token is within the refresh skew of expiry', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ provider: 'supabase', accessToken: 'short', expiresAt: new Date(Date.now() + 1_000).toISOString() }),
    ) as unknown as typeof fetch
    const source = createHostedCredentialSource('supabase', deps(fetchImpl))
    await source()
    await source()
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
  })

  it('treats a null expiry (token-paste) as non-expiring and fetches once', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ provider: 'railway', accessToken: 'rw_live', expiresAt: null }),
    ) as unknown as typeof fetch
    const source = createHostedCredentialSource('railway', deps(fetchImpl))
    expect(await source()).toEqual({ token: 'rw_live' })
    await source()
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce()
  })
})

describe('startHostedConnectors — discovery + wiring', () => {
  function cpFetch(connections: unknown): typeof fetch {
    return (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/connections')) return jsonResponse(connections)
      if (u.endsWith('/supabase/credential')) {
        return jsonResponse({
          provider: 'supabase',
          accessToken: 'at1',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
  }

  it('starts one loop for a project-bound Supabase connection and skips the rest', async () => {
    const started: { provider: string; refreshCredentials?: () => Promise<Record<string, unknown>> }[] = []
    const startLoop = ((connector, _ctx, _graph, _resolve, options) => {
      started.push({ provider: connector.provider, refreshCredentials: options?.refreshCredentials })
      return () => {}
    }) as typeof startConnectorPollLoop
    const skips: string[] = []

    const stop = await startHostedConnectors({
      deps: deps(
        cpFetch([
          { provider: 'supabase', projectRef: 'abcdefghijklmnopqrst' },
          { provider: 'railway', needsProjectSelection: true },
          { provider: 'mystery', projectRef: 'x' },
        ]),
      ),
      graph: newGraph(),
      projectDir: '/repo',
      project: 'orders-api',
      onSkip: (provider) => skips.push(provider),
      startLoop,
    })

    expect(started.map((s) => s.provider)).toEqual(['supabase'])
    expect(skips).toContain('railway') // no project picked
    expect(skips).toContain('mystery') // no pull connector

    // The wired credential source pulls a live token from the control plane.
    expect(await started[0]!.refreshCredentials!()).toEqual({ managementToken: 'at1' })
    stop()
  })

  it('starts nothing and reports a skip when the control plane connection list is unreachable', async () => {
    const failing = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    const skips: string[] = []
    const startLoop = vi.fn(() => () => {}) as unknown as typeof startConnectorPollLoop
    const stop = await startHostedConnectors({
      deps: deps(failing),
      graph: newGraph(),
      projectDir: '/repo',
      project: 'orders-api',
      onSkip: (provider) => skips.push(provider),
      startLoop,
    })
    expect((startLoop as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    expect(skips).toEqual(['(all)'])
    stop()
  })
})

describe('maybeStartHostedConnectors — env gate', () => {
  it('is a no-op when the hosted env is absent (local daemon), touching no control plane', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const stop = await maybeStartHostedConnectors({
      graph: newGraph(),
      projectDir: '/repo',
      project: 'orders-api',
      env: {}, // no NEAT_CP_URL / NEAT_CP_PROJECT_ID / NEAT_AUTH_TOKEN
      fetchImpl,
    })
    expect(typeof stop).toBe('function')
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    stop()
  })

  it('starts discovery when the hosted env is present', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([])) as unknown as typeof fetch
    const stop = await maybeStartHostedConnectors({
      graph: newGraph(),
      projectDir: '/repo',
      project: 'orders-api',
      env: { NEAT_CP_URL: 'https://cp.example', NEAT_CP_PROJECT_ID: 'prj_1', NEAT_AUTH_TOKEN: 'daemon-auth-token' },
      fetchImpl,
    })
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce()
    stop()
  })
})
