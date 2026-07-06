import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'

// ADR-101 — AppShell resolves the active per-daemon profile from discovery
// (/api/profiles), confirming reachability before auto-selecting so a stale
// `running` record never cold-opens onto a dead endpoint (#419). The resolver
// is a pure function of (list, probe, preferredName) — tested directly here.

import { resolveProfile, type Profile } from '../app/components/AppShell'

const reachable = async () => true
const unreachable = async () => false
function p(project: string, status: 'running' | 'stopped' = 'running'): Profile {
  return { project, endpoint: 'http://127.0.0.1:8080', status }
}

describe('#419 — resolveProfile (the resolution selector, tested directly)', () => {
  it('skips a stopped daemon ordered first and picks the running, reachable one', async () => {
    expect(
      await resolveProfile([p('dead', 'stopped'), p('live', 'running')], reachable),
    ).toEqual(p('live'))
  })

  it('never auto-selects an unreachable daemon, even when its record says running', async () => {
    // The discovery file is a hint; reachability is the real signal (#419).
    expect(await resolveProfile([p('ghost', 'running')], unreachable)).toBe(null)
  })

  it('resolves a single running, reachable daemon to it, not to default', async () => {
    expect(await resolveProfile([p('medusa', 'running')], reachable)).toEqual(p('medusa'))
  })

  it('honors a preferred name (URL/localStorage label) when that profile is reachable', async () => {
    expect(await resolveProfile([p('alpha'), p('beta')], reachable, 'beta')).toEqual(p('beta'))
  })

  it('resolves a stored name with no reachable daemon to null, not an error (§2.4)', async () => {
    expect(await resolveProfile([p('alpha')], unreachable, 'alpha')).toBe(null)
    // A stored name with no matching daemon at all also resolves to null.
    expect(await resolveProfile([p('alpha')], reachable, 'gone')).toBe(null)
  })

  it('resolves empty discovery to null, never to a made-up name (#461)', async () => {
    expect(await resolveProfile([], reachable)).toBe(null)
  })
})

// next/navigation is server-aware; stub it so AppShell's sidebar (which
// routes the Incidents nav item via useRouter().push, #697) can render in
// jsdom without a real Next router context.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}))

// Stub the heavy data-fetching children so AppShell renders under jsdom; the
// canvas echoes the project it was handed onto a /api fetch so we can read
// resolution. The stub mirrors the real #461 gate: a null project fires nothing.
vi.mock('../app/components/GraphCanvas', () => ({
  GraphCanvas: ({ project }: { project: string | null }) => {
    if (project) fetch(`/api/graph?project=${encodeURIComponent(project)}`)
    return <div data-testid="graph-canvas" data-project={project ?? ''} />
  },
}))
vi.mock('../app/components/Inspector', () => ({ Inspector: () => null }))
vi.mock('../app/components/StatusBar', () => ({ StatusBar: () => null }))
vi.mock('../app/components/TopBar', () => ({ TopBar: () => null }))
vi.mock('../app/components/Toaster', () => ({ Toaster: () => null }))
vi.mock('../app/components/DebugPanel', () => ({ DebugPanel: () => null }))

import { AppShell } from '../app/components/AppShell'

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
  } as Storage
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('#419 — AppShell resolves to a reachable daemon end to end', () => {
  const fetchCalls: string[] = []

  beforeEach(() => {
    fetchCalls.length = 0
    // No URL or localStorage project, so resolution falls to daemon discovery.
    window.history.replaceState({}, '', '/')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: makeStorage(),
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        fetchCalls.push(url)
        if (url.includes('/api/profiles')) {
          return jsonResponse([
            { project: 'stopped-one', endpoint: 'http://127.0.0.1:9090', status: 'stopped' },
            { project: 'live', endpoint: 'http://127.0.0.1:8080', status: 'running' },
          ])
        }
        if (url.includes('/api/health')) {
          return jsonResponse({ ok: true })
        }
        return jsonResponse({})
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('lands the graph on the running, reachable daemon — never the stopped one', async () => {
    render(<AppShell />)
    await waitFor(() => {
      expect(fetchCalls.some((u) => u.includes('/api/graph?project=live'))).toBe(true)
    })
    expect(fetchCalls.some((u) => u.includes('project=stopped-one'))).toBe(false)
    expect(fetchCalls.filter((u) => u.includes('project=default'))).toEqual([])
  })

  it('cold load fires no project=default request and fetches the graph exactly once', async () => {
    render(<AppShell />)
    await waitFor(() => {
      expect(fetchCalls.some((u) => u.includes('project=live'))).toBe(true)
    })
    expect(fetchCalls.filter((u) => u.includes('project=default'))).toEqual([])
    expect(fetchCalls.filter((u) => u.startsWith('/api/graph'))).toEqual([
      '/api/graph?project=live',
    ])
  })

  it('cold load against empty discovery fires no project-scoped graph requests', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push(url)
      if (url.includes('/api/profiles')) return jsonResponse([])
      return jsonResponse({})
    })
    render(<AppShell />)
    await waitFor(() => {
      expect(fetchCalls.some((u) => u.includes('/api/profiles'))).toBe(true)
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchCalls.filter((u) => u.startsWith('/api/graph'))).toEqual([])
  })
})
