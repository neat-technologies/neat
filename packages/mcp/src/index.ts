#!/usr/bin/env node

import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  CheckPoliciesScopeSchema,
  DivergenceTypeSchema,
  HypotheticalActionSchema,
  type MCPToolName,
} from '@neat.is/types'
import { createHttpClient } from './client.js'
import { registerResources } from './resources.js'
import {
  checkPolicies,
  getBlastRadius,
  getDependencies,
  getDivergences,
  getGraphDiff,
  getIncidentHistory,
  getObservedDependencies,
  getRecentStaleEdges,
  getRootCause,
  semanticSearch,
} from './tools.js'

const baseUrl = process.env.NEAT_CORE_URL ?? 'http://localhost:8080'
// ADR-073 §3 — carry the operator's bearer to a secured core. Sourced from
// NEAT_AUTH_TOKEN, the same env the daemon enforces against; empty/unset
// keeps the header off so a loopback dev core stays reachable.
const authToken = process.env.NEAT_AUTH_TOKEN
const client = createHttpClient(baseUrl, authToken && authToken.length > 0 ? authToken : undefined)

// `NEAT_DEFAULT_PROJECT` is the implicit project for tool calls that don't
// pass a `project` arg. Unset means "use the core's `default` project" — we
// route those calls through the legacy unprefixed URL so an older core (one
// that predates #83) still gets the request it expects.
const defaultProject = process.env.NEAT_DEFAULT_PROJECT
const projectFor = (input: { project?: string }): string | undefined =>
  input.project ?? defaultProject

const projectField = z
  .string()
  .optional()
  .describe(
    'Project name when the core hosts more than one (set NEAT_PROJECTS=...). Omit to use the default project.',
  )

const server = new McpServer({
  name: 'neat',
  version: '0.1.0',
})

// Register every MCP tool through this wrapper, not server.tool directly.
// The tool name is constrained to MCP_TOOL_NAMES in @neat.is/types — add the
// name there first or this won't compile. The contracts audit also checks
// that registrations and the manifest match both ways, so the tool surface
// can't drift from the contract again.
const registerTool = <Args extends z.ZodRawShape>(
  name: MCPToolName,
  description: string,
  paramsSchema: Args,
  cb: ToolCallback<Args>,
): ReturnType<typeof server.tool> => server.tool(name, description, paramsSchema, cb)

registerTool(
  'get_root_cause',
  'Trace a failing node up its dependency graph to find the underlying cause. Use this when something is breaking and you want to know which upstream component is the actual culprit.',
  {
    errorNode: z
      .string()
      .describe('Graph node id where the error surfaced, e.g. "database:payments-db"'),
    errorId: z
      .string()
      .optional()
      .describe('Specific error event id from incident history; if set, the result is coloured with that error message'),
    project: projectField,
  },
  async (input) => getRootCause(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'get_blast_radius',
  'List every node downstream of the given node — what would break if this node failed or was redeployed.',
  {
    nodeId: z.string().describe('Graph node id to compute blast radius from'),
    depth: z
      .number()
      .int()
      .nonnegative()
      .max(20)
      .optional()
      .describe('Max BFS depth (default 10)'),
    project: projectField,
  },
  async (input) => getBlastRadius(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'get_dependencies',
  'List the transitive outgoing dependencies of a node, BFS to depth N (default 3, max 10). Each result carries distance, edge type, and provenance — both static (EXTRACTED) and runtime (OBSERVED). Pass depth=1 for direct-only.',
  {
    nodeId: z.string().describe('Graph node id to inspect'),
    depth: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe('BFS depth (default 3, max 10). depth=1 returns direct dependencies only.'),
    project: projectField,
  },
  async (input) => getDependencies(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'get_observed_dependencies',
  'List only the runtime (OBSERVED via OTel) outgoing dependencies of a node. Use this to compare what code SAYS the service depends on vs what production actually does.',
  {
    nodeId: z.string().describe('Graph node id to inspect'),
    project: projectField,
  },
  async (input) => getObservedDependencies(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'get_incident_history',
  'Return recent OTel error events recorded against a node, most recent first.',
  {
    nodeId: z.string().describe('Graph node id to query'),
    limit: z.number().int().positive().max(100).optional().describe('Max events to return (default 20)'),
    project: projectField,
  },
  async (input) => getIncidentHistory(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'semantic_search',
  'Search nodes by natural-language query. Uses embedding vectors when an embedder is available (Ollama nomic-embed-text → in-process MiniLM → substring fallback) — phrase the query the way you would describe what you want.',
  {
    query: z.string().describe('Free-text query, e.g. "service handling checkout payments"'),
    project: projectField,
  },
  async (input) => semanticSearch(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'get_graph_diff',
  'Diff a saved graph snapshot against the current live graph. Useful for change reviews and post-incidents — answers "what changed in the architecture between then and now." Returns added/removed/changed nodes and edges with both snapshot timestamps.',
  {
    againstSnapshot: z
      .string()
      .describe(
        'Path or http(s) URL of the snapshot to diff against (the "before" state). The current graph is the "after".',
      ),
    project: projectField,
  },
  async (input) => getGraphDiff(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'get_recent_stale_edges',
  'List the most recent OBSERVED → STALE edge transitions. Use this to spot integrations that have gone quiet — a CALLS edge that just went stale typically means an upstream stopped calling, not that the link is healthy.',
  {
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe('Max events to return (default 50)'),
    edgeType: z
      .string()
      .optional()
      .describe('Filter by edge type — e.g. "CALLS" or "CONNECTS_TO"'),
    project: projectField,
  },
  async (input) => getRecentStaleEdges(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'get_divergences',
  "Returns places where what the code declares (EXTRACTED) doesn't match what production observed (OBSERVED). The single most NEAT-shaped query — the one that justifies the whole graph. Use when the user asks 'is anything weird?' or 'what does production do that the code doesn't?' or 'find me a bug' on an unfamiliar codebase. Returns divergences ranked by confidence × severity. Prefer this over `get_root_cause` when no specific node is failing.",
  {
    type: z
      .array(DivergenceTypeSchema)
      .optional()
      .describe(
        'Filter by divergence type. One or more of: missing-observed, missing-extracted, version-mismatch, host-mismatch, compat-violation. Omit for all.',
      ),
    minConfidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Drop divergences below this confidence threshold (0.0 - 1.0).'),
    node: z
      .string()
      .optional()
      .describe('Scope to divergences involving this node id (as source or target).'),
    project: projectField,
  },
  async (input) =>
    getDivergences(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'check_policies',
  'Inspect or dry-run the project\'s policy.json. Without hypotheticalAction, returns currently-recorded violations. With hypotheticalAction, returns violations that would result if the action were applied. Architectural assertions in five shapes (structural / compatibility / provenance / ownership / blast-radius).',
  {
    scope: CheckPoliciesScopeSchema.optional().describe(
      'Narrow to a subset. Default "all".',
    ),
    hypotheticalAction: HypotheticalActionSchema.optional().describe(
      'Dry-run mode: simulate the action and return resulting violations. Omit for current state.',
    ),
    project: projectField,
  },
  async (input) =>
    checkPolicies(client, {
      ...input,
      project: projectFor(input),
    } as Parameters<typeof checkPolicies>[1]),
)

// Resources sit alongside tools — same data, different access pattern. Read
// the per-node resource for raw attrs+edges JSON; subscribe to the incidents
// resource to be notified when new errors land. The eight tools above are
// unchanged.
const incidentsPollMs = process.env.NEAT_RESOURCE_POLL_MS
  ? Number(process.env.NEAT_RESOURCE_POLL_MS)
  : undefined
const resourceRegistration = registerResources(server, client, {
  ...(incidentsPollMs !== undefined ? { incidentsPollMs } : {}),
  ...(defaultProject ? { project: defaultProject } : {}),
})

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

const stopPolling = (): void => {
  resourceRegistration.stop()
}
process.on('SIGTERM', stopPolling)
process.on('SIGINT', stopPolling)

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
