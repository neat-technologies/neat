// computeDivergences — the thesis surface, derived (ADR-060).
//
// Walks the live graph and surfaces the five locked divergence shapes:
// missing-observed, missing-extracted, version-mismatch, host-mismatch,
// and compat-violation. Pure: no I/O, no mutation, no async. The function
// operates on a NeatGraph reference and returns a fresh DivergenceResult
// each call — there is no persistence (binding rule 2).
//
// Mutation authority (ADR-030 / contract #3) is locked to ingest.ts and
// extract/*; this module reads only. The contract test
// `packages/core/test/audits/contracts.test.ts` enforces it.

import type {
  CompatRuleRef,
  Divergence,
  DivergenceResult,
  DivergenceType,
  EdgeTypeValue,
  GraphEdge,
  GraphNode,
  InfraNode,
  ServiceNode,
} from '@neat.is/types'
import {
  databaseId,
  DivergenceResultSchema,
  EdgeType,
  NodeType,
  parseEdgeId,
  parseFileId,
  Provenance,
  serviceId,
} from '@neat.is/types'
import type { NeatGraph } from './graph.js'
import { columnIsDeclared, columnIsObserved } from './columns.js'
import {
  checkCompatibility,
  checkDeprecatedApi,
  compatPairs,
  deprecatedApis,
} from './compat.js'
import { confidenceForEdge } from './traverse.js'

export interface DivergenceQueryOpts {
  // Filter the result to a subset of divergence types. Undefined keeps all
  // five. Empty set returns nothing.
  type?: ReadonlySet<DivergenceType>
  // Drop divergences below this confidence threshold. Undefined keeps all.
  minConfidence?: number
  // Scope to divergences that involve this node (as source or target).
  node?: string
}

// (source, target, type) → which provenance variants are present. Each
// bucket is the unit the missing-observed / missing-extracted detectors
// operate over.
interface EdgeBucket {
  source: string
  target: string
  type: GraphEdge['type']
  extracted?: GraphEdge
  observed?: GraphEdge
  inferred?: GraphEdge
  stale?: GraphEdge
}

function bucketKey(source: string, target: string, type: string): string {
  return `${type}|${source}|${target}`
}

// A database CONNECTS_TO is *declared* in a config file (its connection string)
// but *executed* from a code file (the query call site) — inherently different
// files. Comparing them at file grain would flag both a `missing-observed` (on
// the config-file edge) and a `missing-extracted` (on the code-file edge) for a
// database the service both declares and drives — a false pair on every ORM app
// (ADR-141). So roll a database CONNECTS_TO's source up to its owning service:
// declared and observed then compare at the grain they actually share. The
// file-grained edges stay in the graph untouched — only this comparison
// coarsens, and only for database targets (a route or service edge keeps its
// file grain per the ADR-119 route-grained comparison).
function bucketSourceFor(graph: NeatGraph, edge: GraphEdge): string {
  if (edge.type !== EdgeType.CONNECTS_TO) return edge.source
  const parsed = parseFileId(edge.source)
  if (!parsed || !graph.hasNode(edge.target)) return edge.source
  const target = graph.getNodeAttributes(edge.target) as GraphNode
  if (target.type !== NodeType.DatabaseNode) return edge.source
  return serviceId(parsed.service)
}

function bucketEdges(graph: NeatGraph): Map<string, EdgeBucket> {
  const buckets = new Map<string, EdgeBucket>()
  graph.forEachEdge((id, attrs) => {
    const e = attrs as GraphEdge
    const parsed = parseEdgeId(id)
    // parseEdgeId can fall through to EXTRACTED for unknown shapes — fall
    // back to the edge's own provenance when the id doesn't parse cleanly.
    const provenance = parsed?.provenance ?? e.provenance
    const source = bucketSourceFor(graph, e)
    const key = bucketKey(source, e.target, e.type)
    const cur =
      buckets.get(key) ?? { source, target: e.target, type: e.type }
    switch (provenance) {
      case Provenance.EXTRACTED:
        cur.extracted = e
        break
      case Provenance.OBSERVED:
        cur.observed = e
        break
      case Provenance.INFERRED:
        cur.inferred = e
        break
      default:
        // STALE rides on what used to be an OBSERVED edge — the id format
        // stays OBSERVED per identity.ts, so this branch is mostly defensive.
        if (e.provenance === Provenance.STALE) cur.stale = e
    }
    buckets.set(key, cur)
  })
  return buckets
}

function nodeIsFrontier(graph: NeatGraph, nodeId: string): boolean {
  if (!graph.hasNode(nodeId)) return false
  const attrs = graph.getNodeAttributes(nodeId) as GraphNode
  return attrs.type === NodeType.FrontierNode
}

// A WebSocketChannelNode is minted OBSERVED-only from the HTTP upgrade span
// (ADR-125): a channel is known from observation, never from static extraction,
// so it has no declared twin to diverge against. Its edge is a `CONNECTS_TO`,
// which is in the OBSERVABLE_EDGE_TYPES allowlist, so an OBSERVED-only
// `service ──CONNECTS_TO──▶ ws-channel` would otherwise flag a spurious
// `missing-extracted`. Suppressing it where the target is a channel node is
// signal-preserving — there is no static edge that "should" exist — not
// signal-hiding. See docs/contracts/divergence-query.md.
function nodeIsWebsocketChannel(graph: NeatGraph, nodeId: string): boolean {
  if (!graph.hasNode(nodeId)) return false
  const attrs = graph.getNodeAttributes(nodeId) as GraphNode
  return attrs.type === NodeType.WebSocketChannelNode
}

// A ServerActionNode is minted EXTRACTED-only from a `"use server"` directive
// (ADR-168); its inbound `file ──CALLS──▶ action` client-stitch has no OBSERVED
// twin by construction (Next serialises actions to opaque `Next-Action` hashes,
// so runtime never names the action). CALLS is in OBSERVABLE_EDGE_TYPES, so an
// EXTRACTED-only CALLS onto an action would otherwise flag a spurious
// `missing-observed`. Suppressing it where the target is an action node is
// signal-preserving — the OBSERVED twin cannot exist yet — not signal-hiding.
// A bounded target-exclusion, mirroring nodeIsWebsocketChannel; not a taxonomy
// change. See docs/contracts/divergence-query.md.
function nodeIsServerAction(graph: NeatGraph, nodeId: string): boolean {
  if (!graph.hasNode(nodeId)) return false
  const attrs = graph.getNodeAttributes(nodeId) as GraphNode
  return attrs.type === NodeType.ServerActionNode
}

// A SymbolNode endpoint marks a symbol-grained edge (static heritage, or a
// symbol→symbol EXTRACTED CALLS from Phase 2). Those live one grain below the
// file/service grain this query compares (file-awareness.md §7 — "compare
// CALLS-family edges at the shared grain"), and a static intra-process symbol
// call has no boundary-observed twin by construction (observed CALLS are
// boundary-grained, §5). Comparing them here would report every declared
// heritage link and every static call as a spurious `missing-observed`. Symbol-
// grain divergence is deliberately wired later (ADR-158 §7, Phase 3); until then
// a symbol-grained bucket stays out of this surface.
function nodeIsSymbol(graph: NeatGraph, nodeId: string): boolean {
  if (!graph.hasNode(nodeId)) return false
  const attrs = graph.getNodeAttributes(nodeId) as GraphNode
  return attrs.type === NodeType.SymbolNode
}

function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function reasonForMissingObserved(source: string, target: string, type: string): string {
  return `Code declares ${source} → ${target} (${type}) but no production traffic has been observed for this edge.`
}

function reasonForMissingExtracted(source: string, target: string, type: string): string {
  return `Production observed ${source} → ${target} (${type}) but static analysis did not surface this edge.`
}

const RECOMMENDATION_MISSING_OBSERVED =
  'Verify the code path is exercised in production; check feature flags or conditional branches that might gate the call.'
const RECOMMENDATION_MISSING_EXTRACTED =
  'Likely dynamic dispatch, reflection, or a coverage gap in tree-sitter extraction. Consider an `aliases` entry on the source service or file an extractor issue.'
const RECOMMENDATION_HOST_MISMATCH =
  'Check environment-specific config overrides — the runtime host differs from what static configuration declares.'

// ADR-066 §4 — reweight against graded confidence.
//
// `missing-extracted` (OBSERVED-led) cascades from the OBSERVED edge's
// graded confidence (signal-block grade per ADR-066 §2). `missing-observed`
// weights by the EXTRACTED edge's graded confidence (per-extractor grade
// per ADR-066 §1). Sub-floor EXTRACTED candidates never enter the graph
// (precision floor, §3) so what surfaces here is backed by structural or
// verified-call-site evidence.
//
// Falls back to confidenceForEdge for legacy edges loaded from a pre-v0.3.4
// snapshot that don't carry a stored `confidence` field.
function gradedConfidence(edge: GraphEdge): number {
  if (typeof edge.confidence === 'number') return clampConfidence(edge.confidence)
  return clampConfidence(confidenceForEdge(edge))
}

// Edge types production can actually emit as OBSERVED traffic — the CALLS
// family plus cross-service and connection edges. `missing-observed` only
// makes sense for these: an EXTRACTED edge of one of these types with no
// OBSERVED twin is a real "code declares it, production never ran it" finding.
//
// Structural / static-only edge types (IMPORTS, CONFIGURED_BY, CONTAINS,
// DEPENDS_ON, RUNS_ON) have no runtime span behind them, so there is never an
// OBSERVED twin to be "missing" — measuring their tiers would report every
// import and every config wire as a missing-observed divergence, which is
// noise, not signal. Keep this an allowlist (not a denylist) so a new
// structural edge type stays out of the missing-observed surface by default
// until it is deliberately added here (divergence-query.md — the five locked
// types compare CALLS-family edges at the shared grain).
const OBSERVABLE_EDGE_TYPES: ReadonlySet<EdgeTypeValue> = new Set([
  EdgeType.CALLS,
  EdgeType.CONNECTS_TO,
  EdgeType.PUBLISHES_TO,
  EdgeType.CONSUMES_FROM,
])

function detectMissingDivergences(
  graph: NeatGraph,
  bucket: EdgeBucket,
): Divergence[] {
  const out: Divergence[] = []

  // CONTAINS is structural ownership (service → file), not a declared-vs-
  // observed relationship — comparing its tiers would surface an OTel-only
  // file node as a spurious missing-extracted finding (file-awareness.md §2).
  // Divergence compares CALLS-family edges at the shared grain (§7).
  if (bucket.type === EdgeType.CONTAINS) return out

  // Symbol-grained buckets (heritage, symbol→symbol CALLS) are out of scope for
  // the file/service-grain divergence surface — see nodeIsSymbol.
  if (nodeIsSymbol(graph, bucket.source) || nodeIsSymbol(graph, bucket.target)) return out

  if (bucket.extracted && !bucket.observed && OBSERVABLE_EDGE_TYPES.has(bucket.type)) {
    // Skip when the would-be target is a FrontierNode — those represent
    // unresolved span peers, not real entities we expect OBSERVED traffic
    // to. The coexistence contract is between EXTRACTED and OBSERVED on
    // real nodes; FRONTIER is unknown territory.
    if (!nodeIsFrontier(graph, bucket.target) && !nodeIsServerAction(graph, bucket.target)) {
      // ADR-066 §4 — weight by the EXTRACTED edge's graded confidence.
      // Substring/hostname-shape candidates already dropped at the precision
      // floor; what remains is structural or verified-call-site evidence.
      out.push({
        type: 'missing-observed',
        source: bucket.source,
        target: bucket.target,
        edgeType: bucket.type,
        extracted: bucket.extracted,
        confidence: gradedConfidence(bucket.extracted),
        reason: reasonForMissingObserved(bucket.source, bucket.target, bucket.type),
        recommendation: RECOMMENDATION_MISSING_OBSERVED,
      })
    }
  }

  if (bucket.observed && !bucket.extracted && !nodeIsWebsocketChannel(graph, bucket.target)) {
    // ADR-066 §4 — cascade from the OBSERVED edge's graded confidence.
    // OBSERVED-led finding; the headline divergence type. A WebSocketChannelNode
    // target is skipped: it is OBSERVED-only by design (ADR-125), so an
    // OBSERVED-only CONNECTS_TO onto it is expected, not a missing-extracted
    // divergence — mirrors the CONTAINS exclusion above, keyed on target type.
    out.push({
      type: 'missing-extracted',
      source: bucket.source,
      target: bucket.target,
      edgeType: bucket.type,
      observed: bucket.observed,
      confidence: gradedConfidence(bucket.observed),
      reason: reasonForMissingExtracted(bucket.source, bucket.target, bucket.type),
      recommendation: RECOMMENDATION_MISSING_EXTRACTED,
    })
  }

  return out
}

// Returns the declared host of the service's static DB target, when
// recoverable. ServiceNode.dbConnectionTarget is the static-extraction
// surface for "this service connects to X" — `X` is host[:port] or a
// docker-compose-style service name. Empty / undefined means we have no
// EXTRACTED host to compare against and host-mismatch can't fire.
function declaredHostFor(svc: ServiceNode): string | null {
  const raw = svc.dbConnectionTarget?.trim()
  if (!raw) return null
  // Strip a trailing port if present so it lines up with DatabaseNode.host
  // (ADR-028 §6 — DatabaseNode id excludes port).
  const colon = raw.lastIndexOf(':')
  if (colon === -1) return raw
  const port = raw.slice(colon + 1)
  if (/^\d+$/.test(port)) return raw.slice(0, colon)
  return raw
}

function hasExtractedConfiguredBy(graph: NeatGraph, svcId: string): boolean {
  for (const edgeId of graph.outboundEdges(svcId)) {
    const e = graph.getEdgeAttributes(edgeId) as GraphEdge
    if (e.type === EdgeType.CONFIGURED_BY && e.provenance === Provenance.EXTRACTED) {
      return true
    }
  }
  return false
}

function detectHostMismatch(
  graph: NeatGraph,
  svcId: string,
  svc: ServiceNode,
): Divergence[] {
  const declaredHost = declaredHostFor(svc)
  if (!declaredHost) return []
  if (!hasExtractedConfiguredBy(graph, svcId)) return []

  const out: Divergence[] = []
  for (const edgeId of graph.outboundEdges(svcId)) {
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    if (edge.type !== EdgeType.CONNECTS_TO) continue
    if (edge.provenance !== Provenance.OBSERVED) continue
    const target = graph.getNodeAttributes(edge.target) as GraphNode
    if (target.type !== NodeType.DatabaseNode) continue
    const observedHost = target.host?.trim()
    if (!observedHost) continue
    if (observedHost === declaredHost) continue

    out.push({
      type: 'host-mismatch',
      source: svcId,
      target: edge.target,
      extractedHost: declaredHost,
      observedHost,
      confidence: clampConfidence(confidenceForEdge(edge)),
      reason: `Config declares ${svcId} connects to ${declaredHost}; production connects to ${observedHost}.`,
      recommendation: RECOMMENDATION_HOST_MISMATCH,
    })
  }
  return out
}

function detectCompatDivergences(
  graph: NeatGraph,
  svcId: string,
  svc: ServiceNode,
): Divergence[] {
  const out: Divergence[] = []
  const deps = svc.dependencies ?? {}

  for (const edgeId of graph.outboundEdges(svcId)) {
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    if (edge.type !== EdgeType.CONNECTS_TO) continue
    if (edge.provenance !== Provenance.OBSERVED) continue
    const target = graph.getNodeAttributes(edge.target) as GraphNode
    if (target.type !== NodeType.DatabaseNode) continue

    // Driver-engine compat. Definitive — when a rule fires it's a
    // version-mismatch with confidence 1.0.
    for (const pair of compatPairs()) {
      if (pair.engine !== target.engine) continue
      const declared = deps[pair.driver]
      if (!declared) continue
      const result = checkCompatibility(
        pair.driver,
        declared,
        target.engine,
        target.engineVersion,
      )
      if (!result.compatible && result.reason) {
        out.push({
          type: 'version-mismatch',
          source: svcId,
          target: edge.target,
          extractedVersion: declared,
          observedVersion: target.engineVersion,
          compatibility: 'incompatible',
          confidence: 1.0,
          reason: result.reason,
          recommendation: result.minDriverVersion
            ? `Upgrade ${pair.driver} to >= ${result.minDriverVersion}.`
            : `Update the ${pair.driver} driver to a version compatible with ${target.engine} ${target.engineVersion}.`,
        })
      }
    }

    // Deprecated-api compat. Broader than version-mismatch — surfaces as
    // compat-violation. Driver-engine rules above already covered the
    // "version is too low" shape; deprecated covers "version is too high
    // / no longer supported."
    for (const rule of deprecatedApis()) {
      const declared = deps[rule.package]
      if (!declared) continue
      const result = checkDeprecatedApi(rule, declared)
      if (!result.compatible && result.reason) {
        const ruleRef: CompatRuleRef = {
          kind: rule.kind ?? 'deprecated-api',
          reason: result.reason,
          package: rule.package,
        }
        out.push({
          type: 'compat-violation',
          source: svcId,
          target: edge.target,
          rule: ruleRef,
          observed: edge,
          confidence: 1.0,
          reason: result.reason,
          recommendation: `Replace deprecated ${rule.package}@${declared} with a supported version.`,
        })
      }
    }
  }
  return out
}

const RECOMMENDATION_COLUMN_MISSING_OBSERVED =
  'Verify the column is exercised in production; a migration that renamed or dropped it may have left a writer declaring the old name.'
const RECOMMENDATION_COLUMN_MISSING_EXTRACTED =
  'The schema or migration is likely behind the code — production writes a column the declared schema does not carry. Check for a field rename that updated the query but not the model.'

// Column-drift (ADR-157 §4) — the same missing-observed / missing-extracted
// semantics, computed over the declared and observed column sets on one
// `sql-table` node instead of across an edge triple. A declared-only column is
// `missing-observed`, an observed-only column is `missing-extracted`, reported at
// column grain (`orders.total`). Each column carries the sides it was seen with in
// its `provenances` set, so the declared set and the observed set read straight off
// one node: a column with EXTRACTED but no OBSERVED is declared-only, OBSERVED but
// no EXTRACTED is observed-only, and a column with both is fused — not drift.
//
// A node with only one side present anywhere emits nothing — no drift claim without
// both a declared and an observed column somewhere on the table (the ADR-141 fusion
// discipline). A table that is only declared, or only observed, is the edge-grain
// detectors' business, not column drift: the observed half stands alone as the
// "which columns does production touch" view, and a schema NEAT has parsed but never
// seen driven should not read as all-columns-missing.
function detectColumnDrift(node: InfraNode): Divergence[] {
  const columns = node.columns
  if (!columns || columns.length === 0) return []

  // Both sides must be present *somewhere* on the table, or there is no fused
  // picture to diverge against.
  const anyDeclared = columns.some(columnIsDeclared)
  const anyObserved = columns.some(columnIsObserved)
  if (!anyDeclared || !anyObserved) return []

  const out: Divergence[] = []
  for (const col of columns) {
    const declared = columnIsDeclared(col)
    const observed = columnIsObserved(col)
    if (declared && !observed) {
      out.push({
        type: 'missing-observed',
        source: node.id,
        target: node.id,
        table: node.id,
        column: col.name,
        confidence: clampConfidence(col.confidence),
        reason: `Schema declares column ${node.name}.${col.name} but no production statement has touched it.`,
        recommendation: RECOMMENDATION_COLUMN_MISSING_OBSERVED,
      })
    } else if (observed && !declared) {
      out.push({
        type: 'missing-extracted',
        source: node.id,
        target: node.id,
        table: node.id,
        column: col.name,
        confidence: clampConfidence(col.confidence),
        reason: `Production touched column ${node.name}.${col.name} but the schema does not declare it.`,
        recommendation: RECOMMENDATION_COLUMN_MISSING_EXTRACTED,
      })
    }
  }
  return out
}

function involvesNode(d: Divergence, nodeId: string): boolean {
  return d.source === nodeId || d.target === nodeId
}

// A single service<->DB host drift lights up three ways: the host-mismatch
// itself, a missing-extracted on the observed DB node (the OBSERVED CONNECTS_TO
// edge went to the *wrong* host, so it has no EXTRACTED twin), and a
// missing-observed on the declared DB node (the EXTRACTED wire to the declared
// host was never driven because traffic went elsewhere). The two missing-*
// findings are just the halves of the drift the host-mismatch already names in
// full, so they collapse into it — one divergence per distinct problem, so
// blast-radius counts stay honest (issue #591). Pass 1 and Pass 2 run
// independently, so this reconciles them after both have emitted.
function suppressHostMismatchHalves(all: Divergence[]): Divergence[] {
  const observedHalf = new Set<string>() // `${source}->${target}` of the observed DB edge
  const declaredHalf = new Set<string>() // declared DB node id
  for (const d of all) {
    if (d.type !== 'host-mismatch') continue
    observedHalf.add(`${d.source}->${d.target}`)
    declaredHalf.add(databaseId(d.extractedHost))
  }
  if (observedHalf.size === 0) return all
  return all.filter((d) => {
    if (
      d.type === 'missing-extracted' &&
      observedHalf.has(`${d.source}->${d.target}`)
    ) {
      return false
    }
    if (d.type === 'missing-observed' && declaredHalf.has(d.target)) return false
    return true
  })
}

export function computeDivergences(
  graph: NeatGraph,
  opts: DivergenceQueryOpts = {},
): DivergenceResult {
  const all: Divergence[] = []

  // Pass 1 — bucket every edge and emit missing-observed / missing-extracted.
  const buckets = bucketEdges(graph)
  for (const bucket of buckets.values()) {
    for (const d of detectMissingDivergences(graph, bucket)) all.push(d)
  }

  // Pass 2 — per-service host + compat rules, and per-table column drift.
  graph.forEachNode((nodeId, attrs) => {
    const n = attrs as GraphNode
    if (n.type === NodeType.ServiceNode) {
      const svc = n as ServiceNode
      for (const d of detectHostMismatch(graph, nodeId, svc)) all.push(d)
      for (const d of detectCompatDivergences(graph, nodeId, svc)) all.push(d)
      return
    }
    // Column drift (ADR-157 §4) rides on `sql-table` InfraNodes.
    if (n.type === NodeType.InfraNode && n.kind === 'sql-table') {
      for (const d of detectColumnDrift(n)) all.push(d)
    }
  })

  // Reconcile the two passes: a fired host-mismatch already tells the whole
  // service<->DB drift story, so drop the redundant missing-* halves (#591).
  const reconciled = suppressHostMismatchHalves(all)

  // Filter + sort. Higher confidence first; within the same confidence,
  // stable on (type, source, target) so callers see deterministic output.
  let filtered = reconciled
  if (opts.type) {
    const allowed = opts.type
    filtered = filtered.filter((d) => allowed.has(d.type))
  }
  if (opts.minConfidence !== undefined) {
    const threshold = opts.minConfidence
    filtered = filtered.filter((d) => d.confidence >= threshold)
  }
  if (opts.node) {
    const target = opts.node
    filtered = filtered.filter((d) => involvesNode(d, target))
  }

  // ADR-066 §4 / §5 — confidence desc; missing-extracted leads
  // missing-observed at equal confidence (OBSERVED-led tiebreaker); then
  // stable on (type, source, target).
  const TYPE_LEADERSHIP: Record<DivergenceType, number> = {
    'missing-extracted': 0,
    'missing-observed': 1,
    'version-mismatch': 2,
    'host-mismatch': 3,
    'compat-violation': 4,
  }
  filtered.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence
    const lead = TYPE_LEADERSHIP[a.type] - TYPE_LEADERSHIP[b.type]
    if (lead !== 0) return lead
    if (a.type !== b.type) return a.type.localeCompare(b.type)
    if (a.source !== b.source) return a.source.localeCompare(b.source)
    if (a.target !== b.target) return a.target.localeCompare(b.target)
    // Column-locus drift shares source == target (the table node), so break the
    // final tie on the column name to keep column-grain output deterministic.
    const ac = 'column' in a && a.column ? a.column : ''
    const bc = 'column' in b && b.column ? b.column : ''
    return ac.localeCompare(bc)
  })

  return DivergenceResultSchema.parse({
    divergences: filtered,
    totalAffected: filtered.length,
    computedAt: new Date().toISOString(),
  })
}
