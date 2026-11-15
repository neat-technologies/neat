// Opt-in switches that keep an agent session's setup small and identical from
// one session to the next (#1610, mcp-tools.md "Lean session"). Every default is
// the full surface: nothing changes unless a switch is set.
//
// Why identical matters: a client re-sends the session setup (its instructions
// and tool list) on every turn and caches it by exact prefix. Setup that varies
// between sessions, such as an incident line prepended at startup, means the
// cached copy never matches and the client writes the whole setup afresh.

import type { MCPToolName } from '@neat.is/types'

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

type Env = Record<string, string | undefined>

/**
 * The tools this session leaves out. `NEAT_MCP_TOOLS=core` leaves out the extend
 * and connector groups; any other value, or none, keeps every tool.
 */
export function hiddenTools(env: Env = process.env): ReadonlySet<MCPToolName> {
  if (env.NEAT_MCP_TOOLS?.trim() !== 'core') return new Set()
  return new Set<MCPToolName>([...TOOL_GROUPS.extend, ...TOOL_GROUPS.connectors])
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
