import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ADR-134 / canvas-layout.md §3a — the overlay's second, parallel path.
// Drives the real component so a drifted provider list or a broken copy
// action fails here, not just in a browser check.

import { ObservedOverlay } from '../app/components/ObservedOverlay'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ObservedOverlay — the connect-a-provider path', () => {
  it('lists exactly the four shipped providers, never Vercel', () => {
    render(<ObservedOverlay mode="A" project="demo" onDismiss={vi.fn()} />)
    for (const label of ['Supabase', 'Railway', 'Firebase', 'Cloudflare']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: /Vercel/ })).not.toBeInTheDocument()
  })

  it('clicking a provider copies the real neat connector add command', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<ObservedOverlay mode="A" project="demo" onDismiss={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /Supabase/ }))
    expect(writeText).toHaveBeenCalledWith('neat connector add supabase')
    expect(await screen.findByText('copied')).toBeInTheDocument()
  })

  it('renders the provider path alongside Mode B, not only Mode A', () => {
    render(<ObservedOverlay mode="B" project="demo" onDismiss={vi.fn()} />)
    expect(screen.getByText('connect a provider')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Railway/ })).toBeInTheDocument()
  })
})
