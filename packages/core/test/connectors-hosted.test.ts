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
  parseFirebaseServiceMap,
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

  it('starts a Railway loop for a picked composite ref, and skips a malformed one', async () => {
    // The picker packs (environmentId, serviceId, serviceName) into projectRef as a base64url composite; the
    // daemon decodes it into the connector's pull options (connectors/railway/target-ref.ts).
    const goodRef = Buffer.from(
      JSON.stringify({ environmentId: 'env_1', serviceId: 'svc_9', serviceName: 'api' }),
    ).toString('base64url')
    const started: string[] = []
    const startLoop = ((connector) => {
      started.push(connector.provider)
      return () => {}
    }) as typeof startConnectorPollLoop
    const skips: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/connections')) {
        return jsonResponse([
          { provider: 'railway', projectRef: goodRef },
          { provider: 'railway', projectRef: 'not-a-real-ref' },
        ])
      }
      if (u.endsWith('/railway/credential')) {
        return jsonResponse({ provider: 'railway', accessToken: 'rw_live', expiresAt: null })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const stop = await startHostedConnectors({
      deps: deps(fetchImpl),
      graph: newGraph(),
      projectDir: '/repo',
      project: 'orders-api',
      onSkip: (provider) => skips.push(provider),
      startLoop,
    })

    // The valid ref decodes into runnable options and starts a loop; the malformed one drops honestly.
    expect(started).toEqual(['railway'])
    expect(skips).toContain('railway')
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

describe('Firebase hosted delivery', () => {
  const future = () => new Date(Date.now() + 3_600_000).toISOString()

  it('maps the delivered gcp token and the picked project ref into the connector credential', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ provider: 'gcp', accessToken: 'ya29.at', expiresAt: future(), projectRef: 'rheoswebapp' }),
    ) as unknown as typeof fetch
    const source = createHostedCredentialSource('gcp', deps(fetchImpl))
    expect(await source()).toEqual({ projectId: 'rheoswebapp', accessToken: 'ya29.at' })
  })

  it('fails the tick when a Firebase credential arrives without a project ref', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ provider: 'gcp', accessToken: 'ya29.at', expiresAt: future() })) as unknown as typeof fetch
    await expect(createHostedCredentialSource('gcp', deps(fetchImpl))()).rejects.toThrow(/project ref/)
  })

  function cpFetch(): typeof fetch {
    return (async (url: string | URL | Request) => {
      if (String(url).endsWith('/connections')) {
        return jsonResponse([{ provider: 'gcp', projectRef: 'rheoswebapp' }])
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
  }

  it('fans a gcp connection out to Firebase, Cloud Run and gcp-lb loops', async () => {
    const started: string[] = []
    const startLoop = ((connector) => {
      started.push(connector.provider)
      return () => {}
    }) as typeof startConnectorPollLoop
    const stop = await startHostedConnectors({
      deps: deps(cpFetch()),
      graph: newGraph(),
      projectDir: '/repo',
      project: 'rheos-backend',
      firebaseServiceMap: { cloudRun: { 'generate-post': 'rheos-backend' } },
      startLoop,
    })
    expect(started).toEqual(['firebase', 'cloud-run', 'gcp-lb'])
    stop()
  })

  it('shares one gcp credential fetch across every connector the connection drives', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      urls.push(String(url))
      if (String(url).endsWith('/connections')) return jsonResponse([{ provider: 'gcp', projectRef: 'rheoswebapp' }])
      return jsonResponse({ provider: 'gcp', accessToken: 'ya29.at', expiresAt: future(), projectRef: 'rheoswebapp' })
    }) as unknown as typeof fetch
    const refreshers: (() => Promise<Record<string, unknown>>)[] = []
    const startLoop = ((_c, _ctx, _g, _r, options) => {
      refreshers.push(options!.refreshCredentials!)
      return () => {}
    }) as typeof startConnectorPollLoop
    await startHostedConnectors({
      deps: deps(fetchImpl),
      graph: newGraph(),
      projectDir: '/repo',
      project: 'rheos-backend',
      firebaseServiceMap: { cloudRun: { 'generate-post': 'rheos-backend' } },
      startLoop,
    })
    expect(refreshers).toHaveLength(3)
    for (const refresh of refreshers) {
      expect(await refresh()).toEqual({ projectId: 'rheoswebapp', accessToken: 'ya29.at' })
    }
    expect(urls).toContain('https://cp.example/internal/projects/prj_1/connections/gcp/credential')
    // Three connectors, one shared source: the control plane is asked once, not three times.
    expect(urls.filter((u) => u.endsWith('/gcp/credential'))).toHaveLength(1)
    expect(urls.some((u) => u.includes('/connections/firebase/'))).toBe(false)
  })

  it('starts Firebase with no service map at all — the mapping is inferred, not configured', async () => {
    const started: string[] = []
    const skips: string[] = []
    const startLoop = ((connector) => {
      started.push(connector.provider)
      return () => {}
    }) as typeof startConnectorPollLoop
    await startHostedConnectors({
      deps: deps(cpFetch()),
      graph: newGraph(),
      projectDir: '/repo',
      project: 'orders-api',
      onSkip: (provider) => skips.push(provider),
      startLoop,
    })
    expect(started).toEqual(['firebase', 'cloud-run', 'gcp-lb'])
    expect(skips).toEqual([])
  })

  describe('parseFirebaseServiceMap', () => {
    it('parses a valid map', () => {
      expect(
        parseFirebaseServiceMap(JSON.stringify({ cloudRun: { a: 'svc-a' }, hosting: { site: 'web' } })),
      ).toEqual({ cloudRun: { a: 'svc-a' }, hosting: { site: 'web' } })
    })

    it.each([
      ['absent', undefined],
      ['empty string', ''],
      ['not JSON', '{nope'],
      ['an array', '[]'],
      ['an empty object', '{}'],
      ['a non-string value', JSON.stringify({ cloudRun: { a: 1 } })],
      ['an empty service name', JSON.stringify({ cloudRun: { a: '' } })],
      ['a non-object group', JSON.stringify({ functions: 'x' })],
    ])('returns undefined for %s', (_label, raw) => {
      expect(parseFirebaseServiceMap(raw as string | undefined)).toBeUndefined()
    })
  })
})
