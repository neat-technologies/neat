// Investigation family: the tools that compose or trace an incident —
// get_root_cause, get_incident_history, get_incident_card, and investigate (the
// first call for a failing system). sessionIncidentLead (ADR-260) sits here too:
// it is not a registered tool, but it is the push side of the same incident lead
// investigate pulls, so it shares this module.

import type {
  ErrorEvent,
  IncidentCard,
  IncidentLead,
  GraphNode,
  RootCauseResult,
} from '@neat.is/types'
import { Provenance, serviceId } from '@neat.is/types'
import { HttpError, ProjectNotFoundError, type HttpClient } from '../client.js'
import {
  formatEmptyResponse,
  formatErrorResponse,
  formatToolResponse,
  type ToolResponse,
} from '../format.js'
// One shared renderer for the fused deploy/process/config context an incident
// carries (ADR-237/240) — the same one the CLI `neat incidents` output uses, so
// the two never drift (core #1373 — atomic, no feature mirrors another's fields).
import {
  deployContextsFor,
  changedSinceHealthyLines,
  deployHintLines,
} from '@neat.is/core/incidents-render'
import {
  emptyWithReadiness,
  projectPath,
  withMissingNodeFallback,
  type SearchResponse,
} from './shared.js'

export interface RootCauseInput {
  errorNode: string
  errorId?: string
  project?: string
}

export async function getRootCause(
  client: HttpClient,
  input: RootCauseInput,
): Promise<ToolResponse> {
  const qs = input.errorId ? `?errorId=${encodeURIComponent(input.errorId)}` : ''
  const path = projectPath(
    input.project,
    `/graph/root-cause/${encodeURIComponent(input.errorNode)}${qs}`,
  )

  return withMissingNodeFallback(
    client,
    input.project,
    async () => {
      const result = await client.get<RootCauseResult>(path)
      const arrowPath = result.traversalPath.join(' ← ')
      const provenances = result.edgeProvenances.length
        ? result.edgeProvenances.join(', ')
        : '(direct, no edges traversed)'
      const summary =
        `Root cause for ${input.errorNode} is ${result.rootCauseNode}. ` +
        result.rootCauseReason +
        (result.fixRecommendation ? ` Recommended fix: ${result.fixRecommendation}.` : '')
      const blockLines = [`Traversal path: ${arrowPath}`, `Edge provenances: ${provenances}`]
      if (result.fixRecommendation) {
        blockLines.push(`Recommended fix: ${result.fixRecommendation}`)
      }
      // Navigation (ADR-189): show the ranked candidate set with per-node
      // classification so the agent can weigh alternatives, not just relay one
      // verdict. A symptom-only node is a downstream victim — not the cause.
      if (result.candidates && result.candidates.length > 0) {
        blockLines.push('', 'Candidates (ranked, most likely cause first):')
        for (const c of result.candidates) {
          blockLines.push(
            `  • ${c.node} — ${c.classification} (confidence ${c.confidence.toFixed(2)}): ${c.reason}`,
          )
        }
      }
      return formatToolResponse({
        summary,
        block: blockLines.join('\n'),
        confidence: result.confidence,
        provenance: result.edgeProvenances.length ? result.edgeProvenances : undefined,
      })
    },
    `No root cause found for ${input.errorNode}. The node may be healthy, or it may not exist in the graph.`,
  )
}

export interface IncidentHistoryInput {
  nodeId: string
  limit?: number
  project?: string
}

export async function getIncidentHistory(
  client: HttpClient,
  input: IncidentHistoryInput,
): Promise<ToolResponse> {
  return withMissingNodeFallback(
    client,
    input.project,
    async () => {
      const body = await client.get<{ count: number; total: number; events: ErrorEvent[] }>(
        projectPath(input.project, `/incidents/${encodeURIComponent(input.nodeId)}`),
      )
      const events = body.events
      if (events.length === 0) {
        return formatEmptyResponse(`No incidents recorded against ${input.nodeId}.`)
      }
      // ndjson order is append-time = oldest first. Reverse so the most recent
      // event leads, then trim to the requested limit.
      const ordered = [...events].reverse().slice(0, input.limit ?? 20)
      const contexts = await deployContextsFor(ordered, (nodeId) =>
        client
          .get<{
            node?: { observedDeployContext?: unknown }
          }>(projectPath(input.project, `/graph/node/${encodeURIComponent(nodeId)}`))
          .then((r) => r.node),
      )
      const blockLines: string[] = []
      for (const ev of ordered) {
        blockLines.push(`  ${ev.timestamp} — ${ev.service}: ${ev.errorMessage}`)
        if (ev.exceptionType) blockLines.push(`    exception: ${ev.exceptionType}`)
        // The deploy/process/config context, read off the workload node (ADR-243)
        // and rendered by the one shared renderer the CLI `neat incidents` uses.
        for (const l of deployHintLines(contexts.get(ev.id))) blockLines.push(`    ${l}`)
        blockLines.push(`    trace=${ev.traceId} span=${ev.spanId}`)
      }
      return formatToolResponse({
        summary: `${input.nodeId} has ${body.total} recorded incident${body.total === 1 ? '' : 's'}; showing the ${ordered.length} most recent.`,
        block: blockLines.join('\n'),
        // ErrorEvents are observation records, not graph edges — provenance is
        // OBSERVED by definition (the OTel span happened).
        provenance: Provenance.OBSERVED,
      })
    },
    `Node ${input.nodeId} not found in the graph.`,
  )
}

// get_incident_card — one self-sufficient work order for an incident (ADR-221).
// The incident fused with its root-cause chain, blast radius, governing policies,
// and node divergence, each claim provenance-stamped, so an agent can act without
// grepping. errorId pins one incident; default is the node's most recent, and a
// node with none gets the card composed from the graph alone (ADR-244).
export interface IncidentCardInput {
  nodeId: string
  errorId?: string
  project?: string
}

// Fetch the composed incident card for an exact node id and render it (ADR-221,
// ADR-244). Shared by get_incident_card and investigate so the work order reads
// the same however the agent reached the node. `prefixLines` prepends a note —
// investigate records what it resolved the target to; get_incident_card passes
// none, so its output is unchanged.
async function composeCardResponse(
  client: HttpClient,
  project: string | undefined,
  nodeId: string,
  errorId: string | undefined,
  prefixLines: string[] = [],
): Promise<ToolResponse> {
  const qs = errorId ? `?errorId=${encodeURIComponent(errorId)}` : ''
  const card = await client.get<IncidentCard>(
    projectPath(project, `/graph/incident-card/${encodeURIComponent(nodeId)}${qs}`),
  )
  const lines: string[] = [...prefixLines]
  if (card.noIncident) {
    // Composed for a node with no recorded incident (ADR-244): the same card,
    // without the fields only an incident supplies.
    lines.push(`  ${card.affectedNode}: ${card.noIncident.reason}`)
  } else {
    lines.push(`  incident ${card.id} [${card.incidentKind}] at ${card.at}`)
    lines.push(`  ${card.message}`)
  }
  // What changed since healthy leads the card's body (ADR-270).
  for (const l of changedSinceHealthyLines(card.changedSinceHealthy)) lines.push(`  ${l}`)
  if (card.locus) {
    const l = card.locus
    lines.push(
      `  locus: ${l.symbol ? `${l.symbol} ` : ''}${l.file}${l.lineStart ? `:${l.lineStart}` : ''} [${l.provenance}]`,
    )
  } else if (card.noIncident) {
    lines.push('  locus: none — no incident, and no root-cause locus resolved')
  } else {
    lines.push('  locus: none recovered — service grain')
  }
  // ADR-268: when present, the ranked candidates lead — the grade judged the single
  // verdict too weak to commit to, so the card hands the failing-path candidates with
  // their mechanism and lets the agent select, rather than overshooting to one node.
  if (card.rankedCandidates && card.rankedCandidates.length > 0) {
    lines.push('  likely candidates (ranked; verdict is low-confidence — pick from these):')
    for (const c of card.rankedCandidates) {
      const bits = [c.classification, c.onset ? `onset=${c.onset}` : undefined].filter(Boolean)
      lines.push(`    • ${c.node}${bits.length ? ` [${bits.join(', ')}]` : ''}`)
      for (const e of c.evidence) lines.push(`        ${e}`)
    }
  }
  if (card.rootCause) {
    const rc = card.rootCause
    const label = card.rankedCandidates && card.rankedCandidates.length > 0 ? 'top candidate' : 'root cause'
    lines.push(
      `  ${label}: ${rc.node}${rc.classification ? ` (${rc.classification})` : ''} — ${rc.reason} [confidence ${rc.confidence.toFixed(2)}]`,
    )
    lines.push(`  chain: ${rc.chain.map((h) => `${h.node} [${h.provenance}]`).join(' → ')}`)
    if (rc.fix) lines.push(`  fix: ${rc.fix}`)
  } else {
    lines.push('  root cause: none reachable')
  }
  if (card.blastRadius) {
    lines.push(
      `  blast radius: ${card.blastRadius.totalAffected} node(s); nearest ${card.blastRadius.nearest.map((n) => n.node).join(', ')}`,
    )
  }
  if (card.policies && card.policies.length > 0) {
    lines.push(
      `  policies: ${card.policies.map((p) => `[${p.severity}] ${p.policyName}`).join('; ')}`,
    )
  }
  if (card.divergence && card.divergence.length > 0) {
    lines.push(`  divergence: ${card.divergence.map((d) => `${d.type} (${d.summary})`).join('; ')}`)
  }
  // The faulted workload's deploy context (ADR-240/241): the wrong host, the bad
  // flag, the boot traceback. The card carries it; this renders it.
  for (const l of deployHintLines(card.deployContext)) lines.push(`  ${l}`)
  if (card.grade) {
    // The grade and every factor, so the number can be audited (ADR-238).
    const g = card.grade
    const failed = Object.entries(g.gates)
      .filter(([, gate]) => !gate.passed)
      .map(([name]) => name)
    const factors = Object.entries(g.factors)
      .map(([name, f]) => `${name} ${f.value === null ? 'n/a' : f.value.toFixed(2)}`)
      .join(', ')
    lines.push(
      `  grade: ${g.G.toFixed(2)} (${g.band}) = Γ ${g.gamma}${failed.length ? ` [failed: ${failed.join(', ')}]` : ''} · C ${g.C.toFixed(2)} [${factors}] — priors ${g.priorsVersion}`,
    )
  }
  // A card from an incident rests on an observed failure. One composed for a
  // node with none claims only what its root-cause chain carries.
  const chainProvenances = [...new Set((card.rootCause?.chain ?? []).map((h) => h.provenance))]
  return formatToolResponse({
    summary: card.headline,
    block: lines.join('\n'),
    provenance: card.noIncident
      ? chainProvenances.length > 0
        ? chainProvenances
        : undefined
      : Provenance.OBSERVED,
  })
}

export async function getIncidentCard(
  client: HttpClient,
  input: IncidentCardInput,
): Promise<ToolResponse> {
  return withMissingNodeFallback(
    client,
    input.project,
    () => composeCardResponse(client, input.project, input.nodeId, input.errorId),
    `No incident card available for ${input.nodeId}.`,
  )
}

// investigate — the obvious first call for a failing system (ADR-258). Takes a
// service name, a symptom, or a node id, resolves it to a graph node, and returns
// the composed incident card (ADR-244): the same work order get_incident_card
// builds from an exact node id, with resolution in front so an agent that only has
// "payments" or a symptom still reaches it in one call. Resolution stays on the MCP
// surface (no new core route): a node id is used as-is; a bare name is tried as
// service:<name>, the common operations case; on a miss, the same search
// semantic_search runs picks the best node, and the card names what it resolved to
// and the alternatives — so a wrong top match costs one re-aim, not a dead end back
// to the shell.
const NODE_ID_PREFIX = /^[a-z][a-z0-9_-]*:/

// The culprit candidates of the incident lead (ADR-264), best first; [] when the
// daemon has none or can't be read.
async function leadNodes(client: HttpClient, project: string | undefined): Promise<string[]> {
  try {
    const lead = await client.get<IncidentLead>(projectPath(project, '/incidents/lead'))
    return (lead.ranked ?? []).map((r) => r.node)
  } catch {
    return []
  }
}

// A match counts as failing when it is the failing node, or the service a failing
// file or symbol belongs to (`file:<service>:…`, `symbol:<service>:…`).
function sameFailingNode(matchId: string, failingId: string): boolean {
  if (matchId === failingId) return true
  const m = /^(?:file|symbol):([^:]+):/.exec(failingId)
  return m !== null && matchId === serviceId(m[1]!)
}

export interface InvestigateInput {
  target: string
  errorId?: string
  project?: string
}

export async function investigate(
  client: HttpClient,
  input: InvestigateInput,
): Promise<ToolResponse> {
  const target = input.target.trim()
  if (target.length === 0) {
    return formatErrorResponse('investigate needs a service name, a symptom, or a node id.')
  }

  // Already a node id — compose its card directly.
  if (NODE_ID_PREFIX.test(target)) {
    return withMissingNodeFallback(
      client,
      input.project,
      () => composeCardResponse(client, input.project, target, input.errorId),
      `No incident card available for ${target}.`,
    )
  }

  // A bare name: the common case is a service. Try its service node first (built
  // through the identity helper, ADR-028). A service with no recorded incident
  // still returns its composed card (ADR-244), so only a genuinely absent service
  // node 404s and falls through to resolution.
  const serviceNode = serviceId(target)
  try {
    return await composeCardResponse(client, input.project, serviceNode, input.errorId, [
      `  resolved "${target}" → ${serviceNode}`,
    ])
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return formatErrorResponse(err.message)
    if (!(err instanceof HttpError) || err.status !== 404) {
      return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
    }
    // 404 → no such service node; resolve by description below.
  }

  // No direct service match: resolve the best-matching node by description — the
  // same search semantic_search runs — then compose that node's card.
  let matches: (GraphNode & { score?: number })[]
  try {
    const result = await client.get<SearchResponse>(
      projectPath(input.project, `/search?q=${encodeURIComponent(target)}`),
    )
    matches = result.matches
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return formatErrorResponse(err.message)
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }

  if (matches.length === 0) {
    return emptyWithReadiness(
      client,
      input.project,
      `Couldn't resolve "${target}" to a node. Try ask("${target}") for a plain-language answer, or pass a node id such as service:<name>.`,
    )
  }

  // A description resolves by text, and a text match can be any node: a generated
  // proto file, a React component, an idle deployment (#1481). When the project
  // has failing nodes and none of the top matches is one of them, the target
  // named no failure NEAT can see, so start from NEAT's lead culprit instead
  // (ADR-264) and say so. A top match that is failing still wins.
  const failing = await leadNodes(client, input.project)
  if (failing.length > 0) {
    const hit = matches.slice(0, 4).find((m) => failing.some((f) => sameFailingNode(m.id, f)))
    if (!hit) {
      const lead = failing[0]!
      return withMissingNodeFallback(
        client,
        input.project,
        () =>
          composeCardResponse(client, input.project, lead, input.errorId, [
            `  "${target}" names no failing node (closest text match: ${matches[0]!.id}, no incidents); starting from NEAT's lead culprit ${lead}`,
            `  other failing nodes: ${failing.slice(1, 4).join(', ') || 'none'} — or ask("${target}") for the ranked list`,
          ]),
        `No incident card available for ${lead}.`,
      )
    }
    if (hit !== matches[0]) matches = [hit, ...matches.filter((m) => m !== hit)]
  }

  const best = matches[0]!
  const others = matches.slice(1, 4).map((m) => m.id)
  const prefix = [
    `  resolved "${target}" → ${best.id}${others.length ? ` (other matches: ${others.join(', ')})` : ''}`,
  ]
  if (others.length > 0) {
    prefix.push(
      `  if that is the wrong node, re-run investigate with one of those ids, or ask("${target}")`,
    )
  }
  return withMissingNodeFallback(
    client,
    input.project,
    () => composeCardResponse(client, input.project, best.id, input.errorId, prefix),
    `No incident card available for ${best.id}.`,
  )
}

// The session-start lead (ADR-260, the push side). A one-line headline naming the
// node to start from, so the MCP server can open its instructions with it at
// connect and the agent reads the culprit before its first tool call, then reaches
// for investigate. The ranking is core's incident lead (ADR-264, `GET
// /incidents/lead`): onset before volume, traffic sources never the culprit, the
// same ranking `ask` answers with. Returns undefined when nothing is failing or the
// daemon can't be read — the caller falls back to the static protocol. The caller
// bounds the call; this swallows errors so an unreachable daemon costs the session
// nothing (direction.md rule 8).
export async function sessionIncidentLead(
  client: HttpClient,
  project: string | undefined,
): Promise<string | undefined> {
  let lead: IncidentLead
  try {
    lead = await client.get<IncidentLead>(projectPath(project, '/incidents/lead'))
  } catch {
    return undefined
  }
  const top = lead.ranked?.[0]
  if (!top) return undefined
  const kindBit = top.kind ? ` (${top.kind})` : ''
  const others =
    lead.ranked.length > 1 ? ` ${lead.ranked.length} nodes have open incidents; this is where to start.` : ''
  return `NEAT has a live incident on ${top.node}${kindBit} — call investigate("${top.node}") for the composed card (cause, blast radius, fix locus).${others}`
}
