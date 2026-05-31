// Tool implementations. Each one takes an HttpClient + the validated input and
// returns an MCP CallToolResult routed through formatToolResponse for the
// three-part shape (NL + structured + footer) per ADR-039 / contract #12.
// Keeping these as pure functions of (client, input) means tests don't need a
// running server — just a stub client that returns canned JSON.

import type {
  BlastRadiusAffectedNode,
  BlastRadiusResult,
  Divergence,
  DivergenceResult,
  DivergenceType,
  ErrorEvent,
  GraphEdge,
  GraphNode,
  HypotheticalAction,
  PolicyViolation,
  RootCauseResult,
  TransitiveDependenciesResult,
} from '@neat.is/types'
import { Provenance } from '@neat.is/types'
import { HttpError, type HttpClient } from './client.js'
import {
  formatEmptyResponse,
  formatErrorResponse,
  formatToolResponse,
  type ToolResponse,
} from './format.js'

export type { ToolResponse } from './format.js'

// Project-aware path builder. When `project` is set, route through
// /projects/<name>/...; otherwise hit the legacy root URL (which the core
// resolves to project=`default`). Keeping the legacy path means callers
// running an older core still talk to a known route.
function projectPath(project: string | undefined, suffix: string): string {
  if (!project) return suffix
  return `/projects/${encodeURIComponent(project)}${suffix}`
}

// Most tools want "node missing → friendly message, anything else → real error".
async function withMissingNodeFallback(
  fn: () => Promise<ToolResponse>,
  notFoundMessage: string,
): Promise<ToolResponse> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      return formatEmptyResponse(notFoundMessage)
    }
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

export interface RootCauseInput {
  errorNode: string
  errorId?: string
  project?: string
}

export async function getRootCause(client: HttpClient, input: RootCauseInput): Promise<ToolResponse> {
  const qs = input.errorId ? `?errorId=${encodeURIComponent(input.errorId)}` : ''
  const path = projectPath(
    input.project,
    `/graph/root-cause/${encodeURIComponent(input.errorNode)}${qs}`,
  )

  return withMissingNodeFallback(async () => {
    const result = await client.get<RootCauseResult>(path)
    const arrowPath = result.traversalPath.join(' ← ')
    const provenances = result.edgeProvenances.length
      ? result.edgeProvenances.join(', ')
      : '(direct, no edges traversed)'
    const summary =
      `Root cause for ${input.errorNode} is ${result.rootCauseNode}. ` +
      result.rootCauseReason +
      (result.fixRecommendation ? ` Recommended fix: ${result.fixRecommendation}.` : '')
    const blockLines = [
      `Traversal path: ${arrowPath}`,
      `Edge provenances: ${provenances}`,
    ]
    if (result.fixRecommendation) {
      blockLines.push(`Recommended fix: ${result.fixRecommendation}`)
    }
    return formatToolResponse({
      summary,
      block: blockLines.join('\n'),
      confidence: result.confidence,
      provenance: result.edgeProvenances.length ? result.edgeProvenances : undefined,
    })
  }, `No root cause found for ${input.errorNode}. The node may be healthy, or it may not exist in the graph.`)
}

export interface BlastRadiusInput {
  nodeId: string
  depth?: number
  project?: string
}

export async function getBlastRadius(
  client: HttpClient,
  input: BlastRadiusInput,
): Promise<ToolResponse> {
  const qs = input.depth !== undefined ? `?depth=${input.depth}` : ''
  const path = projectPath(
    input.project,
    `/graph/blast-radius/${encodeURIComponent(input.nodeId)}${qs}`,
  )

  return withMissingNodeFallback(async () => {
    const result = await client.get<BlastRadiusResult>(path)
    if (result.totalAffected === 0) {
      return formatEmptyResponse(
        `${result.origin} has no downstream dependencies. Nothing else would break if it failed.`,
      )
    }
    const sorted = [...result.affectedNodes].sort(
      (a, b) => a.distance - b.distance || a.nodeId.localeCompare(b.nodeId),
    )
    const blockLines = sorted.map(formatBlastEntry)
    // Worst-case confidence — the path with the lowest cascaded confidence
    // is the headline number; agents should treat this as "what's the
    // weakest reachability NEAT actually knows about?"
    const minConfidence = sorted.reduce(
      (m, n) => Math.min(m, n.confidence),
      Number.POSITIVE_INFINITY,
    )
    const provenances = [...new Set(sorted.map((n) => n.edgeProvenance))]
    return formatToolResponse({
      summary: `Blast radius for ${result.origin}: ${result.totalAffected} affected node${result.totalAffected === 1 ? '' : 's'} reachable downstream.`,
      block: blockLines.join('\n'),
      confidence: Number.isFinite(minConfidence) ? minConfidence : undefined,
      provenance: provenances.length ? provenances : undefined,
    })
  }, `Node ${input.nodeId} not found in the graph.`)
}

function formatBlastEntry(n: BlastRadiusAffectedNode): string {
  const tag = n.edgeProvenance === Provenance.STALE ? ' [STALE — last seen too long ago]' : ''
  return `  • ${n.nodeId} (distance ${n.distance}, ${n.edgeProvenance})${tag}`
}

interface EdgesResponse {
  inbound: GraphEdge[]
  outbound: GraphEdge[]
}

export interface DependenciesInput {
  nodeId: string
  // BFS depth. Default 3; max 10. Direct-only consumers pass 1.
  depth?: number
  project?: string
}

// Transitive get_dependencies (issue #144). Calls the core endpoint
// /graph/dependencies/:nodeId?depth=N which BFS-walks outbound. The output
// groups results by hop so direct dependencies stand out from transitives —
// agents asked "what does X depend on?" usually want the direct list with
// transitives as context.
export async function getDependencies(
  client: HttpClient,
  input: DependenciesInput,
): Promise<ToolResponse> {
  const depth = input.depth ?? 3
  const path = projectPath(
    input.project,
    `/graph/dependencies/${encodeURIComponent(input.nodeId)}?depth=${depth}`,
  )

  return withMissingNodeFallback(async () => {
    const result = await client.get<TransitiveDependenciesResult>(path)
    if (result.total === 0) {
      return formatEmptyResponse(
        depth === 1
          ? `${input.nodeId} has no direct dependencies in the graph.`
          : `${input.nodeId} has no dependencies (BFS to depth ${depth}).`,
      )
    }
    // Group by distance so the structured block reads as concentric rings.
    const byDistance = new Map<number, typeof result.dependencies>()
    for (const dep of result.dependencies) {
      const ring = byDistance.get(dep.distance) ?? []
      ring.push(dep)
      byDistance.set(dep.distance, ring)
    }
    const blockLines: string[] = []
    for (const distance of [...byDistance.keys()].sort((a, b) => a - b)) {
      const label = distance === 1 ? 'Direct (distance 1)' : `Distance ${distance}`
      blockLines.push(`${label}:`)
      for (const dep of byDistance.get(distance)!) {
        blockLines.push(`  • ${dep.nodeId} — ${dep.edgeType} (${dep.provenance})`)
      }
    }
    const provenances = [...new Set(result.dependencies.map((d) => d.provenance))]
    const directCount = byDistance.get(1)?.length ?? 0
    const summary =
      depth === 1
        ? `${input.nodeId} has ${directCount} direct dependenc${directCount === 1 ? 'y' : 'ies'}.`
        : `${input.nodeId} has ${result.total} dependenc${result.total === 1 ? 'y' : 'ies'} reachable to depth ${depth} (${directCount} direct).`
    return formatToolResponse({
      summary,
      block: blockLines.join('\n'),
      provenance: provenances,
    })
  }, `Node ${input.nodeId} not found in the graph.`)
}

export async function getObservedDependencies(
  client: HttpClient,
  input: DependenciesInput,
): Promise<ToolResponse> {
  return withMissingNodeFallback(async () => {
    const edges = await client.get<EdgesResponse>(
      projectPath(input.project, `/graph/edges/${encodeURIComponent(input.nodeId)}`),
    )
    const observed = edges.outbound.filter((e) => e.provenance === Provenance.OBSERVED)
    if (observed.length === 0) {
      const hasExtracted = edges.outbound.some((e) => e.provenance === Provenance.EXTRACTED)
      const note = hasExtracted
        ? ' Static (EXTRACTED) dependencies exist but no runtime traffic has been seen — is OTel running?'
        : ''
      return formatEmptyResponse(`No OBSERVED dependencies for ${input.nodeId}.${note}`)
    }
    const blockLines = observed.map((e) => `  • ${e.target} — ${e.type}${edgeMeta(e)}`)
    return formatToolResponse({
      summary: `${input.nodeId} has ${observed.length} runtime dependenc${observed.length === 1 ? 'y' : 'ies'} confirmed by OTel.`,
      block: blockLines.join('\n'),
      provenance: Provenance.OBSERVED,
    })
  }, `Node ${input.nodeId} not found in the graph.`)
}

function edgeMeta(e: GraphEdge): string {
  const bits: string[] = []
  if (e.signal) {
    // Prefer the runtime signal numbers — "saw 1,247 calls, 3 errors" reads
    // better than a derived 0.94 confidence.
    bits.push(`spans=${e.signal.spanCount}`)
    if (e.signal.errorCount > 0) bits.push(`errors=${e.signal.errorCount}`)
    if (e.signal.lastObservedAgeMs !== undefined) {
      bits.push(`age=${formatDuration(e.signal.lastObservedAgeMs)}`)
    }
  } else if (e.callCount !== undefined) {
    bits.push(`callCount=${e.callCount}`)
  }
  if (e.lastObserved) bits.push(`lastObserved=${e.lastObserved}`)
  if (e.confidence !== undefined) bits.push(`confidence=${e.confidence}`)
  return bits.length ? ` [${bits.join(', ')}]` : ''
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
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
  return withMissingNodeFallback(async () => {
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
    const blockLines: string[] = []
    for (const ev of ordered) {
      blockLines.push(`  ${ev.timestamp} — ${ev.service}: ${ev.errorMessage}`)
      blockLines.push(`    trace=${ev.traceId} span=${ev.spanId}`)
    }
    return formatToolResponse({
      summary: `${input.nodeId} has ${body.total} recorded incident${body.total === 1 ? '' : 's'}; showing the ${ordered.length} most recent.`,
      block: blockLines.join('\n'),
      // ErrorEvents are observation records, not graph edges — provenance is
      // OBSERVED by definition (the OTel span happened).
      provenance: Provenance.OBSERVED,
    })
  }, `Node ${input.nodeId} not found in the graph.`)
}

export interface SemanticSearchInput {
  query: string
  project?: string
}

interface SearchResponse {
  query: string
  provider?: 'ollama' | 'transformers' | 'substring'
  matches: (GraphNode & { score?: number })[]
}

export async function semanticSearch(
  client: HttpClient,
  input: SemanticSearchInput,
): Promise<ToolResponse> {
  try {
    const result = await client.get<SearchResponse>(
      projectPath(input.project, `/search?q=${encodeURIComponent(input.query)}`),
    )
    if (result.matches.length === 0) {
      return formatEmptyResponse(`No matches for "${input.query}".`)
    }
    const provider = result.provider ?? 'substring'
    const blockLines: string[] = []
    let topScore: number | undefined
    for (const n of result.matches) {
      // Embedding tiers attach a cosine score in [0,1]; substring fallback
      // doesn't, so we elide the score when it's the placeholder 1.
      const score = provider !== 'substring' && typeof n.score === 'number' ? n.score : undefined
      const scoreBit = score !== undefined ? ` [score=${score.toFixed(2)}]` : ''
      if (score !== undefined && (topScore === undefined || score > topScore)) topScore = score
      blockLines.push(
        `  • ${n.id} (${n.type}) — ${(n as { name?: string }).name ?? n.id}${scoreBit}`,
      )
    }
    return formatToolResponse({
      summary: `Found ${result.matches.length} match${result.matches.length === 1 ? '' : 'es'} for "${input.query}" via ${provider} provider.`,
      block: blockLines.join('\n'),
      // Top similarity score doubles as a "how confident is the embedder
      // about the best match" signal. Substring provider returns no score —
      // the footer shows n/a in that case.
      confidence: topScore,
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

export interface GraphDiffInput {
  againstSnapshot: string
  project?: string
}

interface GraphDiffResponse {
  base: { exportedAt?: string }
  current: { exportedAt: string }
  added: { nodes: GraphNode[]; edges: GraphEdge[] }
  removed: { nodes: GraphNode[]; edges: GraphEdge[] }
  changed: {
    nodes: { id: string; before: GraphNode; after: GraphNode }[]
    edges: { id: string; before: GraphEdge; after: GraphEdge }[]
  }
}

export async function getGraphDiff(
  client: HttpClient,
  input: GraphDiffInput,
): Promise<ToolResponse> {
  try {
    const result = await client.get<GraphDiffResponse>(
      projectPath(
        input.project,
        `/graph/diff?against=${encodeURIComponent(input.againstSnapshot)}`,
      ),
    )
    const total =
      result.added.nodes.length +
      result.added.edges.length +
      result.removed.nodes.length +
      result.removed.edges.length +
      result.changed.nodes.length +
      result.changed.edges.length
    const baseLabel = result.base.exportedAt ?? 'unknown'
    if (total === 0) {
      return formatEmptyResponse(
        `No differences between the current graph and ${input.againstSnapshot} (base exportedAt=${baseLabel}).`,
      )
    }
    const blockLines: string[] = [
      `  base exportedAt:    ${baseLabel}`,
      `  current exportedAt: ${result.current.exportedAt}`,
      '',
    ]
    if (result.added.nodes.length || result.added.edges.length) {
      blockLines.push('Added:')
      for (const n of result.added.nodes) blockLines.push(`  + node ${n.id} (${n.type})`)
      for (const e of result.added.edges)
        blockLines.push(`  + edge ${e.id} — ${e.source} -> ${e.target} (${e.type}, ${e.provenance})`)
      blockLines.push('')
    }
    if (result.removed.nodes.length || result.removed.edges.length) {
      blockLines.push('Removed:')
      for (const n of result.removed.nodes) blockLines.push(`  - node ${n.id} (${n.type})`)
      for (const e of result.removed.edges)
        blockLines.push(`  - edge ${e.id} — ${e.source} -> ${e.target} (${e.type}, ${e.provenance})`)
      blockLines.push('')
    }
    if (result.changed.nodes.length || result.changed.edges.length) {
      blockLines.push('Changed:')
      for (const c of result.changed.nodes) {
        blockLines.push(`  ~ node ${c.id} — ${summariseAttrDiff(c.before, c.after)}`)
      }
      for (const c of result.changed.edges) {
        const provBit =
          c.before.provenance !== c.after.provenance
            ? `provenance ${c.before.provenance} → ${c.after.provenance}`
            : summariseAttrDiff(c.before, c.after)
        blockLines.push(`  ~ edge ${c.id} — ${provBit}`)
      }
    }
    return formatToolResponse({
      summary: `Diff against ${input.againstSnapshot}: ${total} change${total === 1 ? '' : 's'} between the snapshot and the live graph.`,
      block: blockLines.join('\n').trimEnd(),
      // Diff results don't have a per-result provenance — the diff spans
      // every edge type and provenance kind. Footer shows n/a.
    })
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) {
      return formatErrorResponse(
        `Could not load snapshot ${input.againstSnapshot}: ${err.message}`,
      )
    }
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

function summariseAttrDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed: string[] = []
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed.push(k)
  }
  return changed.length === 0
    ? 'attributes differ'
    : `fields changed: ${changed.sort().join(', ')}`
}

export interface RecentStaleEdgesInput {
  limit?: number
  edgeType?: string
  project?: string
}

interface StaleEventResponse {
  edgeId: string
  source: string
  target: string
  edgeType: string
  thresholdMs: number
  ageMs: number
  lastObserved: string
  transitionedAt: string
}

export async function getRecentStaleEdges(
  client: HttpClient,
  input: RecentStaleEdgesInput,
): Promise<ToolResponse> {
  const params = new URLSearchParams()
  if (input.limit !== undefined) params.set('limit', String(input.limit))
  if (input.edgeType) params.set('edgeType', input.edgeType)
  const qs = params.size > 0 ? `?${params.toString()}` : ''

  try {
    const body = await client.get<{ count: number; total: number; events: StaleEventResponse[] }>(
      projectPath(input.project, `/stale-events${qs}`),
    )
    const events = body.events
    if (events.length === 0) {
      return formatEmptyResponse(
        input.edgeType
          ? `No stale ${input.edgeType} edges recorded.`
          : 'No stale-edge transitions recorded yet.',
      )
    }
    const blockLines = events.map(
      (e) =>
        `  ${e.transitionedAt} — ${e.source} -[${e.edgeType}]-> ${e.target}` +
        ` (last seen ${e.lastObserved}, threshold ${formatDuration(e.thresholdMs)})`,
    )
    return formatToolResponse({
      summary: `${events.length} stale-edge transition${events.length === 1 ? '' : 's'} recorded${input.edgeType ? ` for ${input.edgeType}` : ''}.`,
      block: blockLines.join('\n'),
      // STALE by definition — every event is a transition into STALE.
      provenance: Provenance.STALE,
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

export interface CheckPoliciesInput {
  // 'all' (default) returns every current violation. 'unresolved' is reserved
  // for future resolution tracking — for the MVP it behaves the same as 'all'.
  // { policyId } narrows to violations of one named policy.
  scope?: 'all' | 'unresolved' | { policyId: string }
  // When provided, dry-run evaluation: return violations that *would* result
  // if the action were applied. Without it, return current violations.
  hypotheticalAction?: HypotheticalAction
  project?: string
}

interface PoliciesCheckResponse {
  allowed: boolean
  hypotheticalAction?: HypotheticalAction
  violations: PolicyViolation[]
}

// check_policies — single MCP tool covering both state-read and dry-run modes
// per ADR-045. The contract explicitly rejects the audit's two-tool split
// (evaluate_policy + get_policy_violations); both modes route through here.
export async function checkPolicies(
  client: HttpClient,
  input: CheckPoliciesInput,
): Promise<ToolResponse> {
  try {
    let violations: PolicyViolation[]
    let allowed = true
    let hypothetical: HypotheticalAction | undefined

    if (input.hypotheticalAction) {
      // Dry-run via POST /policies/check.
      const body = await postJson<PoliciesCheckResponse>(
        client,
        projectPath(input.project, '/policies/check'),
        { hypotheticalAction: input.hypotheticalAction },
      )
      violations = body.violations
      allowed = body.allowed
      hypothetical = body.hypotheticalAction
    } else {
      // State read via GET /policies/violations. Optional scope filters via
      // ?policyId=, severity isn't surfaced in the tool input today.
      const qsParams = new URLSearchParams()
      if (typeof input.scope === 'object' && 'policyId' in input.scope) {
        qsParams.set('policyId', input.scope.policyId)
      }
      const qs = qsParams.size > 0 ? `?${qsParams.toString()}` : ''
      const body = await client.get<{ violations: PolicyViolation[] }>(
        projectPath(input.project, `/policies/violations${qs}`),
      )
      violations = body.violations
      allowed = violations.every((v) => v.onViolation !== 'block')
    }

    if (violations.length === 0) {
      return formatEmptyResponse(
        hypothetical
          ? `No violations would result from the hypothetical action (${hypothetical.kind}).`
          : 'No policy violations recorded.',
      )
    }

    const blockCount = violations.filter((v) => v.onViolation === 'block').length
    const summaryParts: string[] = []
    if (hypothetical) {
      summaryParts.push(
        `Hypothetical ${hypothetical.kind} would surface ${violations.length} violation${violations.length === 1 ? '' : 's'}`,
      )
    } else {
      summaryParts.push(
        `${violations.length} policy violation${violations.length === 1 ? '' : 's'} currently recorded`,
      )
    }
    if (blockCount > 0) {
      summaryParts.push(`${blockCount} of which block`)
    }
    if (!allowed && hypothetical) {
      summaryParts.push('action denied')
    }
    const summary = summaryParts.join('; ') + '.'

    const blockLines = violations.map((v) => {
      const subject = v.subject.nodeId ?? v.subject.edgeId ?? v.subject.path?.[0] ?? '(global)'
      return `  • [${v.severity}/${v.onViolation}] ${v.policyName}: ${v.message} — ${subject}`
    })
    const severities = [...new Set(violations.map((v) => v.severity))]
    return formatToolResponse({
      summary,
      block: blockLines.join('\n'),
      // Confidence: hypothetical results inherit a 0.7 cap (the engine
      // can't fully simulate every action shape in MVP); confirmed
      // violations report 1.00 since the engine ran against current state.
      confidence: hypothetical ? 0.7 : 1,
      provenance: severities.join(' '),
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

// ──────────────────────────────────────────────────────────────────────────
// get_divergences (ADR-060) — the thesis surface
// ──────────────────────────────────────────────────────────────────────────

export interface DivergencesInput {
  type?: ReadonlyArray<DivergenceType>
  minConfidence?: number
  node?: string
  project?: string
}

function buildDivergencesPath(input: DivergencesInput): string {
  const params = new URLSearchParams()
  if (input.type && input.type.length > 0) params.set('type', input.type.join(','))
  if (input.minConfidence !== undefined) {
    params.set('minConfidence', String(input.minConfidence))
  }
  if (input.node) params.set('node', input.node)
  const qs = params.size > 0 ? `?${params.toString()}` : ''
  return projectPath(input.project, `/graph/divergences${qs}`)
}

function formatDivergenceLine(d: Divergence): string {
  switch (d.type) {
    case 'missing-observed':
      return `  • [${d.type}] ${d.source} → ${d.target} (${d.edgeType}) — confidence ${d.confidence.toFixed(2)}`
    case 'missing-extracted':
      return `  • [${d.type}] ${d.source} → ${d.target} (${d.edgeType}) — confidence ${d.confidence.toFixed(2)}`
    case 'version-mismatch':
      return `  • [${d.type}] ${d.source} → ${d.target} — declared ${d.extractedVersion}, observed engine ${d.observedVersion} (${d.compatibility})`
    case 'host-mismatch':
      return `  • [${d.type}] ${d.source} → ${d.target} — declared host ${d.extractedHost}, observed host ${d.observedHost}`
    case 'compat-violation':
      return `  • [${d.type}] ${d.source} → ${d.target} — ${d.rule.kind}${d.rule.package ? ` (${d.rule.package})` : ''}`
  }
}

export async function getDivergences(
  client: HttpClient,
  input: DivergencesInput,
): Promise<ToolResponse> {
  try {
    const result = await client.get<DivergenceResult>(buildDivergencesPath(input))
    if (result.totalAffected === 0) {
      return formatEmptyResponse(
        'No divergences found between the declared (EXTRACTED) and observed (OBSERVED) views of the graph.',
      )
    }
    // Sorted by confidence descending already; first entry is the headline.
    const headline = result.divergences[0]!
    const summary =
      `Found ${result.totalAffected} divergence${result.totalAffected === 1 ? '' : 's'} between code and production. ` +
      `Highest-confidence: ${headline.type} on ${headline.source} → ${headline.target}. ${headline.reason}`
    const blockLines: string[] = []
    for (const d of result.divergences) {
      blockLines.push(formatDivergenceLine(d))
      blockLines.push(`    reason: ${d.reason}`)
      blockLines.push(`    recommendation: ${d.recommendation}`)
    }
    const maxConfidence = result.divergences.reduce(
      (m, d) => Math.max(m, d.confidence),
      0,
    )
    return formatToolResponse({
      summary,
      block: blockLines.join('\n'),
      confidence: maxConfidence,
      // Composite provenance — divergences sit between EXTRACTED and
      // OBSERVED by construction; that's what makes them divergences.
      provenance: 'composite (EXTRACTED + OBSERVED)',
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

async function postJson<T>(
  client: HttpClient,
  path: string,
  body: unknown,
): Promise<T> {
  // The base HttpClient interface only exposes get(). For POST we need to
  // reach into the underlying transport. Most callers pass the client built
  // by createHttpClient which has post; types are kept minimal so test
  // stubs don't have to implement post unless the tool needs it.
  const c = client as HttpClient & { post?: <U>(p: string, b: unknown) => Promise<U> }
  if (typeof c.post !== 'function') {
    throw new Error('HttpClient does not support POST — required for check_policies dry-run')
  }
  return c.post<T>(path, body)
}

// ── /neat extend tools (ADR-081, ADR-086) ────────────────────────────────

export interface ListUninstrumentedInput {
  project?: string
}

interface LibraryCoverageResult {
  library: string
  coverage: string
  installedVersion?: string
  instrumentation_package?: string
  package_version?: string
  registration?: string
  notes?: string
}

export async function neatListUninstrumented(
  client: HttpClient,
  input: ListUninstrumentedInput,
): Promise<ToolResponse> {
  try {
    const result = await client.get<{ libraries: LibraryCoverageResult[] }>(
      projectPath(input.project, '/extend/list-uninstrumented'),
    )
    const libs = result.libraries
    if (libs.length === 0) {
      return formatEmptyResponse(
        'All detected libraries are covered by the auto-instrumentations bundle or the HTTP fallback. No extension needed.',
      )
    }
    const blockLines = libs.map((l) => {
      const pkgBit = l.instrumentation_package ? ` → ${l.instrumentation_package}@${l.package_version ?? '*'}` : ' → no registry entry'
      return `  • ${l.library} [${l.coverage}]${pkgBit}${l.notes ? ` — ${l.notes}` : ''}`
    })
    return formatToolResponse({
      summary: `${libs.length} librar${libs.length === 1 ? 'y needs' : 'ies need'} instrumentation beyond the auto-instrumentations bundle.`,
      block: blockLines.join('\n'),
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

export interface LookupInstrumentationInput {
  library: string
  installedVersion?: string
  project?: string
}

export async function neatLookupInstrumentation(
  client: HttpClient,
  input: LookupInstrumentationInput,
): Promise<ToolResponse> {
  const qs = input.installedVersion ? `?library=${encodeURIComponent(input.library)}&version=${encodeURIComponent(input.installedVersion)}` : `?library=${encodeURIComponent(input.library)}`
  try {
    const result = await client.get<LibraryCoverageResult>(
      projectPath(input.project, `/extend/lookup${qs}`),
    )
    const lines = [
      `  coverage: ${result.coverage}`,
      ...(result.instrumentation_package ? [`  instrumentation_package: ${result.instrumentation_package}@${result.package_version ?? '*'}`] : []),
      ...(result.registration ? [`  registration: ${result.registration}`] : []),
      ...(result.notes ? [`  notes: ${result.notes}`] : []),
    ]
    return formatToolResponse({
      summary: `Registry entry for ${input.library}: coverage is ${result.coverage}.`,
      block: lines.join('\n'),
    })
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      return formatEmptyResponse(`${input.library} is not in the instrumentation registry.`)
    }
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

export interface DescribeProjectInstrumentationInput {
  project?: string
}

interface ProjectInstrumentationState {
  hookFiles: string[]
  envNeat: boolean
  installedDeps: Record<string, string>
}

export async function neatDescribeProjectInstrumentation(
  client: HttpClient,
  input: DescribeProjectInstrumentationInput,
): Promise<ToolResponse> {
  try {
    const state = await client.get<ProjectInstrumentationState>(
      projectPath(input.project, '/extend/describe'),
    )
    const lines: string[] = [
      `  hook files:     ${state.hookFiles.length > 0 ? state.hookFiles.join(', ') : '(none — run neat init first)'}`,
      `  .env.neat:      ${state.envNeat ? 'present' : 'absent'}`,
    ]
    const depEntries = Object.entries(state.installedDeps)
    if (depEntries.length > 0) {
      lines.push('  installed OTel deps:')
      for (const [pkg, ver] of depEntries) {
        lines.push(`    ${pkg}@${ver}`)
      }
    } else {
      lines.push('  installed OTel deps: (none)')
    }
    const ready = state.hookFiles.length > 0
    return formatToolResponse({
      summary: ready
        ? `Project has ${state.hookFiles.length} instrumentation hook file${state.hookFiles.length === 1 ? '' : 's'} and is ready for neat_apply_extension.`
        : 'Project has no instrumentation hook files. Run neat init before extending.',
      block: lines.join('\n'),
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

export interface ApplyExtensionInput {
  library: string
  instrumentation_package: string
  version: string
  registration_snippet: string
  project?: string
}

interface ExtensionApplyResult {
  library: string
  filesTouched: string[]
  depsAdded: string[]
  installOutput: string
  alreadyApplied: boolean
}

export async function neatApplyExtension(
  client: HttpClient,
  input: ApplyExtensionInput,
): Promise<ToolResponse> {
  try {
    const result = await postJson<ExtensionApplyResult>(
      client,
      projectPath(input.project, '/extend/apply'),
      {
        library: input.library,
        instrumentation_package: input.instrumentation_package,
        version: input.version,
        registration_snippet: input.registration_snippet,
      },
    )
    if (result.alreadyApplied) {
      return formatEmptyResponse(
        `${input.library} instrumentation is already applied — no changes made.`,
      )
    }
    const lines = [
      `  files touched: ${result.filesTouched.join(', ') || '(none)'}`,
      `  deps added:    ${result.depsAdded.join(', ') || '(none)'}`,
      `  install:       ${result.installOutput}`,
    ]
    return formatToolResponse({
      summary: `Applied ${input.instrumentation_package} for ${input.library}. ${result.filesTouched.length} file${result.filesTouched.length === 1 ? '' : 's'} touched, logged to ~/.neat/extend-log.ndjson.`,
      block: lines.join('\n'),
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

export interface DryRunExtensionInput {
  library: string
  instrumentation_package: string
  version: string
  registration_snippet: string
  project?: string
}

interface ExtensionDiff {
  library: string
  filesTouched: string[]
  depsToAdd: string[]
  packageJsonPatch: object
  templatePatch: string
}

export async function neatDryRunExtension(
  client: HttpClient,
  input: DryRunExtensionInput,
): Promise<ToolResponse> {
  try {
    const result = await postJson<ExtensionDiff>(
      client,
      projectPath(input.project, '/extend/dry-run'),
      {
        library: input.library,
        instrumentation_package: input.instrumentation_package,
        version: input.version,
        registration_snippet: input.registration_snippet,
      },
    )
    const lines = [
      `  files that would be touched: ${result.filesTouched.join(', ') || '(none)'}`,
      `  deps to add:                 ${result.depsToAdd.join(', ') || '(none)'}`,
      `  hook file patch:             ${result.templatePatch}`,
    ]
    return formatToolResponse({
      summary: `Dry run for ${input.library}: ${result.filesTouched.length} file${result.filesTouched.length === 1 ? '' : 's'} would be touched. No changes made.`,
      block: lines.join('\n'),
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

export interface RollbackExtensionInput {
  library: string
  project?: string
}

export async function neatRollbackExtension(
  client: HttpClient,
  input: RollbackExtensionInput,
): Promise<ToolResponse> {
  try {
    const result = await postJson<{ undone: boolean; message: string }>(
      client,
      projectPath(input.project, '/extend/rollback'),
      { library: input.library },
    )
    if (!result.undone) {
      return formatEmptyResponse(
        `No prior apply found for ${input.library} — nothing to roll back.`,
      )
    }
    return formatToolResponse({
      summary: `Rolled back instrumentation for ${input.library}. ${result.message}. Run your package manager install to sync the lockfile.`,
      block: `  result: ${result.message}`,
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}
