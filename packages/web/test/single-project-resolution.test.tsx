import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, screen } from '@testing-library/react'

// ADR-101 — one GUI over many daemons via per-daemon profiles. The dashboard
// resolves the active profile via `resolveProfile` over the daemon-discovery
// enumerator (/api/profiles), confirming reachability before auto-selecting,
// then lands every data-fetching consumer on that profile's label. This test
// pins down that resolution and that the profile switcher renders.

// next/navigation is server-aware; stub it so AppShell's sidebar (which
// routes the Incidents nav item via useRouter().push, #697) can render in
// jsdom without a real Next router context.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}))

// GraphCanvas, Inspector, and StatusBar each dynamic-import or render libraries
// (cytoscape, eventsource polyfills) that don't run cleanly under jsdom. Stub
// them with profile-aware fetchers so the test observes each consumer's "did I
// fetch against the resolved profile?" behavior.
vi.mock('../app/components/GraphCanvas', () => ({
  GraphCanvas: ({ project }: { project: string | null }) => {
    if (project) fetch(`/api/graph?project=${encodeURIComponent(project)}`)
    return <div data-testid="graph-canvas" data-project={project ?? ''} />
  },
}))
vi.mock('../app/components/Inspector', () => ({
  Inspector: ({ project }: { project: string | null }) => {
    if (project) fetch(`/api/graph/node/test?project=${encodeURIComponent(project)}`)
    return <div data-testid="inspector" data-project={project ?? ''} />
  },
}))
vi.mock('../app/components/StatusBar', () => ({
  StatusBar: ({ project }: { project: string | null }) => {
    if (project) fetch(`/api/stale-events?project=${encodeURIComponent(project)}`)
    return <div data-testid="statusbar" data-project={project ?? ''} />
  },
}))
vi.mock('../app/components/Toaster', () => ({ Toaster: () => null }))
vi.mock('../app/components/DebugPanel', () => ({ DebugPanel: () => null }))

import { AppShell, resolveProfile } from '../app/components/AppShell'

interface MockResponseInit {
  status?: number
  body?: unknown
}
function jsonResponse({ status = 200, body = {} }: MockResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('ADR-101 — the dashboard resolves the active per-daemon profile', () => {
  const fetchCalls: string[] = []

  beforeEach(() => {
    fetchCalls.length = 0
    // AppShell's auth gate assigns `window.location.href` on an unauthenticated
    // redirect; jsdom's real Location doesn't implement navigation, so — same
    // as test/auth-gate-bare-root.test.tsx — swap in a writable stub.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/', search: '', href: 'http://localhost/' },
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        fetchCalls.push(url)
        if (url.includes('/api/profiles')) {
          return jsonResponse({
            body: [{ project: 'alpha', endpoint: 'http://127.0.0.1:8080', status: 'running' }],
          })
        }
        if (url.includes('/api/health')) {
          return jsonResponse({ body: { ok: true } })
        }
        return jsonResponse({ body: {} })
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // resolveProfile is the shared selector (lib/resolve-project.ts).
  it('resolveProfile auto-selects the single running, reachable daemon', async () => {
    const profiles = [
      { project: 'alpha', endpoint: 'http://127.0.0.1:8080', status: 'running' as const },
    ]
    const resolved = await resolveProfile(profiles, async () => true)
    expect(resolved?.project).toBe('alpha')
  })

  it('resolves the daemon from discovery and every consumer fetches against it', async () => {
    render(<AppShell />)

    await waitFor(() => {
      expect(fetchCalls.some((u) => u.includes('project=alpha'))).toBe(true)
    })

    const consumers = new Set(
      fetchCalls.filter((u) => u.includes('project=alpha')).map((u) => u.split('?')[0]),
    )
    expect(consumers.size).toBeGreaterThanOrEqual(2)
    // Never the made-up 'default' project (#461).
    expect(fetchCalls.filter((u) => u.includes('project=default'))).toEqual([])
  })

  it('renders the per-daemon profile switcher carrying the active label', async () => {
    render(<AppShell />)
    await waitFor(() => {
      expect(fetchCalls.some((u) => u.includes('/api/profiles'))).toBe(true)
    })
    // The switcher trigger surfaces the active profile's label once resolved.
    await waitFor(() => {
      expect(screen.getByLabelText(/Profile: alpha/i)).toBeTruthy()
    })
  })
})
