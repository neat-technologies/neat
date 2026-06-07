import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'

// #461 — consumers handed an unresolved (null) project must stay silent.
// AppShell passes null until the URL → localStorage → /projects chain lands
// on a real name; before this contract every consumer mounted against the
// made-up 'default' project and 404'd, throwing a toast at every fresh
// session. These tests exercise the real components (not the AppShell-level
// stubs in project-resolution.test.tsx) so the gate itself is covered.

import { Rail } from '../app/components/Rail'
import { TopBar } from '../app/components/TopBar'
import { IncidentsClient } from '../app/incidents/IncidentsClient'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('#461 — data-fetching consumers gate on an unresolved project', () => {
  const fetchCalls: string[] = []

  beforeEach(() => {
    fetchCalls.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        fetchCalls.push(url)
        if (url.includes('/api/projects')) {
          return jsonResponse([{ name: 'alpha', status: 'active' }])
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
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchCalls).toEqual([])

    // Resolution lands — same prop transition AppShell performs.
    rerender(<Rail project="alpha" />)
    await waitFor(() => {
      expect(fetchCalls.some((u) => u.includes('/api/policies/violations?project=alpha'))).toBe(true)
      expect(fetchCalls.some((u) => u.includes('/api/incidents?limit=1&project=alpha'))).toBe(true)
    })
    expect(fetchCalls.filter((u) => u.includes('project=default'))).toEqual([])
  })

  it('TopBar lists projects but holds the health probe while project is null', async () => {
    render(
      <TopBar
        project={null}
        onProjectChange={() => {}}
        onNodeSelect={() => {}}
        onRelayout={() => {}}
        onToggleLock={() => {}}
      />,
    )
    // The switcher's /api/projects fetch is not project-scoped and may fire —
    // it's how an unresolved session discovers what exists.
    await waitFor(() => {
      expect(fetchCalls.some((u) => u.includes('/api/projects'))).toBe(true)
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchCalls.filter((u) => u.includes('/api/health'))).toEqual([])
    expect(fetchCalls.filter((u) => u.includes('project='))).toEqual([])
  })

  it('IncidentsClient deep-linked in a fresh session resolves via /projects, never project=default', async () => {
    // No ?project= in the URL, nothing in localStorage — the cold deep-link.
    window.history.replaceState({}, '', '/incidents')
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
