// The incident-card assembler (ADR-221, docs/contracts/incident-card.md). One
// self-sufficient work order per incident, composed so an agent reads its
// context instead of grepping for it: the incident fused with its root-cause
// chain, blast radius, governing policies, and node divergence — each claim
// carrying its own provenance.
//
// `buildIncidentCard` is a PURE function over the graph and the incident set:
// no I/O, no mutation, fully synchronous. It composes surface that already ships and
// computes nothing new (§1). The read of the append-only incident sidecar and
// the policy file stays at the REST call site; this function never touches disk.
// It is zero-fabrication (§2): a missing locus is null, a missing cause is null,
// and each chain hop carries its own provenance rather than a single flattened
// confidence.

import {
  IncidentCardSchema,
  Provenance,
  incidentKindOf,
  type ErrorEvent,
  type IncidentCard,
  type IncidentChainHop,
  type IncidentLocus,
  type Policy,
  type ProvenanceValue,
} from '@neat.is/types'
import type { Divergence } from '@neat.is/types'
import type { NeatGraph } from './graph.js'
import { getBlastRadius, getRootCause } from './traverse.js'
import { selectApplicablePolicies } from './policy.js'
import { computeDivergences } from './divergences.js'

const CODE_FILEPATH_ATTR = 'code.filepath'
const CODE_LINENO_ATTR = 'code.lineno'
const BLAST_NEAREST_LIMIT = 5

// The node's own grain — read from its `type` attribute, falling back to the id
// prefix (`service:foo` → `service`) when the node isn't in the graph.
// Normalized to the grain vocabulary (`SymbolNode` → `symbol`, `FileNode` →
// `file`) so grain reads the same whichever source it came from.
function grainOf(graph: NeatGraph, nodeId: string): string {
  if (graph.hasNode(nodeId)) {
    const t = (graph.getNodeAttributes(nodeId) as { type?: string }).type
    if (typeof t === 'string' && t.length > 0) {
      return (t.endsWith('Node') ? t.slice(0, -4) : t).toLowerCase()
    }
  }
  const colon = nodeId.indexOf(':')
  return colon > 0 ? nodeId.slice(0, colon) : 'unknown'
}

// The declaring file:line, recovered from the incident's own code.* attributes
// (ADR-215/216). Null — never fabricated — when the span carried no locus.
function locusOf(graph: NeatGraph, ev: ErrorEvent): IncidentLocus | null {
  const file = ev.attributes?.[CODE_FILEPATH_ATTR]
  if (typeof file !== 'string' || file.length === 0) return null
  const rawLine = ev.attributes?.[CODE_LINENO_ATTR]
  const line = typeof rawLine === 'number' ? rawLine : Number(rawLine)
  const node = graph.hasNode(ev.affectedNode)
    ? (graph.getNodeAttributes(ev.affectedNode) as { name?: string; service?: string })
    : undefined
  return {
    file,
    ...(Number.isFinite(line) ? { lineStart: line, lineEnd: line } : {}),
    ...(node?.name ? { symbol: node.name } : {}),
    service: node?.service ?? ev.service,
    provenance: Provenance.OBSERVED,
  }
}

// The declared file:line a node itself carries — a SymbolNode's `relPath` +
// definition `span`, or a FileNode's `path`. Used to promote a root-cause locus
// onto a victim-surfaced card (#1111). Null when the node carries no file — never
// synthesized.
function locusFromNode(graph: NeatGraph, nodeId: string): IncidentLocus | null {
  if (!graph.hasNode(nodeId)) return null
  const n = graph.getNodeAttributes(nodeId) as {
    relPath?: string
    path?: string
    service?: string
    qualname?: string
    span?: { startLine?: number; endLine?: number }
  }
  const file = n.relPath ?? n.path
  if (typeof file !== 'string' || file.length === 0) return null
  const start = n.span?.startLine
  const end = n.span?.endLine
  return {
    file,
    ...(typeof start === 'number' ? { lineStart: start } : {}),
    ...(typeof end === 'number' ? { lineEnd: end } : {}),
    ...(n.qualname ? { symbol: shortLabel(graph, nodeId) } : {}),
    ...(n.service ? { service: n.service } : {}),
    provenance: Provenance.INFERRED,
  }
}

// #1111: a victim-surfaced incident (a frontend 5xx / gRPC error) carries no code
// locus of its own, but the resolved root cause does. Surface the cause's locus
// so the card still points the agent at the code instead of `null`. Prefer the
// exact failing line from a native incident recorded AT the cause node; else the
// cause node's own declared definition. Always INFERRED — it names the cause, not
// the observed surface. Zero-fabrication: only a locus that actually exists.
function promoteCauseLocus(
  graph: NeatGraph,
  causeNode: string,
  incidents: readonly ErrorEvent[],
): IncidentLocus | null {
  const native = incidents.find(
    (e) => e.affectedNode === causeNode && typeof e.attributes?.[CODE_FILEPATH_ATTR] === 'string',
  )
  if (native) {
    const l = locusOf(graph, native)
    if (l) return { ...l, symbol: shortLabel(graph, causeNode), provenance: Provenance.INFERRED }
  }
  return locusFromNode(graph, causeNode)
}

// A short, union-safe summary for a divergence at the node — `source/target`
// (and `table.column` when present) are on every variant, so this never trips
// on a variant-specific field. The `type` carries the semantic.
function divergenceSummary(d: Divergence): string {
  const column = 'column' in d && d.column ? `.${d.column}` : ''
  const label = 'table' in d && d.table ? `${d.table}${column}` : `${d.source} → ${d.target}`
  return label
}

// The file's base name — the headline stays readable while the structured
// `locus.file` keeps the absolute path the agent opens. A pure string split, so
// the assembler's no-I/O purity holds (no `node:path` import).
function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

// A short human label for a node id — the graph node's `name`, else the id's
// terminal segment (after `#`, then after the last `:`). Never the raw id.
function shortLabel(graph: NeatGraph, nodeId: string): string {
  if (graph.hasNode(nodeId)) {
    const name = (graph.getNodeAttributes(nodeId) as { name?: string }).name
    if (typeof name === 'string' && name.length > 0) return name
  }
  const afterHash = nodeId.includes('#') ? nodeId.slice(nodeId.lastIndexOf('#') + 1) : nodeId
  return afterHash.includes(':') ? afterHash.slice(afterHash.lastIndexOf(':') + 1) : afterHash
}

// The one-line sentence (ADR-221) — a human/loose-LLM read over the structured
// body. Deterministic and total: it renders whatever the card actually carries,
// using the file's base name and human labels — never an absolute path or a raw
// node id (the structured fields keep those).
function renderHeadline(
  graph: NeatGraph,
  ev: ErrorEvent,
  locus: IncidentLocus | null,
  causeNode: string | null,
): string {
  const what = ev.exceptionType ? `raised ${ev.exceptionType}` : ev.errorMessage || 'failed'
  const causeLabel = causeNode && causeNode !== ev.affectedNode ? shortLabel(graph, causeNode) : ''
  if (locus) {
    const base = baseName(locus.file)
    const lines =
      locus.lineStart != null
        ? locus.lineEnd && locus.lineEnd !== locus.lineStart
          ? `LINES ${locus.lineStart}-${locus.lineEnd}`
          : `LINE ${locus.lineStart}`
        : ''
    // Prefer the recovered symbol; else, when the incident lands on a
    // symbol-grain node, name it from the node id — so a symbol incident reads
    // as SYMBOL, not FILE.
    const symbol =
      locus.symbol ??
      (grainOf(graph, ev.affectedNode) === 'symbol'
        ? shortLabel(graph, ev.affectedNode)
        : undefined)
    const subject = symbol ? `SYMBOL ${symbol}` : `FILE ${base}`
    const at = symbol ? `${lines ? `${lines} in ` : ''}${base}` : lines
    const where = at ? ` at ${at}` : ''
    // Attribute the file to the service that owns it (the promoted cause may live
    // in a different service than where the incident surfaced), and drop the
    // "→ root cause X" tail when the subject already names that cause (#1111).
    const svc = locus.service ?? ev.service
    const cause = causeLabel && causeLabel !== symbol ? ` → root cause ${causeLabel}` : ''
    return `${subject}${where} (SERVICE ${svc}) ${what} at ${ev.timestamp}${cause}`
  }
  const cause = causeLabel ? ` → root cause ${causeLabel}` : ''
  return `SERVICE ${ev.service} ${what} at ${ev.timestamp}${cause}`
}

export function buildIncidentCard(
  graph: NeatGraph,
  errorEvent: ErrorEvent,
  incidents: readonly ErrorEvent[],
  policies: Policy[],
): IncidentCard {
  const affected = errorEvent.affectedNode
  let locus = locusOf(graph, errorEvent)
  // The incident may be attributed to a node the live graph no longer carries
  // (a retired node, or service:unidentified). The graph-walking queries need
  // the node to exist; when it doesn't, the card degrades to locus + headline
  // rather than throwing — the same honest degradation as a missing locus.
  const inGraph = graph.hasNode(affected)

  // Root cause + its chain, each hop stamped with the provenance of the edge
  // into it. Null when no cause is reachable — the incident still ships.
  const rc = inGraph ? getRootCause(graph, affected, errorEvent, incidents) : null
  let rootCause: IncidentCard['rootCause'] = null
  if (rc) {
    const provs = rc.edgeProvenances ?? []
    const chain: IncidentChainHop[] = (rc.traversalPath ?? []).map((node, i) => ({
      node,
      grain: grainOf(graph, node),
      provenance: (provs[i] ??
        provs[provs.length - 1] ??
        Provenance.INFERRED) as ProvenanceValue,
    }))
    rootCause = {
      node: rc.rootCauseNode,
      ...(rc.candidates?.[0]?.classification
        ? { classification: rc.candidates[0].classification }
        : {}),
      reason: rc.rootCauseReason,
      confidence: rc.confidence,
      fix: rc.fixRecommendation ?? null,
      chain,
    }
  }

  // #1111: the incident surfaced on a node with no code locus of its own (a
  // frontend/proxy victim), but the root cause resolved to a node that carries a
  // file:line. Promote the cause's locus (INFERRED) so the card — and its
  // headline — still point the agent at the code instead of `null`.
  if (locus === null && rootCause) {
    locus = promoteCauseLocus(graph, rootCause.node, incidents)
  }

  // What a fix at the locus would reach — the total plus the nearest nodes.
  const blast = inGraph
    ? getBlastRadius(graph, affected)
    : { origin: affected, affectedNodes: [], totalAffected: 0 }
  const nearest = [...blast.affectedNodes]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, BLAST_NEAREST_LIMIT)
    .map((n) => ({ node: n.nodeId, distance: n.distance, provenance: n.edgeProvenance }))

  // The rules that govern the node (soft guardrail, ADR-108).
  const applicable = inGraph ? selectApplicablePolicies(graph, policies, affected) : []
  const policyCards = applicable.map((p) => ({
    policyName: p.policyName,
    severity: p.severity,
    message: p.reason,
  }))

  // Any code↔runtime divergence already standing at the node.
  const divergences = inGraph
    ? computeDivergences(graph, { node: affected, incidents }).divergences.map((d) => ({
        type: d.type,
        summary: divergenceSummary(d),
      }))
    : []

  const card: IncidentCard = {
    kind: 'incident',
    id: errorEvent.id,
    at: errorEvent.timestamp,
    incidentKind: incidentKindOf(errorEvent),
    service: errorEvent.service,
    affectedNode: affected,
    message: errorEvent.errorMessage,
    ...(errorEvent.exceptionType ? { exceptionType: errorEvent.exceptionType } : {}),
    ...(errorEvent.httpStatusCode !== undefined
      ? { httpStatusCode: errorEvent.httpStatusCode }
      : {}),
    ...(errorEvent.incidentCount !== undefined ? { count: errorEvent.incidentCount } : {}),
    ...(errorEvent.firstTimestamp && errorEvent.lastTimestamp
      ? { window: { first: errorEvent.firstTimestamp, last: errorEvent.lastTimestamp } }
      : {}),
    ...(errorEvent.traceId ? { traceId: errorEvent.traceId } : {}),
    ...(errorEvent.spanId ? { spanId: errorEvent.spanId } : {}),
    locus,
    rootCause,
    ...(nearest.length > 0
      ? { blastRadius: { totalAffected: blast.totalAffected, nearest } }
      : {}),
    ...(policyCards.length > 0 ? { policies: policyCards } : {}),
    ...(divergences.length > 0 ? { divergence: divergences } : {}),
    headline: renderHeadline(graph, errorEvent, locus, rootCause?.node ?? null),
  }

  // Validate the composed shape before it leaves the assembler (§Enforcement).
  return IncidentCardSchema.parse(card)
}
