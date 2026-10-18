import {
  EdgeType,
  IncidentLeadSchema,
  NodeType,
  Provenance,
  serviceId,
  type ErrorEvent,
  type GraphEdge,
  type GraphNode,
  type IncidentLead,
  type IncidentLeadRow,
  type IncidentOnset,
  type TrafficSourceRow,
} from '@neat.is/types'
import type { NeatGraph } from './graph.js'

// The incident lead (ADR-264): the one ranking of "where to start" when something
// is failing. `ask`'s graph-wide answer, the MCP session-start lead, the search
// hook and investigate's fallback all read it (through `GET /incidents/lead` when
// they are out of process), so the culprit they name is the same everywhere
// (core #1373: one module, every surface reads it).
//
// Two rules, both read off what the daemon already holds:
//   - Onset (#1483). A node whose incidents were already arriving at a comparable
//     rate before the recent window is steady-state noise, and ranks below any node
//     whose incidents started, or rose sharply, inside it. A chronic failure that
//     has piled up thousands of incidents can't bury a fault a minute old.
//   - Traffic sources (#1479). A node that nothing calls at runtime, whose errors
//     are all on its own outbound calls, is the traffic, not a culprit: a load
//     generator, a synthetic client, a browser. Its errors are responses it
//     received, so it is listed apart, naming the callees whose calls failed.
//     Structural (runtime in-degree and edge direction), never a name list.

// The recent window, ending at the newest incident in the store.
export const INCIDENT_LEAD_WINDOW_MS = 10 * 60_000
// In-window rate at least this many times the rate before the window reads as a
// rise, not steady state.
const RISE_FACTOR = 3

const RUNTIME = new Set<string>([Provenance.OBSERVED, Provenance.INFERRED, Provenance.STALE])
// Edges that carry no traffic: ownership and placement.
const STRUCTURAL = new Set<string>([EdgeType.CONTAINS, EdgeType.RUNS_ON, EdgeType.CONFIGURED_BY])

function isTrafficEdge(e: GraphEdge): boolean {
  return RUNTIME.has(e.provenance) && !STRUCTURAL.has(e.type)
}

function nodeType(graph: NeatGraph, id: string): string | undefined {
  return graph.hasNode(id) ? (graph.getNodeAttributes(id) as GraphNode).type : undefined
}

/**
 * A connector-sourced k8s deploy-failure incident whose workload the connector now
 * observes Ready again (#1488). The k8s substrate stamps `observedReadyReplicas` on
 * the service node every poll — healthy workloads included (ADR-225) — onto the same
 * node the incident names (`connectors/index.ts`: both the deploy-state stamp and the
 * incident target are `resolved.targetNodeId`). So readyReplicas ≥ 1 at read time is
 * the connector observing the condition cleared: the incident is over and must not
 * lead "what is failing now". Read-time only — nothing is written and the record
 * stays in the store, so `get_incident_history` keeps it. An absent or zero
 * readyReplicas is never read as recovery, so a still-failing workload keeps its
 * incident; the durable, poll-recorded `resolved` state is ADR-269 (a partial
 * multi-replica rollout, ready ≥ 1 with a pod still failing, is the edge that ADR
 * closes).
 */
export function isRecoveredK8sIncident(graph: NeatGraph | undefined, ev: ErrorEvent): boolean {
  if (!graph || ev.errorType !== 'k8s-deploy-failure') return false
  const node = ev.affectedNode
  if (!node || !graph.hasNode(node)) return false
  const ready = (graph.getNodeAttributes(node) as { observedReadyReplicas?: number }).observedReadyReplicas
  return typeof ready === 'number' && ready >= 1
}

// A method or route callee is reported as the service that serves it, when the
// graph knows one: that is the callee a reader acts on.
function owningService(graph: NeatGraph, id: string): string {
  if (nodeType(graph, id) === NodeType.ServiceNode) return id
  for (const eid of graph.inboundEdges(id)) {
    const e = graph.getEdgeAttributes(eid) as GraphEdge
    if (e.type === EdgeType.CONTAINS && nodeType(graph, e.source) === NodeType.ServiceNode) return e.source
  }
  return id
}

/**
 * The callees a traffic source's failing calls went to, or null when `nodeId` is
 * not a traffic source. A traffic source has no runtime caller (and consumes from
 * no queue, whose messages would be its inbound work), sends traffic, and has at
 * least as many errors on its outbound calls as incidents of its own, so every
 * error it recorded can be one it received.
 */
export function trafficSourceCallees(
  graph: NeatGraph | undefined,
  nodeId: string,
  incidentCount: number,
): string[] | null {
  if (!graph || nodeType(graph, nodeId) !== NodeType.ServiceNode) return null
  for (const id of graph.inboundEdges(nodeId)) {
    if (isTrafficEdge(graph.getEdgeAttributes(id) as GraphEdge)) return null
  }
  let outboundErrors = 0
  const callees = new Map<string, number>()
  for (const id of graph.outboundEdges(nodeId)) {
    const e = graph.getEdgeAttributes(id) as GraphEdge
    if (!isTrafficEdge(e)) continue
    if (e.type === EdgeType.CONSUMES_FROM) return null
    const errs = e.signal?.errorCount ?? 0
    if (errs === 0) continue
    outboundErrors += errs
    const callee = owningService(graph, e.target)
    callees.set(callee, (callees.get(callee) ?? 0) + errs)
  }
  if (outboundErrors === 0 || outboundErrors < incidentCount) return null
  return [...callees.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id)
}

interface Agg {
  node: string
  service: string
  times: number[]
  latest: string
  firstSeen: string
  message: string
  kind?: string
}

const ONSET_ORDER: Record<IncidentOnset, number> = { new: 0, rising: 0, steady: 1, quiet: 2 }

function onsetOf(times: number[], windowFrom: number, windowMs: number): IncidentOnset {
  const inWindow = times.filter((t) => t >= windowFrom).length
  if (inWindow === 0) return 'quiet'
  const before = times.length - inWindow
  if (before === 0) return 'new'
  const first = Math.min(...times)
  // The span before the window is floored at one window, so a key that began just
  // before the window is not read as a long, slow history.
  const preRate = before / Math.max(windowFrom - first, windowMs)
  const inRate = inWindow / windowMs
  return inRate >= RISE_FACTOR * preRate ? 'rising' : 'steady'
}

/**
 * Rank the incident store into the lead: culprit candidates by onset, then by
 * incidents inside the window, then recency; traffic sources apart. `graph` is
 * optional so the ranking still orders by onset when no graph is at hand.
 */
export function incidentLead(
  graph: NeatGraph | undefined,
  incidents: ErrorEvent[],
  opts: { windowMs?: number } = {},
): IncidentLead {
  const windowMs = opts.windowMs ?? INCIDENT_LEAD_WINDOW_MS
  // #1488 — a connector incident whose workload is observed Ready again is over, so
  // it ranks nowhere in the lead and is not counted in "what is failing now" (it stays
  // in get_incident_history). Read-time, no write; needs the graph, so without one
  // nothing is dropped.
  const active = graph ? incidents.filter((ev) => !isRecoveredK8sIncident(graph, ev)) : incidents
  const byNode = new Map<string, Agg>()
  let newest = Number.NEGATIVE_INFINITY
  for (const ev of active) {
    const t = Date.parse(ev.timestamp)
    if (Number.isNaN(t)) continue
    newest = Math.max(newest, t)
    const node = ev.affectedNode || serviceId(ev.service)
    const cur = byNode.get(node)
    if (!cur) {
      byNode.set(node, {
        node,
        service: serviceId(ev.service),
        times: [t],
        latest: ev.timestamp,
        firstSeen: ev.timestamp,
        message: ev.errorMessage,
        ...(ev.errorType ? { kind: ev.errorType } : {}),
      })
      continue
    }
    cur.times.push(t)
    if (ev.timestamp > cur.latest) {
      cur.latest = ev.timestamp
      cur.message = ev.errorMessage
      if (ev.errorType) cur.kind = ev.errorType
      else delete cur.kind
    }
    if (ev.timestamp < cur.firstSeen) cur.firstSeen = ev.timestamp
  }
  const to = Number.isFinite(newest) ? newest : Date.now()
  const from = to - windowMs

  // Traffic sources are judged per owning service, over all its incidents.
  const perService = new Map<string, number>()
  for (const a of byNode.values()) perService.set(a.service, (perService.get(a.service) ?? 0) + a.times.length)
  const sourceCallees = new Map<string, string[] | null>()
  for (const [svc, n] of perService) sourceCallees.set(svc, trafficSourceCallees(graph, svc, n))

  const ranked: (IncidentLeadRow & { _order: number })[] = []
  const sources = new Map<string, TrafficSourceRow>()
  for (const a of byNode.values()) {
    const callees = sourceCallees.get(a.service)
    if (callees) {
      const cur = sources.get(a.service)
      if (!cur) {
        sources.set(a.service, { node: a.service, count: a.times.length, latest: a.latest, message: a.message, callees })
      } else {
        cur.count += a.times.length
        if (a.latest > cur.latest) {
          cur.latest = a.latest
          cur.message = a.message
        }
      }
      continue
    }
    const onset = onsetOf(a.times, from, windowMs)
    ranked.push({
      node: a.node,
      count: a.times.length,
      windowCount: a.times.filter((t) => t >= from).length,
      firstSeen: a.firstSeen,
      latest: a.latest,
      message: a.message,
      ...(a.kind ? { kind: a.kind } : {}),
      onset,
      _order: ONSET_ORDER[onset],
    })
  }
  ranked.sort(
    (x, y) =>
      x._order - y._order ||
      y.windowCount - x.windowCount ||
      y.count - x.count ||
      y.latest.localeCompare(x.latest) ||
      x.node.localeCompare(y.node),
  )
  return IncidentLeadSchema.parse({
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), ms: windowMs },
    total: active.length,
    ranked: ranked.map(({ _order, ...row }) => row),
    trafficSources: [...sources.values()].sort((x, y) => y.count - x.count || x.node.localeCompare(y.node)),
  })
}
