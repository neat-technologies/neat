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
  GraphEdge,
  GraphNode,
  ServiceNode,
} from '@neat.is/types'
import {
  DivergenceResultSchema,
  EdgeType,
  NodeType,
  parseEdgeId,
  Provenance,
} from '@neat.is/types'
import type { NeatGraph } from './graph.js'
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

function bucketEdges(graph: NeatGraph): Map<string, EdgeBucket> {
  const buckets = new Map<string, EdgeBucket>()
  graph.forEachEdge((id, attrs) => {
    const e = attrs as GraphEdge
    const parsed = parseEdgeId(id)
    // parseEdgeId can fall through to EXTRACTED for unknown shapes — fall
    // back to the edge's own provenance when the id doesn't parse cleanly.
    const provenance = parsed?.provenance ?? e.provenance
    const key = bucketKey(e.source, e.target, e.type)
    const cur =
      buckets.get(key) ?? { source: e.source, target: e.target, type: e.type }
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

  if (bucket.extracted && !bucket.observed) {
    // Skip when the would-be target is a FrontierNode — those represent
    // unresolved span peers, not real entities we expect OBSERVED traffic
    // to. The coexistence contract is between EXTRACTED and OBSERVED on
    // real nodes; FRONTIER is unknown territory.
    if (!nodeIsFrontier(graph, bucket.target)) {
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

  if (bucket.observed && !bucket.extracted) {
    // ADR-066 §4 — cascade from the OBSERVED edge's graded confidence.
    // OBSERVED-led finding; the headline divergence type.
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

function involvesNode(d: Divergence, nodeId: string): boolean {
  return d.source === nodeId || d.target === nodeId
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

  // Pass 2 — per-service host + compat rules.
  graph.forEachNode((nodeId, attrs) => {
    const n = attrs as GraphNode
    if (n.type !== NodeType.ServiceNode) return
    const svc = n as ServiceNode
    for (const d of detectHostMismatch(graph, nodeId, svc)) all.push(d)
    for (const d of detectCompatDivergences(graph, nodeId, svc)) all.push(d)
  })

  // Filter + sort. Higher confidence first; within the same confidence,
  // stable on (type, source, target) so callers see deterministic output.
  let filtered = all
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
    return a.target.localeCompare(b.target)
  })

  return DivergenceResultSchema.parse({
    divergences: filtered,
    totalAffected: filtered.length,
    computedAt: new Date().toISOString(),
  })
}
