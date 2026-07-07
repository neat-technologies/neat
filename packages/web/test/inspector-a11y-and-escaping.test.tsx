import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GraphNode, GraphEdge } from '@neat.is/types'
import type { GraphData } from '../app/components/AppShell'
import { Inspector } from '../app/components/Inspector'

// #698 — Inspector.tsx double-escaped JSX text (a name with `&`/`<` rendered
// as visible HTML entities) and its call/import/service drilldown tabs were
// unreachable by keyboard (clickable divs, no tabIndex/key handling).
const nodes: GraphNode[] = [
  { id: 'service:esc', type: 'ServiceNode', name: 'A & B <script>', language: 'ts' } as GraphNode,
]
const graphData: GraphData = { nodes, edges: [] }

function stubNodeFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const m = url.match(/\/api\/graph\/node\/([^?]+)/)
      if (m) {
        const id = decodeURIComponent(m[1])
        const node = nodes.find((n) => n.id === id)
        return new Response(JSON.stringify({ node }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ rootCauseNode: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  )
}

beforeEach(() => stubNodeFetch())
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Inspector text rendering (#698 — no manual HTML escaping)', () => {
  it('renders a name containing & and < as literal characters, not double-escaped entities', async () => {
    render(
      <Inspector
        project="default"
        selectedNodeId="service:esc"
        graphData={graphData}
        onNodeSelect={vi.fn()}
      />,
    )

    // React already escapes JSX text children; a hand-rolled escapeHtml()
    // upstream of that would turn "A & B <script>" into visible
    // "A &amp; B &lt;script&gt;" text.
    await waitFor(() => expect(screen.getByText('A & B <script>')).toBeInTheDocument())
    expect(screen.queryByText(/&amp;/)).not.toBeInTheDocument()
    expect(screen.queryByText(/&lt;/)).not.toBeInTheDocument()
  })
})

describe('Inspector drilldown tabs keyboard accessibility (#698)', () => {
  it('tabs are real buttons: focusable via Tab and activatable via Enter/Space', async () => {
    const user = userEvent.setup()
    render(
      <Inspector
        project="default"
        selectedNodeId="service:esc"
        graphData={graphData}
        onNodeSelect={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByRole('tablist')).toBeInTheDocument())

    const edgesTab = screen.getByRole('tab', { name: /Edges/ })
    const ownersTab = screen.getByRole('tab', { name: 'Owners' })

    // real <button> elements — not inert divs with no keyboard path
    expect(edgesTab.tagName).toBe('BUTTON')
    expect(ownersTab.tagName).toBe('BUTTON')

    // reachable by keyboard focus (a plain div with role="tab" and no
    // tabIndex cannot receive focus at all)
    edgesTab.focus()
    expect(edgesTab).toHaveFocus()

    // Enter activates the focused tab
    await user.keyboard('{Enter}')
    expect(edgesTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/All edges/i)).toBeInTheDocument()

    // Space activates the Owners tab
    ownersTab.focus()
    expect(ownersTab).toHaveFocus()
    await user.keyboard(' ')
    expect(ownersTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/no owner declared/i)).toBeInTheDocument()
  })

  it('the disabled History tab correctly opts out of the tab order', async () => {
    render(
      <Inspector
        project="default"
        selectedNodeId="service:esc"
        graphData={graphData}
        onNodeSelect={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByRole('tablist')).toBeInTheDocument())
    const historyTab = screen.getByRole('tab', { name: /History/ })
    expect(historyTab.tagName).toBe('BUTTON')
    expect(historyTab).toBeDisabled()
  })
})
