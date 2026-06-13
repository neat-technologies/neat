import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, screen } from '@testing-library/react'

// ADR-096 §5 — one daemon, one project. The dashboard resolves the project the
// daemon serves and shows it; there is no local cross-project switcher. This
// test pins down that resolution lands every consumer on the daemon's single
// project, and that no switcher control is rendered.

// GraphCanvas, Inspector, StatusBar, and Rail each dynamic-import or render
// libraries (cytoscape, eventsource polyfills) that don't run cleanly under
// jsdom. We stub them with project-aware fetchers so the test observes each
// consumer's "did I fetch against the resolved project?" behavior.
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
vi.mock('../app/components/Rail', () => ({
  Rail: ({ project }: { project: string | null }) => {
    if (project) fetch(`/api/policies/violations?project=${encodeURIComponent(project)}`)
    return <div data-testid="rail" data-project={project ?? ''} />
  },
}))
vi.mock('../app/components/Toaster', () => ({ Toaster: () => null }))
vi.mock('../app/components/DebugPanel', () => ({ DebugPanel: () => null }))

import { AppShell } from '../app/components/AppShell'

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

describe('ADR-096 §5 — the dashboard shows the daemon\'s single project', () => {
  const fetchCalls: string[] = []

  beforeEach(() => {
    fetchCalls.length = 0
    // No ?project= read anymore — resolution comes only from the daemon's
    // /projects, which on a per-project daemon returns its one project.
    window.history.replaceState({}, '', '/')

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        fetchCalls.push(url)
        if (url.includes('/api/projects')) {
          return jsonResponse({ body: [{ name: 'alpha', status: 'active' }] })
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

  it('resolves the daemon project from /projects and every consumer fetches against it', async () => {
    render(<AppShell />)

    await waitFor(() => {
      expect(fetchCalls.some((u) => u.includes('project=alpha'))).toBe(true)
    })

    const consumers = new Set(
      fetchCalls.filter((u) => u.includes('project=alpha')).map((u) => u.split('?')[0]),
    )
    expect(consumers.size).toBeGreaterThanOrEqual(3)
    // Never the made-up 'default' project (#461).
    expect(fetchCalls.filter((u) => u.includes('project=default'))).toEqual([])
  })

  it('renders no cross-project switcher — the project is a static breadcrumb', async () => {
    render(<AppShell />)
    await waitFor(() => {
      expect(fetchCalls.some((u) => u.includes('/api/projects'))).toBe(true)
    })
    // The old switcher button announced "Active project: … Click to switch."
    expect(screen.queryByLabelText(/click to switch/i)).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
