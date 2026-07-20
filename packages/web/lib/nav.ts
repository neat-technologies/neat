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
// page explicitly marked as not-yet-built — it's still a normal, clickable
// nav entry (#697): it routes through like any other page, landing on
// StubPage's honest "here's what's coming" copy instead of the real surface.
// web-completeness #26 is satisfied by that placeholder being real and wired,
// not by disabling the entry.

export type NavId =
  | 'graph'
  | 'divergences'
  | 'policies'
  | 'incidents'
  | 'connectors'
  | 'logs'
  | 'find'
  | 'settings'

export interface NavItem {
  id: NavId
  label: string
  /** one-line description shown in the command palette */
  hint: string
  /** 'page' = wired this redo; 'todo' = sibling, reachable via StubPage */
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
        kind: 'page',
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
        kind: 'page',
      },
      {
        id: 'connectors',
        label: 'Connectors',
        hint: 'Configured connectors and their poll health (credentials never shown)',
        kind: 'page',
      },
      {
        id: 'logs',
        label: 'Logs',
        hint: 'Native OTLP logs and connector-sourced records, one filterable surface',
        kind: 'page',
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
        kind: 'page',
      },
      {
        id: 'settings',
        label: 'Settings',
        hint: 'Project, daemon connection, token',
        kind: 'page',
      },
    ],
  },
]

export const ALL_NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items)

// Most nav ids are views AppShell switches between in place (graph, divergences,
// …) via its `onNavigate` callback. A few are standalone Next routes instead
// (app/incidents/page.tsx), so they need a real navigation, not the in-shell
// switch. Both the sidebar AND the command palette read this one map — if only
// one of them knows a page is a standalone route, the other sends it through
// `onNavigate` to a nonexistent AppShell branch and it lands on StubPage's
// "not built yet" copy, i.e. a shipped page looking unbuilt (#804).
export const NAV_ROUTES: Partial<Record<NavId, string>> = {
  incidents: '/incidents',
}
