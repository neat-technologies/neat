// Opt-in switches that keep an agent session's setup small and identical from
// one session to the next (#1610, #1675, mcp-tools.md "Lean session"). Every
// default is the full surface: nothing changes unless a switch is set.
//
// Why identical matters: a client re-sends the session setup (its instructions
// and tool list) on every turn and caches it by exact prefix. Setup that varies
// between sessions, such as an incident line prepended at startup, means the
// cached copy never matches and the client writes the whole setup afresh.
//
// NEAT_MCP_TOOLS selects which tool FAMILIES a session exposes, so the per-turn
// tool schema stays flat as the surface grows: tools added into an opt-in family
// (one not in DEFAULT_FAMILIES) do not inflate the default session.

import type { MCPToolName } from '@neat.is/types'

// The /neat extend and hosted connector groups, kept as named exports because
// other call sites and tests refer to them directly.
export const TOOL_GROUPS = {
  // The /neat extend tools (ADR-081, ADR-086): closing instrumentation gaps.
  extend: [
    'neat_list_uninstrumented',
    'neat_lookup_instrumentation',
    'neat_describe_project_instrumentation',
    'neat_apply_extension',
    'neat_dry_run_extension',
    'neat_rollback_extension',
  ],
  // The hosted connector tools (ADR-228): connecting a provider to a hosted project.
  connectors: ['neat_list_connectable', 'neat_connect', 'neat_connection_status', 'neat_disconnect'],
} as const satisfies Record<string, readonly MCPToolName[]>

// Every tool belongs to exactly one family, the same grouping the registry uses
// (tools/<family>.ts). A session exposes a set of families; the rest are hidden.
// A contracts test asserts this map covers the manifest exactly, so a tool added
// to the manifest must be placed in a family here.
export const TOOL_FAMILIES = {
  investigation: ['get_root_cause', 'get_incident_history', 'get_incident_card', 'investigate'],
  navigation: [
    'ask',
    'get_blast_radius',
    'get_dependencies',
    'get_observed_dependencies',
    'expand',
    'relate',
    'semantic_search',
    'get_graph_diff',
    'get_recent_stale_edges',
    'get_divergences',
  ],
  policy: ['check_policies', 'policy_read'],
  security: ['get_reachable_cves', 'is_reachable', 'scan_diff'],
  // Opt-in operational reads (#1694): left out of DEFAULT_FAMILIES, so an agent
  // opts in with NEAT_MCP_TOOLS=...,ops (or =all) and the default surface stays flat.
  ops: ['get_logs', 'get_changes', 'graph_trust', 'get_incident_lead', 'get_edges', 'connector_health'],
  extend: TOOL_GROUPS.extend,
  connectors: TOOL_GROUPS.connectors,
} as const satisfies Record<string, readonly MCPToolName[]>

type Family = keyof typeof TOOL_FAMILIES

// Families a session exposes when NEAT_MCP_TOOLS is unset. A family in TOOL_FAMILIES
// but left out of here is opt-in: its tools are hidden by default and ride only
// when named (or with NEAT_MCP_TOOLS=all), so the default surface stays flat as the
// surface grows. `ops` is such a family (#1694).
const DEFAULT_FAMILIES: readonly Family[] = [
  'investigation',
  'navigation',
  'policy',
  'security',
  'extend',
  'connectors',
]

// `core` keeps its meaning: the graph-read families, without the operative extend
// group and the hosted connector group.
const CORE_FAMILIES: readonly Family[] = ['investigation', 'navigation', 'policy', 'security']

type Env = Record<string, string | undefined>

// Which families NEAT_MCP_TOOLS asks for. Unset or empty is the default set;
// `all` is every family, including opt-in ones; `core` is the read set; otherwise
// a comma-list of family names exposes exactly those. A value that names no real
// family falls back to the default set rather than hiding everything, so a typo
// never blanks the tools.
function selectedFamilies(raw: string | undefined): readonly Family[] {
  const value = raw?.trim()
  if (!value) return DEFAULT_FAMILIES
  if (value === 'all') return Object.keys(TOOL_FAMILIES) as Family[]
  if (value === 'core') return CORE_FAMILIES
  const named = value
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is Family => s in TOOL_FAMILIES)
  return named.length > 0 ? named : DEFAULT_FAMILIES
}

/**
 * The tools this session leaves out. NEAT_MCP_TOOLS selects the families to
 * expose (unset keeps every tool, `core` drops the extend and connector groups,
 * a comma-list exposes exactly the named families); every tool outside the
 * selected families is hidden.
 */
export function hiddenTools(env: Env = process.env): ReadonlySet<MCPToolName> {
  const shown = new Set<MCPToolName>()
  for (const family of selectedFamilies(env.NEAT_MCP_TOOLS)) {
    for (const tool of TOOL_FAMILIES[family]) shown.add(tool)
  }
  const hidden = new Set<MCPToolName>()
  for (const tools of Object.values(TOOL_FAMILIES)) {
    for (const tool of tools) if (!shown.has(tool)) hidden.add(tool)
  }
  return hidden
}

/**
 * Whether the ADR-260 session-start lead may read the daemon and prepend a live
 * incident to the instructions. `NEAT_SESSION_LEAD=0` (or `false`) keeps the
 * instructions static.
 */
export function sessionLeadEnabled(env: Env = process.env): boolean {
  const v = env.NEAT_SESSION_LEAD?.trim()
  return !(v === '0' || v === 'false')
}
