import { describe, it, expect } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode } from '@neat.is/types'
import { buildRegistration, startConnectorPolling, validateConnectorEntry } from '../src/connectors/registry.js'
import type { ConnectorRegistration, ObservedConnector, ResolveConnectorTarget } from '../src/connectors/index.js'
import type { NeatGraph } from '../src/graph.js'

const newGraph = (): NeatGraph => new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
const flush = () => new Promise((r) => setTimeout(r, 5))
const nullResolve: ResolveConnectorTarget = () => null

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const SA_KEY_JSON = JSON.stringify({
  client_email: 'neat-reader@acme.iam.gserviceaccount.com',
  private_key: privateKey,
  project_id: 'acme-prod',
})

describe('refreshable GCP credential — buildRegistration wiring (ADR-230)', () => {
  it('a static GCP credential yields NO refresher — this is the dead-token gap being closed', () => {
    // The pre-fix shape: a pre-minted { projectId, accessToken }. The registration carries a fixed credential
    // and no refresher, so the daemon reuses that one token for its whole life — dead after Google's ~1h.
    const res = buildRegistration(
      { id: 'fb', provider: 'firebase', credential: { projectId: 'acme-prod', accessToken: 'ya29.static' } },
      newGraph(),
      {},
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.registration.refreshCredentials).toBeUndefined()
    expect(res.registration.credentials).toEqual({ projectId: 'acme-prod', accessToken: 'ya29.static' })
  })

  it('a service-account-key GCP credential resolves to a per-tick token source instead', () => {
    const res = buildRegistration(
      { id: 'fb', provider: 'firebase', credential: { serviceAccountKey: SA_KEY_JSON } },
      newGraph(),
      {},
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(typeof res.registration.refreshCredentials).toBe('function')
    // Only the projectId is static; the access token is minted per tick, never stored on the registration.
    expect(res.registration.credentials).toEqual({ projectId: 'acme-prod' })
  })

  it('leaves a non-GCP provider carrying a serviceAccountKey field untouched (no accidental capture)', () => {
    // A serviceAccountKey only means "refreshable" for the GCP connectors; elsewhere it's an ordinary field
    // and the normal required-field check applies.
    const res = buildRegistration(
      { id: 'sb', provider: 'supabase', credential: { serviceAccountKey: SA_KEY_JSON } },
      newGraph(),
      {},
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/required field/)
  })

  it('a malformed service-account key is a skip with a clear reason, never a crash', () => {
    const res = buildRegistration(
      { id: 'fb', provider: 'firebase', credential: { serviceAccountKey: '{not json' } },
      newGraph(),
      {},
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/not valid JSON/)
  })
})

describe('startConnectorPolling — a registration\'s refreshCredentials reaches the loop', () => {
  it('polls with the per-tick minted credential, not a static one', async () => {
    const seen: Record<string, unknown>[] = []
    const connector: ObservedConnector = {
      provider: 'firebase',
      async poll(ctx) {
        seen.push(ctx.credentials)
        return []
      },
    }
    const registration: ConnectorRegistration = {
      id: 'fb',
      connector,
      credentials: { projectId: 'acme-prod' },
      resolveTarget: nullResolve,
      intervalMs: 3_600_000,
      refreshCredentials: async () => ({ projectId: 'acme-prod', accessToken: 'ya29.fresh' }),
    }
    const stop = await startConnectorPolling({
      project: 'p',
      graph: newGraph(),
      projectDir: '/repo',
      extra: [registration],
    })
    await flush()
    stop()
    expect(seen).toEqual([{ projectId: 'acme-prod', accessToken: 'ya29.fresh' }])
  })
})

describe('validateConnectorEntry — minting the token IS the auth probe for a service-account key', () => {
  it('mints, then runs the provider probe with the fresh token → ok', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'ya29.minted', expires_in: 3600 }), { status: 200 })
      }
      // firebase's validate probe (Cloud Logging logs list) — accepts the minted token.
      if (u.startsWith('https://logging.googleapis.com/')) return new Response('{}', { status: 200 })
      return new Response('unexpected', { status: 500 })
    }) as unknown as typeof fetch

    const outcome = await validateConnectorEntry(
      { id: 'fb', provider: 'firebase', credential: { serviceAccountKey: SA_KEY_JSON } },
      {},
      fetchImpl,
    )
    expect(outcome.status).toBe('ok')
  })

  it('rejects a service-account key whose token mint is refused', async () => {
    const fetchImpl = (async () =>
      new Response('invalid_grant', { status: 400, statusText: 'Bad Request' })) as unknown as typeof fetch
    const outcome = await validateConnectorEntry(
      { id: 'fb', provider: 'firebase', credential: { serviceAccountKey: SA_KEY_JSON } },
      {},
      fetchImpl,
    )
    expect(outcome.status).toBe('rejected')
    if (outcome.status !== 'rejected') return
    expect(outcome.reason).toMatch(/gcp token mint failed: 400/)
  })
})
