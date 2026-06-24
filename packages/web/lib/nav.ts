// The page set for the multi-page SaaS shell (web-shell / IA ADR). The graph
// is one spatial view among list/table views — that's what deflates the
// "cram everything on the canvas" slop pressure.
//
// Spine framing (locked spec, lead-05/06): NEAT IS the fused graph as the
// agent's eyes — code + observed runtime in one file-grained model. Divergence
// is one peer query that falls out of it, NOT the headline; it sits in the
// query family alongside the node-scoped root-cause / blast / deps actions.
//
// `kind: 'page'` is a real, shipped capability. `kind: 'todo'` is a sibling
// page explicitly marked as not-yet-built — rendered disabled per
// web-completeness #26 (no permanent stub that looks active and does nothing).

export type NavId =
  | 'graph'
  | 'divergences'
  | 'policies'
  | 'incidents'
  | 'find'
  | 'settings'

export interface NavItem {
  id: NavId
  label: string
  /** one-line description shown in the command palette */
  hint: string
  /** 'page' = wired this redo; 'todo' = sibling, disabled-with-affordance */
  kind: 'page' | 'todo'
}

// Order carries nav weight: the fused Graph leads (the model is the product).
// Divergences is demoted to a peer query view, not the marquee.
export const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Graph',
    items: [
      {
        id: 'graph',
        label: 'Graph',
        hint: 'The fused graph — what your system is and does, unified',
        kind: 'page',
      },
    ],
  },
  {
    label: 'Queries',
    items: [
      {
        id: 'divergences',
        label: 'Divergences',
        hint: 'Where a declared relationship and its observed twin diverge',
        kind: 'todo',
      },
      {
        id: 'policies',
        label: 'Policies',
        hint: 'Rules that currently flag nodes/edges (enforcement is preview)',
        kind: 'page',
      },
      {
        id: 'incidents',
        label: 'Incidents',
        hint: 'OTel error events',
        kind: 'todo',
      },
    ],
  },
  {
    label: 'Workspace',
    items: [
      {
        id: 'find',
        label: 'Find',
        hint: 'Jump to a node, file, or page · ⌘K',
        kind: 'todo',
      },
      {
        id: 'settings',
        label: 'Settings',
        hint: 'Project, daemon connection, token',
        kind: 'todo',
      },
    ],
  },
]

export const ALL_NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items)
