import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ADR-073 §3 — EventSource can't set request headers, so a bearer-protected
// daemon would 401 every SSE stream the dashboard opens. The browser passes the
// token as the `access_token` query param (authedEventSourceUrl) and the
// /api/events route promotes it back to an Authorization header before
// forwarding to the daemon. These tests cover both ends of that hand-off.

function makeStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, String(v))
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
    clear: () => store.clear(),
  }
}

describe('authedEventSourceUrl (browser side)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('appends the stored token as access_token', async () => {
    window.localStorage.setItem('neat:authToken', 'tok-sse')
    const { authedEventSourceUrl } = await import('../lib/authed-fetch')
    const url = authedEventSourceUrl('/api/events?project=alpha')
    expect(url).toBe('/api/events?project=alpha&access_token=tok-sse')
  })

  it('uses a ? separator when the path has no query string', async () => {
    window.localStorage.setItem('neat:authToken', 'tok-sse')
    const { authedEventSourceUrl } = await import('../lib/authed-fetch')
    expect(authedEventSourceUrl('/api/events')).toBe('/api/events?access_token=tok-sse')
  })

  it('url-encodes the token', async () => {
    window.localStorage.setItem('neat:authToken', 'a b/c')
    const { authedEventSourceUrl } = await import('../lib/authed-fetch')
    expect(authedEventSourceUrl('/api/events')).toBe('/api/events?access_token=a%20b%2Fc')
  })

  it('leaves the path unchanged when no token is stored', async () => {
    const { authedEventSourceUrl } = await import('../lib/authed-fetch')
    expect(authedEventSourceUrl('/api/events?project=alpha')).toBe('/api/events?project=alpha')
  })
})

describe('/api/events route token promotion (server side)', () => {
  afterEach(() => {
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
    const req = new NextRequest('http://localhost/api/events?access_token=qparam', {
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
