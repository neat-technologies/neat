import { describe, expect, it } from 'vitest'
import { runConnectCommand } from '../src/hosted-connect-cli.js'

function collect() {
  const out: string[] = []
  const err: string[] = []
  return { out, err, sink: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } }
}

const creds = { NEAT_CP_URL: 'https://cp.test', NEAT_API_KEY: 'neat_pat_x', NEAT_CP_PROJECT_ID: 'prj_1' }

describe('neat connect (hosted OAuth)', () => {
  it('errors (exit 2) without a hosted login — no api key', async () => {
    const c = collect()
    expect(await runConnectCommand(['supabase'], { env: {}, ...c.sink })).toBe(2)
    expect(c.err.join(' ')).toMatch(/neat login|NEAT_API_KEY/)
  })

  it('prints usage and exits 2 with no provider', async () => {
    const c = collect()
    expect(await runConnectCommand([], { env: creds, ...c.sink })).toBe(2)
    expect(c.out.join(' ')).toMatch(/usage: neat connect/)
  })

  it('reports a provider with no OAuth driver as not available (501)', async () => {
    const c = collect()
    const fetchImpl = (async () => new Response('', { status: 501 })) as unknown as typeof fetch
    expect(await runConnectCommand(['supabase'], { env: creds, fetchImpl, ...c.sink })).toBe(1)
    expect(c.err.join(' ')).toMatch(/isn't available/)
  })

  it('opens the consent URL and returns 0 once the connection lands', async () => {
    const c = collect()
    let opened = ''
    let polls = 0
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/connections/supabase/authorize') && init?.method === 'POST') {
        return new Response(JSON.stringify({ authorizeUrl: 'https://api.supabase.com/v1/oauth/authorize?x=1' }), { status: 200 })
      }
      if (u.endsWith('/connections')) {
        polls++
        const body = polls >= 2 ? [{ provider: 'supabase', status: 'connecting' }] : []
        return new Response(JSON.stringify(body), { status: 200 })
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch

    const code = await runConnectCommand(['supabase'], {
      env: creds,
      fetchImpl,
      openBrowser: (url) => {
        opened = url
        return true
      },
      pollMs: 1,
      timeoutMs: 1000,
      sleepImpl: async () => {},
      ...c.sink,
    })
    expect(code).toBe(0)
    expect(opened).toBe('https://api.supabase.com/v1/oauth/authorize?x=1')
    expect(c.out.join(' ')).toMatch(/connected/)
  })

  it('times out (exit 1) if the connection never lands', async () => {
    const c = collect()
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/authorize') && init?.method === 'POST') {
        return new Response(JSON.stringify({ authorizeUrl: 'https://x' }), { status: 200 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    }) as unknown as typeof fetch
    const code = await runConnectCommand(['supabase'], {
      env: creds,
      fetchImpl,
      openBrowser: () => true,
      pollMs: 1,
      timeoutMs: 5,
      sleepImpl: async () => {},
      ...c.sink,
    })
    expect(code).toBe(1)
    expect(c.err.join(' ')).toMatch(/timed out/)
  })
})
