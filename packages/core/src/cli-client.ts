// REST helper + CLI verb implementations for `neat <verb>` (ADR-050).
//
// The HttpClient and its createHttpClient factory are the "shared REST helper
// module" the contract calls for — one endpoint surface, two consumers
// (`packages/mcp/src/client.ts` re-exports from here, the CLI dispatcher
// imports it directly).
//
// Verb handlers live alongside the client because they're tightly coupled:
// each verb maps 1:1 to an MCP tool from ADR-039, but produces the structured
// `{ summary, block, confidence, provenance }` shape (ADR-050 #3) in pure
// data form. cli.ts formats that shape into either human-readable text or
// `--json` output.

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

// ──────────────────────────────────────────────────────────────────────────
// REST client
// ──────────────────────────────────────────────────────────────────────────

export interface HttpClient {
  get<T>(path: string): Promise<T>
  post?<T>(path: string, body: unknown): Promise<T>
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly responseBody: string = '',
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

// Network-level failures (ECONNREFUSED, ETIMEDOUT, DNS) — distinct from
// HttpError so the CLI can map them to exit code 3 (daemon-down) without
// parsing error strings.
export class TransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransportError'
  }
}

// Single-source the bearer for every first-party read (ADR-073 §3). The CLI
// query verbs, `neat sync`, the MCP server, and the snapshot push all read the
// token from here so a new read site can't quietly skip auth. Returns
// undefined when the env var is unset or empty — a loopback dev daemon stays
// reachable without a token.
export function resolveAuthToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const t = env.NEAT_AUTH_TOKEN
  return t && t.length > 0 ? t : undefined
}

export function createHttpClient(baseUrl: string, bearerToken?: string): HttpClient {
  const root = baseUrl.replace(/\/$/, '')
  const authHeader: Record<string, string> = bearerToken && bearerToken.length > 0
    ? { authorization: `Bearer ${bearerToken}` }
    : {}
  return {
    async get<T>(path: string): Promise<T> {
      let res: Response
      try {
        res = await fetch(`${root}${path}`, {
          headers: { ...authHeader },
        })
      } catch (err) {
        throw new TransportError(
          `cannot reach neat-core at ${root}: ${(err as Error).message}`,
        )
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new HttpError(
          res.status,
          `${res.status} ${res.statusText} on GET ${path}: ${body}`,
          body,
        )
      }
      return (await res.json()) as T
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      let res: Response
      try {
        res = await fetch(`${root}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeader },
          body: JSON.stringify(body),
        })
      } catch (err) {
        throw new TransportError(
          `cannot reach neat-core at ${root}: ${(err as Error).message}`,
        )
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new HttpError(
          res.status,
          `${res.status} ${res.statusText} on POST ${path}: ${text}`,
          text,
        )
      }
      return (await res.json()) as T
    },
  }
}

// Project routing per ADR-050 #2: `--project <name>` (handled in cli.ts) →
// `NEAT_PROJECT` env → `default`. The default routes hit the legacy
// unprefixed URLs which the core resolves to project=`default`.
function projectPath(project: string | undefined, suffix: string): string {
  if (!project) return suffix
  return `/projects/${encodeURIComponent(project)}${suffix}`
}

// ──────────────────────────────────────────────────────────────────────────
// Verb result shape (ADR-050 #3)
// ──────────────────────────────────────────────────────────────────────────

export interface VerbResult {
  // NL paragraph. What was found and why it matters.
  summary: string
  // Structured payload — usually a bulleted list. Empty when the summary
  // already conveys everything.
  block?: string
  // Per-result confidence in [0, 1]. Undefined → footer reads "n/a".
  confidence?: number
  // Per-result provenance. String, array (mixed paths), or undefined.
  provenance?: string | string[]
}

// Common shape the nine verbs produce. cli.ts renders this to text or JSON.

// ──────────────────────────────────────────────────────────────────────────
// Verbs
// ──────────────────────────────────────────────────────────────────────────

export interface RootCauseInput {
  errorNode: string
  errorId?: string
  project?: string
}

export async function runRootCause(
  client: HttpClient,
  input: RootCauseInput,
): Promise<VerbResult> {
  const qs = input.errorId ? `?errorId=${encodeURIComponent(input.errorId)}` : ''
  const path = projectPath(
    input.project,
    `/graph/root-cause/${encodeURIComponent(input.errorNode)}${qs}`,
  )
  try {
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
    if (result.fixRecommendation) blockLines.push(`Recommended fix: ${result.fixRecommendation}`)
    return {
      summary,
      block: blockLines.join('\n'),
      confidence: result.confidence,
      provenance: result.edgeProvenances.length ? result.edgeProvenances : undefined,
    }
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      return {
        summary: `No root cause found for ${input.errorNode}. The node may be healthy, or it may not exist in the graph.`,
      }
    }
    throw err
  }
}

export interface BlastRadiusInput {
  nodeId: string
  depth?: number
  project?: string
}

export async function runBlastRadius(
  client: HttpClient,
  input: BlastRadiusInput,
): Promise<VerbResult> {
  const qs = input.depth !== undefined ? `?depth=${input.depth}` : ''
  const path = projectPath(
    input.project,
    `/graph/blast-radius/${encodeURIComponent(input.nodeId)}${qs}`,
  )
  try {
    const result = await client.get<BlastRadiusResult>(path)
    if (result.totalAffected === 0) {
      return {
        summary: `${result.origin} has no dependents. Nothing else would break if it failed.`,
      }
    }
    const sorted = [...result.affectedNodes].sort(
      (a, b) => a.distance - b.distance || a.nodeId.localeCompare(b.nodeId),
    )
    const blockLines = sorted.map(formatBlastEntry)
    const minConfidence = sorted.reduce(
      (m, n) => Math.min(m, n.confidence),
      Number.POSITIVE_INFINITY,
    )
    const provenances = [...new Set(sorted.map((n) => n.edgeProvenance))]
    return {
      summary: `Blast radius for ${result.origin}: ${result.totalAffected} dependent node${result.totalAffected === 1 ? '' : 's'} would break if it changed.`,
      block: blockLines.join('\n'),
      confidence: Number.isFinite(minConfidence) ? minConfidence : undefined,
      provenance: provenances.length ? provenances : undefined,
    }
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      return { summary: `Node ${input.nodeId} not found in the graph.` }
    }
    throw err
  }
}

function formatBlastEntry(n: BlastRadiusAffectedNode): string {
  const tag = n.edgeProvenance === Provenance.STALE ? ' [STALE — last seen too long ago]' : ''
  return `  • ${n.nodeId} (distance ${n.distance}, ${n.edgeProvenance})${tag}`
}

export interface DependenciesInput {
  nodeId: string
  depth?: number
  project?: string
}

export async function runDependencies(
  client: HttpClient,
  input: DependenciesInput,
): Promise<VerbResult> {
  const depth = input.depth ?? 3
  const path = projectPath(
    input.project,
    `/graph/dependencies/${encodeURIComponent(input.nodeId)}?depth=${depth}`,
  )
  try {
    const result = await client.get<TransitiveDependenciesResult>(path)
    if (result.total === 0) {
      return {
        summary:
          depth === 1
            ? `${input.nodeId} has no direct dependencies in the graph.`
            : `${input.nodeId} has no dependencies (BFS to depth ${depth}).`,
      }
    }
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
    return { summary, block: blockLines.join('\n'), provenance: provenances }
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      return { summary: `Node ${input.nodeId} not found in the graph.` }
    }
    throw err
  }
}

interface EdgesResponse {
  inbound: GraphEdge[]
  outbound: GraphEdge[]
}

export async function runObservedDependencies(
  client: HttpClient,
  input: DependenciesInput,
): Promise<VerbResult> {
  try {
    const edges = await client.get<EdgesResponse>(
      projectPath(input.project, `/graph/edges/${encodeURIComponent(input.nodeId)}`),
    )
    const observed = edges.outbound.filter((e) => e.provenance === Provenance.OBSERVED)
    if (observed.length === 0) {
      const hasExtracted = edges.outbound.some((e) => e.provenance === Provenance.EXTRACTED)
      const note = hasExtracted
        ? ' Static (EXTRACTED) dependencies exist but no runtime traffic has been seen — is OTel running?'
        : ''
      return { summary: `No OBSERVED dependencies for ${input.nodeId}.${note}` }
    }
    const blockLines = observed.map((e) => `  • ${e.target} — ${e.type}${edgeMeta(e)}`)
    return {
      summary: `${input.nodeId} has ${observed.length} runtime dependenc${observed.length === 1 ? 'y' : 'ies'} confirmed by OTel.`,
      block: blockLines.join('\n'),
      provenance: Provenance.OBSERVED,
    }
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      return { summary: `Node ${input.nodeId} not found in the graph.` }
    }
    throw err
  }
}

function edgeMeta(e: GraphEdge): string {
  const bits: string[] = []
  if (e.signal) {
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

export interface IncidentsInput {
  nodeId?: string
  limit?: number
  project?: string
}

// `neat incidents` shape: with a node id, returns that node's incidents.
// Without one, returns the global recent log.
export async function runIncidents(
  client: HttpClient,
  input: IncidentsInput,
): Promise<VerbResult> {
  const path = input.nodeId
    ? projectPath(input.project, `/incidents/${encodeURIComponent(input.nodeId)}`)
    : projectPath(input.project, '/incidents')
  try {
    const body = await client.get<{ count: number; total: number; events: ErrorEvent[] }>(path)
    const events = body.events
    if (events.length === 0) {
      return {
        summary: input.nodeId
          ? `No incidents recorded against ${input.nodeId}.`
          : 'No incidents recorded.',
      }
    }
    const ordered = [...events].reverse().slice(0, input.limit ?? 20)
    const blockLines: string[] = []
    for (const ev of ordered) {
      blockLines.push(`  ${ev.timestamp} — ${ev.service}: ${ev.errorMessage}`)
      blockLines.push(`    trace=${ev.traceId} span=${ev.spanId}`)
    }
    const target = input.nodeId ?? 'the project'
    return {
      summary: `${target} has ${body.total} recorded incident${body.total === 1 ? '' : 's'}; showing the ${ordered.length} most recent.`,
      block: blockLines.join('\n'),
      provenance: Provenance.OBSERVED,
    }
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      return { summary: `Node ${input.nodeId ?? ''} not found in the graph.` }
    }
    throw err
  }
}

export interface SearchInput {
  query: string
  project?: string
}

interface SearchResponse {
  query: string
  provider?: 'ollama' | 'transformers' | 'substring'
  matches: (GraphNode & { score?: number })[]
}

export async function runSearch(
  client: HttpClient,
  input: SearchInput,
): Promise<VerbResult> {
  const result = await client.get<SearchResponse>(
    projectPath(input.project, `/search?q=${encodeURIComponent(input.query)}`),
  )
  if (result.matches.length === 0) {
    return { summary: `No matches for "${input.query}".` }
  }
  const provider = result.provider ?? 'substring'
  const blockLines: string[] = []
  let topScore: number | undefined
  for (const n of result.matches) {
    const score = provider !== 'substring' && typeof n.score === 'number' ? n.score : undefined
    const scoreBit = score !== undefined ? ` [score=${score.toFixed(2)}]` : ''
    if (score !== undefined && (topScore === undefined || score > topScore)) topScore = score
    blockLines.push(
      `  • ${n.id} (${n.type}) — ${(n as { name?: string }).name ?? n.id}${scoreBit}`,
    )
  }
  return {
    summary: `Found ${result.matches.length} match${result.matches.length === 1 ? '' : 'es'} for "${input.query}" via ${provider} provider.`,
    block: blockLines.join('\n'),
    confidence: topScore,
  }
}

export interface DiffInput {
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

export async function runDiff(client: HttpClient, input: DiffInput): Promise<VerbResult> {
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
    return {
      summary: `No differences between the current graph and ${input.againstSnapshot} (base exportedAt=${baseLabel}).`,
    }
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
  return {
    summary: `Diff against ${input.againstSnapshot}: ${total} change${total === 1 ? '' : 's'} between the snapshot and the live graph.`,
    block: blockLines.join('\n').trimEnd(),
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

export interface StaleEdgesInput {
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

export async function runStaleEdges(
  client: HttpClient,
  input: StaleEdgesInput,
): Promise<VerbResult> {
  const params = new URLSearchParams()
  if (input.limit !== undefined) params.set('limit', String(input.limit))
  if (input.edgeType) params.set('edgeType', input.edgeType)
  const qs = params.size > 0 ? `?${params.toString()}` : ''
  const body = await client.get<{ count: number; total: number; events: StaleEventResponse[] }>(
    projectPath(input.project, `/stale-events${qs}`),
  )
  const events = body.events
  if (events.length === 0) {
    return {
      summary: input.edgeType
        ? `No stale ${input.edgeType} edges recorded.`
        : 'No stale-edge transitions recorded yet.',
    }
  }
  const blockLines = events.map(
    (e) =>
      `  ${e.transitionedAt} — ${e.source} -[${e.edgeType}]-> ${e.target}` +
      ` (last seen ${e.lastObserved}, threshold ${formatDuration(e.thresholdMs)})`,
  )
  return {
    summary: `${events.length} stale-edge transition${events.length === 1 ? '' : 's'} recorded${input.edgeType ? ` for ${input.edgeType}` : ''}.`,
    block: blockLines.join('\n'),
    provenance: Provenance.STALE,
  }
}

export interface PoliciesInput {
  nodeId?: string
  policyId?: string
  hypotheticalAction?: HypotheticalAction
  project?: string
}

interface PoliciesCheckResponse {
  allowed: boolean
  hypotheticalAction?: HypotheticalAction
  violations: PolicyViolation[]
}

export async function runPolicies(
  client: HttpClient,
  input: PoliciesInput,
): Promise<VerbResult> {
  let violations: PolicyViolation[]
  let allowed = true
  let hypothetical: HypotheticalAction | undefined

  if (input.hypotheticalAction) {
    if (typeof client.post !== 'function') {
      throw new Error('HttpClient does not support POST — required for policies dry-run')
    }
    const body = await client.post<PoliciesCheckResponse>(
      projectPath(input.project, '/policies/check'),
      { hypotheticalAction: input.hypotheticalAction },
    )
    violations = body.violations
    allowed = body.allowed
    hypothetical = body.hypotheticalAction
  } else {
    const params = new URLSearchParams()
    if (input.policyId) params.set('policyId', input.policyId)
    const qs = params.size > 0 ? `?${params.toString()}` : ''
    const body = await client.get<{ violations: PolicyViolation[] }>(
      projectPath(input.project, `/policies/violations${qs}`),
    )
    violations = body.violations
    allowed = violations.every((v) => v.onViolation !== 'block')
  }

  // Optional --node filter is applied here against the returned set; the
  // server-side endpoint doesn't take a node-id query yet.
  if (input.nodeId) {
    violations = violations.filter(
      (v) => v.subject.nodeId === input.nodeId || v.subject.path?.includes(input.nodeId!),
    )
  }

  if (violations.length === 0) {
    return {
      summary: hypothetical
        ? `No violations would result from the hypothetical action (${hypothetical.kind}).`
        : 'No policy violations recorded.',
    }
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
  if (blockCount > 0) summaryParts.push(`${blockCount} of which block`)
  if (!allowed && hypothetical) summaryParts.push('action denied')
  const summary = summaryParts.join('; ') + '.'

  const blockLines = violations.map((v) => {
    const subject = v.subject.nodeId ?? v.subject.edgeId ?? v.subject.path?.[0] ?? '(global)'
    return `  • [${v.severity}/${v.onViolation}] ${v.policyName}: ${v.message} — ${subject}`
  })
  const severities = [...new Set(violations.map((v) => v.severity))]
  return {
    summary,
    block: blockLines.join('\n'),
    confidence: hypothetical ? 0.7 : 1,
    provenance: severities.join(' '),
  }
}

// ──────────────────────────────────────────────────────────────────────────
// divergences (ADR-060) — the tenth verb. Amends ADR-050's nine-verb
// allowlist; the verb mirrors the get_divergences MCP tool.
// ──────────────────────────────────────────────────────────────────────────

export interface DivergencesInput {
  type?: ReadonlyArray<DivergenceType>
  minConfidence?: number
  node?: string
  project?: string
}

function formatDivergenceLine(d: Divergence): string {
  switch (d.type) {
    case 'missing-observed':
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

export async function runDivergences(
  client: HttpClient,
  input: DivergencesInput,
): Promise<VerbResult> {
  const params = new URLSearchParams()
  if (input.type && input.type.length > 0) params.set('type', input.type.join(','))
  if (input.minConfidence !== undefined) {
    params.set('minConfidence', String(input.minConfidence))
  }
  if (input.node) params.set('node', input.node)
  const qs = params.size > 0 ? `?${params.toString()}` : ''
  const result = await client.get<DivergenceResult>(
    projectPath(input.project, `/graph/divergences${qs}`),
  )
  if (result.totalAffected === 0) {
    return {
      summary:
        'No divergences found between the declared (EXTRACTED) and observed (OBSERVED) views of the graph.',
    }
  }
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
  return {
    summary,
    block: blockLines.join('\n'),
    confidence: maxConfidence,
    provenance: 'composite (EXTRACTED + OBSERVED)',
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Output formatting (ADR-050 #3)
// ──────────────────────────────────────────────────────────────────────────

function formatFooter(
  confidence: number | undefined,
  provenance: string | string[] | undefined,
): string {
  const c = confidence === undefined ? 'n/a' : confidence.toFixed(2)
  const p =
    provenance === undefined
      ? 'n/a'
      : Array.isArray(provenance)
        ? [...new Set(provenance)].join(', ')
        : provenance
  return `confidence: ${c} · provenance: ${p}`
}

// Default human output (NL summary + table-shaped block + footer). Mirrors
// the three-part MCP response from ADR-039 in plain text.
export function formatHuman(result: VerbResult): string {
  const sections: string[] = [result.summary.trim()]
  if (result.block && result.block.trim().length > 0) sections.push(result.block.trimEnd())
  sections.push(formatFooter(result.confidence, result.provenance))
  return sections.join('\n\n')
}

// `--json` output. Same three sections as named fields per ADR-050 #3.
export function formatJson(result: VerbResult): string {
  return JSON.stringify(
    {
      summary: result.summary,
      block: result.block ?? '',
      confidence: result.confidence ?? null,
      provenance: result.provenance ?? null,
    },
    null,
    2,
  )
}

// Exit-code mapping for thrown errors (ADR-050 #4):
//   0 — success (handled at the call site, never via throw)
//   1 — server error (HttpError)
//   2 — misuse (handled in cli.ts before any network call)
//   3 — daemon unreachable (TransportError)
export function exitCodeForError(err: unknown): number {
  if (err instanceof TransportError) return 3
  if (err instanceof HttpError) return 1
  return 1
}

// ──────────────────────────────────────────────────────────────────────────
// Snapshot push (ADR-074 §1)
//
// `neat sync` (local + --to <url>) feeds the freshly extracted snapshot into
// either the local daemon or a remote one. The endpoint is dual-mounted via
// registerRoutes — default project lands at /snapshot, named projects at
// /projects/:project/snapshot. The helper goes through the shared
// HttpClient so the verb stays on the same network path as every query verb.
// ──────────────────────────────────────────────────────────────────────────

export interface PushSnapshotInput {
  baseUrl: string
  token: string | undefined
  project: string
  snapshot: unknown
}

export interface PushSnapshotResult {
  project: string
  nodesAdded: number
  edgesAdded: number
  nodeCount: number
  edgeCount: number
}

export function createSnapshotPushClient(
  baseUrl: string,
  token: string | undefined,
): HttpClient {
  return createHttpClient(baseUrl, token && token.length > 0 ? token : undefined)
}

export async function pushSnapshotToRemote(
  input: PushSnapshotInput,
): Promise<PushSnapshotResult> {
  const client = createSnapshotPushClient(input.baseUrl, input.token)
  if (typeof client.post !== 'function') {
    throw new Error('HttpClient does not support POST — required for snapshot push')
  }
  return client.post<PushSnapshotResult>(
    `/projects/${encodeURIComponent(input.project)}/snapshot`,
    { snapshot: input.snapshot },
  )
}
