'use client'

import { Badge } from '@/components/ui/badge'
import { ALL_NAV, type NavId } from '../../lib/nav'

// A clearly-marked TODO page for sibling capabilities not built in the GUI-redo
// CORE (Divergences / Find / Settings). web-completeness #26: this is not a
// stub pretending to work — it states plainly that the surface isn't built yet
// and points at what it will be. No live-looking controls that do nothing.
//
// These are progressive per the locked sequence (eng-02 #4): shell + graph +
// the two-mode overlay are the core that has to be great on day one; the
// sibling list pages land thinner and iterate.

interface StubPageProps {
  id: NavId
}

const COPY: Partial<Record<NavId, { lede: string; detail: string }>> = {
  divergences: {
    lede: 'A peer query over the fused graph, not the headline.',
    detail:
      'Where a declared relationship and its observed twin diverge, at whichever grain both sides share. This will land as a list view; a row focuses the pair on the graph. Today, divergences are reachable through the API and the Inspector’s root-cause block.',
  },
  find: {
    lede: 'Press ⌘K anywhere — the command palette is the Find surface.',
    detail:
      'Jump to a node, a file, or a page, and run a semantic search over the graph. A dedicated full-page Find view is progressive; the palette covers it for now.',
  },
  settings: {
    lede: 'Project, daemon connection, and token.',
    detail:
      'Switch the active project from the top bar; daemon/SSE connection state lives in the status bar; the bearer is managed at /login. A consolidated Settings page is progressive.',
  },
}

export function StubPage({ id }: StubPageProps) {
  const item = ALL_NAV.find((n) => n.id === id)
  const copy = COPY[id]
  return (
    <div className="page-scroll">
      <header className="page-head">
        <div className="flex items-center gap-3">
          <h1 className="page-title">{item?.label ?? id}</h1>
          <Badge variant="outline">not built yet</Badge>
        </div>
        <p className="page-sub">{copy?.lede ?? item?.hint}</p>
      </header>
      <section className="page-section">
        <div className="stub-note">
          <p>{copy?.detail}</p>
          <p className="stub-foot">
            The graph canvas and its live overlay shipped first; pages like
            this one are landing next.
          </p>
        </div>
      </section>
    </div>
  )
}
