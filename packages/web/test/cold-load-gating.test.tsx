import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'

// #461 — consumers handed an unresolved (null) project must stay silent.
// AppShell passes null until the URL → localStorage → daemon-discovery chain
// (ADR-101) lands on a reachable profile; before this gate every consumer
// mounted against the made-up 'default' project and 404'd. These tests exercise
// the real components (not the AppShell-level stubs) so the gate itself is
// covered.

import { Rail } from '../app/components/Rail'
import { TopBar } from '../app/components/TopBar'
import { IncidentsClient } from '../app/incidents/IncidentsClient'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('#461 — data-fetching consumers gate on an unresolved profile', () => {
  const fetchCalls: string[] = []
  let location: { pathname: string; search: string; href: string }

  beforeEach(() => {
    fetchCalls.length = 0
    // IncidentsClient's auth gate assigns `window.location.href` on an
    // unauthenticated redirect; jsdom's real Location doesn't implement
    // navigation, so — same as test/auth-gate-bare-root.test.tsx — swap in a
    // writable stub. Rail and TopBar don't read it, so this is a no-op there.
    location = { pathname: '/', search: '', href: 'http://localhost/' }
    Object.defineProperty(window, 'location', { configurable: true, value: location })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        fetchCalls.push(url)
        if (url.includes('/api/profiles')) {
          return jsonResponse([
            { project: 'alpha', endpoint: 'http://127.0.0.1:8080', status: 'running' },
          ])
        }
        if (url.includes('/api/health')) {
          return jsonResponse({ ok: true })
        }
        if (url.includes('/api/incidents')) {
          return jsonResponse({ count: 0, total: 0, events: [] })
        }
        return jsonResponse({})
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('Rail fires nothing while project is null, then fetches once it resolves', async () => {
    const { rerender } = render(<Rail project={null} />)
    // Rail renders next/link's <Link>; under jsdom (no IntersectionObserver)
    // it falls back to a requestIdleCallback-scheduled visibility update, which
    // lands during this wait. act() keeps that update from leaking outside a
    // React-tracked scope and tripping the "not wrapped in act(...)" warning.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(fetchCalls).toEqual([])

    // Resolution lands — same prop transition AppShell performs.
    rerender(<Rail project="alpha" />)
    await waitFor(() => {
      expect(fetchCalls.some((u) => u.includes('/api/policies/violations?project=alpha'))).toBe(true)
      expect(fetchCalls.some((u) => u.includes('/api/incidents?limit=1&project=alpha'))).toBe(true)
    })
    expect(fetchCalls.filter((u) => u.includes('project=default'))).toEqual([])
  })

  it('TopBar holds the health probe while project is null', async () => {
    render(
      <TopBar
        project={null}
        profiles={[]}
        onSelectProfile={() => {}}
        onOpenPalette={() => {}}
        pageLabel="graph"
      />,
    )
    // The health dot gates on a resolved profile; an empty switcher with a null
    // active profile fires nothing.
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchCalls.filter((u) => u.includes('/api/health'))).toEqual([])
    expect(fetchCalls.filter((u) => u.includes('project='))).toEqual([])
  })

  it('IncidentsClient deep-linked in a fresh session resolves via discovery, never project=default', async () => {
    // No ?project= in the URL, nothing in localStorage — the cold deep-link.
    location.pathname = '/incidents'
    try {
      window.localStorage.removeItem('neat:lastProject')
    } catch { /* jsdom storage can be flaky; the fetch assertions carry the test */ }

    render(<IncidentsClient />)
    await waitFor(() => {
      expect(fetchCalls.some((u) => u.includes('/api/incidents?limit=100&project=alpha'))).toBe(true)
    })
    expect(fetchCalls.filter((u) => u.includes('project=default'))).toEqual([])
  })
})
