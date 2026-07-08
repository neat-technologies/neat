import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Gate 2 (truthful frontend): the Divergences page is a real in-shell surface
// over `get_divergences`. These tests drive the real component against the real
// FIXTURE_DIVERGENCES so a wire-shape drift or a broken focus-on-row fails here.

import { DivergencesPage } from '../app/components/DivergencesPage'
import { FIXTURE_DIVERGENCES } from '../lib/fixtures'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mockFetch(divergencesBody: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/divergences')) return jsonResponse(divergencesBody)
      return jsonResponse({})
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Divergences page — renders the fixture result and focuses a pair on click', () => {
  beforeEach(() => mockFetch(FIXTURE_DIVERGENCES))

  it('renders a row per divergence with its type, relationship, and confidence', async () => {
    render(<DivergencesPage project="demo" onNodeSelect={vi.fn()} onNavigateGraph={vi.fn()} />)

    // one row per fixture divergence — the missing-observed and host-mismatch.
    for (const d of FIXTURE_DIVERGENCES.divergences) {
      expect(await screen.findByText(d.reason)).toBeInTheDocument()
      // both endpoints render as focus buttons.
      expect(screen.getAllByRole('button', { name: d.source }).length).toBeGreaterThan(0)
    }
    // the type label is spelled out (missing-observed → "missing observed").
    expect(screen.getAllByText('missing observed').length).toBeGreaterThan(0)
  })

  it('clicking an endpoint focuses that node on the graph', async () => {
    const onNodeSelect = vi.fn()
    const onNavigateGraph = vi.fn()
    const user = userEvent.setup()
    render(<DivergencesPage project="demo" onNodeSelect={onNodeSelect} onNavigateGraph={onNavigateGraph} />)

    const first = FIXTURE_DIVERGENCES.divergences[0]
    const btn = await screen.findByRole('button', { name: first.source })
    await user.click(btn)
    expect(onNodeSelect).toHaveBeenCalledWith(first.source)
    expect(onNavigateGraph).toHaveBeenCalled()
  })
})

describe('Divergences page — designed empty state', () => {
  beforeEach(() => mockFetch({ divergences: [], totalAffected: 0, computedAt: new Date().toISOString() }))

  it('shows the fused-picture empty state when nothing diverged', async () => {
    render(<DivergencesPage project="demo" onNodeSelect={vi.fn()} onNavigateGraph={vi.fn()} />)
    expect(await screen.findByText(/Nothing diverged/i)).toBeInTheDocument()
  })
})
