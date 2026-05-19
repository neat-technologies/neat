import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

// The EnvironmentIndicator is small and self-contained, but it lives inside
// StatusBar.tsx alongside the daemon-health and SSE wiring — both of which
// fire fetch() and EventSource on mount. We stub those so the test stays
// scoped to the environment-chip behavior surfaced by ADR-073 §1's summary
// block (the local/remote awareness the orchestrator promises the operator).
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  )
  class FakeEventSource {
    onopen: ((this: EventSource, ev: Event) => unknown) | null = null
    onerror: ((this: EventSource, ev: Event) => unknown) | null = null
    readyState = 0
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSED = 2
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {}
  }
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function setHostname(host: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, hostname: host },
  })
}

describe('ADR-073 §1 — dashboard environment indicator', () => {
  it('renders the green "local" chip when window.location.hostname is localhost', async () => {
    setHostname('localhost')
    const { EnvironmentIndicator } = await import('../app/components/StatusBar')
    render(<EnvironmentIndicator />)

    const chip = await screen.findByTestId('env-chip')
    expect(chip.textContent).toBe('local')
    const wrapper = chip.closest('[data-env-state]')
    expect(wrapper?.getAttribute('data-env-state')).toBe('local')
  })

  it('renders the orange "remote · <host>" chip for any non-loopback hostname', async () => {
    setHostname('neat.example.com')
    const { EnvironmentIndicator } = await import('../app/components/StatusBar')
    render(<EnvironmentIndicator />)

    const chip = await screen.findByTestId('env-chip')
    await waitFor(() => {
      expect(chip.textContent).toBe('remote · neat.example.com')
    })
    const wrapper = chip.closest('[data-env-state]')
    expect(wrapper?.getAttribute('data-env-state')).toBe('remote')
  })

  it('exposes the multi-instance explanation through the info icon tooltip', async () => {
    setHostname('localhost')
    const { EnvironmentIndicator } = await import('../app/components/StatusBar')
    render(<EnvironmentIndicator />)

    const info = await screen.findByRole('img', { name: /Each NEAT instance has its own graph/i })
    expect(info.getAttribute('title')).toMatch(/Each NEAT instance has its own graph/)
    expect(info.getAttribute('title')).toMatch(/Local sees your dev environment/)
    expect(info.getAttribute('title')).toMatch(/remote sees what you've deployed it to/)
  })
})
