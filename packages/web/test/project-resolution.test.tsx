import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'

// #419 / ADR-096 §5 — AppShell resolves the daemon's project against GET
// /projects (the daemon serves one project; there's no URL/localStorage read
// and no switcher). Taking list[0] blindly lands on a broken (dead path) or
// paused project, which graphs to nothing and blanks the dashboard. The
// resolver must skip non-active projects.

import { AppShell, resolveProjectFromList } from '../app/components/AppShell'

describe('#419 — resolveProjectFromList (the resolution selector, tested directly)', () => {
  it('skips a broken project ordered first and picks the active one', () => {
    expect(
      resolveProjectFromList([
        { name: 'dead', status: 'broken' },
        { name: 'live', status: 'active' },
      ]),
    ).toBe('live')
  })

  it('skips a paused project ordered first and picks the active one', () => {
    expect(
      resolveProjectFromList([
        { name: 'snoozed', status: 'paused' },
        { name: 'live', status: 'active' },
      ]),
    ).toBe('live')
  })

  it('resolves a single registered project to it, not to default', () => {
    expect(resolveProjectFromList([{ name: 'medusa', status: 'active' }])).toBe('medusa')
  })

  it('falls back to the first available when none are active', () => {
    expect(
      resolveProjectFromList([
        { name: 'dead', status: 'broken' },
        { name: 'snoozed', status: 'paused' },
      ]),
    ).toBe('dead')
  })

  it('treats a missing status as non-active but still resolvable', () => {
    // A registered project with no status string shouldn't be preferred over an
    // explicitly active one...
    expect(
      resolveProjectFromList([{ name: 'unknown' }, { name: 'live', status: 'active' }]),
    ).toBe('live')
    // ...but on its own it still resolves.
    expect(resolveProjectFromList([{ name: 'unknown' }])).toBe('unknown')
  })

  it('resolves an empty list to null, never to a made-up name (#461)', () => {
    // No project named 'default' exists in any registry — inventing one just
    // guarantees a 404 storm across every consumer.
    expect(resolveProjectFromList([])).toBe(null)
  })
})

// Stub the heavy data-fetching children so AppShell renders under jsdom; each
// echoes the project it was handed onto a /api fetch so we can read resolution.
// The stub mirrors the real component's #461 gate: a null project fires nothing.
vi.mock('../app/components/GraphCanvas', () => ({
  GraphCanvas: ({ project }: { project: string | null }) => {
    if (project) fetch(`/api/graph?project=${encodeURIComponent(project)}`)
    return <div data-testid="graph-canvas" data-project={project ?? ''} />
  },
}))
vi.mock('../app/components/Inspector', () => ({ Inspector: () => null }))
vi.mock('../app/components/StatusBar', () => ({ StatusBar: () => null }))
vi.mock('../app/components/Rail', () => ({ Rail: () => null }))
vi.mock('../app/components/TopBar', () => ({ TopBar: () => null }))
vi.mock('../app/components/Toaster', () => ({ Toaster: () => null }))
vi.mock('../app/components/DebugPanel', () => ({ DebugPanel: () => null }))

// jsdom 25's built-in localStorage is flaky under this setup, so we install a
// fresh in-memory shim per test (same pattern as login-surface.test.tsx).
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

describe('#419 — AppShell resolves to a healthy project end to end', () => {
  const fetchCalls: string[] = []

  beforeEach(() => {
    fetchCalls.length = 0
    // No URL or localStorage project, so resolution falls to GET /projects.
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
        if (url.includes('/api/projects')) {
          return jsonResponse([
            { name: 'broken-one', status: 'broken' },
            { name: 'healthy-one', status: 'active' },
          ])
        }
        return jsonResponse({})
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('lands the graph on the active project, never the broken one ordered first', async () => {
    render(<AppShell />)
    await waitFor(() => {
      expect(fetchCalls.some((u) => u.includes('project=healthy-one'))).toBe(true)
    })
    expect(fetchCalls.some((u) => u.includes('project=broken-one'))).toBe(false)
    // ADR-096 §5 — the daemon serves one project; resolution comes only from
    // /projects, not the URL or localStorage, and the shell never persists a
    // switch.
    expect(fetchCalls.filter((u) => u.includes('project=default'))).toEqual([])
  })

  // #461 — the launch-visitor path. A fresh session (no ?project=, empty
  // localStorage) must not fire a single request against the made-up
  // 'default' project while the async /projects resolution is in flight.
  // Before the fix, AppShell initialized project to the literal 'default'
  // and every consumer 404'd on mount, flooding the toaster.
  it('cold load fires zero project=default requests and fetches exactly once, with the resolved project', async () => {
    render(<AppShell />)
    await waitFor(() => {
      expect(fetchCalls.some((u) => u.includes('project=healthy-one'))).toBe(true)
    })
    expect(fetchCalls.filter((u) => u.includes('project=default'))).toEqual([])
    // Exactly one graph fetch — resolution lands, then the request fires.
    // No doomed-placeholder fetch followed by the real one.
    expect(fetchCalls.filter((u) => u.startsWith('/api/graph'))).toEqual([
      '/api/graph?project=healthy-one',
    ])
  })

  it('cold load against an empty registry fires no project-scoped requests at all', async () => {
    // Override the stub: registry knows nothing.
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push(url)
      return jsonResponse([])
    })
    render(<AppShell />)
    await waitFor(() => {
      expect(fetchCalls.some((u) => u.includes('/api/projects'))).toBe(true)
    })
    // Let any stray gated effects flush before asserting silence.
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchCalls.filter((u) => u.includes('project='))).toEqual([])
  })
})
