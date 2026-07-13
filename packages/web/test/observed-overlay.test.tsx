import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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

// ---------------------------------------------------------------------------
// #763 — those provider buttons were unclickable in the running app even though
// the component renders them fine. cytoscape-expand-collapse appends a
// <canvas class="expand-collapse-canvas"> at z-index 999 inside the graph
// container; .observed-overlay sat at z-index 9, so the canvas painted over the
// whole modal and ate every click (document.elementFromPoint at a button's
// centre returned the canvas). The overlay now rides at z-index 1000, and the
// chrome that must stay above it — toasts, the command palette — is lifted above
// 1000 in turn. jsdom doesn't do stacking/paint, so this reads the declared
// z-indexes off the source and locks the ladder rather than the click.
// ---------------------------------------------------------------------------

// The z-index cytoscape-expand-collapse hardcodes on the canvas it injects.
const EXPAND_COLLAPSE_CANVAS_Z = 999

function readSrc(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
}

// z-index declared in the first `{ ... }` block for a CSS selector. Comments
// are stripped first so prose like "at z-index: 999" doesn't get parsed as the
// rule's own declaration.
function cssZIndex(cssRaw: string, selector: string): number {
  const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '')
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))
  expect(block, `no rule found for ${selector}`).not.toBeNull()
  const z = block![1].match(/z-index:\s*(\d+)/)
  expect(z, `no z-index in ${selector}`).not.toBeNull()
  return Number(z![1])
}

describe('observed=0 overlay layering (#763)', () => {
  const overlayZ = cssZIndex(readSrc('../app/globals.css'), '.observed-overlay')

  it('rides above the expand-collapse canvas so its buttons stay clickable', () => {
    expect(overlayZ).toBeGreaterThan(EXPAND_COLLAPSE_CANVAS_Z)
  })

  it('keeps toasts above the overlay', () => {
    const z = readSrc('../app/components/Toaster.tsx').match(/zIndex:\s*(\d+)/)
    expect(z, 'no zIndex in Toaster.tsx').not.toBeNull()
    expect(Number(z![1])).toBeGreaterThan(overlayZ)
  })

  it('keeps the command-palette dialog above the overlay', () => {
    const zs = [...readSrc('../components/ui/dialog.tsx').matchAll(/z-\[(\d+)\]/g)].map((m) =>
      Number(m[1]),
    )
    // backdrop and popup both carry an explicit z-index; every layer of the
    // dialog has to clear the overlay, so check the lowest.
    expect(zs.length, 'no z-[n] utility in dialog.tsx').toBeGreaterThan(0)
    expect(Math.min(...zs)).toBeGreaterThan(overlayZ)
  })
})
