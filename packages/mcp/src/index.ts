#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolveServerTarget } from './base-url.js'
import { createHttpClient, unresolvedClient } from './client.js'
import { checkEndpointIsNeat, describeForeignEndpoint } from './endpoint-check.js'
import { registerResources } from './resources.js'
import { setBindingLine } from './format.js'
import { hiddenTools, sessionLeadEnabled } from './session-surface.js'
import { allTools, sessionIncidentLead, type ToolContext } from './tools.js'
import { createConnectorDeps } from './connectors.js'

// ADR-273 — what this server talks to, resolved once at start: the project this
// session is in (or NEAT_PROJECT / an env pin), routed by its binding. When nothing
// resolves, every tool call answers with why, rather than querying loopback.
const target = resolveServerTarget()
const resolved = target
for (const n of target.notices) console.error(`neat-mcp: ${n}`)
// §6 (project-identity.md) — stamp the resolved target's binding line on every
// tool result, every tool error and neat://status, so the agent always knows
// which project and daemon answered. target.line is always set (including the
// "nothing resolved" form), so this is unconditional.
setBindingLine(target.line)
const baseUrl = resolved.url
// ADR-073 §3 + client-profiles.md §6 — the bearer comes from the same resolver
// that picked the URL, so a hosted profile's token rides with its endpoint while
// a local/loopback core still reads NEAT_AUTH_TOKEN. Empty/unset keeps the
// header off so a loopback dev core stays reachable.
const bearerToken = resolved.authToken
const client = target.error ? unresolvedClient(target.error) : createHttpClient(baseUrl, bearerToken)

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
  "NEAT does the investigation for this software system so you spend your effort on the code. It answers from a live graph fusing code, data, infrastructure, runtime traffic, incidents, and supported provider telemetry at the finest grain the evidence allows. These are NEAT's MCP tools (mcp__neat__*); load them before you reach for a shell.",
  'Start here when a system is failing, slow, crashing, or misbehaving. First call: investigate with the service or the symptom — one call composes the incident: the recorded failure with its deploy/env context, the likely cause and its provenance, the blast radius, the governing policies, and where declared and observed behavior diverge. If you already have the exact node, get_incident_card composes the same card; if you do not yet know what is failing, ask a plain-language question first. For detail: get_incident_history and get_root_cause on the failing node, get_divergences for declared-versus-observed drift, get_graph_diff for what changed, get_blast_radius and get_dependencies before an edit, expand and relate to test the cause one hop at a time. Reach for kubectl, logs, or grep after NEAT, or for what the graph does not model.',
  'Every claim carries provenance and confidence: EXTRACTED from source or config, OBSERVED from spans or supported provider signals, INFERRED from a bounded stitch, STALE when a once-seen edge goes quiet. A cluster read (kubectl get pods, a log tail) shows what the system looks like right now; NEAT reads what it actually did over time, fused to the exact service, file, and symbol — plus the declared-versus-observed divergence, the blast radius across observed edges, and the code locus of the failure, which a cluster read has no source for. One investigate call is the cheaper path to that answer.',
  'Trust each result by its provenance and stop once the fault is localized — the failing node and what is wrong with it. A graph answer is not a live call to a provider, and missing observations do not prove a path never runs. Use Read/Grep for comments, arbitrary literals, config minutiae, unsupported syntax, and repositories without a graph.',
].join('\n\n')

// Build the server, register every tool and resource, and return the pieces
// main() needs. A factory rather than module-top construction (ADR-260) so the
// session-start instructions can be composed from a guarded daemon read BEFORE
// the server is built — a stdio MCP server is a fresh process per Claude Code
// session, so "at construction" is "per connection" in practice.
function buildServer(instructions: string): {
  server: McpServer
  resourceRegistration: ReturnType<typeof registerResources>
} {
  const server = new McpServer(
    {
      name: 'neat',
      version: '0.1.0',
    },
    { instructions },
  )

  // Register the whole tool set as one loop over the registry (tools.ts). Each
  // tool's name is constrained to MCP_TOOL_NAMES via ToolDef, and the manifest
  // plus the contracts audit gate the set both ways, so the surface can't drift
  // from the contract. A lean session (NEAT_MCP_TOOLS=core, #1610) skips the
  // groups session-surface.ts names; every defineTool entry stays in source, so
  // the audit still sees the full manifest. build(ctx) closes each handler over
  // the resolved client / project resolver / connector deps.
  const hidden = hiddenTools()
  const ctx: ToolContext = { client, projectFor, connectorDeps }
  for (const def of allTools) {
    if (hidden.has(def.name)) continue
    server.tool(def.name, def.description, def.schema, def.build(ctx))
  }

  // Resources sit alongside tools — same data, different access pattern. Read
  // the per-node resource for raw attrs+edges JSON; subscribe to the incidents
  // resource to be notified when new errors land.
  const incidentsPollMs = process.env.NEAT_RESOURCE_POLL_MS
    ? Number(process.env.NEAT_RESOURCE_POLL_MS)
    : undefined
  const resourceRegistration = registerResources(server, client, {
    ...(incidentsPollMs !== undefined ? { incidentsPollMs } : {}),
    ...(defaultProject ? { project: defaultProject } : {}),
    bindingLine: target.line,
  })

  return { server, resourceRegistration }
}

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
  // Nothing resolved: there is no endpoint to probe; tools report why.
  if (target.error) return

  const check = await checkEndpointIsNeat(baseUrl, { bearerToken })
  if (check.kind === 'foreign') {
    console.error(describeForeignEndpoint(baseUrl, resolved.source, check))
    process.exit(1)
  }
}

// ADR-260 — the push side at session start. When the daemon holds live incidents,
// open the instructions with the top culprit so the agent reads it before its
// first tool call and reaches for investigate; otherwise fall back to the static
// protocol. Guarded (direction.md rule 8): the read is bounded so a slow or
// unreachable daemon never delays session start, and any failure is swallowed.
const SESSION_LEAD_TIMEOUT_MS = 1500

async function composeInstructions(): Promise<string> {
  // NEAT_SESSION_LEAD=0 (#1610): static instructions, identical every session,
  // so the client's prompt cache holds. No daemon read at startup either.
  if (!sessionLeadEnabled()) return serverInstructions
  const lead = await Promise.race([
    sessionIncidentLead(client, defaultProject).catch(() => undefined),
    new Promise<undefined>((resolve) => {
      setTimeout(() => resolve(undefined), SESSION_LEAD_TIMEOUT_MS).unref()
    }),
  ])
  return lead ? `${lead}\n\n${serverInstructions}` : serverInstructions
}

async function main(): Promise<void> {
  await guardEndpoint()
  const instructions = await composeInstructions()
  const { server, resourceRegistration } = buildServer(instructions)
  const stopPolling = (): void => {
    resourceRegistration.stop()
  }
  process.on('SIGTERM', stopPolling)
  process.on('SIGINT', stopPolling)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
