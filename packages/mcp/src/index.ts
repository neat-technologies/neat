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
import { resolveBaseUrlWithSource } from './base-url.js'
import { createHttpClient } from './client.js'
import { checkEndpointIsNeat, describeForeignEndpoint } from './endpoint-check.js'
import { registerResources } from './resources.js'
import {
  ask,
  checkPolicies,
  expandNode,
  getBlastRadius,
  getDependencies,
  getDivergences,
  getGraphDiff,
  getIncidentCard,
  getIncidentHistory,
  getObservedDependencies,
  getRecentStaleEdges,
  getRootCause,
  neatApplyExtension,
  neatDescribeProjectInstrumentation,
  neatDryRunExtension,
  neatListUninstrumented,
  neatLookupInstrumentation,
  neatRollbackExtension,
  relate,
  semanticSearch,
} from './tools.js'
import {
  createConnectorDeps,
  neatConnect,
  neatConnectionStatus,
  neatDisconnect,
  neatListConnectable,
} from './connectors.js'

const resolved = resolveBaseUrlWithSource()
const baseUrl = resolved.url
// ADR-073 §3 + client-profiles.md §6 — the bearer comes from the same resolver
// that picked the URL, so a hosted profile's token rides with its endpoint while
// a local/loopback core still reads NEAT_AUTH_TOKEN. Empty/unset keeps the
// header off so a loopback dev core stays reachable.
const bearerToken = resolved.authToken
const client = createHttpClient(baseUrl, bearerToken)

// The hosted connector tools (ADR-228) talk to the CONTROL PLANE, not the daemon:
// NEAT_CP_URL + the durable neat_pat_ (NEAT_API_KEY). Env is the interim source; the
// login-written profile is the durable one, read through resolveCpTarget as a
// follow-on with env as the override (ADR-228 §5). Unset → the tools return a
// "not configured" message rather than erroring, so a local-only server stays clean.
const cpUrl = process.env.NEAT_CP_URL
const cpApiKey = process.env.NEAT_API_KEY
const connectorDeps =
  cpUrl && cpApiKey
    ? createConnectorDeps(createHttpClient(cpUrl, cpApiKey), process.env.NEAT_CP_PROJECT_ID)
    : null

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

// Server-level orientation the MCP `initialize` handshake hands the connecting
// agent, so it knows what NEAT's data *is* before it reads a tool result. NEAT
// is one server among however many the agent has wired up — some of them
// (Supabase, Cloudflare, ...) may be the very platforms NEAT's connectors pull
// from. The line to draw: NEAT's tools answer from its own fused graph, not a
// live connection to those platforms, and every answer carries provenance so
// the agent can weigh it. The agent's other servers, and their overlap with
// NEAT's view, are the agent's own to reconcile — NEAT can't see its peers and
// doesn't try to; it just says plainly what its own data is.
const serverInstructions = [
  'NEAT is a live semantic graph of this software system: code, data, infrastructure, runtime traffic, incidents, and supported provider telemetry fused at the finest grain the evidence allows. Ask it before searching files for how the system works, what actually runs, what failed, or what a change could affect.',
  'Every graph claim carries provenance and confidence: EXTRACTED from source/config, OBSERVED from spans or supported provider signals, INFERRED from a bounded stitch, and STALE when a once-observed edge goes quiet. A graph answer is not a live call to a provider. Missing observations do not prove a path never runs.',
  'Start with ask: it resolves names and routes a question to graph traversals. For a failure, read get_incident_card, then expand or relate to test the cause. Before an edit, get_blast_radius and applicable check_policies; compare declared and observed behavior with get_divergences. Use Read/Grep for comments, arbitrary literals, config minutiae, unsupported syntax, and repos without a graph.',
].join('\n\n')

const server = new McpServer(
  {
    name: 'neat',
    version: '0.1.0',
  },
  { instructions: serverInstructions },
)

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
  'ask',
  "Ask the graph a question in plain language — the front door to NEAT. Reach for this FIRST, before Read/Grep/Bash, for any question about this system's behaviour, dependencies, failures, root cause, or blast radius. You do NOT need to know which tool or the exact node id: `ask` resolves the entities in your question to graph nodes and routes it to the right traversal (root cause, dependencies, observed runtime calls, incidents, divergences, blast radius), returning one compact answer with every fact provenance-tagged (EXTRACTED/OBSERVED/INFERRED/STALE) and confidence-scored. Ask what a node talks to, connects to, uses, hits, calls, reads from, or writes to for dependencies; add actually, in production, or at runtime for observed calls. Ask who calls or depends on a node, or for its consumers or callers, for blast radius. Ask about slow, latency, p95, or timing for runtime evidence; a why/failure question leads with root cause. Use the structured tools (get_root_cause, get_dependencies, …) when you already have a node id and want just that one traversal.",
  {
    question: z
      .string()
      .describe(
        'A natural-language question, e.g. "why is checkout failing?" or "what breaks if I change the orders table?"',
      ),
    project: projectField,
  },
  async (input) => ask(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'get_root_cause',
  'When a named node is failing, trace its dependency graph toward likely root-cause candidates. Returns a provenance-scored cause chain, including recorded error context when available, that file search cannot establish from runtime evidence.',
  {
    errorNode: z
      .string()
      .describe('Graph node id where the error surfaced, e.g. "database:payments-db"'),
    errorId: z
      .string()
      .optional()
      .describe(
        'Specific error event id from incident history; if set, the result is coloured with that error message',
      ),
    project: projectField,
  },
  async (input) => getRootCause(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'get_blast_radius',
  'Before changing or redeploying a node, see its downstream dependents and evidence-bearing paths. Returns the bounded blast radius so an edit plan includes affected services, routes, data, and callers.',
  {
    nodeId: z.string().describe('Graph node id to compute blast radius from'),
    depth: z.number().int().nonnegative().max(20).optional().describe('Max BFS depth (default 10)'),
    project: projectField,
  },
  async (input) => getBlastRadius(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'get_dependencies',
  'When you know a node id, map what it depends on across code, data, and infrastructure. Returns a bounded outgoing traversal (default depth 3, max 10) with distance, edge type, provenance, and confidence; depth=1 shows direct dependencies.',
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
  'When you need evidence of what a node actually called, return only its OBSERVED outgoing dependencies from runtime or supported provider signals. Compare with get_dependencies or get_divergences to distinguish declared intent from seen behavior.',
  {
    nodeId: z.string().describe('Graph node id to inspect'),
    project: projectField,
  },
  async (input) => getObservedDependencies(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'expand',
  'After an incident card points to a locus, walk one evidence-bearing hop. "up" finds callers/dependents and "down" finds callees/dependencies; each neighbor is classified primary-failure, symptom-only, or unrelated so you can separate cause from downstream symptoms.',
  {
    nodeId: z.string().describe('Graph node id to step from'),
    direction: z
      .enum(['up', 'down'])
      .describe('up = callers/dependents (toward the cause), down = callees/dependencies'),
    project: projectField,
  },
  async (input) => expandNode(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'relate',
  'Test a suspected cause-and-symptom pair. Returns a bounded connecting path, direction, per-hop provenance, and whether error/latency signal carries end to end. No path within the bound is reported as such, not as proof the nodes are unrelated.',
  {
    a: z.string().describe('First node id (the hypothesised cause)'),
    b: z.string().describe('Second node id (the hypothesised symptom)'),
    maxDepth: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe('Max path length to search (default 5)'),
    project: projectField,
  },
  async (input) => relate(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'get_incident_history',
  'When a node has failed, read its recorded error events, most recent first. The incident ledger preserves failure evidence and timestamps that a source search cannot reveal.',
  {
    nodeId: z.string().describe('Graph node id to query'),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Max events to return (default 20)'),
    project: projectField,
  },
  async (input) => getIncidentHistory(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'get_incident_card',
  'When something is failing, get one work order for a service, file, or symbol: the recorded incident, likely cause chain, blast radius, governing policies, and divergences with provenance on each claim. Omit errorId for the latest incident or pin a specific one, then use expand/relate to verify the path.',
  {
    nodeId: z.string().describe('Graph node id the incident is on (service/file/symbol)'),
    errorId: z
      .string()
      .optional()
      .describe('Pin a specific incident by its id; omit for the most recent'),
    project: projectField,
  },
  async (input) => getIncidentCard(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'semantic_search',
  'When you cannot name a graph node, find candidate nodes by a natural-language description. Searches node labels through Ollama nomic-embed-text when reachable, then in-process MiniLM, then substring fallback; it does not search arbitrary source contents. MiniLM can download a multi-hundred-megabyte model on a cold cache; set NEAT_SEARCH_PROVIDER=substring before daemon startup to avoid model initialization and download.',
  {
    query: z.string().describe('Free-text query, e.g. "service handling checkout payments"'),
    project: projectField,
  },
  async (input) => semanticSearch(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'get_graph_diff',
  'When reviewing a change or incident timeline, compare a saved snapshot with the live graph. Returns added, removed, and changed nodes and edges plus both timestamps, so architecture drift is visible beyond a file diff.',
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
  'When traffic or an integration seems to have disappeared, list recent OBSERVED → STALE edge transitions. Returns the edges that went quiet and when; quiet is a signal to investigate, not proof the dependency is healthy or removed.',
  {
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe('Max events to return (default 50)'),
    edgeType: z.string().optional().describe('Filter by edge type — e.g. "CALLS" or "CONNECTS_TO"'),
    project: projectField,
  },
  async (input) => getRecentStaleEdges(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'get_divergences',
  'When you need to find drift between declared code/config and observed behavior, return ranked divergences: missing edges, version or host mismatches, compatibility violations, symbol/field mismatches, and observed failures. Each result carries confidence and severity; use this for a broad audit before choosing a specific failing node.',
  {
    type: z
      .array(DivergenceTypeSchema)
      .optional()
      .describe(
        'Filter by divergence type. One or more of: missing-observed, missing-extracted, version-mismatch, host-mismatch, compat-violation, observed-symbol-mismatch, observed-failing. Omit for all.',
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
  async (input) => getDivergences(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'check_policies',
  'Before an edit, ask which architectural policies apply to its node; before a proposed action, dry-run its policy effect. Returns advisory rules or violations across structure, compatibility, provenance, ownership, and blast radius. Policies inform the agent; this tool does not block changes.',
  {
    scope: CheckPoliciesScopeSchema.optional().describe('Narrow to a subset. Default "all".'),
    hypotheticalAction: HypotheticalActionSchema.optional().describe(
      'Dry-run mode: simulate the action and return resulting violations. Omit for current state.',
    ),
    applicableTo: z
      .string()
      .optional()
      .describe(
        'Soft guardrail (ADR-108): pass the node id you are about to edit and check_policies returns the policies that govern it, as a context block — so you stay inside the lines. Advisory only; never blocks.',
      ),
    project: projectField,
  },
  async (input) =>
    checkPolicies(client, {
      ...input,
      project: projectFor(input),
    } as Parameters<typeof checkPolicies>[1]),
)

// ── /neat extend tools (ADR-081, ADR-086) ────────────────────────────────

registerTool(
  'neat_list_uninstrumented',
  'When the graph lacks expected runtime evidence, list project libraries outside automatic instrumentation coverage. Returns first-party, third-party, and gap libraries that may need an explicit instrumentation package.',
  { project: projectField },
  async (input) => neatListUninstrumented(client, { project: projectFor(input) }),
)

registerTool(
  'neat_lookup_instrumentation',
  'When a library is an instrumentation gap, look up its supported registry recipe. Returns the instrumentation package, matching version range, and registration snippet when one exists.',
  {
    library: z.string().describe('npm package name, e.g. "@prisma/client"'),
    installedVersion: z.string().optional().describe('Installed version for range matching'),
    project: projectField,
  },
  async (input) => neatLookupInstrumentation(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'neat_describe_project_instrumentation',
  "When OBSERVED evidence is missing, inspect this project's instrumentation wiring. Returns hook-file presence, .env.neat presence, and installed OTel dependencies before you change code.",
  { project: projectField },
  async (input) => neatDescribeProjectInstrumentation(client, { project: projectFor(input) }),
)

registerTool(
  'neat_apply_extension',
  'After reviewing an instrumentation gap and preferably previewing it, apply the chosen library extension. Installs the package and updates the OTel hook, package.json, and lockfile; repeating the same extension is a no-op.',
  {
    library: z.string().describe('The library being instrumented, e.g. "@prisma/client"'),
    instrumentation_package: z
      .string()
      .describe('The instrumentation npm package, e.g. "@prisma/instrumentation"'),
    version: z.string().describe('Semver range for the instrumentation package, e.g. "^6.0.0"'),
    registration_snippet: z
      .string()
      .describe(
        'The JS/TS snippet to splice into the instrumentations array, e.g. "instrumentations.push(new PrismaInstrumentation())"',
      ),
    project: projectField,
  },
  async (input) => neatApplyExtension(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'neat_dry_run_extension',
  'Before filling an instrumentation gap, preview the extension. Returns the exact file diff, dependencies, and install command without changing the project.',
  {
    library: z.string().describe('The library being instrumented, e.g. "@prisma/client"'),
    instrumentation_package: z
      .string()
      .describe('The instrumentation npm package, e.g. "@prisma/instrumentation"'),
    version: z.string().describe('Semver range for the instrumentation package, e.g. "^6.0.0"'),
    registration_snippet: z
      .string()
      .describe('The JS/TS snippet to splice into the instrumentations array'),
    project: projectField,
  },
  async (input) => neatDryRunExtension(client, { ...input, project: projectFor(input) }),
)

registerTool(
  'neat_rollback_extension',
  'If a library extension needs reversing, remove its package.json dependency and hook registration. Returns the rollback result; run the package manager afterward because this tool does not refresh the lockfile.',
  {
    library: z.string().describe('The library whose instrumentation should be rolled back'),
    project: projectField,
  },
  async (input) => neatRollbackExtension(client, { ...input, project: projectFor(input) }),
)

// ── Hosted connector tools (ADR-228) ──────────────────────────────────────
// The only tools that call the control plane (NEAT_CP_URL + a neat_pat_) rather
// than the daemon. connect/disconnect write connection state, never the graph.

registerTool(
  'neat_list_connectable',
  'When a hosted graph lacks provider-side evidence, list the providers this project can connect. Returns control-plane options, or a configuration note when NEAT_CP_URL and a neat_pat_ NEAT_API_KEY are unavailable.',
  {},
  async () => neatListConnectable(connectorDeps),
)

registerTool(
  'neat_connect',
  'When authorized to add hosted provider evidence, connect a listed provider with its API credential. The control plane verifies and seals the credential; the daemon then polls or receives the supported telemetry into OBSERVED. Hosted only.',
  {
    provider: z
      .string()
      .describe('Provider id, e.g. "supabase" or "railway" (see neat_list_connectable)'),
    credential: z
      .string()
      .describe(
        "The provider's own API token — e.g. a Supabase Management token (sbp_...) or a Railway account/team token. Sealed at rest; never stored in the graph or returned.",
      ),
  },
  async (input) => neatConnect(connectorDeps, input),
)

registerTool(
  'neat_connection_status',
  'When provider evidence is absent or stale in a hosted graph, inspect connections and their connecting, healthy, error, or needs-reconnect status. Returns control-plane state, not a live graph traversal.',
  {},
  async () => neatConnectionStatus(connectorDeps),
)

registerTool(
  'neat_disconnect',
  'When authorized to remove a hosted provider integration, disconnect it and drop its stored connection. Returns the control-plane result; this changes future provider evidence, not source code.',
  {
    provider: z.string().describe('Provider id to disconnect, e.g. "supabase"'),
  },
  async (input) => neatDisconnect(connectorDeps, input),
)

// Resources sit alongside tools — same data, different access pattern. Read
// the per-node resource for raw attrs+edges JSON; subscribe to the incidents
// resource to be notified when new errors land. The tools above are unchanged.
const incidentsPollMs = process.env.NEAT_RESOURCE_POLL_MS
  ? Number(process.env.NEAT_RESOURCE_POLL_MS)
  : undefined
const resourceRegistration = registerResources(server, client, {
  ...(incidentsPollMs !== undefined ? { incidentsPollMs } : {}),
  ...(defaultProject ? { project: defaultProject } : {}),
})

// Before the MCP handshake, confirm the resolved endpoint is actually NEAT.
// Resolution falls back to :8080 when it can't find a project daemon, and if
// another service holds that port the server would otherwise query it and hand
// the agent an opaque HTML/404 on every tool call (#1069). A single /health
// probe separates NEAT (proceed) from a confirmed-foreign service (fail fast
// with a clear fix) from merely-unreachable (proceed — a daemon may still be
// booting, or be gated behind auth this server lacks the token for; the per-
// request path reports that cleanly). NEAT_SKIP_ENDPOINT_CHECK=1 opts out.
async function guardEndpoint(): Promise<void> {
  const skip = process.env.NEAT_SKIP_ENDPOINT_CHECK
  if (skip === '1' || skip === 'true') return

  const check = await checkEndpointIsNeat(baseUrl, { bearerToken })
  if (check.kind === 'foreign') {
    console.error(describeForeignEndpoint(baseUrl, resolved.source, check))
    process.exit(1)
  }
}

async function main(): Promise<void> {
  await guardEndpoint()
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
