import { describe, it, expect, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import {
  exchangeCredential,
  loopbackReceiveToken,
  runSsoLogin,
  resolveCpUrl,
  resolveWebUrl,
} from '../src/login-sso.js'
import { getActiveProfile } from '../src/profiles.js'

// docs/contracts/cli-surface.md §neat login — the hosted "I have a NEAT account"
// path. Exchange a Supabase access token (browser loopback or pasted) for a
// project's daemon credential via GET /me → GET /me/projects/:id/cli-credential,
// write the profile, surface the OTel block. The access token is never persisted.

const tmpDirs: string[] = []

async function makeHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-sso-'))
  const real = await fs.realpath(dir)
  tmpDirs.push(real)
  return real
}

function jsonRes(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
  } as unknown as Response
}

// Routes /me and /cli-credential to configured responses.
function cpFetch(config: {
  me?: { status?: number; body?: unknown }
  cred?: { status?: number; body?: unknown }
}): typeof fetch {
  return (async (url: string) => {
    const u = String(url)
    if (u.endsWith('/me')) return jsonRes(config.me?.status ?? 200, config.me?.body ?? {})
    if (u.includes('/cli-credential')) return jsonRes(config.cred?.status ?? 200, config.cred?.body ?? {})
    return jsonRes(404, {})
  }) as unknown as typeof fetch
}

function capture(): { deps: { out: (l: string) => void; err: (l: string) => void }; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { deps: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err }
}

const CP = 'https://cp.example'
const RUNNING = { id: 'prj_1', name: 'acme', status: 'running' as const }
const CRED = { endpoint: 'https://neat-acme.run.app', authToken: 'dtok', ingestEndpoint: 'https://neat-acme.run.app', otelToken: 'otok' }

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
  }
})

describe('resolveCpUrl / resolveWebUrl', () => {
  it('defaults, honors overrides, strips trailing slash', () => {
    expect(resolveCpUrl({})).toContain('run.app')
    expect(resolveCpUrl({ NEAT_CP_URL: 'https://api.example/' })).toBe('https://api.example')
    expect(resolveCpUrl({}, 'https://flag.example')).toBe('https://flag.example')
    expect(resolveWebUrl({ NEAT_WEB_URL: 'https://gui.example/' })).toBe('https://gui.example')
  })
})

describe('exchangeCredential', () => {
  it('resolves the single running project to its credential', async () => {
    const fetchImpl = cpFetch({ me: { body: { projects: [RUNNING] } }, cred: { body: CRED } })
    const res = await exchangeCredential(CP, 'jwt', {}, { fetchImpl })
    expect('cred' in res && res.cred).toMatchObject({ endpoint: CRED.endpoint, authToken: 'dtok' })
    expect('project' in res && res.project.name).toBe('acme')
  })

  it('errors (create + provision) when the account has no projects', async () => {
    const fetchImpl = cpFetch({ me: { body: { projects: [] } } })
    const res = await exchangeCredential(CP, 'jwt', {}, { fetchImpl })
    expect('error' in res && res.error.message).toMatch(/no running project/)
  })

  it('errors when a project exists but none is running', async () => {
    const fetchImpl = cpFetch({ me: { body: { projects: [{ id: 'p', name: 'x', status: 'provisioning' }] } } })
    const res = await exchangeCredential(CP, 'jwt', {}, { fetchImpl })
    expect('error' in res && res.error.message).toMatch(/no running project/)
  })

  it('asks for --project when several are running', async () => {
    const fetchImpl = cpFetch({
      me: { body: { projects: [RUNNING, { id: 'prj_2', name: 'beta', status: 'running' }] } },
    })
    const res = await exchangeCredential(CP, 'jwt', {}, { fetchImpl })
    expect('error' in res && res.error.code).toBe(2)
    expect('error' in res && res.error.message).toMatch(/--project/)
  })

  it('selects the named project when --project is given', async () => {
    const fetchImpl = cpFetch({
      me: { body: { projects: [RUNNING, { id: 'prj_2', name: 'beta', status: 'running' }] } },
      cred: { body: CRED },
    })
    const res = await exchangeCredential(CP, 'jwt', { project: 'beta' }, { fetchImpl })
    expect('project' in res && res.project.id).toBe('prj_2')
  })

  it('maps a 409 to a not-provisioned error', async () => {
    const fetchImpl = cpFetch({ me: { body: { projects: [RUNNING] } }, cred: { status: 409 } })
    const res = await exchangeCredential(CP, 'jwt', {}, { fetchImpl })
    expect('error' in res && res.error.message).toMatch(/isn't provisioned/)
  })

  it('maps a 401 on /me to a session error', async () => {
    const fetchImpl = cpFetch({ me: { status: 401 } })
    const res = await exchangeCredential(CP, 'jwt', {}, { fetchImpl })
    expect('error' in res && res.error.message).toMatch(/session is expired/)
  })

  it('errors when the credential is missing fields', async () => {
    const fetchImpl = cpFetch({ me: { body: { projects: [RUNNING] } }, cred: { body: { endpoint: 'x' } } })
    const res = await exchangeCredential(CP, 'jwt', {}, { fetchImpl })
    expect('error' in res && res.error.message).toMatch(/missing endpoint\/authToken/)
  })
})

describe('loopbackReceiveToken', () => {
  // A browser stand-in: reads the callback + state out of the auth URL and posts
  // the token back to the loopback, exactly as the bridge page will.
  function autoBrowser(token: string, opts: { badState?: boolean } = {}): (url: string) => boolean {
    return (authUrl: string) => {
      const u = new URL(authUrl)
      const cb = new URL(u.searchParams.get('callback')!)
      cb.searchParams.set('token', token)
      cb.searchParams.set('state', opts.badState ? 'WRONG' : u.searchParams.get('state')!)
      void fetch(cb.toString()).catch(() => {})
      return true
    }
  }

  it('receives the token the browser forwards to the loopback', async () => {
    const res = await loopbackReceiveToken('https://gui.example', { openBrowser: autoBrowser('jwt-abc') }, { timeoutMs: 5000 })
    expect('token' in res && res.token).toBe('jwt-abc')
  })

  it('rejects a state mismatch', async () => {
    const res = await loopbackReceiveToken('https://gui.example', { openBrowser: autoBrowser('jwt-abc', { badState: true }) }, { timeoutMs: 5000 })
    expect('error' in res && res.error.message).toMatch(/invalid or mismatched/)
  })

  it('times out when the browser never answers', async () => {
    const res = await loopbackReceiveToken('https://gui.example', { openBrowser: () => true }, { timeoutMs: 150 })
    expect('error' in res && res.error.message).toMatch(/timed out/)
  })
})

describe('runSsoLogin', () => {
  it('writes the profile and surfaces the OTel block (pasted token path)', async () => {
    const home = await makeHome()
    const { deps, out } = capture()
    const fetchImpl = cpFetch({ me: { body: { projects: [RUNNING] } }, cred: { body: CRED } })
    const code = await runSsoLogin(
      { cpUrl: CP, webUrl: 'https://gui.example', ssoToken: 'jwt', name: 'hosted', json: false },
      { ...deps, fetchImpl, home },
    )
    expect(code).toBe(0)
    expect(await getActiveProfile(home)).toEqual({ name: 'hosted', endpoint: CRED.endpoint, authToken: 'dtok' })
    const printed = out.join('\n')
    expect(printed).toContain('OTEL_EXPORTER_OTLP_ENDPOINT=https://neat-acme.run.app')
    expect(printed).toContain('Authorization=Bearer otok')
  })

  it('surfaces an exchange error with its exit code and writes nothing', async () => {
    const home = await makeHome()
    const { deps } = capture()
    const fetchImpl = cpFetch({ me: { status: 401 } })
    const code = await runSsoLogin(
      { cpUrl: CP, webUrl: 'https://gui.example', ssoToken: 'jwt', name: 'hosted', json: false },
      { ...deps, fetchImpl, home },
    )
    expect(code).toBe(1)
    expect(await getActiveProfile(home)).toBeUndefined()
  })
})
