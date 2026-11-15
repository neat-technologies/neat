// Graph-navigation family: the read-only traversals over the fused graph —
// ask (the plain-language door), blast radius, dependencies (static and
// observed), expand/relate (two-way RCA steps), semantic_search, get_graph_diff,
// get_recent_stale_edges, and get_divergences (the thesis surface).

import type {
  AskResult,
  BlastRadiusAffectedNode,
  BlastRadiusResult,
  Divergence,
  DivergenceResult,
  DivergenceType,
  ExpandResult,
  GraphEdge,
  GraphNode,
  ObservedDependenciesResult,
  RelateResult,
  TransitiveDependenciesResult,
} from '@neat.is/types'
import { Provenance } from '@neat.is/types'
import { ProjectNotFoundError, HttpError, type HttpClient } from '../client.js'
import {
  formatEmptyResponse,
  formatErrorResponse,
  formatToolResponse,
  type ToolResponse,
} from '../format.js'
import { flagMismatchPhrase, configMismatchPhrase } from '@neat.is/core/incidents-render'
import {
  emptyWithReadiness,
  projectPath,
  withMissingNodeFallback,
  type SearchResponse,
} from './shared.js'

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

  return withMissingNodeFallback(
    client,
    input.project,
    async () => {
      const result = await client.get<BlastRadiusResult>(path)
      if (result.totalAffected === 0) {
        return emptyWithReadiness(
          client,
          input.project,
          `${result.origin} has no dependents. Nothing else would break if it failed.`,
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
        summary: `Blast radius for ${result.origin}: ${result.totalAffected} dependent node${result.totalAffected === 1 ? '' : 's'} would break if it changed.`,
        block: blockLines.join('\n'),
        confidence: Number.isFinite(minConfidence) ? minConfidence : undefined,
        provenance: provenances.length ? provenances : undefined,
      })
    },
    `Node ${input.nodeId} not found in the graph.`,
  )
}

function formatBlastEntry(n: BlastRadiusAffectedNode): string {
  const tag = n.edgeProvenance === Provenance.STALE ? ' [STALE — last seen too long ago]' : ''
  return `  • ${n.nodeId} (distance ${n.distance}, ${n.edgeProvenance})${tag}`
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

  return withMissingNodeFallback(
    client,
    input.project,
    async () => {
      const result = await client.get<TransitiveDependenciesResult>(path)
      if (result.total === 0) {
        return emptyWithReadiness(
          client,
          input.project,
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
    },
    `Node ${input.nodeId} not found in the graph.`,
  )
}

// Render one OBSERVED dependency, file-grained. When the edge source isn't the
// queried node — a service's owned file made the call — name that file, so the
// answer stays file-first rather than a service rollup (file-awareness §3).
function observedDepLine(nodeId: string, e: GraphEdge): string {
  const via = e.source !== nodeId ? ` (via ${e.source})` : ''
  return `  • ${e.target} — ${e.type}${via}${edgeMeta(e)}`
}

export async function getObservedDependencies(
  client: HttpClient,
  input: DependenciesInput,
): Promise<ToolResponse> {
  return withMissingNodeFallback(
    client,
    input.project,
    async () => {
      const result = await client.get<ObservedDependenciesResult>(
        projectPath(
          input.project,
          `/graph/observed-dependencies/${encodeURIComponent(input.nodeId)}`,
        ),
      )
      if (result.dependencies.length === 0) {
        // A pure receiver is fully observed — it just calls nothing downstream.
        // Reporting "is OTel running?" at it would be wrong; that note is honest
        // only when nothing has been observed at all and static deps exist.
        if (result.observed) {
          return formatToolResponse({
            summary:
              `${input.nodeId} makes no outbound runtime calls, but OTel has observed it ` +
              `receiving traffic on ${result.inboundObservedCount} inbound call ` +
              `path${result.inboundObservedCount === 1 ? '' : 's'} — it's a pure receiver.`,
            provenance: Provenance.OBSERVED,
          })
        }
        const note = result.hasExtractedOutbound
          ? ' Static (EXTRACTED) dependencies exist but no runtime traffic has been seen — is OTel running?'
          : ''
        return formatEmptyResponse(`No OBSERVED dependencies for ${input.nodeId}.${note}`)
      }
      const blockLines = result.dependencies.map((e) => observedDepLine(input.nodeId, e))
      return formatToolResponse({
        summary: `${input.nodeId} has ${result.dependencies.length} runtime dependenc${result.dependencies.length === 1 ? 'y' : 'ies'} confirmed by OTel.`,
        block: blockLines.join('\n'),
        provenance: Provenance.OBSERVED,
      })
    },
    `Node ${input.nodeId} not found in the graph.`,
  )
}

// A message-only exemplar can run to 512 chars with newlines (a stack-dump
// message); the meta line is one line, so collapse whitespace and cap it.
const LAST_ERROR_LABEL_MAX = 80
function oneLineLabel(message: string | undefined): string | undefined {
  if (!message) return undefined
  const flat = message.replace(/\s+/g, ' ').trim()
  return flat.length > LAST_ERROR_LABEL_MAX ? `${flat.slice(0, LAST_ERROR_LABEL_MAX - 1)}…` : flat
}

function edgeMeta(e: GraphEdge): string {
  const bits: string[] = []
  if (e.signal) {
    // Prefer the runtime signal numbers — "saw 1,247 calls, 3 errors" reads
    // better than a derived 0.94 confidence.
    bits.push(`spans=${e.signal.spanCount}`)
    if (e.signal.errorCount > 0) bits.push(`errors=${e.signal.errorCount}`)
    // The bounded last-error exemplar (ADR-236): name WHAT failed, not just how
    // many times. This is exactly the signal `errorCount` alone drops — a
    // timeout, a deadlock, and a connection-refused all read as "errors=N"
    // without it. Prefer the exception type, then the HTTP status, then the
    // message.
    const lastError = e.signal.lastError
    if (lastError) {
      const label =
        lastError.exceptionType ??
        (lastError.httpStatusCode !== undefined ? `HTTP ${lastError.httpStatusCode}` : undefined) ??
        oneLineLabel(lastError.message)
      if (label) bits.push(`lastError=${label}`)
    }
    // Per-edge latency percentiles (ADR-190) — p50/p95 in ms. Latency drift is a
    // failure signal errorCount never shows: calls succeed but slow down.
    if (e.signal.latencyMs) {
      const { p50, p95 } = e.signal.latencyMs
      bits.push(`latency=p50 ${Math.round(p50)}ms/p95 ${Math.round(p95)}ms`)
    }
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

// Expand — one bidirectional navigation step (ADR-189). The agent walks the
// failure neighbourhood one legible hop at a time instead of relaying a verdict.
export interface ExpandInput {
  nodeId: string
  direction: 'up' | 'down'
  project?: string
}

export async function expandNode(client: HttpClient, input: ExpandInput): Promise<ToolResponse> {
  const path = projectPath(
    input.project,
    `/graph/expand/${encodeURIComponent(input.nodeId)}?direction=${input.direction}`,
  )
  return withMissingNodeFallback(
    client,
    input.project,
    async () => {
      const result = await client.get<ExpandResult>(path)
      const dirWord =
        input.direction === 'up' ? 'callers/dependents (up)' : 'callees/dependencies (down)'
      const summary =
        `${result.node.id} is ${result.node.classification}. ` +
        `${result.neighbours.length} ${dirWord}.`
      const blockLines = result.neighbours.map(
        (n) => `  • ${n.node} — ${n.classification} via ${n.edgeType} (${n.provenance})`,
      )
      return formatToolResponse({
        summary,
        block: blockLines.length
          ? blockLines.join('\n')
          : '(no runtime neighbours in this direction)',
      })
    },
    `Node ${input.nodeId} not found in the graph.`,
  )
}

// Relate — pairwise directed link-confirmation (ADR-189). Confirms a hypothesised
// cause→symptom link and whether the connecting path carries the failure.
export interface RelateInput {
  a: string
  b: string
  maxDepth?: number
  project?: string
}

export async function relate(client: HttpClient, input: RelateInput): Promise<ToolResponse> {
  const qs = input.maxDepth !== undefined ? `&maxDepth=${input.maxDepth}` : ''
  const path = projectPath(
    input.project,
    `/graph/relate?a=${encodeURIComponent(input.a)}&b=${encodeURIComponent(input.b)}${qs}`,
  )
  try {
    const result = await client.get<RelateResult>(path)
    if (!result.related) {
      return formatEmptyResponse(
        `${input.a} and ${input.b} are not related — ${result.note ?? 'no path found'}.`,
      )
    }
    const arrow =
      result.direction === 'a->b' ? `${input.a} → ${input.b}` : `${input.b} → ${input.a}`
    const carries = result.paths[0]?.carriesSignal
      ? 'and the path carries the failure end to end'
      : 'but the path carries no failure signal'
    const gap = result.grainGap ? ' (grain gap — only a coarser link is in evidence)' : ''
    const summary = `${arrow}: a path exists ${carries}${gap}.`
    const blockLines = result.paths.map(
      (p) =>
        `  ${p.nodes.join(' → ')}  [${p.edgeTypes.join(', ')}]  carriesSignal=${p.carriesSignal}`,
    )
    return formatToolResponse({ summary, block: blockLines.join('\n') })
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return formatErrorResponse(err.message)
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

// ask — the plain-language door over the whole tool surface (ADR-198). One
// natural-language question in; one compact, provenance-tagged answer out. The
// core resolves the question to nodes and routes it to the right traversal, so
// the agent never has to know WHICH structured tool or the exact node id first.
export interface AskInput {
  question: string
  project?: string
}

export async function ask(client: HttpClient, input: AskInput): Promise<ToolResponse> {
  const question = input.question.trim()
  if (!question) return formatEmptyResponse('ask: the question was empty.')
  return withMissingNodeFallback(
    client,
    input.project,
    async () => {
      const result = await client.get<AskResult>(
        projectPath(input.project, `/graph/ask?q=${encodeURIComponent(question)}`),
      )
      const blockLines: string[] = []
      if (result.matched.length > 0) {
        blockLines.push(
          `Matched (${result.intent}): ` +
            result.matched.map((m) => `${m.nodeId} [${m.via} ${m.score.toFixed(2)}]`).join(', '),
        )
      } else if (result.scope === 'global') {
        // A graph-wide answer to an entity-less question — no node was named.
        blockLines.push(`Graph-wide answer (${result.intent}) — no entity named.`)
      }
      for (const section of result.sections) {
        blockLines.push('', `${section.heading}:`)
        for (const fact of section.facts) {
          const tag = fact.provenance
            ? ` [${fact.provenance}${fact.confidence !== undefined ? ` ${fact.confidence.toFixed(2)}` : ''}]`
            : fact.confidence !== undefined
              ? ` [confidence ${fact.confidence.toFixed(2)}]`
              : ''
          blockLines.push(`  • ${fact.text}${tag}`)
        }
      }
      return formatToolResponse({
        summary: result.answer,
        block: blockLines.join('\n').trim(),
        ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
        ...(result.provenance.length > 0 ? { provenance: result.provenance } : {}),
      })
    },
    `ask: nothing in "${question}" resolved to a node in the graph.`,
  )
}

export interface SemanticSearchInput {
  query: string
  project?: string
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
        blockLines.push(
          `  + edge ${e.id} — ${e.source} -> ${e.target} (${e.type}, ${e.provenance})`,
        )
      blockLines.push('')
    }
    if (result.removed.nodes.length || result.removed.edges.length) {
      blockLines.push('Removed:')
      for (const n of result.removed.nodes) blockLines.push(`  - node ${n.id} (${n.type})`)
      for (const e of result.removed.edges)
        blockLines.push(
          `  - edge ${e.id} — ${e.source} -> ${e.target} (${e.type}, ${e.provenance})`,
        )
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
      return formatErrorResponse(`Could not load snapshot ${input.againstSnapshot}: ${err.message}`)
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
  return changed.length === 0 ? 'attributes differ' : `fields changed: ${changed.sort().join(', ')}`
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

const NO_TELEMETRY = 'NEAT has received no runtime telemetry for this project yet (0 OBSERVED edges)'

function formatDivergenceLine(d: Divergence): string {
  switch (d.type) {
    case 'missing-observed':
    case 'missing-extracted':
      // Column locus (ADR-157 §4) — a column-grain drift on one `sql-table` node,
      // no edge. Edge locus — the declared/observed edge triple.
      if (d.column) {
        return `  • [${d.type}] ${d.table ?? d.source} column ${d.column} — confidence ${d.confidence.toFixed(2)}`
      }
      return `  • [${d.type}] ${d.source} → ${d.target} (${d.edgeType}) — confidence ${d.confidence.toFixed(2)}`
    case 'version-mismatch':
      return `  • [${d.type}] ${d.source} → ${d.target} — declared ${d.extractedVersion}, observed engine ${d.observedVersion} (${d.compatibility})`
    case 'host-mismatch':
      return `  • [${d.type}] ${d.source} → ${d.target} — declared host ${d.extractedHost}, observed host ${d.observedHost}`
    case 'compat-violation':
      return `  • [${d.type}] ${d.source} → ${d.target} — ${d.rule.kind}${d.rule.package ? ` (${d.rule.package})` : ''}`
    case 'observed-symbol-mismatch': {
      // Symbol/field-grain (ADR-215) — the code declares access to a member the
      // runtime object lacks. source == target (the code node), so name the
      // member and the declaring file:line instead of an edge.
      const at = d.location ? ` at ${d.location}` : ''
      const member = d.symbol ? ` ${d.symbol}` : ''
      return `  • [${d.type}] ${d.source}${member}${at} (${d.mismatchKind}) — confidence ${d.confidence.toFixed(2)}`
    }
    case 'observed-failing': {
      // Behavioral-failure (ADR-220). Edge locus — a declared+observed dependency
      // edge whose calls predominantly fail. Incident locus — source == target
      // (the declaring code node), named at the file:line.
      if (d.edgeType) {
        const rate =
          d.errorRate !== undefined
            ? ` ${Math.round(d.errorRate * 100)}% of observed calls fail`
            : ''
        return `  • [${d.type}] ${d.source} → ${d.target} (${d.edgeType}) —${rate} (${d.failureKind}) — confidence ${d.confidence.toFixed(2)}`
      }
      const at = d.location ? ` at ${d.location}` : ''
      return `  • [${d.type}] ${d.source}${at} (${d.failureKind}) — confidence ${d.confidence.toFixed(2)}`
    }
    case 'deploy-mismatch': {
      // Node-local compare (ADR-225) — source and target are both the
      // `service:<name>` node, so name the service once and then the pair that
      // disagrees. `kind` picks which pair: a stuck rollout serving the old
      // image, or a declared replica count the cluster never reached.
      const detail =
        d.kind === 'replicas'
          ? `declared ${d.declaredReplicas ?? 'unknown'} replicas, observed ${d.observedReplicas ?? 'unknown'} ready`
          : `declared image ${d.declaredImage ?? 'unknown'}, observed image ${d.observedImage ?? 'unknown'}`
      return `  • [${d.type}] ${d.source} — ${detail} — confidence ${d.confidence.toFixed(2)}`
    }
    case 'flag-mismatch':
      // Flag grain (ADR-242): the reading service against the flag store, the
      // same phrase the CLI and the card use.
      return `  • [${d.type}] ${d.source} — ${flagMismatchPhrase(d)} — confidence ${d.confidence.toFixed(2)}`
    case 'config-mismatch':
      // Config drift (ADR-265): every side with its source; NEAT does not say
      // which one is wrong.
      return `  • [${d.type}] ${d.source} → ${d.target} (${d.kind}) — ${configMismatchPhrase(d)} — confidence ${d.confidence.toFixed(2)}`
    default: {
      // A divergence type added to the union but not given a case above still
      // reaches the agent named, rather than as the blank line this switch
      // emitted before. `d` narrows to `never` here when every case is covered.
      const other = d as Divergence
      return `  • [${other.type}] ${other.source} → ${other.target} — confidence ${other.confidence.toFixed(2)}`
    }
  }
}

export async function getDivergences(
  client: HttpClient,
  input: DivergencesInput,
): Promise<ToolResponse> {
  try {
    const result = await client.get<DivergenceResult>(buildDivergencesPath(input))
    // With no OBSERVED edge in the graph there is nothing runtime to compare
    // against (#1528): say so, rather than presenting a code-only result as a
    // production finding. `observedEdges` is absent from an older daemon.
    const noTelemetry = result.observedEdges === 0
    if (result.totalAffected === 0) {
      return emptyWithReadiness(
        client,
        input.project,
        noTelemetry
          ? `No divergences found, but ${NO_TELEMETRY}, so only the declared (EXTRACTED) view was checked.`
          : 'No divergences found between the declared (EXTRACTED) and observed (OBSERVED) views of the graph.',
      )
    }
    // Sorted by confidence descending already; first entry is the headline.
    const headline = result.divergences[0]!
    const count = `${result.totalAffected} divergence${result.totalAffected === 1 ? '' : 's'}`
    const summary =
      (noTelemetry
        ? `${NO_TELEMETRY}, so these ${count} come from the declared (EXTRACTED) view alone: a missing-observed means not seen yet, not that production never runs it. `
        : `Found ${count} between code and production. `) +
      `Highest-confidence: ${headline.type} on ${headline.source} → ${headline.target}. ${headline.reason}`
    const blockLines: string[] = []
    for (const d of result.divergences) {
      blockLines.push(formatDivergenceLine(d))
      blockLines.push(`    reason: ${d.reason}`)
      blockLines.push(`    recommendation: ${d.recommendation}`)
    }
    const maxConfidence = result.divergences.reduce((m, d) => Math.max(m, d.confidence), 0)
    return formatToolResponse({
      summary,
      block: blockLines.join('\n'),
      confidence: maxConfidence,
      // Composite provenance — divergences sit between EXTRACTED and
      // OBSERVED by construction — except when there is no OBSERVED at all.
      provenance: noTelemetry ? 'EXTRACTED only (0 OBSERVED edges)' : 'composite (EXTRACTED + OBSERVED)',
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}
