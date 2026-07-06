import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

// #695 — the live/offline chip in the top-right of TopBar used to be a
// focusable <button> with no onClick, which looked actionable but did
// nothing when clicked or activated with a keyboard. There's no reconnect
// capability anywhere in the codebase to wire it to (the health poll below
// is already automatic), so it's a status region instead — same
// role="status" / aria-live="polite" convention Toaster.tsx uses for other
// ambient state that updates on its own.
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
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('#695 — TopBar connection indicator', () => {
  it('renders the core connection state as a status region, not a focusable button', async () => {
    const { TopBar } = await import('../app/components/TopBar')
    render(
      <TopBar
        project="demo"
        profiles={[]}
        onSelectProfile={vi.fn()}
        onOpenPalette={vi.fn()}
        pageLabel="graph view"
      />,
    )

    const indicator = await screen.findByRole('status', { name: 'Core connected' })
    expect(indicator.tagName).toBe('SPAN')
    expect(indicator.getAttribute('aria-live')).toBe('polite')
    // Not in the tab order and not exposed as a button — activating it
    // (click or Enter/Space while focused) has nothing to do.
    expect(indicator.getAttribute('tabindex')).toBeNull()
    expect(screen.queryByRole('button', { name: /Core (connected|offline)/ })).toBeNull()
  })

  it('flips label and live-region content from offline to connected once the health check resolves', async () => {
    const { TopBar } = await import('../app/components/TopBar')
    render(
      <TopBar
        project="demo"
        profiles={[]}
        onSelectProfile={vi.fn()}
        onOpenPalette={vi.fn()}
        pageLabel="graph view"
      />,
    )

    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Core connected' })).toBeTruthy()
    })
  })

  it('stays a status region (offline) when there is no resolved project to poll', async () => {
    const { TopBar } = await import('../app/components/TopBar')
    render(
      <TopBar
        project={null}
        profiles={[]}
        onSelectProfile={vi.fn()}
        onOpenPalette={vi.fn()}
        pageLabel="graph view"
      />,
    )

    const indicator = screen.getByRole('status', { name: 'Core offline' })
    expect(indicator.tagName).toBe('SPAN')
    expect(screen.queryByRole('button', { name: /Core (connected|offline)/ })).toBeNull()
  })
})
