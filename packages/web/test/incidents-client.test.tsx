import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// #699 — two regressions on the Incidents page:
//  1. FIXTURE_INCIDENTS (demo mode) drifted to a stale nodeId/type/message/
//     stacktrace shape while IncidentsClient reads the canonical ErrorEvent
//     envelope (affectedNode/errorType/errorMessage/exceptionStacktrace),
//     so demo mode rendered undefined cells and a `/?node=undefined` link.
//  2. The stacktrace row only expanded on a `<tr onClick>` with no keyboard
//     path — not reachable via Tab, no Enter/Space affordance.
// These tests exercise the real fixture object against the real component so
// a future shape drift, or a regression back to a click-only row, fails here.

import { IncidentsClient } from '../app/incidents/IncidentsClient'
import { FIXTURE_INCIDENTS } from '../lib/fixtures'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('#699 — Incidents table renders the canonical fixture shape and is keyboard-expandable', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/api/profiles')) {
          return jsonResponse([
            { project: 'demo', endpoint: 'http://127.0.0.1:8080', status: 'running' },
          ])
        }
        if (url.includes('/api/health')) {
          return jsonResponse({ ok: true })
        }
        if (url.includes('/api/incidents')) {
          // The real demo-mode fixture, not a hand-rolled stand-in — this is
          // what ties the test to fixtures.ts actually matching the envelope
          // IncidentsClient expects.
          return jsonResponse(FIXTURE_INCIDENTS)
        }
        return jsonResponse({})
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders every fixture row with real values — no undefined cells, no broken node links', async () => {
    render(<IncidentsClient />)

    const rows = await screen.findAllByRole('row')
    // header row + one row per fixture event.
    expect(rows.length).toBe(FIXTURE_INCIDENTS.events.length + 1)

    for (const evt of FIXTURE_INCIDENTS.events) {
      const link = screen.getByRole('link', { name: evt.affectedNode })
      expect(link).toHaveAttribute('href', `/?node=${encodeURIComponent(evt.affectedNode)}`)
      expect(screen.getByText(evt.errorType as string)).toBeInTheDocument()
      expect(screen.getByText(evt.errorMessage, { exact: false })).toBeInTheDocument()
    }
  })

  it('a stacktrace row expands via keyboard (Enter and Space) and exposes aria-expanded', async () => {
    const user = userEvent.setup()
    render(<IncidentsClient />)

    const withStack = FIXTURE_INCIDENTS.events.find((e) => e.exceptionStacktrace)
    expect(withStack).toBeDefined()

    const toggle = await screen.findByRole('button', { name: 'Expand stacktrace' })
    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // The stacktrace text spans multiple lines; match a single-line marker
    // from it rather than the whole (newline-containing) string, since
    // getByText normalizes whitespace against the query as given.
    const stackMarker = withStack!.exceptionStacktrace!.split('\n')[0]
    expect(screen.queryByText(stackMarker, { exact: false })).not.toBeInTheDocument()

    toggle.focus()
    expect(toggle).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByText(stackMarker, { exact: false })).toBeInTheDocument()

    await user.keyboard(' ')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(stackMarker, { exact: false })).not.toBeInTheDocument()
  })
})

describe('#762 — Incidents shows the shared page-empty voice when a project has zero incidents', () => {
  function stubFetch(incidents: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/api/profiles')) {
          return jsonResponse([
            { project: 'demo', endpoint: 'http://127.0.0.1:8080', status: 'running' },
          ])
        }
        if (url.includes('/api/health')) return jsonResponse({ ok: true })
        if (url.includes('/api/incidents')) return jsonResponse(incidents)
        return jsonResponse({})
      }),
    )
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders the honest empty-state message and no table on an empty payload', async () => {
    stubFetch({ count: 0, total: 0, events: [] })
    render(<IncidentsClient />)

    expect(await screen.findByText(/No incidents yet/i)).toBeInTheDocument()
    // The empty state stands in for the table — not an empty table with a header row.
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('row')).not.toBeInTheDocument()
  })

  it('still renders a row per event when the payload is non-empty', async () => {
    stubFetch({
      count: 1,
      total: 1,
      events: [
        {
          id: 'evt-1',
          timestamp: '2026-07-12T10:00:00.000Z',
          service: 'checkout',
          errorType: 'TimeoutError',
          errorMessage: 'upstream timed out',
          affectedNode: 'svc:checkout',
        },
      ],
    })
    render(<IncidentsClient />)

    expect(await screen.findByRole('link', { name: 'svc:checkout' })).toBeInTheDocument()
    // header row + one data row, and the empty message stays away.
    expect(screen.getAllByRole('row')).toHaveLength(2)
    expect(screen.queryByText(/No incidents yet/i)).not.toBeInTheDocument()
  })
})
