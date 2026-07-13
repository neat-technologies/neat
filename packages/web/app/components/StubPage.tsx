'use client'

import { Badge } from '@/components/ui/badge'
import { ALL_NAV, type NavId } from '../../lib/nav'

// A clearly-marked TODO page for sibling capabilities not yet built in the
// GUI-redo core. web-completeness #26: this is not a stub pretending to
// work — it states plainly that the surface isn't built yet and points at
// what it will be. No live-looking controls that do nothing.
//
// Every nav entry has graduated to a real page as of ADR-135 (Settings was
// the last `kind: 'todo'`) — this component has no live caller today, kept
// as the mechanism for whichever page lands next.

interface StubPageProps {
  id: NavId
}

const COPY: Partial<Record<NavId, { lede: string; detail: string }>> = {}

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
