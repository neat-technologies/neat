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

import type { Divergence, GraphEdge, GraphNode, ServiceNode } from '@neat.is/types'
import { NodeType, Provenance } from '@neat.is/types'
import type { NeatGraph } from './graph.js'

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

export function renderValueForwardSummary(input: SummaryInput): string {
  const { graph, divergences, verbose } = input
  const nodes: GraphNode[] = []
  graph.forEachNode((_id, attrs) => nodes.push(attrs))
  const edges: GraphEdge[] = []
  graph.forEachEdge((_id, attrs) => edges.push(attrs))

  const lines: string[] = []
  lines.push('=== neat: findings ===')
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
