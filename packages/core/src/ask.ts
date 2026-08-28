// ask (ADR-198) — the plain-language door over the fused graph.
//
// NEAT's tools are structured: get_root_cause(nodeId), get_dependencies(nodeId),
// get_blast_radius(nodeId). To use them an agent has to already know WHICH tool
// and the exact NODE ID — higher friction than `grep`, so in practice the agent
// grep-scans source instead of reaching for the graph even when the graph would
// answer better. `ask` closes that gap: one natural-language question in, one
// compact provenance-tagged answer out.
//
// It is a ROUTER/COMPOSER over the traversals in traverse.ts + the divergence
// query, not a new engine. Two deterministic steps and then existing walks:
//
//   1. Resolve the question's entities to graph nodes — token/label overlap
//      against node ids + names, plus the semantic_search embedder against node
//      labels (the graphify vocab-expansion move). NO LLM in the engine
//      (docs/contracts/llm-policy.md): the calling agent is the only model.
//   2. Read the question's intent off a fixed English keyword vocabulary — never
//      a provider / framework / language name, so `ask` stays as agnostic as the
//      traversal core it composes (docs/contracts/traversal.md).
//   3. Compose the intent-relevant traversal (leading with get_root_cause's
//      navigation when the question is root-cause-shaped) plus a compact fused
//      local context, every fact provenance-tagged + confidence-scored
//      (docs/contracts/provenance.md).

import type {
  AskFact,
  AskIntent,
  AskMatch,
  AskResult,
  AskSection,
  Divergence,
  ErrorEvent,
  GraphEdge,
  GraphNode,
  RootCauseCandidate,
} from '@neat.is/types'
import { AskResultSchema, NodeType, Provenance, serviceId } from '@neat.is/types'
import type { NeatGraph } from './graph.js'
import type { SearchIndex } from './search.js'
import { computeDivergences } from './divergences.js'
import {
  confidenceForEdge,
  getBlastRadius,
  getObservedDependencies,
  getRootCause,
  getTransitiveDependencies,
} from './traverse.js'

export interface AskOptions {
  // The embedder-backed node index (semantic_search). When present it widens
  // entity resolution beyond literal token overlap, the same way graphify's
  // vocab expansion rescues a wording mismatch. Absent → token/label match only.
  searchIndex?: SearchIndex
  // The recorded incident store, so a root-cause / incidents question answers
  // from OBSERVED failures the graph can't carry on an edge.
  incidents?: ErrorEvent[]
  // Clock seam for deterministic tests.
  now?: number
  // Cap on how many entities the question resolves to (default 3).
  maxNodes?: number
}

const DEFAULT_MAX_NODES = 3
const MAX_FACTS_PER_SECTION = 6

// ─────────────────────────────────────────────────────────────────────────────
// Intent — a fixed English keyword vocabulary, checked in priority order. The
// words are question shapes ("why", "depends", "weird"), never provider /
// framework / language names, so the router never smuggles adapter knowledge in.
// ─────────────────────────────────────────────────────────────────────────────

interface IntentRule {
  intent: AskIntent
  test: RegExp
}

// Order matters: the first rule that fires wins. Root-cause (a failure question)
// is the most specific and leads; overview is the catch-all fallback below.
const INTENT_RULES: IntentRule[] = [
  {
    intent: 'root-cause',
    test: /\b(why|root[\s-]?cause|failing|fail(?:s|ed)?|breaking|broke(?:n)?|crash(?:ing|ed)?|throw(?:ing|s)?|culprit|5\d\d)\b/,
  },
  {
    intent: 'blast-radius',
    test: /\b(blast|break[\s-]?if|breaks[\s-]?if|impact|downstream|dependents?|redeploy|who\s+(?:uses|calls|depends)|what\s+depends\s+on|affect(?:s|ed)?)\b/,
  },
  {
    intent: 'divergence',
    test: /\b(diverg\w*|weird|mismatch|drift|out\s+of\s+sync|inconsistent|disagree\w*|declared\s+vs|anything\s+wrong)\b/,
  },
  {
    intent: 'incidents',
    test: /\b(incidents?|recent\s+(?:errors?|failures?)|error\s+history|failure\s+history)\b/,
  },
  {
    intent: 'observed',
    test: /\b(at\s+runtime|in\s+prod(?:uction)?|actually\s+call\w*|really\s+call\w*|observed|runtime\s+traffic)\b/,
  },
  {
    intent: 'dependencies',
    test: /\b(depend\w*|calls?|uses?|imports?|relies\s+on|needs?)\b/,
  },
]

export function classifyIntent(question: string): AskIntent {
  const q = question.toLowerCase()
  for (const rule of INTENT_RULES) {
    if (rule.test.test(q)) return rule.intent
  }
  return 'overview'
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity resolution — deterministic. Token/label overlap over node ids + names,
// widened by the embedder when one is available.
// ─────────────────────────────────────────────────────────────────────────────

// Words that carry no entity signal — dropped from the query so they never match
// a node. Intent keywords are dropped too (they steer routing, not resolution).
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'of',
  'to', 'in', 'on', 'at', 'by', 'for', 'with', 'and', 'or', 'but', 'if', 'as',
  'this', 'that', 'these', 'those', 'it', 'its', 'do', 'does', 'did', 'has',
  'have', 'had', 'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'my',
  'me', 'i', 'we', 'you', 'they', 'them', 'from', 'into', 'about', 'would',
  'will', 'can', 'could', 'should', 'anything', 'everything', 'something', 'all',
  'any', 'some', 'no', 'not', 'so', 'up', 'out', 'over', 'get', 'got', 'show',
  'tell', 'explain', 'find', 'give', 'happen', 'happens', 'happening', 'here',
  'there', 'system', 'code', 'service', 'node', 'graph',
])

// The routing words also carry no entity signal — strip them so "why is checkout
// failing" resolves on "checkout", not "why"/"failing".
const INTENT_WORDS = new Set([
  'why', 'root', 'cause', 'failing', 'fail', 'fails', 'failed', 'breaking',
  'broke', 'broken', 'crash', 'crashing', 'crashed', 'throw', 'throwing',
  'throws', 'culprit', 'blast', 'radius', 'break', 'breaks', 'impact',
  'downstream', 'dependent', 'dependents', 'redeploy', 'affect', 'affects',
  'affected', 'diverge', 'divergence', 'divergences', 'weird', 'mismatch',
  'drift', 'inconsistent', 'disagree', 'declared', 'observed', 'incident',
  'incidents', 'recent', 'errors', 'error', 'failures', 'failure', 'history',
  'runtime', 'production', 'prod', 'traffic', 'actually', 'really', 'depend',
  'depends', 'dependency', 'dependencies', 'call', 'calls', 'use', 'uses',
  'using', 'import', 'imports', 'relies', 'rely', 'needs', 'need', 'sync',
])

// camelCase / kebab / snake / path splitter → lowercase alphanumeric tokens.
function tokens(input: string): string[] {
  const spaced = input.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  return (spaced.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2)
}

function queryTokens(question: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tokens(question)) {
    if (STOPWORDS.has(t) || INTENT_WORDS.has(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

function nodeName(node: GraphNode): string {
  return (node as { name?: string }).name ?? node.id
}

// The distinctive part of a node id — everything after its `type:` prefix
// (`service:checkout` → `checkout`, `database:payments-db` → `payments-db`).
function idBody(id: string): string {
  const colon = id.indexOf(':')
  return colon >= 0 ? id.slice(colon + 1) : id
}

interface Scored {
  nodeId: string
  label: string
  via: AskMatch['via']
  score: number
}

// Only an embedder match this similar (or better) is trusted on its own; below
// it, an embedding-only hit is noise and dropped. Token matches are kept
// regardless — they are exact overlaps, not similarity guesses.
const EMBED_MIN_SCORE = 0.35

// Resolve the question to nodes. Token/label overlap first, then fold in the
// embedder's matches (semantic_search against node labels) so a wording mismatch
// still lands. Returns best match first, capped at `maxNodes`.
async function resolveEntities(
  graph: NeatGraph,
  question: string,
  searchIndex: SearchIndex | undefined,
  maxNodes: number,
): Promise<AskMatch[]> {
  const qTokens = queryTokens(question)
  const normalized = question.toLowerCase()
  const best = new Map<string, Scored>()

  const consider = (cand: Scored): void => {
    const cur = best.get(cand.nodeId)
    if (!cur || cand.score > cur.score) best.set(cand.nodeId, cand)
  }

  // Pass 1 — token/label overlap over every node.
  graph.forEachNode((id, attrs) => {
    const node = attrs as GraphNode
    if (node.type === NodeType.FrontierNode) return
    const name = nodeName(node)
    const body = idBody(id)
    const labelTokens = new Set([...tokens(body), ...tokens(name)])
    if (labelTokens.size === 0) return

    let matched = 0
    for (const t of qTokens) if (labelTokens.has(t)) matched += 1
    // The node's own distinctive id/name appearing verbatim in the question is
    // the strongest signal — an explicit reference, not a token coincidence.
    const named =
      (body.length >= 2 && normalized.includes(body.toLowerCase())) ||
      (name.length >= 2 && normalized.includes(name.toLowerCase()))
    if (matched === 0 && !named) return

    const coverage = qTokens.length > 0 ? matched / qTokens.length : 0
    const via: AskMatch['via'] = named ? 'id' : matched > 0 && tokens(name).some((t) => qTokens.includes(t)) ? 'label' : 'token'
    const score = named ? Math.max(0.9, coverage) : Math.min(0.85, 0.3 + 0.7 * coverage)
    consider({ nodeId: id, label: name, via, score: Math.min(1, score) })
  })

  // Pass 2 — the embedder. Its cosine score is a genuine semantic match against
  // the node label; fold it in so a question phrased unlike the code still lands.
  if (searchIndex) {
    try {
      const res = await searchIndex.search(question, 10)
      // The substring fallback returns a placeholder score of 1 that would swamp
      // real token overlap — pass 1 already covers substring, so skip that tier.
      if (res.provider !== 'substring') {
        for (const m of res.matches) {
          if (m.node.type === NodeType.FrontierNode) continue
          const already = best.get(m.node.id)
          if (!already && m.score < EMBED_MIN_SCORE) continue
          consider({
            nodeId: m.node.id,
            label: nodeName(m.node),
            via: 'embedding',
            score: Math.max(0, Math.min(1, m.score)),
          })
        }
      }
    } catch {
      // A flaky embedder must never sink a query that token matching answered.
    }
  }

  const viaRank: Record<AskMatch['via'], number> = { id: 3, label: 2, token: 1, embedding: 0 }
  return [...best.values()]
    .sort(
      (a, b) =>
        b.score - a.score || viaRank[b.via] - viaRank[a.via] || a.nodeId.localeCompare(b.nodeId),
    )
    .slice(0, maxNodes)
    .map((s) => ({ nodeId: s.nodeId, label: s.label, via: s.via, score: Number(s.score.toFixed(3)) }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Composition — each builder wraps one existing traversal into a section of
// provenance-tagged facts. Every fact carries the provenance + confidence the
// traversal already computed; nothing is synthesized.
// ─────────────────────────────────────────────────────────────────────────────

function incidentsForNode(nodeId: string, incidents: ErrorEvent[] | undefined): ErrorEvent[] {
  if (!incidents || incidents.length === 0) return []
  const svc = nodeId.replace(/^service:/, '')
  return incidents.filter((e) => e.affectedNode === nodeId || e.service === svc)
}

function edgeSignalNote(e: GraphEdge): string {
  const bits: string[] = []
  if (e.signal) {
    bits.push(`${e.signal.spanCount} spans`)
    if (e.signal.errorCount > 0) bits.push(`${e.signal.errorCount} errors`)
    if (e.signal.latencyMs?.p95 !== undefined) bits.push(`p95 ${Math.round(e.signal.latencyMs.p95)}ms`)
  } else if (e.callCount !== undefined) {
    bits.push(`${e.callCount} calls`)
  }
  return bits.length ? ` (${bits.join(', ')})` : ''
}

function buildRootCauseSection(
  graph: NeatGraph,
  node: string,
  incidents: ErrorEvent[] | undefined,
  now: number,
): AskSection | null {
  const result = getRootCause(graph, node, undefined, incidents, { now })
  if (!result) return null
  const lastProv = result.edgeProvenances[result.edgeProvenances.length - 1] ?? Provenance.OBSERVED
  const facts: AskFact[] = [
    {
      text: `Root cause: ${result.rootCauseNode} — ${result.rootCauseReason}`,
      provenance: lastProv,
      confidence: result.confidence,
    },
  ]
  // Lead with the ADR-189 navigation: the ranked candidate set, so the agent
  // weighs alternatives instead of relaying one verdict. A symptom-only node is
  // a downstream victim, not the cause.
  const candidates: RootCauseCandidate[] = result.candidates ?? []
  for (const c of candidates.slice(0, 3)) {
    facts.push({
      text: `Candidate ${c.node} — ${c.classification}: ${c.reason}`,
      ...(c.provenance ? { provenance: c.provenance } : {}),
      confidence: c.confidence,
    })
  }
  if (result.traversalPath.length > 1) {
    facts.push({ text: `Traversal: ${result.traversalPath.join(' ← ')}` })
  }
  if (result.fixRecommendation) {
    facts.push({ text: `Recommended fix: ${result.fixRecommendation}` })
  }
  return { heading: 'Root cause (navigation)', facts: facts.slice(0, MAX_FACTS_PER_SECTION) }
}

function buildDependenciesSection(graph: NeatGraph, node: string): AskSection | null {
  const result = getTransitiveDependencies(graph, node, 2)
  if (result.total === 0) return null
  const facts: AskFact[] = result.dependencies
    .slice(0, MAX_FACTS_PER_SECTION)
    .map((d) => ({
      text: `${d.nodeId} — ${d.edgeType} (distance ${d.distance})`,
      // Per-fact provenance: the transitive walk mixes EXTRACTED and OBSERVED
      // edges, so the tag is on the fact, not asserted for the whole section.
      provenance: d.provenance,
    }))
  return { heading: 'Dependencies', facts }
}

function buildObservedSection(graph: NeatGraph, node: string): AskSection | null {
  const result = getObservedDependencies(graph, node)
  const facts: AskFact[] = []
  for (const e of result.dependencies.slice(0, MAX_FACTS_PER_SECTION)) {
    const via = e.source !== node ? ` via ${e.source}` : ''
    facts.push({
      text: `calls ${e.target}${via}${edgeSignalNote(e)}`,
      provenance: e.provenance,
      confidence: confidenceForEdge(e),
    })
  }
  if (facts.length === 0) {
    if (result.observed && result.inboundObservedCount > 0) {
      // Pure receiver: seen by OTel, but calls nothing downstream.
      facts.push({
        text: `no outbound runtime calls, but OTel observed ${result.inboundObservedCount} inbound call path${result.inboundObservedCount === 1 ? '' : 's'} — a pure receiver`,
        provenance: Provenance.OBSERVED,
      })
    } else {
      return null
    }
  }
  return { heading: 'Runtime dependencies (OBSERVED)', facts }
}

function buildBlastSection(graph: NeatGraph, node: string): AskSection | null {
  const result = getBlastRadius(graph, node)
  if (result.totalAffected === 0) return null
  const facts: AskFact[] = result.affectedNodes
    .slice(0, MAX_FACTS_PER_SECTION)
    .map((n) => ({
      text: `${n.nodeId} (distance ${n.distance})`,
      provenance: n.edgeProvenance,
      confidence: n.confidence,
    }))
  return {
    heading: `Blast radius — ${result.totalAffected} dependent${result.totalAffected === 1 ? '' : 's'}`,
    facts,
  }
}

function buildIncidentsSection(node: string, incidents: ErrorEvent[] | undefined): AskSection | null {
  const relevant = incidentsForNode(node, incidents)
  if (relevant.length === 0) return null
  const ordered = [...relevant].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 4)
  const facts: AskFact[] = ordered.map((ev) => ({
    text: `${ev.timestamp} — ${ev.service}: ${ev.errorMessage}`,
    // ErrorEvents are observation records — OBSERVED by definition.
    provenance: Provenance.OBSERVED,
  }))
  return { heading: `Recent incidents (OBSERVED) — ${relevant.length} recorded`, facts }
}

function divergenceLine(d: Divergence): string {
  if ((d.type === 'missing-observed' || d.type === 'missing-extracted') && d.column) {
    return `[${d.type}] ${d.table ?? d.source} column ${d.column} — ${d.reason}`
  }
  // Symbol/field-grain (ADR-215) shares source == target (the code node); name
  // the member and the declaring location instead of a `a → a` edge.
  if (d.type === 'observed-symbol-mismatch') {
    const at = d.location ? ` at ${d.location}` : ''
    const member = d.symbol ? ` ${d.symbol}` : ''
    return `[${d.type}] ${d.source}${member}${at} — ${d.reason}`
  }
  // Behavioral-failure (ADR-220) at the incident locus also shares source ==
  // target; name the declaring file:line. The edge locus keeps the a → b form.
  if (d.type === 'observed-failing' && !d.edgeType) {
    const at = d.location ? ` at ${d.location}` : ''
    return `[${d.type}] ${d.source}${at} — ${d.reason}`
  }
  return `[${d.type}] ${d.source} → ${d.target} — ${d.reason}`
}

function buildDivergenceSection(
  graph: NeatGraph,
  node: string,
  incidents: ErrorEvent[] | undefined,
): AskSection | null {
  const result = computeDivergences(graph, { node, ...(incidents ? { incidents } : {}) })
  if (result.totalAffected === 0) return null
  const facts: AskFact[] = result.divergences.slice(0, MAX_FACTS_PER_SECTION).map((d) => ({
    text: divergenceLine(d),
    confidence: d.confidence,
    // A divergence is composite by construction (EXTRACTED vs OBSERVED), so it
    // carries no single provenance — the fact leaves it unset.
  }))
  return {
    heading: `Divergences (EXTRACTED vs OBSERVED) — ${result.totalAffected}`,
    facts,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Global (entity-less) answers. Three intents are inherently graph-wide — an
// agent's opening orient ("give me an overview", "any divergences", "recent
// incidents"). When the question named no entity, these answer across the whole
// graph instead of dead-ending, so a broad first question doesn't push the agent
// back to grep (ADR-198). The other four intents genuinely need a subject and
// keep their naming guidance.
// ─────────────────────────────────────────────────────────────────────────────

function buildGlobalDivergenceSection(
  graph: NeatGraph,
  incidents: ErrorEvent[] | undefined,
): AskSection {
  // computeDivergences already runs graph-wide with no `node` filter.
  const result = computeDivergences(graph, incidents ? { incidents } : {})
  if (result.totalAffected === 0) {
    return {
      heading: 'Divergences (EXTRACTED vs OBSERVED)',
      facts: [{ text: 'None — declared code and observed runtime agree across the graph.' }],
    }
  }
  const facts: AskFact[] = result.divergences.slice(0, MAX_FACTS_PER_SECTION).map((d) => ({
    text: divergenceLine(d),
    confidence: d.confidence,
    // Composite by construction (EXTRACTED vs OBSERVED), so no single provenance.
  }))
  return {
    heading: `Divergences (EXTRACTED vs OBSERVED) — ${result.totalAffected}`,
    facts,
  }
}

// Aggregate the incident store by the node each failure is recorded against
// (the finer affectedNode when present, else the owning service). Top-N by
// count, then recency.
function buildGlobalIncidentsSection(incidents: ErrorEvent[] | undefined): AskSection {
  if (!incidents || incidents.length === 0) {
    return {
      heading: 'Incidents across the system',
      facts: [{ text: 'None recorded — the OBSERVED incident store is empty.' }],
    }
  }
  interface Agg {
    key: string
    count: number
    latest: string
    sampleMsg: string
  }
  const byKey = new Map<string, Agg>()
  for (const ev of incidents) {
    const key = ev.affectedNode || serviceId(ev.service)
    const cur = byKey.get(key)
    if (!cur) {
      byKey.set(key, { key, count: 1, latest: ev.timestamp, sampleMsg: ev.errorMessage })
    } else {
      cur.count += 1
      if (ev.timestamp > cur.latest) {
        cur.latest = ev.timestamp
        cur.sampleMsg = ev.errorMessage
      }
    }
  }
  const rows = [...byKey.values()]
    .sort((a, b) => b.count - a.count || b.latest.localeCompare(a.latest) || a.key.localeCompare(b.key))
    .slice(0, MAX_FACTS_PER_SECTION)
  const facts: AskFact[] = rows.map((r) => ({
    text: `${r.key} — ${r.count} incident${r.count === 1 ? '' : 's'}, latest ${r.latest}: ${r.sampleMsg}`,
    provenance: Provenance.OBSERVED,
  }))
  return {
    heading: `Incidents across the system — ${incidents.length} recorded`,
    facts,
  }
}

// A real system summary: what the graph is made of (nodes by kind, edges by
// provenance), which services are busiest and which are failing, and how many
// divergences stand. The orient an agent needs before it asks anything specific.
function buildOverviewSections(
  graph: NeatGraph,
  incidents: ErrorEvent[] | undefined,
): AskSection[] {
  const nodeByType = new Map<string, number>()
  const services: string[] = []
  graph.forEachNode((_id, attrs) => {
    const node = attrs as GraphNode
    nodeByType.set(node.type, (nodeByType.get(node.type) ?? 0) + 1)
    if (node.type === NodeType.ServiceNode) services.push(node.id)
  })

  const edgeByProv = new Map<Provenance, number>()
  graph.forEachEdge((_id, attrs) => {
    const p = (attrs as GraphEdge).provenance
    edgeByProv.set(p, (edgeByProv.get(p) ?? 0) + 1)
  })

  const sections: AskSection[] = []
  const count = (t: NodeType): number => nodeByType.get(t) ?? 0

  // System shape: node + edge counts, each provenance tally tagged with its own
  // provenance so the footer reflects how much of the graph is OBSERVED.
  const shapeFacts: AskFact[] = [
    { text: `${graph.order} nodes, ${graph.size} edges` },
    {
      text: `${count(NodeType.ServiceNode)} services, ${count(NodeType.FileNode)} files, ${count(NodeType.SymbolNode)} symbols, ${count(NodeType.DatabaseNode)} databases`,
    },
  ]
  for (const p of [Provenance.EXTRACTED, Provenance.OBSERVED, Provenance.INFERRED, Provenance.STALE]) {
    const n = edgeByProv.get(p) ?? 0
    if (n > 0) shapeFacts.push({ text: `${n} ${p} edge${n === 1 ? '' : 's'}`, provenance: p })
  }
  sections.push({ heading: 'System shape', facts: shapeFacts })

  // Busiest services by direct dependency count (getTransitiveDependencies at
  // depth 1 — the same walk the per-node `dependencies` answer uses).
  const depCounts = services
    .map((s) => ({ s, n: getTransitiveDependencies(graph, s, 1).total }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n || a.s.localeCompare(b.s))
    .slice(0, MAX_FACTS_PER_SECTION)
  if (depCounts.length > 0) {
    sections.push({
      heading: 'Busiest services (by direct dependencies)',
      facts: depCounts.map((r) => ({
        text: `${r.s} — ${r.n} direct dependenc${r.n === 1 ? 'y' : 'ies'}`,
      })),
    })
  }

  // Services/nodes with the most incidents.
  if (incidents && incidents.length > 0) {
    const incCount = new Map<string, number>()
    for (const ev of incidents) {
      const key = ev.affectedNode || serviceId(ev.service)
      incCount.set(key, (incCount.get(key) ?? 0) + 1)
    }
    const top = [...incCount.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_FACTS_PER_SECTION)
    sections.push({
      heading: `Nodes with incidents — ${incidents.length} recorded`,
      facts: top.map(([k, n]) => ({
        text: `${k} — ${n} incident${n === 1 ? '' : 's'}`,
        provenance: Provenance.OBSERVED,
      })),
    })
  }

  // Total divergences — the headline number for "is anything wrong?".
  const div = computeDivergences(graph, incidents ? { incidents } : {})
  sections.push({
    heading: 'Divergences',
    facts: [
      {
        text:
          div.totalAffected === 0
            ? 'None — declared code and observed runtime agree across the graph.'
            : `${div.totalAffected} divergence${div.totalAffected === 1 ? '' : 's'} between declared code and observed runtime — ask "are there any divergences?" for the list.`,
      },
    ],
  })

  return sections
}

// Route an entity-less question to a graph-wide answer, or null when the intent
// needs a subject (dependencies / blast-radius / root-cause / observed).
function buildGlobalSections(
  intent: AskIntent,
  graph: NeatGraph,
  incidents: ErrorEvent[] | undefined,
): AskSection[] | null {
  switch (intent) {
    case 'divergence':
      return [buildGlobalDivergenceSection(graph, incidents)]
    case 'incidents':
      return [buildGlobalIncidentsSection(incidents)]
    case 'overview':
      return buildOverviewSections(graph, incidents)
    default:
      return null
  }
}

type SectionKind = 'root-cause' | 'dependencies' | 'observed' | 'blast' | 'incidents' | 'divergence'

// The section order for each intent: the intent's own traversal leads, the rest
// follow as compact fused local context so one answer carries the whole picture.
const SECTION_ORDER: Record<AskIntent, SectionKind[]> = {
  'root-cause': ['root-cause', 'incidents', 'blast', 'observed', 'divergence'],
  'blast-radius': ['blast', 'dependencies', 'observed', 'incidents'],
  dependencies: ['dependencies', 'observed', 'blast'],
  observed: ['observed', 'dependencies', 'incidents'],
  incidents: ['incidents', 'root-cause', 'observed'],
  divergence: ['divergence', 'observed', 'dependencies', 'incidents'],
  overview: ['dependencies', 'observed', 'blast', 'incidents', 'divergence'],
}

function buildSection(
  kind: SectionKind,
  graph: NeatGraph,
  node: string,
  incidents: ErrorEvent[] | undefined,
  now: number,
): AskSection | null {
  switch (kind) {
    case 'root-cause':
      return buildRootCauseSection(graph, node, incidents, now)
    case 'dependencies':
      return buildDependenciesSection(graph, node)
    case 'observed':
      return buildObservedSection(graph, node)
    case 'blast':
      return buildBlastSection(graph, node)
    case 'incidents':
      return buildIncidentsSection(node, incidents)
    case 'divergence':
      return buildDivergenceSection(graph, node, incidents)
  }
}

// The answer for a graph-wide (entity-less) question. Reads the leading global
// section's headline so the summary names the finding without re-deriving it.
function summarizeGlobal(intent: AskIntent, sections: AskSection[]): string {
  const lead = sections[0]
  switch (intent) {
    case 'divergence': {
      const none = lead?.facts[0]?.text.startsWith('None') ?? true
      return none
        ? 'No divergences across the graph — declared code and observed runtime agree.'
        : `${lead!.heading} across the graph, highest-confidence first below.`
    }
    case 'incidents': {
      const none = lead?.facts[0]?.text.startsWith('None') ?? true
      return none
        ? 'No incidents recorded across the system — the OBSERVED incident store is empty.'
        : `${lead!.heading}, aggregated by node below.`
    }
    case 'overview':
    default:
      return `System overview across the whole graph: ${sections.length} view${sections.length === 1 ? '' : 's'} below — shape (nodes/edges by provenance), busiest services, incidents, and divergences.`
  }
}

// The compact, answer-shaped summary the agent reads first. Derived from the
// leading section so it names the finding, not a raw graph dump.
function summarize(
  question: string,
  intent: AskIntent,
  matched: AskMatch[],
  primary: string | undefined,
  sections: AskSection[],
  scope: 'global' | 'node' | undefined,
): string {
  // Entity-less GLOBAL answer — the graph-wide orient (overview / divergences /
  // incidents). The lead section already carries a headline; name the scope.
  if (scope === 'global') {
    return summarizeGlobal(intent, sections)
  }
  if (!primary) {
    // An entity-required intent (dependencies / blast-radius / root-cause /
    // observed) with nothing named — keep the naming guidance, and point at the
    // graph-wide questions that need no subject.
    return `Nothing in "${question}" resolved to a node in the graph. Name a service, file, route, or table — e.g. \`ask "what does <service> depend on?"\`. For a graph-wide look, ask for an overview, divergences, or incidents.`
  }
  const lead = sections[0]
  const others = matched.slice(1)
  const alsoNote = others.length
    ? ` Also matched: ${others.map((m) => m.nodeId).join(', ')}.`
    : ''

  let core: string
  switch (intent) {
    case 'root-cause': {
      // Only lead with the finding when the root-cause traversal actually
      // produced one. When it didn't, say so — never dress a fallback context
      // section up as the cause.
      const rc = sections.find((s) => s.heading === 'Root cause (navigation)')
      if (rc) {
        core = rc.facts[0]?.text ?? ''
      } else if (lead) {
        core = `No root cause surfaced for ${primary} — it may be healthy, or the failure isn't recorded. Nearest context: ${lead.heading.toLowerCase()}.`
      } else {
        core = `No root cause surfaced for ${primary} — it may be healthy.`
      }
      break
    }
    case 'blast-radius':
      core = lead ? `${lead.heading} of ${primary}.` : `${primary} has no dependents — nothing else would break if it failed.`
      break
    case 'dependencies':
      core = lead ? `${primary}: ${lead.heading.toLowerCase()} listed below.` : `${primary} has no declared dependencies in the graph.`
      break
    case 'observed':
      core = lead ? `${primary} at runtime: ${lead.facts.length} OBSERVED fact${lead.facts.length === 1 ? '' : 's'}.` : `No runtime traffic OBSERVED for ${primary}.`
      break
    case 'incidents':
      core = lead ? `${primary}: ${lead.heading.toLowerCase()}.` : `No incidents recorded against ${primary}.`
      break
    case 'divergence':
      core = lead ? `${lead.heading} involving ${primary}.` : `No divergences involve ${primary} — declared and observed agree here.`
      break
    default:
      core = `${primary}: ${sections.length} view${sections.length === 1 ? '' : 's'} of its fused local context below.`
  }
  return `${core}${alsoNote}`
}

// ─────────────────────────────────────────────────────────────────────────────
// The public entry — resolve, route, compose, validate.
// ─────────────────────────────────────────────────────────────────────────────

export async function askGraph(
  graph: NeatGraph,
  question: string,
  opts: AskOptions = {},
): Promise<AskResult> {
  const now = opts.now ?? Date.now()
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES
  const intent = classifyIntent(question)
  const matched = await resolveEntities(graph, question, opts.searchIndex, maxNodes)
  const primary = matched[0]?.nodeId

  const sections: AskSection[] = []
  let scope: 'global' | 'node' | undefined
  if (primary) {
    scope = 'node'
    for (const kind of SECTION_ORDER[intent]) {
      const s = buildSection(kind, graph, primary, opts.incidents, now)
      if (s && s.facts.length > 0) sections.push(s)
    }
  } else {
    // No entity named. The graph-wide intents (overview / divergences /
    // incidents) answer across the whole graph instead of dead-ending; the
    // entity-required intents fall through to naming guidance (scope stays unset).
    const global = buildGlobalSections(intent, graph, opts.incidents)
    if (global) {
      scope = 'global'
      for (const s of global) if (s.facts.length > 0) sections.push(s)
    }
  }

  const answer = summarize(question, intent, matched, primary, sections, scope)
  const provSet = new Set<Provenance>()
  for (const s of sections) for (const f of s.facts) if (f.provenance) provSet.add(f.provenance)
  const confidence = sections[0]?.facts[0]?.confidence

  return AskResultSchema.parse({
    question,
    intent,
    matched,
    ...(primary ? { primaryNode: primary } : {}),
    ...(scope ? { scope } : {}),
    sections,
    answer,
    ...(confidence !== undefined ? { confidence } : {}),
    provenance: [...provSet],
  })
}
