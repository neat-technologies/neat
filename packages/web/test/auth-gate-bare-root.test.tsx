import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'

// #637 (ADR-073 §3 / ADR-101) — a token-secured daemon, first login done, then a
// bare `/` entry: no `?project=` in the URL, empty `neat:lastProject`. The gate
// has no synchronous profile hint to key `neat:authToken:<name>` off, so it must
// fall to daemon discovery (the same step-3 source the shell resolves through)
// to learn which per-profile token key to read. A single discovered profile with
// a stored bearer means the operator is already authenticated — the gate stays
// put instead of bouncing to /login. It only redirects when a resolvable profile
// genuinely has no stored token (and the daemon is not public-read).

import { useAuthGate } from '../lib/use-auth-gate'
import { setActiveProfile, writeProfileToken } from '../lib/active-profile'
import { resetDaemonAuthConfigForTests } from '../lib/public-read-mode'

function Gated() {
  useAuthGate()
  return <div data-testid="gated" />
}

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

// A writable location stub so the gate can set `href` without jsdom's
// unimplemented-navigation noise; the test reads it back to assert redirects.
let location: { pathname: string; search: string; href: string }

beforeEach(() => {
  resetDaemonAuthConfigForTests()
  setActiveProfile(null)
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: makeStorage(),
  })
  location = { pathname: '/', search: '', href: '' }
  Object.defineProperty(window, 'location', { configurable: true, value: location })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setActiveProfile(null)
})

function stubFetch(opts: { profiles: unknown; publicRead?: boolean }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/profiles')) {
        return new Response(JSON.stringify(opts.profiles), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/api/config')) {
        return new Response(JSON.stringify({ publicRead: opts.publicRead === true, authProxy: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200 })
    }),
  )
}

describe('#637 — auth gate on a bare `/` entry', () => {
  it('stays put when the single discovered profile has a stored token', async () => {
    // The first login wrote the bearer under the profile's per-profile key.
    writeProfileToken('alpha', 'tok-from-first-login')
    stubFetch({ profiles: [{ project: 'alpha', endpoint: 'http://127.0.0.1:8080', status: 'running' }] })

    render(<Gated />)

    // Give the discovery + config chain time to settle, then assert no bounce.
    await waitFor(() => {
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0)
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(location.href).toBe('')
  })

  it('redirects to /login when the single discovered profile has no stored token', async () => {
    stubFetch({ profiles: [{ project: 'alpha', endpoint: 'http://127.0.0.1:8080', status: 'running' }] })

    render(<Gated />)

    await waitFor(() => {
      expect(location.href).toContain('/login')
    })
  })

  it('does not redirect when the daemon is public-read, even with no token', async () => {
    stubFetch({
      profiles: [{ project: 'alpha', endpoint: 'http://127.0.0.1:8080', status: 'running' }],
      publicRead: true,
    })

    render(<Gated />)

    await new Promise((r) => setTimeout(r, 20))
    expect(location.href).toBe('')
  })
})
