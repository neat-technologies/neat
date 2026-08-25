// computeDivergences — the thesis surface, derived (ADR-060).
//
// Walks the live graph and surfaces the edge-grain divergence shapes:
// missing-observed, missing-extracted, version-mismatch, host-mismatch, and
// compat-violation. When the caller passes the recorded incidents, it also
// surfaces observed-symbol-mismatch (ADR-215) — a symbol/field-grain code↔runtime
// disagreement fused from an OBSERVED incident and the EXTRACTED code location it
// localized to, the one shape that never appears as a missing edge. Pure: no
// I/O, no mutation, no async. The function operates on a NeatGraph reference (and
// the in-memory incidents array the caller supplies) and returns a fresh
// DivergenceResult each call — there is no persistence (binding rule 2).
//
// Mutation authority (ADR-030 / contract #3) is locked to ingest.ts and
// extract/*; this module reads only. The contract test
// `packages/core/test/audits/contracts.test.ts` enforces it.

import type {
  CompatRuleRef,
  DatabaseNode,
  Divergence,
  DivergenceResult,
  DivergenceType,
  EdgeTypeValue,
  ErrorEvent,
  GraphEdge,
  GraphNode,
  InfraNode,
  ServiceNode,
  SymbolMismatchKind,
} from '@neat.is/types'
import {
  databaseId,
  DivergenceResultSchema,
  EdgeType,
  NodeType,
  parseEdgeId,
  parseFileId,
  parseSymbolId,
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
import { codeFilepathOf, codeLinenoOf } from './ingest.js'

export interface DivergenceQueryOpts {
  // Filter the result to a subset of divergence types. Undefined keeps all of
  // them. Empty set returns nothing.
  type?: ReadonlySet<DivergenceType>
  // Drop divergences below this confidence threshold. Undefined keeps all.
  minConfidence?: number
  // Scope to divergences that involve this node (as source or target).
  node?: string
  // The recorded incident store (ADR-215). Symbol/field-grain divergence is not
  // in the edge sets — it lives in the OBSERVED error content — so the detector
  // needs the incidents the caller has already read off the sidecar. Passing an
  // in-memory array keeps `computeDivergences` pure: no I/O, no mutation, no
  // async; the read stays at the call site. Omitted or empty means the
  // symbol-grain pass contributes nothing and the edge-grain result is identical
  // to before.
  incidents?: readonly ErrorEvent[]
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
// heritage link and every static call as a spurious `missing-observed`. This
// edge-bucket exclusion is independent of the symbol/field-grain divergence
// ADR-215 wires below (detectSymbolMismatches): that one is sourced from the
// incident store, not from comparing symbol edge buckets, so a symbol→symbol edge
// with no observed twin still stays out of this surface.
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

// ── Symbol/field-grain divergence (ADR-215) ────────────────────────────────
//
// The edge detectors above compare declared and observed *edges* — "does a
// declared edge have an observed twin?". A whole class of code↔runtime
// disagreement never shows up as a missing edge: the code declares access to a
// field / attribute / method / column the runtime object does not have. The call
// the member sits behind is made and observed — the edge is present — but the
// access fails at runtime, recorded as an incident localized to the declaring
// `code.filepath`/`code.lineno`. This detector fuses that OBSERVED incident with
// the EXTRACTED code location and surfaces it here, so `get_divergences` answers
// "where does declared disagree with observed" at symbol grain too, not only at
// edge grain. This is the purest fusion win — invisible to a code-only reader,
// decisive once the runtime error is joined to the declared access.
//
// The classifier keys ONLY on generic error *semantics* — the shape of the
// failure — never a language / framework / provider / field name (ADR-158 §6,
// scanned). Each entry pairs a neutral mismatch category with the phrasings
// runtimes use to report it; the capture group, when present, recovers the
// member the runtime lacked. New phrasings are added to a category, never a
// per-language branch.
const SYMBOL_MISMATCH_PATTERNS: ReadonlyArray<{
  kind: SymbolMismatchKind
  patterns: readonly RegExp[]
}> = [
  {
    // "'ListProductsResponse' object has no attribute 'products_list'" and kin.
    kind: 'missing-attribute',
    patterns: [/\bhas no attribute\b[\s:=]*['"`]?([A-Za-z_$][\w$]*)['"`]?/i],
  },
  {
    // "object has no field 'X'", "no such field X", "unknown field X".
    kind: 'missing-field',
    patterns: [
      /\b(?:has no field|no such field|unknown field)\b(?:\s+named)?[\s:=]*['"`]?([A-Za-z_$][\w$.]*)['"`]?/i,
    ],
  },
  {
    // "has no property X", "no property named X".
    kind: 'missing-property',
    patterns: [
      /\b(?:has no property|no property named)\b[\s:=]*['"`]?([A-Za-z_$][\w$]*)['"`]?/i,
    ],
  },
  {
    // "no such column: X", "unknown column 'X'", "column X does not exist".
    kind: 'missing-column',
    patterns: [
      /\bno such column\b[\s:=]*['"`]?([\w$.]+)['"`]?/i,
      /\bunknown column\b[\s:=]*['"`]?([\w$.]+)['"`]?/i,
      /\bcolumn\b[\s:=]*['"`]?([\w$.]+)['"`]?\s+does not exist/i,
    ],
  },
  {
    // "undefined method `foo' for X" — kept to the unambiguous form so a generic
    // "method not found" (an unimplemented RPC — an edge/route gap, not a symbol
    // mismatch) does not get miscategorised here.
    kind: 'undefined-method',
    patterns: [/\bundefined method\b\s*[`'"]?([\w$?!]+)/i],
  },
]

// Classify an error message by generic semantics. Returns the neutral mismatch
// category and, when the message names it, the member the runtime lacked.
function classifySymbolMismatch(
  message: string,
): { kind: SymbolMismatchKind; symbol?: string } | null {
  for (const entry of SYMBOL_MISMATCH_PATTERNS) {
    for (const re of entry.patterns) {
      const m = re.exec(message)
      if (m) {
        const captured = m[1]
        return captured ? { kind: entry.kind, symbol: captured } : { kind: entry.kind }
      }
    }
  }
  return null
}

// The finest code node an incident fused to, plus the declaring `file:line`. The
// strong path: the incident localized to a symbol or file node the graph carries
// (the EXTRACTED code location the runtime named, already joined by ingest —
// file-awareness §4 / ADR-158 §5). Falls back to the owning service when we still
// have a `file:line` to point at. Returns null when the incident names no code
// location at all — there is nothing honest to surface without one.
function symbolLocus(
  graph: NeatGraph,
  ev: ErrorEvent,
): { node: string; location?: string } | null {
  const attrs = ev.attributes ?? {}
  const filepath = codeFilepathOf(attrs)
  const lineno = codeLinenoOf(attrs)
  const location = filepath
    ? `${filepath}${lineno !== undefined ? `:${lineno}` : ''}`
    : undefined

  const affected = ev.affectedNode
  const affectedInGraph = affected.length > 0 && graph.hasNode(affected)
  const affectedIsCode =
    affectedInGraph && (parseSymbolId(affected) !== null || parseFileId(affected) !== null)

  // Strong path — the incident sits on a symbol/file node; that node is the
  // declared code location, and points at code with or without a captured line.
  if (affectedIsCode) return { node: affected, ...(location ? { location } : {}) }

  // Weaker paths must carry a `file:line`: the finding names a declaring code
  // location, so without one there is nothing to surface.
  if (!location) return null
  if (affectedInGraph) return { node: affected, location }
  const svc = serviceId(ev.service)
  if (graph.hasNode(svc)) return { node: svc, location }
  return null
}

// Confidence a symbol/field-grain finding carries: the INFERRED stitch grade
// (~0.6, the same grade a stitched edge and an incident-localized root cause
// take). It ranks below the high-confidence edge divergences — structural
// `missing-extracted`, definitive `version-mismatch`/`compat-violation` at 1.0 —
// while sitting well above a dampened dead-code probe (0.1). The classification
// itself is unambiguous, but the claim that this error corresponds to a declared
// access at this line is an inference joining two layers, so INFERRED is the
// honest grade.
const SYMBOL_MISMATCH_CONFIDENCE = 0.6

function detectSymbolMismatches(
  graph: NeatGraph,
  incidents: readonly ErrorEvent[],
): Divergence[] {
  // Collapse the same failing access reported many times into one finding that
  // carries the count — the "count this failure mode, not every incident on the
  // node" discipline the root-cause localizer uses (issue #624). Key on the
  // (locus node, mismatch kind, member) triple.
  interface Group {
    node: string
    kind: SymbolMismatchKind
    symbol?: string
    location?: string
    latest: ErrorEvent
    count: number
  }
  const groups = new Map<string, Group>()

  for (const ev of incidents) {
    const classified = classifySymbolMismatch(ev.errorMessage)
    if (!classified) continue
    const locus = symbolLocus(graph, ev)
    if (!locus) continue
    const key = `${locus.node}|${classified.kind}|${classified.symbol ?? ''}`
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, {
        node: locus.node,
        kind: classified.kind,
        ...(classified.symbol ? { symbol: classified.symbol } : {}),
        ...(locus.location ? { location: locus.location } : {}),
        latest: ev,
        count: 1,
      })
    } else {
      existing.count += 1
      // Most recent incident is the representative; ISO timestamps sort lexically.
      if (ev.timestamp.localeCompare(existing.latest.timestamp) > 0) {
        existing.latest = ev
        if (locus.location) existing.location = locus.location
      }
    }
  }

  const out: Divergence[] = []
  for (const g of groups.values()) {
    const member = g.symbol ? `\`${g.symbol}\`` : 'a member'
    const where = g.location ? ` at ${g.location}` : ''
    const times =
      g.count > 1 ? ` (${g.count} recorded incidents)` : ' (1 recorded incident)'
    out.push({
      type: 'observed-symbol-mismatch',
      source: g.node,
      target: g.node,
      mismatchKind: g.kind,
      ...(g.symbol ? { symbol: g.symbol } : {}),
      ...(g.location ? { location: g.location } : {}),
      provenance: Provenance.INFERRED,
      incidentId: g.latest.id,
      errorMessage: g.latest.errorMessage,
      incidentCount: g.count,
      confidence: SYMBOL_MISMATCH_CONFIDENCE,
      reason:
        `Code${where} declares access to ${member} the runtime object does not have — ` +
        `${g.latest.service} raised "${g.latest.errorMessage}"${times}. ` +
        `The declared access (EXTRACTED) and the runtime shape (OBSERVED) disagree at symbol grain.`,
      recommendation:
        'Reconcile the declared access with the runtime shape: a field, attribute, method, or column was ' +
        'renamed, removed, or never existed on the object this code reaches. Update the code to the current ' +
        'shape, or restore the member.',
    })
  }
  return out
}

function involvesNode(d: Divergence, nodeId: string): boolean {
  return d.source === nodeId || d.target === nodeId
}

// A datastore host production has actually connected to — now, or before it went
// quiet. `discoveredVia` is the durable marker: a DatabaseNode OTel ever minted
// or merged carries `otel`/`merged` and keeps it even after its OBSERVED edge is
// culled, so a host that was observed then went dark still reads as ever-observed.
// The inbound OBSERVED/STALE edge is the live read for the same fact (a STALE
// edge kept its OBSERVED-format id, so it is the transitioned twin of a host that
// was observed). A purely-static node with no observed edge anywhere is not.
function datastoreEverObserved(graph: NeatGraph, nodeId: string): boolean {
  if (!graph.hasNode(nodeId)) return false
  const n = graph.getNodeAttributes(nodeId) as GraphNode
  if (n.type === NodeType.DatabaseNode) {
    const via = (n as DatabaseNode).discoveredVia
    if (via === 'otel' || via === 'merged') return true
  }
  for (const edgeId of graph.inboundEdges(nodeId)) {
    const e = graph.getEdgeAttributes(edgeId) as GraphEdge
    if (e.provenance === Provenance.OBSERVED || e.provenance === Provenance.STALE) return true
  }
  return false
}

// Does `serviceId` connect to a DatabaseNode of `engine`, other than
// `excludeTarget`, that production is or was observed talking to? The sibling
// side of the dead-code-probe signature (ADR-213): the service clearly drives a
// real store of this kind, so an extra never-observed literal alternate reads as
// dead code. Reuses the buckets already grouped by (service, target, type); a
// datastore CONNECTS_TO bucket's `source` is the owning service id
// (bucketSourceFor), and a STALE twin lands in `.observed` (its id stays
// OBSERVED-format), so `.observed` here means "is or was observed".
function serviceHasObservedSameEngineStore(
  graph: NeatGraph,
  buckets: Map<string, EdgeBucket>,
  serviceId: string,
  engine: string,
  excludeTarget: string,
): boolean {
  for (const bucket of buckets.values()) {
    if (bucket.type !== EdgeType.CONNECTS_TO) continue
    if (bucket.source !== serviceId) continue
    if (bucket.target === excludeTarget) continue
    if (!graph.hasNode(bucket.target)) continue
    const target = graph.getNodeAttributes(bucket.target) as GraphNode
    if (target.type !== NodeType.DatabaseNode) continue
    if ((target as DatabaseNode).engine !== engine) continue
    if (bucket.observed || datastoreEverObserved(graph, bucket.target)) return true
  }
  return false
}

// Confidence a dead-code / flag-gated datastore probe is dampened to (ADR-213).
// Low enough to fall below the default surfacing thresholds and sort to the
// bottom, but not zero: a genuinely-suspicious dead declaration can still be
// found at low confidence rather than vanishing (dampen, don't delete).
const DEAD_CODE_PROBE_CONFIDENCE = 0.1

// A hardcoded-literal datastore host that (a) production has never observed and
// (b) sits beside another datastore of the SAME engine on the SAME service that
// production IS or WAS observed talking to is a dead-code / fault-injection probe
// (ADR-213) — e.g. the otel-demo cart's hardcoded `"badhost:1234"` store next to
// its env-configured `valkey-cart`. Its `missing-observed` is a false positive
// against the divergence thesis: "declared but never driven" is by design here,
// not a declared-vs-observed gap, and on a code/config RCA it steers the agent
// wrong. Dampen it to low confidence (not deletion) so it drops off the top-line
// while a genuinely-suspicious dead declaration can still surface.
//
// The real broken-dependency divergence — the signal the divergence pitch rests
// on — never matches this signature and keeps its full confidence: a host that
// WAS observed and went dark reads as ever-observed (its DatabaseNode kept
// `discoveredVia: 'merged'`, or a STALE twin still stands), and the service's
// sole or env-configured store is `config`-sourced, not a hardcoded literal, so
// neither the never-observed test nor the literal test that gate this ever fire
// on it. The three gates are conjunctive by design — dropping any one would risk
// dampening a real never-observed dependency (see docs/contracts/divergence-query.md).
function dampenDeadCodeProbes(
  graph: NeatGraph,
  buckets: Map<string, EdgeBucket>,
  all: Divergence[],
): Divergence[] {
  return all.map((d) => {
    if (d.type !== 'missing-observed') return d
    // Edge locus only — a column-locus drift carries no `extracted` edge.
    if (!d.extracted || d.edgeType !== EdgeType.CONNECTS_TO) return d
    if (!graph.hasNode(d.target)) return d
    const target = graph.getNodeAttributes(d.target) as GraphNode
    if (target.type !== NodeType.DatabaseNode) return d
    // Gate 1 — the host was recovered from a hardcoded literal, not config/env.
    if (d.extracted.evidence?.hostSource !== 'literal') return d
    // Gate 2 — production has never observed this host (now or before).
    if (datastoreEverObserved(graph, d.target)) return d
    // Gate 3 — the service does observe a real store of the same engine.
    const engine = (target as DatabaseNode).engine
    if (!serviceHasObservedSameEngineStore(graph, buckets, d.source, engine, d.target)) return d

    const host = (target as DatabaseNode).host ?? target.name
    return {
      ...d,
      confidence: Math.min(d.confidence, DEAD_CODE_PROBE_CONFIDENCE),
      reason:
        `${d.source} declares a ${engine} connection to a hardcoded-literal host (${host}) that production has never observed, ` +
        `while it does observe another ${engine} store — this reads as a flag-gated or dead-code declaration (e.g. a fault-injection probe), not a real declared-vs-observed gap.`,
      recommendation:
        'Confirm this is an intentional dead alternate — a fault-injection probe or a flag-gated branch. ' +
        'If it is meant to run in production, check the feature flag or conditional that gates it; if not, it can be ignored or removed.',
    }
  })
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

  // Pass 3 — symbol/field-grain divergence (ADR-215). Fuse OBSERVED incidents
  // whose error semantics name a field/attribute/method/column mismatch with the
  // EXTRACTED code location that declares the access. Sourced from the incident
  // store the caller passed in — the mismatch never appears as a missing edge, so
  // the edge sets can't surface it. Read-only, still pure: incidents are
  // in-memory data. Skipped entirely (no cost, identical edge-grain output) when
  // no incidents are supplied.
  if (opts.incidents && opts.incidents.length > 0) {
    for (const d of detectSymbolMismatches(graph, opts.incidents)) all.push(d)
  }

  // Reconcile the two passes: a fired host-mismatch already tells the whole
  // service<->DB drift story, so drop the redundant missing-* halves (#591).
  const reconciled = suppressHostMismatchHalves(all)

  // Dampen dead-code / flag-gated datastore probes (ADR-213): a never-observed
  // hardcoded-literal store sitting beside an observed same-engine store on the
  // same service is a false-positive missing-observed, not a real gap. Real
  // broken dependencies never match the signature and keep full confidence.
  const dampened = dampenDeadCodeProbes(graph, buckets, reconciled)

  // Filter + sort. Higher confidence first; within the same confidence,
  // stable on (type, source, target) so callers see deterministic output.
  let filtered = dampened
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
    // Symbol/field-grain (ADR-215) rides the confidence sort like every other
    // type; this only breaks a confidence tie, and it orders last so a same-
    // confidence edge finding leads. In practice it carries the INFERRED grade
    // (0.6), so it sits below the high-confidence edge divergences already.
    'observed-symbol-mismatch': 5,
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
    if (ac !== bc) return ac.localeCompare(bc)
    // Symbol/field-grain (ADR-215) also shares source == target (the code node);
    // break its final tie on the accessed member so two mismatches on one node
    // stay deterministically ordered.
    const asym = 'symbol' in a && a.symbol ? a.symbol : ''
    const bsym = 'symbol' in b && b.symbol ? b.symbol : ''
    return asym.localeCompare(bsym)
  })

  return DivergenceResultSchema.parse({
    divergences: filtered,
    totalAffected: filtered.length,
    computedAt: new Date().toISOString(),
  })
}
