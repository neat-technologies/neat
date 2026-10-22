// MCP Resources — additive surface alongside the tools. Resources:
//
//   neat://node/<id>          — one resource per graph node. Read returns the
//                                node attributes plus its outbound edges.
//   neat://incidents/recent   — most recent error events. Pollable by the SDK
//                                via subscribe; we send `notifications/resources/
//                                updated` when /incidents grows.
//   neat://status             — which project, binding and daemon this server
//                                answers from (project-identity.md §6), plus
//                                whether that daemon is reachable right now.
//
// Pure read helpers are exported so tests can exercise them without spinning up
// an MCP transport. `registerResources()` does the SDK wiring + the poll loop.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js'
import type {
  ListResourcesResult,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { ErrorEvent, GraphEdge, GraphNode, PolicyViolation } from '@neat.is/types'
import { HttpError, type HttpClient } from './client.js'

interface EdgesResponse {
  inbound: GraphEdge[]
  outbound: GraphEdge[]
}

interface SerializedGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

const NODE_RESOURCE_MIME = 'application/json'
const INCIDENTS_URI = 'neat://incidents/recent'
const INCIDENTS_DEFAULT_LIMIT = 50
const POLICY_VIOLATIONS_URI = 'neat://policies/violations'
const POLICY_VIOLATIONS_DEFAULT_LIMIT = 100
const STATUS_URI = 'neat://status'
const STATUS_MIME = 'text/plain'

function nodeUri(id: string): string {
  // Node ids contain `:` which RFC 6570 percent-encodes; doing it explicitly
  // here keeps the URI we hand the SDK identical to what `list` produces.
  return `neat://node/${encodeURIComponent(id)}`
}

// Project-aware URL prefix for the underlying core. When unset, hit the
// legacy unprefixed routes (which the core resolves to project=`default`).
function corePrefix(project: string | undefined): string {
  return project ? `/projects/${encodeURIComponent(project)}` : ''
}

function nameFromAttrs(attrs: GraphNode): string {
  return (attrs as { name?: string }).name ?? attrs.id
}

export async function listNodeResources(
  client: HttpClient,
  project?: string,
): Promise<ListResourcesResult> {
  const graph = await client.get<SerializedGraph>(`${corePrefix(project)}/graph`)
  return {
    resources: graph.nodes.map((n) => ({
      uri: nodeUri(n.id),
      name: nameFromAttrs(n),
      description: `${n.type} — ${nameFromAttrs(n)}`,
      mimeType: NODE_RESOURCE_MIME,
    })),
  }
}

export async function readNodeResource(
  client: HttpClient,
  id: string,
  project?: string,
): Promise<ReadResourceResult> {
  const uri = nodeUri(id)
  const prefix = corePrefix(project)
  try {
    const [nodeBody, edges] = await Promise.all([
      client.get<{ node: GraphNode }>(`${prefix}/graph/node/${encodeURIComponent(id)}`),
      client.get<EdgesResponse>(`${prefix}/graph/edges/${encodeURIComponent(id)}`),
    ])
    const body = {
      node: nodeBody.node,
      // Outbound only — the issue spec says "attrs + outbound edges". Inbound
      // edges are still reachable via the other endpoint and would double the
      // payload for hub nodes (e.g. a shared database).
      outboundEdges: edges.outbound,
    }
    return {
      contents: [
        {
          uri,
          mimeType: NODE_RESOURCE_MIME,
          text: JSON.stringify(body, null, 2),
        },
      ],
    }
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      return {
        contents: [
          {
            uri,
            mimeType: NODE_RESOURCE_MIME,
            text: JSON.stringify({ error: 'node not found', id }),
          },
        ],
      }
    }
    throw err
  }
}

export async function readPolicyViolationsResource(
  client: HttpClient,
  limit: number = POLICY_VIOLATIONS_DEFAULT_LIMIT,
  project?: string,
): Promise<ReadResourceResult> {
  const body = await client.get<{ violations: PolicyViolation[] }>(
    `${corePrefix(project)}/policies/violations`,
  )
  const violations = body.violations
  // Latest first; cap at limit so an exploding violations log doesn't blow
  // up the resource read. The full file is still on disk for forensic use.
  const ordered = [...violations].reverse().slice(0, limit)
  return {
    contents: [
      {
        uri: POLICY_VIOLATIONS_URI,
        mimeType: NODE_RESOURCE_MIME,
        text: JSON.stringify(
          { count: ordered.length, total: violations.length, violations: ordered },
          null,
          2,
        ),
      },
    ],
  }
}

// neat://status — the binding line (project-identity.md §6) that names which
// project, binding and daemon this MCP server answers from, plus a live
// reachability probe of that daemon. `bindingLine` is resolved once at server
// startup and threaded in through RegisterResourcesOptions; undefined (before
// WO-0.4 step 2 wires the resolver accessor) renders an explicit "unresolved"
// placeholder rather than a wrong-looking line. Exported so tests can drive it
// without an MCP transport, like the other read helpers.
export async function readStatusResource(
  client: HttpClient,
  bindingLine: string | undefined,
  project?: string,
): Promise<ReadResourceResult> {
  const line = bindingLine ?? 'project=<unresolved> · binding=<unknown> · daemon=<unresolved>'
  let reach: string
  try {
    await client.get(`${corePrefix(project)}/health`)
    reach = 'daemon: reachable'
  } catch (err) {
    const why =
      err instanceof HttpError
        ? `HTTP ${err.status}`
        : err instanceof Error
          ? err.message
          : String(err)
    reach = `daemon: unreachable (${why})`
  }
  return {
    contents: [{ uri: STATUS_URI, mimeType: STATUS_MIME, text: `${line}\n\n${reach}` }],
  }
}

export async function readRecentIncidentsResource(
  client: HttpClient,
  limit: number = INCIDENTS_DEFAULT_LIMIT,
  project?: string,
): Promise<ReadResourceResult> {
  const body = await client.get<{ count: number; total: number; events: ErrorEvent[] }>(
    `${corePrefix(project)}/incidents`,
  )
  const events = body.events
  // ndjson order is append-time = oldest first. Reverse so most-recent leads.
  const ordered = [...events].reverse().slice(0, limit)
  return {
    contents: [
      {
        uri: INCIDENTS_URI,
        mimeType: NODE_RESOURCE_MIME,
        text: JSON.stringify(
          { count: ordered.length, total: events.length, events: ordered },
          null,
          2,
        ),
      },
    ],
  }
}

// Pure helper so the poll loop can be tested without timers. Returns true when
// the visible state of /incidents has changed in a way subscribers should hear
// about. Compares total count + the id of the newest event — either is enough
// on its own, but the pair makes deletes (if they ever happen) survive a
// missed update.
export function incidentsChanged(
  prev: { total: number; lastId?: string } | null,
  next: { total: number; lastId?: string },
): boolean {
  if (!prev) return false // first observation seeds, doesn't notify
  if (prev.total !== next.total) return true
  if (prev.lastId !== next.lastId) return true
  return false
}

export interface RegisterResourcesOptions {
  // Poll interval for /incidents in ms. 5s by default; 0 disables polling.
  incidentsPollMs?: number
  // Project this MCP instance reports against. Unset → core's `default`
  // project via the legacy unprefixed URLs.
  project?: string
  // §6 binding line ("project=… · binding=… · daemon=…") served at
  // neat://status. Resolved once at startup (index.ts, WO-0.4 step 2). Unset
  // → the status read renders an "unresolved" placeholder.
  bindingLine?: string
}

export interface ResourceRegistration {
  // Stops the poll loop. The SDK keeps the registered resources around as
  // long as the server is alive — calling stop() doesn't unregister them.
  stop: () => void
}

export function registerResources(
  server: McpServer,
  client: HttpClient,
  options: RegisterResourcesOptions = {},
): ResourceRegistration {
  const pollMs = options.incidentsPollMs ?? 5000
  const project = options.project

  // neat://node/<id> — templated. The list callback enumerates current nodes;
  // the read callback resolves a specific id.
  server.registerResource(
    'graph-node',
    new ResourceTemplate('neat://node/{id}', {
      list: async () => listNodeResources(client, project),
    }),
    {
      description:
        'A single graph node by id. Reading returns the node attributes plus its outbound edges as JSON.',
      mimeType: NODE_RESOURCE_MIME,
    },
    async (_uri, variables) => {
      const raw = variables.id
      const id = Array.isArray(raw) ? raw[0] : raw
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error('neat://node/{id} requires an id')
      }
      const decoded = id.includes('%') ? decodeURIComponent(id) : id
      return readNodeResource(client, decoded, project)
    },
  )

  // neat://incidents/recent — static. Subscribers get notifications/resources/
  // updated on each tick where /incidents has changed.
  server.registerResource(
    'incidents-recent',
    INCIDENTS_URI,
    {
      description:
        'Most recent error events recorded by neat-core, newest first. JSON: { count, total, events[] }.',
      mimeType: NODE_RESOURCE_MIME,
    },
    async () => readRecentIncidentsResource(client, INCIDENTS_DEFAULT_LIMIT, project),
  )

  // neat://policies/violations — static. Same poll-and-notify pattern as
  // incidents. Subscribers get resource-updated notifications when the
  // policy-violations.ndjson grows. ADR-045.
  server.registerResource(
    'policies-violations',
    POLICY_VIOLATIONS_URI,
    {
      description:
        'Current policy violations from policy-violations.ndjson, newest first. JSON: { count, total, violations[] }.',
      mimeType: NODE_RESOURCE_MIME,
    },
    async () => readPolicyViolationsResource(client, POLICY_VIOLATIONS_DEFAULT_LIMIT, project),
  )

  // neat://status — static. The server's own binding line + a live daemon
  // reachability probe (project-identity.md §6). Not polled: a client reads it
  // when it wants to know what it is talking to.
  server.registerResource(
    'status',
    STATUS_URI,
    {
      description:
        "Which project, binding (local/hosted/pinned) and daemon this MCP server answers from (project-identity.md §6), plus whether that daemon is reachable right now. Read this to confirm what you are talking to.",
      mimeType: STATUS_MIME,
    },
    async () => readStatusResource(client, options.bindingLine, project),
  )

  let stopped = false
  let timer: NodeJS.Timeout | null = null
  let lastIncidents: { total: number; lastId?: string } | null = null
  let lastViolations: { total: number; lastId?: string } | null = null

  const tick = async (): Promise<void> => {
    if (stopped) return
    // Incidents poll.
    try {
      const incidents = await client.get<{ count: number; total: number; events: ErrorEvent[] }>(
        `${corePrefix(project)}/incidents`,
      )
      const events = incidents.events
      const next = {
        total: incidents.total,
        lastId: events.length > 0 ? events[events.length - 1].id : undefined,
      }
      if (incidentsChanged(lastIncidents, next)) {
        await server.server.sendResourceUpdated({ uri: INCIDENTS_URI }).catch(() => {})
      }
      lastIncidents = next
    } catch {
      // Core down — keep polling, next tick will catch up.
    }
    // Policy-violations poll. Fires the alert action's notifications/
    // resources/updated for neat://policies/violations subscribers per
    // ADR-044 §alert. Same change-detection shape as incidents.
    try {
      const polBody = await client.get<{ violations: PolicyViolation[] }>(
        `${corePrefix(project)}/policies/violations`,
      )
      const violations = polBody.violations
      const next = {
        total: violations.length,
        lastId:
          violations.length > 0 ? violations[violations.length - 1].id : undefined,
      }
      if (incidentsChanged(lastViolations, next)) {
        await server.server
          .sendResourceUpdated({ uri: POLICY_VIOLATIONS_URI })
          .catch(() => {})
      }
      lastViolations = next
    } catch {
      // Core down or no policies yet — keep polling.
    }
  }

  if (pollMs > 0) {
    // Seed `last` on first tick so we don't fire an "updated" notification
    // when the server first comes up.
    timer = setInterval(() => {
      void tick()
    }, pollMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  return {
    stop: (): void => {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
