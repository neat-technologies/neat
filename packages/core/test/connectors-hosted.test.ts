import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import {
  getPushProviderDispatch,
  type PushProviderDispatch,
  type ValidateInput,
} from '../src/connectors/registry.js'
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

describe('startHostedConnectors — push providers (a Vercel drain, ADR-146)', () => {
  // The CP reports one Vercel connection whose projectRef is the team the token can act for, and delivers a
  // long-lived (token-paste) credential for it.
  function vercelCpFetch(connections: unknown = [{ provider: 'vercel', projectRef: 'team_abc' }]): typeof fetch {
    return (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/connections')) return jsonResponse(connections)
      if (u.endsWith('/vercel/credential')) {
        return jsonResponse({ provider: 'vercel', accessToken: 'vc_token', expiresAt: null })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
  }

  // A fake push dispatch standing in for PUSH_PROVIDER_DISPATCH.vercel — records what validate/provision
  // were handed, so the hosted path is asserted without a Drains API.
  function fakePush(validation: { ok: true } | { ok: false; reason: string } = { ok: true }) {
    const validate = vi.fn(async () => validation)
    const provision = vi.fn(async () => ({ ok: true as const, options: { drainId: 'drn_1' } }))
    const deprovision = vi.fn(async () => ({ ok: true as const }))
    const dispatch = { validate, provision, deprovision } as unknown as PushProviderDispatch
    const lookup = ((provider: string) => (provider === 'vercel' ? dispatch : undefined)) as typeof getPushProviderDispatch
    return { validate, provision, lookup }
  }

  it('runs validate → provision once with the brokered token, the daemon OTLP bearer, the team id and the public endpoint; a restart re-validates only', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'neat-hosted-push-'))
    const push = fakePush()
    const provisioned: string[] = []
    const startLoop = vi.fn(() => () => {}) as unknown as typeof startConnectorPollLoop
    const run = () =>
      startHostedConnectors({
        deps: { ...deps(vercelCpFetch()), publicUrl: 'https://neat-default.run.app/', otelToken: 'otel-bearer' },
        graph: newGraph(),
        projectDir,
        project: 'orders-api',
        onProvisioned: (provider) => provisioned.push(provider),
        startLoop,
        pushDispatch: push.lookup,
      })

    await run()
    expect(push.validate).toHaveBeenCalledOnce()
    expect(push.provision).toHaveBeenCalledOnce()
    const [call] = push.provision.mock.calls[0] as unknown as [ValidateInput]
    expect(call.credentials).toEqual({ token: 'vc_token', otelToken: 'otel-bearer' })
    expect(call.options).toEqual({ teamId: 'team_abc', endpoint: 'https://neat-default.run.app/v1/traces' })
    // A drain is provisioned, not polled.
    expect(startLoop).not.toHaveBeenCalled()

    // The handle lands beside the snapshot and carries no credential.
    const raw = await readFile(join(projectDir, 'neat-out', 'connectors-hosted.json'), 'utf8')
    expect(JSON.parse(raw).vercel.options).toEqual({ drainId: 'drn_1' })
    expect(raw).not.toContain('vc_token')
    expect(raw).not.toContain('otel-bearer')

    // Restart: delivery is re-validated, no second drain is created.
    await run()
    expect(push.validate).toHaveBeenCalledTimes(2)
    expect(push.provision).toHaveBeenCalledOnce()
    expect(provisioned).toEqual(['vercel', 'vercel'])
  })

  it('skips with the reason when this daemon has no public URL — nothing is validated or provisioned', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'neat-hosted-push-'))
    const push = fakePush()
    const skips: string[] = []
    await startHostedConnectors({
      deps: deps(vercelCpFetch()), // no publicUrl
      graph: newGraph(),
      projectDir,
      project: 'orders-api',
      onSkip: (_provider, reason) => skips.push(reason),
      pushDispatch: push.lookup,
    })
    expect(skips).toEqual(['no public URL for this daemon (NEAT_PUBLIC_URL) — a drain has nowhere to deliver'])
    expect(push.validate).not.toHaveBeenCalled()
    expect(push.provision).not.toHaveBeenCalled()
  })

  it('skips when the CP has not captured a team id — drains are team-scoped', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'neat-hosted-push-'))
    const push = fakePush()
    const skips: string[] = []
    await startHostedConnectors({
      deps: { ...deps(vercelCpFetch([{ provider: 'vercel' }])), publicUrl: 'https://neat-default.run.app' },
      graph: newGraph(),
      projectDir,
      project: 'orders-api',
      onSkip: (_provider, reason) => skips.push(reason),
      pushDispatch: push.lookup,
    })
    expect(skips).toEqual(['no Vercel team selected yet — drains are team-scoped'])
    expect(push.provision).not.toHaveBeenCalled()
  })

  it('does not provision when the delivery test fails, and says why', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'neat-hosted-push-'))
    const push = fakePush({ ok: false, reason: 'vercel rejected the token (401)' })
    const skips: string[] = []
    const provisioned: string[] = []
    await startHostedConnectors({
      deps: { ...deps(vercelCpFetch()), publicUrl: 'https://neat-default.run.app' },
      graph: newGraph(),
      projectDir,
      project: 'orders-api',
      onSkip: (_provider, reason) => skips.push(reason),
      onProvisioned: (provider) => provisioned.push(provider),
      pushDispatch: push.lookup,
    })
    expect(skips).toEqual(['drain delivery test failed — vercel rejected the token (401)'])
    expect(push.provision).not.toHaveBeenCalled()
    expect(provisioned).toEqual([])
  })
})

describe('one grant, several connectors — the GCP fan-out (#1207)', () => {
  const future = () => new Date(Date.now() + 3_600_000).toISOString()

  function gcpFetch(connections: unknown[], credential?: Record<string, unknown>): typeof fetch {
    return (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/connections')) return jsonResponse(connections)
      if (u.endsWith('/gcp/credential')) {
        return jsonResponse(
          credential ?? { provider: 'gcp', accessToken: 'ya29.at', expiresAt: future(), projectRef: 'rheos-prod' },
        )
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
  }

  type Started = { provider: string; connectorId?: string; refresh?: () => Promise<Record<string, unknown>> }

  function recorder(started: Started[]): typeof startConnectorPollLoop {
    return ((connector, _ctx, _graph, _resolve, options) => {
      started.push({
        provider: connector.provider,
        ...(options?.connectorId ? { connectorId: options.connectorId } : {}),
        ...(options?.refreshCredentials ? { refresh: options.refreshCredentials } : {}),
      })
      return () => {}
    }) as typeof startConnectorPollLoop
  }

  const withMap = {
    provider: 'gcp',
    projectRef: 'rheos-prod',
    options: { firebase: { cloudRun: { 'generate-post': 'rheos-backend' } } },
  }

  it('expands one gcp connection into every connector that reads the grant', async () => {
    const started: Started[] = []
    const stop = await startHostedConnectors({
      deps: deps(gcpFetch([withMap])),
      graph: newGraph(),
      projectDir: '/repo',
      project: 'rheos-backend',
      startLoop: recorder(started),
    })
    expect(started.map((s) => s.provider).sort()).toEqual(['cloud-run', 'firebase', 'gcp-lb'])
    stop()
  })

  it('names each loop for its connector, not the grant, so their ticks stay distinct', async () => {
    const started: Started[] = []
    const stop = await startHostedConnectors({
      deps: deps(gcpFetch([withMap])),
      graph: newGraph(),
      projectDir: '/repo',
      project: 'rheos-backend',
      startLoop: recorder(started),
    })
    expect(started.map((s) => s.connectorId).sort()).toEqual([
      'hosted:cloud-run',
      'hosted:firebase',
      'hosted:gcp-lb',
    ])
    stop()
  })

  it('maps the grant to the credential every GCP connector declares', async () => {
    const started: Started[] = []
    const stop = await startHostedConnectors({
      deps: deps(gcpFetch([withMap])),
      graph: newGraph(),
      projectDir: '/repo',
      project: 'rheos-backend',
      startLoop: recorder(started),
    })
    expect(await started[0]!.refresh!()).toEqual({ projectId: 'rheos-prod', accessToken: 'ya29.at' })
    stop()
  })

  it('shares one credential source across the connectors, so the CP is asked once', async () => {
    const started: Started[] = []
    const fetchImpl = vi.fn(gcpFetch([withMap])) as unknown as typeof fetch
    const stop = await startHostedConnectors({
      deps: deps(fetchImpl),
      graph: newGraph(),
      projectDir: '/repo',
      project: 'rheos-backend',
      startLoop: recorder(started),
    })
    // All three hold the same source object rather than one apiece.
    expect(started).toHaveLength(3)
    expect(started[1]!.refresh).toBe(started[0]!.refresh)
    expect(started[2]!.refresh).toBe(started[0]!.refresh)

    // So once one has pulled a live token the others read the cache, not the control plane. A
    // simultaneous first call would still race — the source caches on resolve and doesn't dedupe
    // in-flight requests — but the loops tick on their own schedules and the cache is warm after one.
    for (const s of started) await s.refresh!()
    const credentialCalls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => String(c[0]).endsWith('/gcp/credential'),
    )
    expect(credentialCalls).toHaveLength(1)
    stop()
  })

  it('sits Firebase out for a missing map without holding back its siblings', async () => {
    const started: Started[] = []
    const skips: string[] = []
    const stop = await startHostedConnectors({
      deps: deps(gcpFetch([{ provider: 'gcp', projectRef: 'rheos-prod' }])),
      graph: newGraph(),
      projectDir: '/repo',
      project: 'rheos-backend',
      onSkip: (id) => skips.push(id),
      startLoop: recorder(started),
    })
    expect(started.map((s) => s.provider).sort()).toEqual(['cloud-run', 'gcp-lb'])
    expect(skips).toContain('firebase')
    stop()
  })

  it('treats an empty map as no map', async () => {
    const started: Started[] = []
    const skips: string[] = []
    const stop = await startHostedConnectors({
      deps: deps(gcpFetch([{ provider: 'gcp', projectRef: 'rheos-prod', options: { firebase: {} } }])),
      graph: newGraph(),
      projectDir: '/repo',
      project: 'rheos-backend',
      onSkip: (id) => skips.push(id),
      startLoop: recorder(started),
    })
    expect(started.map((s) => s.provider)).not.toContain('firebase')
    expect(skips).toContain('firebase')
    stop()
  })

  it('fails the tick when the grant arrives without a picked project', async () => {
    const started: Started[] = []
    const stop = await startHostedConnectors({
      deps: deps(
        gcpFetch([withMap], { provider: 'gcp', accessToken: 'ya29.at', expiresAt: future() }),
      ),
      graph: newGraph(),
      projectDir: '/repo',
      project: 'rheos-backend',
      startLoop: recorder(started),
    })
    await expect(started[0]!.refresh!()).rejects.toThrow(/project ref/)
    stop()
  })

  it('leaves a one-to-one provider exactly as it was', async () => {
    const started: Started[] = []
    const skips: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/connections')) return jsonResponse([{ provider: 'mystery', projectRef: 'x' }])
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
    const stop = await startHostedConnectors({
      deps: deps(fetchImpl),
      graph: newGraph(),
      projectDir: '/repo',
      project: 'orders-api',
      onSkip: (id) => skips.push(id),
      startLoop: recorder(started),
    })
    expect(started).toHaveLength(0)
    expect(skips).toContain('mystery')
    stop()
  })
})
