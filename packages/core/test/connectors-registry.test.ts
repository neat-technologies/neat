import { describe, it, expect, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import {
  PROVIDER_DISPATCH,
  buildRegistration,
  getProviderDispatch,
  loadConnectorRegistrations,
} from '../src/connectors/registry.js'
import { connectorsConfigPath, type ConnectorEntry } from '../src/connectors-config.js'

// docs/contracts/connector-config.md §5 — the dispatch table is the one place
// a provider registers and the seam that normalizes the shipped factories'
// mismatched signatures into one ConnectorRegistration.

function freshGraph(): NeatGraph {
  return new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
}

const tmpDirs: string[] = []
async function makeHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-connectors-reg-'))
  const real = await fs.realpath(dir)
  tmpDirs.push(real)
  return real
}
afterEach(async () => {
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
  }
})

// One valid entry + a matching env per built provider. The options match each
// provider's own config shape (SupabaseConnectorConfig, RailwayConnectorConfig,
// FirebaseServiceMap, CloudflareConnectorConfig).
const validCases: Array<{
  provider: string
  entry: ConnectorEntry
  env: NodeJS.ProcessEnv
  credentialKey: string
  secret: string
}> = [
  {
    provider: 'supabase',
    secret: 'sbp_mgmt_token',
    credentialKey: 'managementToken',
    env: { SUPABASE_MGMT: 'sbp_mgmt_token' },
    entry: {
      id: 'supabase-prod',
      provider: 'supabase',
      credential: '$SUPABASE_MGMT',
      options: { apiProjectRef: 'abcdefghijklmnopqrst', nodeRef: 'x.supabase.co', serviceName: 'api' },
    },
  },
  {
    provider: 'railway',
    secret: 'railway_pat',
    credentialKey: 'token',
    env: { RAILWAY_TOKEN: 'railway_pat' },
    entry: {
      id: 'railway-prod',
      provider: 'railway',
      credential: '$RAILWAY_TOKEN',
      options: { environmentId: 'env-1', serviceId: 'svc-1', serviceNameById: { 'svc-1': 'api' } },
    },
  },
  {
    provider: 'firebase',
    secret: 'ya29.access_token',
    credentialKey: 'accessToken',
    env: { FB_PROJECT: 'my-app', FB_TOKEN: 'ya29.access_token' },
    entry: {
      id: 'firebase-prod',
      provider: 'firebase',
      credential: { projectId: '$FB_PROJECT', accessToken: '$FB_TOKEN' },
      options: { functions: { myFn: 'api' } },
    },
  },
  {
    provider: 'cloudflare',
    secret: 'cf_api_token',
    credentialKey: 'apiToken',
    env: { CF_TOKEN: 'cf_api_token' },
    entry: {
      id: 'cloudflare-prod',
      provider: 'cloudflare',
      credential: '$CF_TOKEN',
      options: {
        accountId: 'acct-123',
        workers: { 'my-worker': { service: 'api', entryFile: 'src/index.ts' } },
      },
    },
  },
]

describe('PROVIDER_DISPATCH table', () => {
  it('registers every built provider', () => {
    expect(Object.keys(PROVIDER_DISPATCH).sort()).toEqual([
      'cloudflare',
      'firebase',
      'railway',
      'supabase',
    ])
  })

  it('getProviderDispatch resolves a known provider and misses an unknown one', () => {
    expect(getProviderDispatch('supabase')?.provider).toBe('supabase')
    expect(getProviderDispatch('vercel')).toBeUndefined()
  })

  // CF-1 (live-verified): a Workers connector token is account-scoped, and
  // `GET /user/tokens/verify` returns 401 for it while
  // `GET /accounts/{id}/tokens/verify` returns 200. Validate must probe the
  // account-scoped endpoint or it falsely rejects working tokens on `add`.
  it('cloudflare validate probes the account-scoped token-verify endpoint, not /user', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url))
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ success: true }) } as Response
    }) as unknown as typeof fetch
    const result = await PROVIDER_DISPATCH.cloudflare!.validate({
      credentials: { apiToken: 'cf-token' },
      options: { accountId: 'acc123' },
      fetchImpl,
    })
    expect(result).toEqual({ ok: true })
    expect(urls[0]).toContain('/accounts/acc123/tokens/verify')
    expect(urls[0]).not.toContain('/user/tokens/verify')
  })
})

describe('buildRegistration normalizes each provider into one registration shape', () => {
  it.each(validCases)('$provider → a valid ConnectorRegistration', ({ entry, env, credentialKey, secret, provider }) => {
    const result = buildRegistration(entry, freshGraph(), env)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const reg = result.registration
    expect(reg.connector.provider).toBe(provider)
    expect(typeof reg.resolveTarget).toBe('function')
    // The resolved secret lives on the registration's credentials record,
    // under the key that provider's poll() reads it from — and nowhere else.
    expect(reg.credentials[credentialKey]).toBe(secret)
  })

  it('firebase carries both resolved credential fields', () => {
    const fb = validCases.find((c) => c.provider === 'firebase')!
    const result = buildRegistration(fb.entry, freshGraph(), fb.env)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.registration.credentials).toEqual({
      projectId: 'my-app',
      accessToken: 'ya29.access_token',
    })
  })

  it('carries intervalMs through from options when set', () => {
    const entry: ConnectorEntry = {
      id: 'cf',
      provider: 'cloudflare',
      credential: '$CF_TOKEN',
      options: { accountId: 'a', workers: {}, intervalMs: 15000 },
    }
    const result = buildRegistration(entry, freshGraph(), { CF_TOKEN: 't' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.registration.intervalMs).toBe(15000)
  })
})

describe('buildRegistration skips a bad entry rather than throwing', () => {
  it('unknown provider', () => {
    const result = buildRegistration(
      { id: 'x', provider: 'notaprovider', credential: '$K' },
      freshGraph(),
      { K: 'v' },
    )
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('unknown provider') })
  })

  it('unset env-ref names the variable', () => {
    const result = buildRegistration(
      {
        id: 'x',
        provider: 'railway',
        credential: '$RAILWAY_TOKEN',
        options: { environmentId: 'e', serviceId: 's', serviceNameById: { s: 'api' } },
      },
      freshGraph(),
      {},
    )
    expect(result).toEqual({ ok: false, reason: '$RAILWAY_TOKEN is unset' })
  })

  it('missing required option field', () => {
    const result = buildRegistration(
      {
        id: 'x',
        provider: 'supabase',
        credential: '$SB',
        options: { apiProjectRef: 'abcdefghijklmnopqrst', serviceName: 'api' }, // nodeRef missing
      },
      freshGraph(),
      { SB: 'tok' },
    )
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('options missing required field(s): nodeRef'),
    })
  })

  it('firebase with a single-string credential misses the projectId field', () => {
    const result = buildRegistration(
      { id: 'x', provider: 'firebase', credential: '$FB_TOKEN', options: {} },
      freshGraph(),
      { FB_TOKEN: 'ya29.tok' },
    )
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('credential missing required field(s): projectId'),
    })
  })
})

describe('loadConnectorRegistrations reads the file and builds project-matched entries', () => {
  async function writeConfig(home: string, entries: ConnectorEntry[]): Promise<void> {
    await fs.writeFile(connectorsConfigPath(home), JSON.stringify({ version: 1, connectors: entries }))
    await fs.chmod(connectorsConfigPath(home), 0o600)
  }

  it('builds only the entries matching the bootstrapping project (plus project-less ones)', async () => {
    const home = await makeHome()
    await writeConfig(home, [
      {
        id: 'cf-brief',
        provider: 'cloudflare',
        project: 'brief',
        credential: '$CF_TOKEN',
        options: { accountId: 'a', workers: {} },
      },
      {
        id: 'rw-other',
        provider: 'railway',
        project: 'newdryve',
        credential: '$RW_TOKEN',
        options: { environmentId: 'e', serviceId: 's', serviceNameById: { s: 'api' } },
      },
      {
        id: 'cf-any',
        provider: 'cloudflare',
        credential: '$CF_TOKEN', // no project → binds to whatever bootstraps
        options: { accountId: 'b', workers: {} },
      },
    ])

    const registrations = await loadConnectorRegistrations({
      project: 'brief',
      graph: freshGraph(),
      home,
      env: { CF_TOKEN: 'cf', RW_TOKEN: 'rw' },
    })
    // cf-brief (project match) + cf-any (project-less) — not rw-other.
    expect(registrations).toHaveLength(2)
    expect(registrations.every((r) => r.connector.provider === 'cloudflare')).toBe(true)
    expect(registrations.every((r) => r.credentials.apiToken === 'cf')).toBe(true)
  })

  it('a missing file yields no registrations and no throw', async () => {
    const home = await makeHome()
    const registrations = await loadConnectorRegistrations({
      project: 'brief',
      graph: freshGraph(),
      home,
    })
    expect(registrations).toEqual([])
  })

  it('a malformed file yields no registrations and one skip callback, not a crash', async () => {
    const home = await makeHome()
    await fs.writeFile(connectorsConfigPath(home), 'not json at all')
    await fs.chmod(connectorsConfigPath(home), 0o600)
    const skips: string[] = []
    const registrations = await loadConnectorRegistrations({
      project: 'brief',
      graph: freshGraph(),
      home,
      onSkip: (_e, reason) => skips.push(reason),
    })
    expect(registrations).toEqual([])
    expect(skips).toHaveLength(1)
    expect(skips[0]).toMatch(/unreadable/)
  })

  it('an unresolvable entry is skipped, a good sibling still loads', async () => {
    const home = await makeHome()
    await writeConfig(home, [
      {
        id: 'good',
        provider: 'cloudflare',
        credential: '$CF_TOKEN',
        options: { accountId: 'a', workers: {} },
      },
      {
        id: 'bad',
        provider: 'railway',
        credential: '$RW_MISSING', // unset
        options: { environmentId: 'e', serviceId: 's', serviceNameById: { s: 'api' } },
      },
    ])
    const skips: Array<{ id: string; reason: string }> = []
    const registrations = await loadConnectorRegistrations({
      project: 'brief',
      graph: freshGraph(),
      home,
      env: { CF_TOKEN: 'cf' },
      onSkip: (e, reason) => skips.push({ id: e.id, reason }),
    })
    expect(registrations).toHaveLength(1)
    expect(registrations[0].connector.provider).toBe('cloudflare')
    expect(skips).toEqual([{ id: 'bad', reason: '$RW_MISSING is unset' }])
  })
})
