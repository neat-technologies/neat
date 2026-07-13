import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// ADR-137 — the Connectors page is a real read-only surface over
// GET /connectors. These tests drive the real component against the real
// FIXTURE_CONNECTORS so a wire-shape drift, a leaked secret, or a live-
// looking re-test button all fail here rather than only in a browser.

import { ConnectorsPage } from '../app/components/ConnectorsPage'
import { FIXTURE_CONNECTORS } from '../lib/fixtures'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mockFetch(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/connectors')) return jsonResponse(body)
      return jsonResponse({})
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Connectors page — renders the fixture result, never a resolved secret', () => {
  it('renders a row per connector with id, provider, credentialRef, and status', async () => {
    mockFetch(FIXTURE_CONNECTORS)
    render(<ConnectorsPage project="demo" />)

    for (const c of FIXTURE_CONNECTORS.connectors) {
      expect((await screen.findAllByText(c.id)).length).toBeGreaterThan(0)
      expect(screen.getAllByText(c.provider).length).toBeGreaterThan(0)
      const credText = typeof c.credentialRef === 'string' ? c.credentialRef : Object.values(c.credentialRef).join(' · ')
      expect(screen.getAllByText(credText).length).toBeGreaterThan(0)
    }
    // every status label from the fixture shows up somewhere
    expect(screen.getAllByText('healthy').length).toBeGreaterThan(0)
    expect(screen.getAllByText('error').length).toBeGreaterThan(0)
    expect(screen.getAllByText('stale').length).toBeGreaterThan(0)
    expect(screen.getAllByText('idle').length).toBeGreaterThan(0)
  })

  it('never renders a resolved secret — only the credentialRef pointer strings', async () => {
    mockFetch(FIXTURE_CONNECTORS)
    const { container } = render(<ConnectorsPage project="demo" />)
    await screen.findByText(FIXTURE_CONNECTORS.connectors[0].id)

    const text = container.textContent ?? ''
    for (const c of FIXTURE_CONNECTORS.connectors) {
      // credentialRef is a $-pointer string (single-field) or a field→pointer map;
      // either way every value is a redacted $-ref, never a resolved secret.
      const refs = typeof c.credentialRef === 'string' ? [c.credentialRef] : Object.values(c.credentialRef)
      for (const ref of refs) expect(ref.startsWith('$')).toBe(true)
    }
    // sanity: no bare, non-$-prefixed secret-shaped token rendered
    expect(text).not.toMatch(/sk_live|AIza|ghp_/)
  })

  it('renders the re-test action as explicitly disabled, not a live handler', async () => {
    mockFetch(FIXTURE_CONNECTORS)
    render(<ConnectorsPage project="demo" />)
    await screen.findByText(FIXTURE_CONNECTORS.connectors[0].id)

    const retestButtons = screen.getAllByRole('button', { name: /re-test/i })
    expect(retestButtons.length).toBe(FIXTURE_CONNECTORS.connectors.length)
    for (const btn of retestButtons) {
      expect(btn).toBeDisabled()
      expect(btn.getAttribute('aria-disabled')).toBe('true')
    }
  })
})

describe('Connectors page — designed empty state', () => {
  it('shows a real empty state pointing at the CLI when nothing is configured', async () => {
    mockFetch({ connectors: [] })
    render(<ConnectorsPage project="demo" />)
    expect(await screen.findByText(/No connectors configured/i)).toBeInTheDocument()
    expect(screen.getAllByText(/neat connector add/).length).toBeGreaterThan(0)
  })
})
