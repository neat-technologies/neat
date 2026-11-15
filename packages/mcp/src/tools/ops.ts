// Ops family (#1694): read-only operational views core already serves over REST
// but no MCP tool reached. These are an opt-in family (session-surface.ts), so
// they do not inflate the default surface; an agent opts in with
// NEAT_MCP_TOOLS=...,ops. Every answer is compact and capped.

import type { GraphEdge, IncidentLead } from '@neat.is/types'
import { Provenance } from '@neat.is/types'
import type { HttpClient } from '../client.js'
import {
  formatEmptyResponse,
  formatErrorResponse,
  formatToolResponse,
  type ToolResponse,
} from '../format.js'
import { projectPath, withMissingNodeFallback } from './shared.js'
import { z } from 'zod'
import { defineTool, projectField } from './registry.js'

// Shared caps so no ops answer runs long on a busy system.
const MAX_LINES = 40
const MAX_CHARS = 6000
const MSG_MAX = 160

function oneLine(s: string, max = 120): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// Append the "N more" pointer when a list was capped by count.
function cap(lines: string[], total: number, hint: string): string[] {
  return total > lines.length ? [...lines, `  … and ${total - lines.length} more. ${hint}`] : lines
}

// Clamp the whole block by chars as a hard backstop, independent of line count.
function clampChars(block: string, note: string): string {
  return block.length > MAX_CHARS ? `${block.slice(0, MAX_CHARS)}…\n  ${note}` : block
}

function fieldValue(v: unknown): string {
  if (v === undefined) return 'none'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 60 ? `${s.slice(0, 59)}…` : s
}

// ── get_logs ────────────────────────────────────────────────────────────────

export interface LogsInput {
  service?: string
  source?: string
  since?: string
  limit?: number
  project?: string
}

interface LogEntry {
  timestamp: string
  severity?: string
  serviceName?: string
  source: string
  message: string
}
interface LogsResponse {
  count: number
  total: number
  logs: LogEntry[]
}

export async function getLogs(client: HttpClient, input: LogsInput): Promise<ToolResponse> {
  const params = new URLSearchParams()
  if (input.service) params.set('service', input.service)
  if (input.source) params.set('source', input.source)
  if (input.since) params.set('since', input.since)
  params.set('limit', String(input.limit ?? 100))
  try {
    const r = await client.get<LogsResponse>(projectPath(input.project, `/logs?${params.toString()}`))
    if (r.logs.length === 0) {
      const scope = [input.service && `for ${input.service}`, input.source && `from ${input.source}`]
        .filter(Boolean)
        .join(' ')
      return formatEmptyResponse(`No logs recorded${scope ? ` ${scope}` : ''}.`)
    }
    // Ring buffer returns oldest-first; show newest first.
    const newest = [...r.logs].reverse()
    const shown = newest.slice(0, MAX_LINES)
    const lineFor = (l: LogEntry): string =>
      `  ${l.timestamp} [${l.severity ?? 'info'}] ${l.serviceName ?? l.source}: ${oneLine(l.message, MSG_MAX)}`
    const lines = cap(
      shown.map(lineFor),
      newest.length,
      'Raise limit, or narrow with service=, source= or since=, for more.',
    )
    const block = clampChars(lines.join('\n'), 'output truncated; narrow with service=/source=/since=.')
    return formatToolResponse({
      summary: `${r.total} log line${r.total === 1 ? '' : 's'} match; showing the ${Math.min(shown.length, MAX_LINES)} most recent, newest first.`,
      block,
      // Logs are observations.
      provenance: Provenance.OBSERVED,
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

// ── get_changes ───────────────────────────────────────────────────────────────

export interface ChangesInput {
  from?: string
  at?: string
  project?: string
}

interface HealthyChange {
  kind: string
  node: string
  change: string
  fields?: { path: string; before?: unknown; after?: unknown }[]
  distance?: number
}
interface ChangesResponse {
  at: string
  base: { takenAt: string } | null
  from?: string
  changes: HealthyChange[]
  provenance?: string
}

export async function getChanges(client: HttpClient, input: ChangesInput): Promise<ToolResponse> {
  const params = new URLSearchParams()
  if (input.at) params.set('at', input.at)
  if (input.from) params.set('from', input.from)
  const qs = params.size > 0 ? `?${params.toString()}` : ''
  return withMissingNodeFallback(
    client,
    input.project,
    async () => {
      const r = await client.get<ChangesResponse>(projectPath(input.project, `/graph/changes${qs}`))
      const basis = r.base ? `since the last healthy baseline (${r.base.takenAt})` : 'with no prior healthy baseline to compare against'
      if (r.changes.length === 0) {
        return formatEmptyResponse(`No changes ${basis}.`)
      }
      const lineFor = (c: HealthyChange): string => {
        const flds = c.fields?.length
          ? ` (${c.fields.map((f) => `${f.path}: ${fieldValue(f.before)} → ${fieldValue(f.after)}`).join('; ')})`
          : ''
        return `  • [${c.kind}] ${c.change} ${c.node}${flds}`
      }
      const lines = cap(
        r.changes.slice(0, MAX_LINES).map(lineFor),
        r.changes.length,
        'Pass from=<node> to scope to one neighbourhood.',
      )
      return formatToolResponse({
        summary: `${r.changes.length} change${r.changes.length === 1 ? '' : 's'} ${basis}${input.from ? `, near ${input.from}` : ''}.`,
        block: clampChars(lines.join('\n'), 'output truncated; scope with from=<node>.'),
        provenance: r.provenance ?? undefined,
      })
    },
    `Node ${input.from} not found in the graph.`,
  )
}

// ── graph_trust ───────────────────────────────────────────────────────────────

export interface GraphTrustInput {
  project?: string
}

interface Coverage {
  skippedFiles: number
  files?: string[]
  updatedAt?: string
}
interface HealthResponse {
  project?: string
  nodeCount?: number
  edgeCount?: number
  lastUpdated?: string
  coverage?: Coverage
}

export async function graphTrust(client: HttpClient, input: GraphTrustInput): Promise<ToolResponse> {
  try {
    // Coverage rides the per-project /health, so name the project even when the
    // caller didn't (an unset project resolves to the documented 'default').
    const named = input.project ?? 'default'
    const r = await client.get<HealthResponse>(projectPath(named, '/health'))
    const cov = r.coverage
    const coverageLine = !cov
      ? 'extraction coverage not recorded yet (the first scan may still be in flight)'
      : cov.skippedFiles === 0
        ? 'the last extraction pass was clean (0 files skipped)'
        : `${cov.skippedFiles} file${cov.skippedFiles === 1 ? '' : 's'} failed to parse in the last pass`
    const trust = !cov ? 'not ready' : cov.skippedFiles === 0 ? 'trustworthy' : 'partial'
    const summary =
      `Graph for ${r.project ?? named}: ${r.nodeCount ?? '?'} nodes, ${r.edgeCount ?? '?'} edges; ${coverageLine}. ` +
      `Trust: ${trust}.${r.lastUpdated ? ` Last updated ${r.lastUpdated}.` : ''}`
    const block =
      cov?.files && cov.files.length > 0
        ? `  files that failed to parse (sample): ${cov.files.slice(0, 10).join(', ')}`
        : ''
    return formatToolResponse({
      summary,
      block,
      confidence: !cov ? undefined : cov.skippedFiles === 0 ? 1 : 0.7,
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

// ── get_incident_lead ─────────────────────────────────────────────────────────

export interface IncidentLeadInput {
  project?: string
}

export async function getIncidentLead(
  client: HttpClient,
  input: IncidentLeadInput,
): Promise<ToolResponse> {
  try {
    const r = await client.get<IncidentLead>(projectPath(input.project, '/incidents/lead'))
    const top = r.ranked?.[0]
    if (!top) {
      return formatEmptyResponse('No open incidents in the window; nothing to lead with.')
    }
    const lineFor = (row: IncidentLead['ranked'][number]): string =>
      `  • ${row.node} — ${row.onset}, ${row.windowCount} in window (${row.count} total)${row.kind ? ` [${row.kind}]` : ''}: ${oneLine(row.message)}`
    const lines = cap(
      r.ranked.slice(0, MAX_LINES).map(lineFor),
      r.ranked.length,
      'Call investigate(<node>) for a card.',
    )
    const traffic =
      r.trafficSources && r.trafficSources.length > 0
        ? `\n  traffic sources (never culprits): ${r.trafficSources.slice(0, 5).map((t) => t.node).join(', ')}`
        : ''
    return formatToolResponse({
      summary: `Start with ${top.node} (${top.onset}). ${r.ranked.length} node${r.ranked.length === 1 ? '' : 's'} with incidents in the window; call investigate("${top.node}") for the composed card.`,
      block: clampChars(lines.join('\n'), 'output truncated.') + traffic,
      provenance: Provenance.OBSERVED,
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

// ── get_edges ─────────────────────────────────────────────────────────────────

export interface EdgesInput {
  nodeId: string
  project?: string
}

interface EdgesResponse {
  inbound: GraphEdge[]
  outbound: GraphEdge[]
}

export async function getEdges(client: HttpClient, input: EdgesInput): Promise<ToolResponse> {
  return withMissingNodeFallback(
    client,
    input.project,
    async () => {
      const r = await client.get<EdgesResponse>(
        projectPath(input.project, `/graph/edges/${encodeURIComponent(input.nodeId)}`),
      )
      if (r.inbound.length === 0 && r.outbound.length === 0) {
        return formatEmptyResponse(`${input.nodeId} has no edges in the graph.`)
      }
      const outbound = cap(
        r.outbound.slice(0, MAX_LINES).map((e) => `  → ${e.target} (${e.type}, ${e.provenance})`),
        r.outbound.length,
        'Use get_dependencies for a deeper walk.',
      )
      const inbound = cap(
        r.inbound.slice(0, MAX_LINES).map((e) => `  ← ${e.source} (${e.type}, ${e.provenance})`),
        r.inbound.length,
        'Use get_blast_radius for dependents.',
      )
      const block = [
        `Outbound (${r.outbound.length}):`,
        ...outbound,
        '',
        `Inbound (${r.inbound.length}):`,
        ...inbound,
      ].join('\n')
      const provenances = [...new Set([...r.inbound, ...r.outbound].map((e) => e.provenance))]
      return formatToolResponse({
        summary: `${input.nodeId}: ${r.outbound.length} outbound, ${r.inbound.length} inbound edge${r.inbound.length + r.outbound.length === 1 ? '' : 's'}.`,
        block,
        provenance: provenances.length ? provenances : undefined,
      })
    },
    `Node ${input.nodeId} not found in the graph.`,
  )
}

// ── connector_health ──────────────────────────────────────────────────────────

export interface ConnectorHealthInput {
  project?: string
}

interface ConnectorStatus {
  state: string
  lastPollAt: string | null
  lastOutcome: string | null
  lastError: string | null
  signalsLastPoll: number
}
interface ConnectorEntry {
  id: string
  provider: string
  status: ConnectorStatus
}
interface ConnectorsResponse {
  connectors: ConnectorEntry[]
}

export async function connectorHealth(
  client: HttpClient,
  input: ConnectorHealthInput,
): Promise<ToolResponse> {
  try {
    const r = await client.get<ConnectorsResponse>(projectPath(input.project, '/connectors'))
    if (r.connectors.length === 0) {
      return formatEmptyResponse('No connectors are configured on this daemon.')
    }
    const tally = new Map<string, number>()
    for (const c of r.connectors) tally.set(c.status.state, (tally.get(c.status.state) ?? 0) + 1)
    const tallyLine = [...tally.entries()].map(([state, n]) => `${n} ${state}`).join(', ')
    const lineFor = (c: ConnectorEntry): string => {
      const s = c.status
      const poll = s.lastPollAt ? `last poll ${s.lastPollAt}` : 'never polled'
      const err = s.lastError ? `, error: ${oneLine(s.lastError)}` : ''
      return `  • ${c.provider} ${c.id}: ${s.state}; ${poll}; ${s.signalsLastPoll} signal${s.signalsLastPoll === 1 ? '' : 's'} last poll${err}`
    }
    return formatToolResponse({
      summary: `${r.connectors.length} connector${r.connectors.length === 1 ? '' : 's'}: ${tallyLine}.`,
      block: r.connectors.map(lineFor).join('\n'),
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

export const opsTools = [
  defineTool({
    name: 'get_logs',
    description:
      'Recent log lines for this project, newest first, instead of tailing a file. Filter by service, by source (native, supabase, railway, firebase, cloudflare, vercel) and by since (ISO time); the answer is capped by lines and characters, so raise limit or narrow the filters to see more. Each line is time, severity, service or source, and the message.',
    schema: {
      service: z.string().optional().describe('Only this service.'),
      source: z
        .string()
        .optional()
        .describe('Only this log source: native, supabase, railway, firebase, cloudflare, or vercel.'),
      since: z.string().optional().describe('Only lines at or after this ISO 8601 time.'),
      limit: z.number().int().positive().max(500).optional().describe('How many recent lines to fetch (default 100).'),
      project: projectField,
    },
    build: (ctx) => async (input) => getLogs(ctx.client, { ...input, project: ctx.projectFor(input) }),
  }),
  defineTool({
    name: 'get_changes',
    description:
      'What changed since the system was last healthy: served feature-flag changes, infrastructure or spec changes, and edges that started erroring, each with the fields that moved. Distinct from get_graph_diff, which compares against a saved snapshot. Pass from=<node id> to scope to one neighbourhood, or at=<ISO time> to pick the compare point.',
    schema: {
      from: z.string().optional().describe('Scope to changes near this node id.'),
      at: z.string().optional().describe('Compare as of this ISO 8601 time (default: the current incident onset, else now).'),
      project: projectField,
    },
    build: (ctx) => async (input) => getChanges(ctx.client, { ...input, project: ctx.projectFor(input) }),
  }),
  defineTool({
    name: 'graph_trust',
    description:
      'Is the graph current and trustworthy here before you rely on its answers? Returns the node and edge counts and the last extraction pass: clean, partial (files failed to parse), or not yet recorded (first scan in flight). Check this when a tool comes back empty or thin, to tell a real empty answer from a still-building index.',
    schema: { project: projectField },
    build: (ctx) => async (input) => graphTrust(ctx.client, { project: ctx.projectFor(input) }),
  }),
  defineTool({
    name: 'get_incident_lead',
    description:
      'Where to start: the ranked culprit across the whole system, onset before volume, with traffic sources listed apart (never culprits). The same ranking investigate and the session-start lead use. Reach for this to pick the node to investigate when several things are failing; then call investigate(<node>) for the composed card.',
    schema: { project: projectField },
    build: (ctx) => async (input) => getIncidentLead(ctx.client, { project: ctx.projectFor(input) }),
  }),
  defineTool({
    name: 'get_edges',
    description:
      "One node's raw inbound and outbound edges, finer than the get_dependencies and get_blast_radius rollups: each edge with its type and provenance. Use it when you want the exact edge set on a node rather than a traversal summary.",
    schema: {
      nodeId: z.string().describe('Graph node id to read edges for.'),
      project: projectField,
    },
    build: (ctx) => async (input) => getEdges(ctx.client, { ...input, project: ctx.projectFor(input) }),
  }),
  defineTool({
    name: 'connector_health',
    description:
      "This self-hosted daemon's provider connectors and their poll health: idle, healthy, error or stale, with the last poll time, the last outcome, how many signals the last poll returned, and any error. Distinct from neat_connection_status, which reads the hosted control plane. Use it to check whether provider evidence is flowing.",
    schema: { project: projectField },
    build: (ctx) => async (input) => connectorHealth(ctx.client, { project: ctx.projectFor(input) }),
  }),
]
