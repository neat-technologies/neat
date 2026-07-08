'use client'

import { Badge } from '@/components/ui/badge'
import { ALL_NAV, type NavId } from '../../lib/nav'

// A clearly-marked TODO page for sibling capabilities not built in the GUI-redo
// CORE (Settings). web-completeness #26: this is not a stub pretending to work —
// it states plainly that the surface isn't built yet and points at what it will
// be. No live-looking controls that do nothing.
//
// Divergences and Find graduated to real in-shell pages (Gate 2); Settings is
// the remaining progressive sibling per the locked sequence (eng-02 #4): shell +
// graph + the two-mode overlay are the core that has to be great on day one; the
// sibling pages land thinner and iterate.

interface StubPageProps {
  id: NavId
}

const COPY: Partial<Record<NavId, { lede: string; detail: string }>> = {
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
