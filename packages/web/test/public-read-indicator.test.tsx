import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

// PublicReadIndicator reads the daemon's auth-mode singleton via the
// useDaemonAuthConfig hook. The hook fetches /api/config once and caches
// the result, so each test resets the cache and stubs fetch to return the
// shape it wants. StatusBar's heartbeat + SSE wiring isn't exercised here
// — we render the indicator in isolation.
beforeEach(async () => {
  const { resetDaemonAuthConfigForTests } = await import('../lib/public-read-mode')
  resetDaemonAuthConfigForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function stubConfig(body: { publicRead?: boolean; authProxy?: boolean }, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (!url.endsWith('/api/config')) {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify(body), {
        status: ok ? 200 : 500,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

describe('ADR-073 §3a — public-read indicator in StatusBar', () => {
  it('renders the "public read-only" chip when /api/config returns publicRead=true', async () => {
    stubConfig({ publicRead: true, authProxy: false })
    const { PublicReadIndicator } = await import('../app/components/StatusBar')
    render(<PublicReadIndicator />)

    const chip = await screen.findByTestId('public-read-chip')
    expect(chip.textContent).toBe('public read-only')
    expect(chip.getAttribute('title')).toMatch(/publicly readable/i)
  })

  it('renders nothing when publicRead is false', async () => {
    stubConfig({ publicRead: false, authProxy: false })
    const { PublicReadIndicator } = await import('../app/components/StatusBar')
    const { container } = render(<PublicReadIndicator />)

    // Give the negotiation a tick to resolve before asserting absence.
    await waitFor(() => {
      expect(container.querySelector('[data-testid="public-read-chip"]')).toBeNull()
    })
  })

  it('stays hidden when /api/config is unreachable', async () => {
    stubConfig({}, false)
    const { PublicReadIndicator } = await import('../app/components/StatusBar')
    const { container } = render(<PublicReadIndicator />)

    await waitFor(() => {
      expect(container.querySelector('[data-testid="public-read-chip"]')).toBeNull()
    })
  })
})
