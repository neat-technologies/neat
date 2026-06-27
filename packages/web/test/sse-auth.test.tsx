import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ADR-073 §3 — EventSource can't set request headers, so a bearer-protected
// daemon would 401 every SSE stream the dashboard opens. The browser passes the
// token as the `access_token` query param (authedEventSourceUrl) and the
// /api/events route promotes it back to an Authorization header before
// forwarding to the daemon. ADR-101 — the bearer is per-profile (active
// profile), not a single localStorage token.

import { setActiveProfile } from '../lib/active-profile'

describe('authedEventSourceUrl (browser side)', () => {
  afterEach(() => {
    setActiveProfile(null)
  })

  it('appends the active profile token as access_token', async () => {
    setActiveProfile({ project: 'alpha', endpoint: 'http://127.0.0.1:8080', authToken: 'tok-sse' })
    const { authedEventSourceUrl } = await import('../lib/authed-fetch')
    const url = authedEventSourceUrl('/api/events?project=alpha')
    expect(url).toBe('/api/events?project=alpha&access_token=tok-sse')
  })

  it('uses a ? separator when the path has no query string', async () => {
    setActiveProfile({ project: 'alpha', endpoint: 'http://127.0.0.1:8080', authToken: 'tok-sse' })
    const { authedEventSourceUrl } = await import('../lib/authed-fetch')
    expect(authedEventSourceUrl('/api/events')).toBe('/api/events?access_token=tok-sse')
  })

  it('url-encodes the token', async () => {
    setActiveProfile({ project: 'alpha', endpoint: 'http://127.0.0.1:8080', authToken: 'a b/c' })
    const { authedEventSourceUrl } = await import('../lib/authed-fetch')
    expect(authedEventSourceUrl('/api/events')).toBe('/api/events?access_token=a%20b%2Fc')
  })

  it('leaves the path unchanged when no token is on the active profile', async () => {
    setActiveProfile({ project: 'alpha', endpoint: 'http://127.0.0.1:8080' })
    const { authedEventSourceUrl } = await import('../lib/authed-fetch')
    expect(authedEventSourceUrl('/api/events?project=alpha')).toBe('/api/events?project=alpha')
  })
})

describe('/api/events route token promotion (server side)', () => {
  let home: string

  beforeEach(() => {
    // A discovered daemon for `alpha` so the route resolves an endpoint and
    // actually forwards upstream (ADR-101 — endpoint comes from discovery).
    home = mkdtempSync(join(tmpdir(), 'neat-sse-'))
    mkdirSync(join(home, 'daemons'), { recursive: true })
    writeFileSync(
      join(home, 'daemons', 'alpha.json'),
      JSON.stringify({
        project: 'alpha',
        projectPath: '/tmp/alpha',
        pid: 1,
        status: 'running',
        ports: { rest: 8080, otlp: 4318, web: 6328 },
        startedAt: new Date().toISOString(),
        neatVersion: '0.0.0',
      }),
    )
    process.env.NEAT_HOME = home
  })

  afterEach(() => {
    delete process.env.NEAT_HOME
    rmSync(home, { recursive: true, force: true })
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  function capturingFetch(): { lastHeaders: () => Headers } {
    let captured: HeadersInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        captured = init?.headers
        // No body → the route's not-ok / no-body branch returns a 200 SSE
        // shell; we only care about the headers it forwarded upstream.
        return new Response(null, { status: 401 })
      }),
    )
    return { lastHeaders: () => new Headers(captured) }
  }

  it('promotes access_token to an Authorization header upstream', async () => {
    const cap = capturingFetch()
    const { GET } = await import('../app/api/events/route')
    const { NextRequest } = await import('next/server')
    const req = new NextRequest('http://localhost/api/events?project=alpha&access_token=tok-sse')
    await GET(req)
    expect(cap.lastHeaders().get('authorization')).toBe('Bearer tok-sse')
  })

  it('prefers a real Authorization header over the query param', async () => {
    const cap = capturingFetch()
    const { GET } = await import('../app/api/events/route')
    const { NextRequest } = await import('next/server')
    const req = new NextRequest('http://localhost/api/events?project=alpha&access_token=qparam', {
      headers: { authorization: 'Bearer header-wins' },
    })
    await GET(req)
    expect(cap.lastHeaders().get('authorization')).toBe('Bearer header-wins')
  })

  it('forwards no Authorization when neither is present', async () => {
    const cap = capturingFetch()
    const { GET } = await import('../app/api/events/route')
    const { NextRequest } = await import('next/server')
    const req = new NextRequest('http://localhost/api/events?project=alpha')
    await GET(req)
    expect(cap.lastHeaders().get('authorization')).toBeNull()
  })
})
