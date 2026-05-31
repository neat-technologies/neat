// Single source of truth for the MCP tool surface (ADR-091).
// Adding or renaming a tool means editing this tuple; the MCP server
// registration and the contracts audit both derive from it, so they
// never disagree about what tools exist.
export const MCP_TOOL_NAMES = [
  'get_root_cause',
  'get_blast_radius',
  'get_dependencies',
  'get_observed_dependencies',
  'get_incident_history',
  'semantic_search',
  'get_graph_diff',
  'get_recent_stale_edges',
  'check_policies',
  'get_divergences',
] as const

export type MCPToolName = (typeof MCP_TOOL_NAMES)[number]
