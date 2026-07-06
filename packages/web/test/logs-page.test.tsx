import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// docs/contracts/logs.md, ADR-132 — the Logs page reads GET /logs (proxied at
// /api/logs) and its source filter chips set the same `source` query param
// MCP's get_logs and the CLI's neat logs use. Mirrors the state-machine
// coverage cold-load-gating.test.tsx applies to IncidentsClient: idle while
// unresolved, loading, populated, empty, and error.

import { LogsPage } from '../app/components/LogsPage'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const SAMPLE_LOGS = {
  count: 2,
  total: 2,
  logs: [
    {
      id: 'log-a',
      projectName: 'alpha',
      source: 'native',
      serviceName: 'checkout',
      timestamp: new Date('2026-01-01T00:00:00Z').toISOString(),
      severity: 'error',
      message: 'connection refused',
    },
    {
      id: 'log-b',
      projectName: 'alpha',
      source: 'supabase',
      serviceName: 'auth',
      timestamp: new Date('2026-01-01T00:01:00Z').toISOString(),
      severity: 'info',
      message: 'row read ok',
    },
  ],
}

describe('LogsPage', () => {
  const fetchCalls: string[] = []

  beforeEach(() => {
    fetchCalls.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        fetchCalls.push(url)
        if (url.includes('/api/logs')) return jsonResponse(SAMPLE_LOGS)
        return jsonResponse({})
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('fires nothing while project is null (#461 gate)', async () => {
    render(<LogsPage project={null} />)
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchCalls).toEqual([])
    expect(screen.getByText('no project registered')).toBeInTheDocument()
  })

  it('fetches /api/logs once a project resolves and renders the rows', async () => {
    render(<LogsPage project="alpha" />)
    await waitFor(() => {
      expect(fetchCalls.some((u) => u.includes('/api/logs?project=alpha&limit=200'))).toBe(true)
    })
    await waitFor(() => {
      expect(screen.getByText('connection refused')).toBeInTheDocument()
      expect(screen.getByText('row read ok')).toBeInTheDocument()
    })
  })

  it('clicking a source chip sets the same `source` query param the REST/MCP/CLI surfaces share', async () => {
    const user = userEvent.setup()
    render(<LogsPage project="alpha" />)
    await waitFor(() => {
      expect(fetchCalls.some((u) => u.includes('/api/logs?project=alpha&limit=200'))).toBe(true)
    })

    await user.click(screen.getByRole('button', { name: 'Supabase' }))

    await waitFor(() => {
      expect(fetchCalls.some((u) => u.includes('source=supabase'))).toBe(true)
    })
    // toggling back off drops the param again
    await user.click(screen.getByRole('button', { name: 'Supabase' }))
    await waitFor(() => {
      const last = fetchCalls[fetchCalls.length - 1]
      expect(last.includes('source=supabase')).toBe(false)
    })
  })

  it('shows the empty state when the daemon returns no logs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ count: 0, total: 0, logs: [] })),
    )
    render(<LogsPage project="alpha" />)
    await waitFor(() => {
      expect(screen.getByText('no logs recorded')).toBeInTheDocument()
    })
  })

  it('shows an error state when the daemon is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    render(<LogsPage project="alpha" />)
    await waitFor(() => {
      expect(screen.getByText(/failed to load/)).toBeInTheDocument()
    })
  })
})
