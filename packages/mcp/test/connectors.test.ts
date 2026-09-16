import { describe, expect, it } from 'vitest'
import { HttpError, type HttpClient } from '../src/client.js'
import {
  createConnectorDeps,
  neatConnect,
  neatConnectionStatus,
  neatDisconnect,
  neatListConnectable,
} from '../src/connectors.js'

interface Call {
  method: string
  path: string
  body?: unknown
}

// A stub CP client. Each route returns the canned value, or — when it returns an
// Error instance — throws it, so a test can drive the HttpError paths.
function stubClient(
  routes: {
    get?: (path: string) => unknown
    post?: (path: string, body: unknown) => unknown
    del?: (path: string) => unknown
  },
  calls: Call[] = [],
): HttpClient {
  return {
    async get<T>(path: string): Promise<T> {
      calls.push({ method: 'GET', path })
      const r = routes.get?.(path)
      if (r instanceof Error) throw r
      return r as T
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      calls.push({ method: 'POST', path, body })
      const r = routes.post?.(path, body)
      if (r instanceof Error) throw r
      return r as T
    },
    async del<T>(path: string): Promise<T> {
      calls.push({ method: 'DELETE', path })
      const r = routes.del?.(path)
      if (r instanceof Error) throw r
      return r as T
    },
  }
}

function text(res: { content: { text: string }[] }): string {
  return res.content.map((c) => c.text).join('\n')
}

describe('connector tools — not configured', () => {
  it('every tool returns a plain not-configured note (not an error) when deps is null', async () => {
    const responses = [
      await neatListConnectable(null),
      await neatConnect(null, { provider: 'supabase', credential: 'x' }),
      await neatConnectionStatus(null),
      await neatDisconnect(null, { provider: 'supabase' }),
    ]
    for (const res of responses) {
      expect(text(res)).toContain("aren't configured")
      expect(res.isError).toBeUndefined()
    }
  })
})

describe('neatListConnectable', () => {
  it('lists connectable providers and hits /me/connectable', async () => {
    const calls: Call[] = []
    const deps = createConnectorDeps(
      stubClient({ get: () => ({ connectable: ['supabase', 'railway'] }) }, calls),
      'prj_1',
    )
    const res = await neatListConnectable(deps)
    expect(text(res)).toContain('supabase')
    expect(text(res)).toContain('railway')
    expect(calls[0]).toEqual({ method: 'GET', path: '/me/connectable' })
  })

  it('reports when nothing is connectable', async () => {
    const deps = createConnectorDeps(stubClient({ get: () => ({ connectable: [] }) }), 'prj_1')
    expect(text(await neatListConnectable(deps))).toContain('No providers')
  })
})

describe('neatConnect', () => {
  it('trims and posts the credential to the project/provider path, reporting the subject', async () => {
    const calls: Call[] = []
    const deps = createConnectorDeps(
      stubClient(
        { post: () => ({ provider: 'supabase', subject: 'Acme Inc', scopes: ['supabase:management'] }) },
        calls,
      ),
      'prj_9',
    )
    const res = await neatConnect(deps, { provider: 'supabase', credential: '  sbp_tok  ' })
    expect(res.isError).toBeUndefined()
    expect(text(res)).toContain('Connected supabase as Acme Inc')
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/me/projects/prj_9/connections/supabase',
      body: { credential: 'sbp_tok' },
    })
  })

  it('never echoes the credential back', async () => {
    const deps = createConnectorDeps(
      stubClient({ post: () => ({ provider: 'supabase', subject: 'Acme' }) }),
      'prj_1',
    )
    const res = await neatConnect(deps, { provider: 'supabase', credential: 'sbp_secret_123' })
    expect(text(res)).not.toContain('sbp_secret_123')
  })

  it('requires a provider and a credential', async () => {
    const deps = createConnectorDeps(stubClient({}), 'prj_1')
    expect((await neatConnect(deps, { provider: '', credential: 'x' })).isError).toBe(true)
    expect((await neatConnect(deps, { provider: 'supabase', credential: '   ' })).isError).toBe(true)
  })

  it('resolves the project from /me when NEAT_CP_PROJECT_ID is unset', async () => {
    const calls: Call[] = []
    const deps = createConnectorDeps(
      stubClient(
        {
          get: (p) => (p === '/me' ? { projects: [{ id: 'prj_sole' }] } : undefined),
          post: () => ({ provider: 'railway', subject: 'dev@x' }),
        },
        calls,
      ),
      undefined,
    )
    const res = await neatConnect(deps, { provider: 'railway', credential: 'rw' })
    expect(res.isError).toBeUndefined()
    expect(calls.map((c) => c.path)).toEqual(['/me', '/me/projects/prj_sole/connections/railway'])
  })

  it('memoizes the resolved project id across calls', async () => {
    const calls: Call[] = []
    const deps = createConnectorDeps(
      stubClient(
        {
          get: (p) => (p === '/me' ? { projects: [{ id: 'p1' }] } : undefined),
          post: () => ({ provider: 'supabase' }),
        },
        calls,
      ),
      undefined,
    )
    await neatConnect(deps, { provider: 'supabase', credential: 'a' })
    await neatConnect(deps, { provider: 'supabase', credential: 'b' })
    expect(calls.filter((c) => c.path === '/me')).toHaveLength(1)
  })

  it('refuses to guess when the account has several projects', async () => {
    const deps = createConnectorDeps(
      stubClient({ get: () => ({ projects: [{ id: 'a' }, { id: 'b' }] }) }),
      undefined,
    )
    const res = await neatConnect(deps, { provider: 'supabase', credential: 'x' })
    expect(text(res)).toContain('NEAT_CP_PROJECT_ID')
  })

  it('surfaces a 401 from the control plane as an error', async () => {
    const deps = createConnectorDeps(
      stubClient({ post: () => new HttpError(401, 'supabase rejected the token') }),
      'prj_1',
    )
    const res = await neatConnect(deps, { provider: 'supabase', credential: 'bad' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('401')
  })

  it('surfaces a 501 as "not connectable yet"', async () => {
    const deps = createConnectorDeps(
      stubClient({ post: () => new HttpError(501, 'provider not connectable by token: gcp') }),
      'prj_1',
    )
    const res = await neatConnect(deps, { provider: 'gcp', credential: 'x' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('not connectable yet')
  })
})

describe('neatConnectionStatus', () => {
  it('lists connections with their status', async () => {
    const deps = createConnectorDeps(
      stubClient({
        get: () => [{ provider: 'supabase', status: 'connecting', accountLabel: 'Acme', connectedAt: 't' }],
      }),
      'prj_1',
    )
    expect(text(await neatConnectionStatus(deps))).toContain('supabase (Acme): connecting')
  })

  it('reports an empty project', async () => {
    const deps = createConnectorDeps(stubClient({ get: () => [] }), 'prj_1')
    expect(text(await neatConnectionStatus(deps))).toContain('No providers are connected')
  })
})

describe('neatDisconnect', () => {
  it('disconnects a provider via DELETE', async () => {
    const calls: Call[] = []
    const deps = createConnectorDeps(stubClient({ del: () => ({ removed: 1 }) }, calls), 'prj_1')
    const res = await neatDisconnect(deps, { provider: 'supabase' })
    expect(text(res)).toContain('Disconnected supabase')
    expect(calls[0]).toEqual({ method: 'DELETE', path: '/me/projects/prj_1/connections/supabase' })
  })

  it('reports nothing to disconnect when none matched', async () => {
    const deps = createConnectorDeps(stubClient({ del: () => ({ removed: 0 }) }), 'prj_1')
    expect(text(await neatDisconnect(deps, { provider: 'supabase' }))).toContain('nothing to disconnect')
  })
})
