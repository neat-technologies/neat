import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Gate 2 (truthful frontend) / logs.md — the Logs page is a real in-shell
// surface over GET /logs. These tests drive the real component against the
// real FIXTURE_LOGS so a wire-shape drift or a broken source-filter fails here.

import { LogsPage } from '../app/components/LogsPage'
import { FIXTURE_LOGS } from '../lib/fixtures'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/logs')) {
        const params = new URL(url, 'http://localhost').searchParams
        const source = params.get('source')
        const logs = source ? FIXTURE_LOGS.logs.filter((l) => l.source === source) : FIXTURE_LOGS.logs
        return jsonResponse({ count: logs.length, total: logs.length, logs })
      }
      return jsonResponse({})
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Logs page — renders the fixture result and filters by source', () => {
  it('renders a row per log entry with its source, service, severity, and message', async () => {
    mockFetch()
    render(<LogsPage project="demo" onNodeSelect={vi.fn()} onNavigateGraph={vi.fn()} />)

    for (const l of FIXTURE_LOGS.logs) {
      expect(await screen.findByText(l.message)).toBeInTheDocument()
    }
    expect(screen.getAllByText('Supabase').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Cloudflare').length).toBeGreaterThan(0)
  })

  it('clicking a source chip re-queries GET /logs with that source', async () => {
    mockFetch()
    const user = userEvent.setup()
    render(<LogsPage project="demo" onNodeSelect={vi.fn()} onNavigateGraph={vi.fn()} />)

    await screen.findByText(FIXTURE_LOGS.logs[0].message)

    const chip = screen.getByRole('button', { name: 'Railway' })
    await user.click(chip)

    const railwayEntry = FIXTURE_LOGS.logs.find((l) => l.source === 'railway')
    expect(await screen.findByText(railwayEntry!.message)).toBeInTheDocument()
    const supabaseEntry = FIXTURE_LOGS.logs.find((l) => l.source === 'supabase')
    expect(screen.queryByText(supabaseEntry!.message)).not.toBeInTheDocument()
  })

  it('clicking a log row with a nodeId focuses that node on the graph', async () => {
    mockFetch()
    const onNodeSelect = vi.fn()
    const onNavigateGraph = vi.fn()
    const user = userEvent.setup()
    render(<LogsPage project="demo" onNodeSelect={onNodeSelect} onNavigateGraph={onNavigateGraph} />)

    const withNode = FIXTURE_LOGS.logs.find((l) => l.nodeId)!
    const link = await screen.findByRole('button', { name: withNode.serviceName })
    await user.click(link)
    expect(onNodeSelect).toHaveBeenCalledWith(withNode.nodeId)
    expect(onNavigateGraph).toHaveBeenCalled()
  })
})

describe('Logs page — designed empty state', () => {
  it('shows an empty state when a source has no entries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ count: 0, total: 0, logs: [] })),
    )
    render(<LogsPage project="demo" onNodeSelect={vi.fn()} onNavigateGraph={vi.fn()} />)
    expect(await screen.findByText(/No log entries/i)).toBeInTheDocument()
  })
})
