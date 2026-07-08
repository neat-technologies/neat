import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// #697 — the maintainer's nav-reachability decision: Incidents is a real,
// shipped page (no longer flagged `todo`), and todo-marked sibling pages are
// normal clickable nav entries that route through to StubPage's honest
// "coming soon" copy, instead of being disabled outright.
//
// next/navigation needs a real Next router context to resolve `useRouter()`;
// stub it the same way test/login-surface.test.tsx does so PageSidebar can
// call router.push() in jsdom without one.
const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), prefetch: vi.fn() }),
}))

import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PageSidebar } from '../app/components/PageSidebar'
import { StubPage } from '../app/components/StubPage'
import { ALL_NAV } from '../lib/nav'

function renderSidebar() {
  const onNavigate = vi.fn()
  render(
    <TooltipProvider delay={0}>
      <SidebarProvider defaultOpen>
        <PageSidebar active="graph" onNavigate={onNavigate} />
      </SidebarProvider>
    </TooltipProvider>,
  )
  return { onNavigate }
}

afterEach(() => {
  pushMock.mockClear()
})

describe('#697 — nav.ts: incidents is promoted off the todo list', () => {
  it('the incidents entry is kind "page", not "todo"', () => {
    const incidents = ALL_NAV.find((n) => n.id === 'incidents')
    expect(incidents?.kind).toBe('page')
  })

  // Gate 2 (truthful frontend): Divergences and Find graduated from StubPage
  // todos to real in-shell pages, so they're kind "page" now too.
  it('Divergences and Find are kind "page" (real surfaces, not todos)', () => {
    expect(ALL_NAV.find((n) => n.id === 'divergences')?.kind).toBe('page')
    expect(ALL_NAV.find((n) => n.id === 'find')?.kind).toBe('page')
  })

  it('at least one sibling nav item is still marked todo, so the reachable-todo behavior below has something real to prove', () => {
    const todoItems = ALL_NAV.filter((n) => n.kind === 'todo')
    expect(todoItems.length).toBeGreaterThan(0)
  })
})

describe('#697 — PageSidebar: todo items are clickable, not disabled', () => {
  it('a todo-marked nav item (Settings) renders enabled and routes through onNavigate instead of being disabled', async () => {
    const { onNavigate } = renderSidebar()
    const user = userEvent.setup()
    const button = screen.getByRole('button', { name: /Settings/i })

    expect(button).not.toHaveAttribute('disabled')
    expect(button.getAttribute('aria-disabled')).not.toBe('true')

    await user.click(button)
    expect(onNavigate).toHaveBeenCalledWith('settings')
  })

  it('Incidents renders as a plain enabled entry (no "soon" affordance) and navigates to the real /incidents route', async () => {
    const { onNavigate } = renderSidebar()
    const user = userEvent.setup()
    const button = screen.getByRole('button', { name: /^Incidents$/ })

    expect(button).not.toHaveAttribute('disabled')
    expect(button.getAttribute('aria-disabled')).not.toBe('true')
    expect(button.textContent).not.toMatch(/soon/i)

    await user.click(button)
    expect(pushMock).toHaveBeenCalledWith('/incidents')
    expect(onNavigate).not.toHaveBeenCalled()
  })
})

describe('#697 — StubPage: what a reachable todo item actually renders', () => {
  it('renders real, honest placeholder copy for a todo page rather than inert/internal-only text', () => {
    render(<StubPage id="settings" />)
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByText('not built yet')).toBeInTheDocument()
    expect(
      screen.getByText(/Project, daemon connection, and token\./),
    ).toBeInTheDocument()
  })
})
