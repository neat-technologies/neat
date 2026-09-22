/**
 * Value-forward CLI summary (issue #305, ADR-073 §5).
 *
 * Replaces the per-type node/edge counts that ended `neat init` with a
 * findings-first block — compat violations, top divergences, services
 * that never produced an OBSERVED edge, and the OTel env-vars block the
 * operator pastes into their deploy platform. Per-type counts move behind
 * `--verbose`.
 *
 * The renderer is a pure string builder so tests can assert against its
 * output without spawning the CLI.
 */

import type {
  Divergence,
  FileNode,
  GraphEdge,
  GraphNode,
  InfraNode,
  RouteNode,
  ServiceNode,
  SymbolNode,
} from '@neat.is/types'
import { EdgeType, NodeType, Provenance } from '@neat.is/types'
import type { NeatGraph } from './graph.js'
import * as style from './style.js'

export interface SummaryInput {
  graph: NeatGraph
  divergences: Divergence[]
  // True → render the per-type counts after the value-forward block.
  verbose: boolean
}

// Static placeholder. The orchestrator and `neat deploy` print the same
// block; `neat deploy` substitutes the actual token + host. This shape
// lives in one place so the wire format stays in step.
export function renderOtelEnvBlock(): string {
  return [
    'for prod OTel routing, set these in your deploy platform\'s env:',
    '  OTEL_EXPORTER_OTLP_ENDPOINT=https://<your-neat-host>:4318',
    '  OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <NEAT_AUTH_TOKEN>',
  ].join('\n')
}

function findIncompatServices(nodes: GraphNode[]): ServiceNode[] {
  return nodes.filter(
    (n): n is ServiceNode =>
      n.type === NodeType.ServiceNode &&
      Array.isArray((n as ServiceNode).incompatibilities) &&
      ((n as ServiceNode).incompatibilities ?? []).length > 0,
  )
}

// Services that show up in the EXTRACTED graph but have no OBSERVED edge
// pointing at or out of them. The thesis says: when the OBSERVED layer is
// silent on a service, the gap is a load-bearing signal for the operator.
function servicesWithoutObserved(nodes: GraphNode[], edges: GraphEdge[]): ServiceNode[] {
  const seen = new Set<string>()
  for (const e of edges) {
    if (e.provenance === Provenance.OBSERVED) {
      seen.add(e.source)
      seen.add(e.target)
    }
  }
  return nodes.filter(
    (n): n is ServiceNode => n.type === NodeType.ServiceNode && !seen.has(n.id),
  )
}

function formatDivergence(d: Divergence): string {
  // Short, scannable, one-line-per-finding. The reason field already carries
  // the load-bearing detail; the recommendation rides on a second indent.
  const conf = d.confidence.toFixed(2)
  return `  [${conf}] ${d.type} ${d.source} → ${d.target} — ${d.reason}`
}

// ── Static coverage by language (#1174, part of #1158) ─────────────────────
//
// Symbol grain, server routes, and the ORM data axis extract for many
// languages; outbound HTTP client call recognition (calls/http.ts,
// calls/route-match.ts) reads JS/TS only. So a caller written in any other
// language mints no client→route CALLS edge, and its cross-service topology
// comes from the OBSERVED layer instead. That degradation is graceful but
// silent — a reader can't tell "thin because no such calls" from "thin
// because the recognizer skipped this language". This block names it: per
// service language present in the scan, which static axes actually produced
// output, so the boundary reads as a stated limit rather than a low count.
const JS_TS_LANGUAGES = new Set(['javascript', 'typescript'])

interface LanguageCoverage {
  symbols: boolean
  routes: boolean
  data: boolean
  crossServiceCalls: boolean
}

const COVERAGE_COLUMNS: ReadonlyArray<{ key: keyof LanguageCoverage; label: string }> = [
  { key: 'symbols', label: 'symbols' },
  { key: 'routes', label: 'routes' },
  { key: 'data', label: 'data' },
  { key: 'crossServiceCalls', label: 'cross-service calls' },
]

// A table InfraNode is the data-axis target — `sql-table`, `supabase-table`,
// `firestore-collection`. Kept to the shared suffixes so a new table-shaped
// kind lands here without a code change.
function isTableInfra(kind: string | undefined): boolean {
  return kind !== undefined && /(table|collection)$/.test(kind)
}

// Reads which static axes produced output for each service language. Counts
// only what static extraction actually minted: EXTRACTED CALLS edges (an
// OBSERVED edge into a route would otherwise mask the very gap this surfaces)
// and symbols/routes that aren't OBSERVED-only placeholders.
function computeLanguageCoverage(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, LanguageCoverage> {
  const serviceLang = new Map<string, string>()
  const fileService = new Map<string, string>()
  const nodeById = new Map<string, GraphNode>()
  for (const n of nodes) {
    nodeById.set(n.id, n)
    if (n.type === NodeType.ServiceNode) serviceLang.set((n as ServiceNode).name, (n as ServiceNode).language)
    else if (n.type === NodeType.FileNode) fileService.set(n.id, (n as FileNode).service)
  }

  const cov = new Map<string, LanguageCoverage>()
  const ensure = (lang: string): LanguageCoverage => {
    let c = cov.get(lang)
    if (!c) {
      c = { symbols: false, routes: false, data: false, crossServiceCalls: false }
      cov.set(lang, c)
    }
    return c
  }
  // Every present service language gets a row, even one that produced nothing.
  for (const lang of serviceLang.values()) ensure(lang)

  for (const n of nodes) {
    if (n.type === NodeType.SymbolNode) {
      if ((n as SymbolNode).discoveredVia === 'otel') continue
      const lang = serviceLang.get((n as SymbolNode).service)
      if (lang) ensure(lang).symbols = true
    } else if (n.type === NodeType.RouteNode) {
      if ((n as RouteNode).discoveredVia === 'otel') continue
      const lang = serviceLang.get((n as RouteNode).service)
      if (lang) ensure(lang).routes = true
    }
  }

  for (const e of edges) {
    if (e.type !== EdgeType.CALLS || e.provenance !== Provenance.EXTRACTED) continue
    // File-first: a CALLS edge originates from the FileNode of its call site.
    const svc = fileService.get(e.source)
    const lang = svc ? serviceLang.get(svc) : undefined
    if (!lang) continue
    const target = nodeById.get(e.target)
    if (!target) continue
    if (target.type === NodeType.RouteNode) ensure(lang).crossServiceCalls = true
    else if (target.type === NodeType.InfraNode && isTableInfra((target as InfraNode).kind)) ensure(lang).data = true
  }

  return cov
}

function renderLanguageCoverage(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const cov = computeLanguageCoverage(nodes, edges)
  const langs = [...cov.keys()]
  // The boundary is only worth stating off the JS/TS island — a pure JS/TS
  // scan has nothing to disclose here, so the block earns its place only when
  // a non-JS/TS service is present.
  if (!langs.some((l) => !JS_TS_LANGUAGES.has(l))) return []

  const glyph = (on: boolean): string => (on ? style.ok(style.sym.ok) : style.dim('—'))
  const header = ['', ...COVERAGE_COLUMNS.map((c) => c.label)]
  const rows: string[][] = [header]
  for (const lang of [...langs].sort()) {
    const c = cov.get(lang) as LanguageCoverage
    rows.push([lang, ...COVERAGE_COLUMNS.map((col) => glyph(c[col.key]))])
  }

  const lines: string[] = ['static coverage by language (this scan):']
  for (const row of style.table(rows)) lines.push(`  ${row}`)
  lines.push(
    `  ${style.sym.arrow} cross-service call recognition is JS/TS-only today (#1158); non-JS/TS callers rely on OBSERVED for cross-service topology.`,
  )
  lines.push('')
  return lines
}

export function renderValueForwardSummary(input: SummaryInput): string {
  const { graph, divergences, verbose } = input
  const nodes: GraphNode[] = []
  graph.forEachNode((_id, attrs) => nodes.push(attrs))
  const edges: GraphEdge[] = []
  graph.forEachEdge((_id, attrs) => edges.push(attrs))

  const lines: string[] = []
  lines.push(style.heading('neat · findings'))
  lines.push('')

  // ── Compat violations (driver/engine mismatches) ───────────────────────
  const incompatServices = findIncompatServices(nodes)
  const totalIncompats = incompatServices.reduce(
    (acc, s) => acc + (s.incompatibilities?.length ?? 0),
    0,
  )
  lines.push(`compat violations: ${totalIncompats}`)
  for (const svc of incompatServices) {
    for (const inc of svc.incompatibilities ?? []) {
      const detail = formatIncompat(inc)
      lines.push(`  ${svc.name}: ${detail}`)
    }
  }
  lines.push('')

  // ── Top divergences (top 3 by confidence desc) ─────────────────────────
  const top = [...divergences].sort((a, b) => b.confidence - a.confidence).slice(0, 3)
  lines.push(`top divergences: ${divergences.length} total${top.length > 0 ? ', top 3:' : ''}`)
  for (const d of top) lines.push(formatDivergence(d))
  lines.push('')

  // ── Services missing OBSERVED coverage ─────────────────────────────────
  const noObserved = servicesWithoutObserved(nodes, edges)
  if (noObserved.length > 0) {
    lines.push(`services without OBSERVED coverage: ${noObserved.length}`)
    for (const svc of noObserved) lines.push(`  ${svc.name}`)
    lines.push('  → run your services with the generated otel-init to populate OBSERVED edges.')
    lines.push('')
  }

  // ── Static coverage by language (#1174) ────────────────────────────────
  for (const line of renderLanguageCoverage(nodes, edges)) lines.push(line)

  // ── OTel env-vars block (static; `neat deploy` substitutes real values)
  lines.push(renderOtelEnvBlock())
  lines.push('')

  // ── --verbose: per-type node/edge counts ──────────────────────────────
  if (verbose) {
    const byNode = new Map<string, number>()
    for (const n of nodes) byNode.set(n.type, (byNode.get(n.type) ?? 0) + 1)
    const byEdge = new Map<string, number>()
    for (const e of edges) byEdge.set(e.type, (byEdge.get(e.type) ?? 0) + 1)
    lines.push('=== graph (verbose) ===')
    lines.push(`total: ${graph.order} nodes, ${graph.size} edges`)
    lines.push('nodes:')
    for (const [t, c] of [...byNode.entries()].sort()) lines.push(`  ${t}: ${c}`)
    lines.push('edges:')
    for (const [t, c] of [...byEdge.entries()].sort()) lines.push(`  ${t}: ${c}`)
    lines.push('')
  }

  return lines.join('\n')
}

function formatIncompat(inc: NonNullable<ServiceNode['incompatibilities']>[number]): string {
  if (inc.kind === 'node-engine') {
    const range = inc.declaredNodeEngine ? ` (engines.node="${inc.declaredNodeEngine}")` : ''
    return `${inc.package}@${inc.packageVersion ?? '?'} requires Node ${inc.requiredNodeVersion}${range} — ${inc.reason}`
  }
  if (inc.kind === 'package-conflict') {
    const found = inc.foundVersion ? `@${inc.foundVersion}` : ' (missing)'
    return `${inc.package}@${inc.packageVersion ?? '?'} requires ${inc.requires.name}>=${inc.requires.minVersion}; found ${inc.requires.name}${found} — ${inc.reason}`
  }
  if (inc.kind === 'deprecated-api') {
    return `${inc.package}@${inc.packageVersion ?? '?'} is deprecated — ${inc.reason}`
  }
  return `${inc.driver}@${inc.driverVersion} vs ${inc.engine} ${inc.engineVersion} — ${inc.reason}`
}
