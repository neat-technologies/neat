import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'

// ADR-139 — read-only rendering stays keyed on `publicRead` alone, kept apart
// from the new `requiresAuth` gate. A NEAT_PUBLIC_READ reference deployment
// renders read-only; a tokenless local daemon (requiresAuth:false but
// publicRead:false) is fully writable and must NOT render read-only. This is
// the invariant the rejected "widen publicRead to cover tokenless" stopgap
// would have broken.

import { useReadOnly, resetDaemonAuthConfigForTests } from '../lib/public-read-mode'

function ReadOnlyProbe() {
  const readOnly = useReadOnly()
  return <div data-testid="probe">{readOnly ? 'read-only' : 'writable'}</div>
}

function stubConfig(body: { publicRead?: boolean; authProxy?: boolean; requiresAuth?: boolean }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (!url.includes('/api/config')) {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

beforeEach(() => {
  resetDaemonAuthConfigForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ADR-139 — useReadOnly keys on publicRead, not requiresAuth', () => {
  it('renders read-only for a NEAT_PUBLIC_READ deployment (publicRead:true)', async () => {
    stubConfig({ publicRead: true, authProxy: false, requiresAuth: true })
    render(<ReadOnlyProbe />)

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('read-only')
    })
  })

  it('stays writable for a tokenless daemon (requiresAuth:false, publicRead:false)', async () => {
    stubConfig({ publicRead: false, authProxy: false, requiresAuth: false })
    render(<ReadOnlyProbe />)

    // Let the /api/config negotiation resolve (flushing the state update inside
    // act), then assert it never flips to read-only — a tokenless local daemon
    // serves anonymous writes.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(screen.getByTestId('probe').textContent).toBe('writable')
  })
})
