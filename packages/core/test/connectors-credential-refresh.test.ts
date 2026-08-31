import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { buildRegistration, validateConnectorEntry } from '../src/connectors/registry.js'
import { startConnectorPollLoop } from '../src/connectors/index.js'
import type { ConnectorContext, ObservedConnector, ObservedSignal } from '../src/connectors/types.js'
import { redactCredentialRef, type ConnectorEntry } from '../src/connectors-config.js'

// A real, parseable service-account key JSON — createGcpTokenSource parses it at
// build time but mints no token until the loop calls it, so buildRegistration
// needs a valid key, not a live endpoint.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const KEY_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'neat-reader@neat-demo.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  project_id: 'neat-demo',
})

function freshGraph(): NeatGraph {
  return new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
}

// A gcp-lb entry whose credential is a refreshable gcp-service-account, keyed to
// an env-ref for the durable secret (ADR-223, connector-config.md §9).
function gcpLbRefreshableEntry(): ConnectorEntry {
  return {
    id: 'gcp-lb-prod',
    provider: 'gcp-lb',
    credential: { kind: 'gcp-service-account', keyJson: '$GCP_SA_KEY' },
    options: {},
  }
}

function okTokenFetch(token = 'ya29.tok'): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ access_token: token, token_type: 'Bearer', expires_in: 3600 }),
  }) as Response) as unknown as typeof fetch
}

describe('buildRegistration — a refreshable credential resolves to a source, not a static value (ADR-223)', () => {
  it('routes a gcp-service-account credential to a credentialSource and leaves credentials empty', () => {
    const result = buildRegistration(gcpLbRefreshableEntry(), freshGraph(), { GCP_SA_KEY: KEY_JSON })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(typeof result.registration.credentialSource).toBe('function')
    // The static required-field check is skipped — projectId/accessToken are
    // produced at mint time, not carried statically.
    expect(result.registration.credentials).toEqual({})
    expect(result.registration.connector.provider).toBe('gcp-lb')
  })

  it('skips honestly on an unset key env-ref (distinct from a malformed key)', () => {
    const result = buildRegistration(gcpLbRefreshableEntry(), freshGraph(), {}) // GCP_SA_KEY unset
    expect(result).toEqual({ ok: false, reason: '$GCP_SA_KEY is unset' })
  })

  it('skips honestly on an unknown credential kind, naming the known kinds', () => {
    const entry: ConnectorEntry = {
      id: 'x',
      provider: 'gcp-lb',
      credential: { kind: 'aws-sts', roleArn: '$ROLE' },
      options: {},
    }
    const result = buildRegistration(entry, freshGraph(), { ROLE: 'arn:...' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/unknown credential kind "aws-sts"/)
    expect(result.reason).toMatch(/gcp-service-account/)
  })

  it('a static-credential provider is untouched — no credentialSource', () => {
    const entry: ConnectorEntry = {
      id: 'cf',
      provider: 'cloudflare',
      credential: '$CF_TOKEN',
      options: { accountId: 'acct-1', workers: {} },
    }
    const result = buildRegistration(entry, freshGraph(), { CF_TOKEN: 'tok' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.registration.credentialSource).toBeUndefined()
    expect(result.registration.credentials).toEqual({ apiToken: 'tok' })
  })
})

describe('validateConnectorEntry — a refreshable credential validates by minting a token', () => {
  it('mints once and reports ok', async () => {
    const outcome = await validateConnectorEntry(gcpLbRefreshableEntry(), { GCP_SA_KEY: KEY_JSON }, okTokenFetch())
    expect(outcome).toEqual({ status: 'ok' })
  })

  it('reports rejected when the token endpoint turns the key down', async () => {
    const reject = (async () => ({ ok: false, status: 400, statusText: 'Bad Request', json: async () => ({}) }) as Response) as unknown as typeof fetch
    const outcome = await validateConnectorEntry(gcpLbRefreshableEntry(), { GCP_SA_KEY: KEY_JSON }, reject)
    expect(outcome.status).toBe('rejected')
  })

  it('reports unset-env for an unset key ref, distinct from a rejected key', async () => {
    const outcome = await validateConnectorEntry(gcpLbRefreshableEntry(), {}, okTokenFetch())
    expect(outcome).toEqual({ status: 'unset-env', reason: '$GCP_SA_KEY is unset' })
  })
})

describe('the poll loop mints a fresh credential each tick (the staleness fix)', () => {
  afterEach(() => vi.useRealTimers())

  function recordingConnector(seen: string[]): ObservedConnector {
    return {
      provider: 'fake',
      async poll(ctx: ConnectorContext): Promise<ObservedSignal[]> {
        seen.push(String(ctx.credentials.accessToken))
        return []
      },
    }
  }

  it('a refreshable source is consulted before every tick, so a rotated token reaches poll()', async () => {
    vi.useFakeTimers()
    const seen: string[] = []
    let n = 0
    const credentialSource = async () => ({ projectId: 'p', accessToken: `T${++n}` })
    const ctx: ConnectorContext = { projectDir: '/x', credentials: { accessToken: 'STATIC-NEVER-USED' } }
    const stop = startConnectorPollLoop(recordingConnector(seen), ctx, freshGraph(), () => null, {
      credentialSource,
      intervalMs: 1000,
    })

    await vi.advanceTimersByTimeAsync(0) // immediate tick
    expect(seen).toEqual(['T1'])
    await vi.advanceTimersByTimeAsync(1000) // next interval tick — a fresh mint
    expect(seen).toEqual(['T1', 'T2'])
    stop()
  })

  it('a static-credential loop reuses ctx.credentials unchanged (backward compatible)', async () => {
    vi.useFakeTimers()
    const seen: string[] = []
    const ctx: ConnectorContext = { projectDir: '/x', credentials: { accessToken: 'STATIC' } }
    const stop = startConnectorPollLoop(recordingConnector(seen), ctx, freshGraph(), () => null, { intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual(['STATIC', 'STATIC'])
    stop()
  })
})

describe('redactCredentialRef — a refreshable credential shows its kind, never its secret', () => {
  it('shows kind + scope verbatim and redacts the secret env-ref through the same rule', () => {
    const redacted = redactCredentialRef({
      kind: 'gcp-service-account',
      keyJson: '$GCP_SA_KEY',
      scope: 'https://www.googleapis.com/auth/logging.read',
    })
    expect(redacted).toEqual({
      kind: 'gcp-service-account',
      keyJson: '$GCP_SA_KEY', // an env-ref names the variable, safe to show
      scope: 'https://www.googleapis.com/auth/logging.read',
    })
  })

  it('a plaintext-literal durable secret is masked, while kind stays visible', () => {
    const redacted = redactCredentialRef({ kind: 'gcp-service-account', keyJson: '{"private_key":"..."}' })
    expect(redacted).toEqual({ kind: 'gcp-service-account', keyJson: '****' })
  })
})
