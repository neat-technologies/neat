import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ADR-135 / web-shell.md §4 — the Settings page consolidates three real
// sections. These tests drive the real component so a broken switch action,
// a stalled connection poll, or a token round trip that silently fails all
// get caught here rather than only in a browser.

import { SettingsPage } from '../app/components/SettingsPage'

function makeStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, String(v))
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
    clear: () => store.clear(),
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const PROFILES = [
  { project: 'demo', endpoint: 'http://127.0.0.1:8080', status: 'running' as const },
  { project: 'other', endpoint: 'http://127.0.0.1:8081', status: 'running' as const },
  { project: 'stale', endpoint: 'http://127.0.0.1:8082', status: 'stopped' as const },
]

// jsdom has no EventSource implementation; SettingsPage opens one
// unconditionally for the SSE-state section, same as StatusBar.
class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readyState = FakeEventSource.CONNECTING
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  close(): void {
    this.readyState = FakeEventSource.CLOSED
  }
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: makeStorage() })
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/health')) return jsonResponse({ ok: true })
      return jsonResponse({})
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Settings page — project section', () => {
  it('lists discovered profiles and switching a non-active one calls onSelectProfile', async () => {
    const onSelectProfile = vi.fn()
    const user = userEvent.setup()
    render(<SettingsPage project="demo" profiles={PROFILES} onSelectProfile={onSelectProfile} />)

    expect(screen.getByText('other')).toBeInTheDocument()
    const switchBtn = screen.getAllByRole('button', { name: 'switch' })[0]
    await user.click(switchBtn)
    expect(onSelectProfile).toHaveBeenCalledWith(PROFILES[1])
  })

  it('disables switching to a stopped daemon', () => {
    render(<SettingsPage project="demo" profiles={PROFILES} onSelectProfile={vi.fn()} />)
    const buttons = screen.getAllByRole('button', { name: 'switch' })
    const staleRow = buttons.find((b) => b.title.includes('stopped'))
    expect(staleRow).toBeDefined()
    expect(staleRow).toBeDisabled()
  })
})

describe('Settings page — daemon connection section', () => {
  it('shows the connection as ok once the health poll resolves', async () => {
    render(<SettingsPage project="demo" profiles={PROFILES} onSelectProfile={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText(/^ok/)).toBeInTheDocument()
    })
  })
})

describe('Settings page — token section', () => {
  it('shows no-token state, saves a valid token, then shows it set', async () => {
    const user = userEvent.setup()
    render(<SettingsPage project="demo" profiles={PROFILES} onSelectProfile={vi.fn()} />)

    expect(await screen.findByText(/has no bearer token set/)).toBeInTheDocument()

    const input = screen.getByLabelText('Bearer token')
    await user.type(input, 'good-token')
    await user.click(screen.getByRole('button', { name: 'save' }))

    expect(await screen.findByText(/has a bearer token set/)).toBeInTheDocument()
    expect(await screen.findByText('token saved.')).toBeInTheDocument()

    const { readProfileToken } = await import('../lib/active-profile')
    expect(readProfileToken('demo')).toBe('good-token')
  })

  it('shows the wrong-token error and does not store a 401ing token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/api/health') && (init?.headers as Record<string, string>)?.Authorization) {
          return jsonResponse({}, 401)
        }
        if (url.includes('/api/health')) return jsonResponse({ ok: true })
        return jsonResponse({})
      }),
    )
    const user = userEvent.setup()
    render(<SettingsPage project="demo" profiles={PROFILES} onSelectProfile={vi.fn()} />)

    const input = screen.getByLabelText('Bearer token')
    await user.type(input, 'bad-token')
    await user.click(screen.getByRole('button', { name: 'save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent("doesn't match this NEAT instance")
    const { readProfileToken } = await import('../lib/active-profile')
    expect(readProfileToken('demo')).toBeNull()
  })

  it('clears a set token', async () => {
    const { writeProfileToken } = await import('../lib/active-profile')
    writeProfileToken('demo', 'existing-token')
    const user = userEvent.setup()
    render(<SettingsPage project="demo" profiles={PROFILES} onSelectProfile={vi.fn()} />)

    expect(await screen.findByText(/has a bearer token set/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'clear' }))

    expect(await screen.findByText(/has no bearer token set/)).toBeInTheDocument()
    const { readProfileToken } = await import('../lib/active-profile')
    expect(readProfileToken('demo')).toBeNull()
  })
})
