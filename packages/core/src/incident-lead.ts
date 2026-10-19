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

// Membership tests kept as functions, not module-level `new Set([Enum.X])`
// constants: the enum values are read at call time, never at module load, so this
// module's body dereferences no imported binding before it is initialized — which
// keeps it safe under the parallel module initialization the test runner does.
function isRuntimeProvenance(p: string): boolean {
  return p === Provenance.OBSERVED || p === Provenance.INFERRED || p === Provenance.STALE
}
// Edges that carry no traffic: ownership and placement.
function isStructuralEdge(t: string): boolean {
  return t === EdgeType.CONTAINS || t === EdgeType.RUNS_ON || t === EdgeType.CONFIGURED_BY
}

function isTrafficEdge(e: GraphEdge): boolean {
  return isRuntimeProvenance(e.provenance) && !isStructuralEdge(e.type)
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
 * A node's runtime activity, read off its non-structural traffic edges (ADR-271):
 *   - `everObserved`: production ever recorded traffic on it (an OBSERVED or STALE
 *     edge), so a silence reads as "went quiet", not "never ran".
 *   - `lastActivityMs`: the newest `lastObserved` across those edges.
 *   - `liveInWindow`: it carries live OBSERVED traffic in the window (a timestamp
 *     at/after `fromMs`, or an OBSERVED edge with no timestamp we cannot call quiet).
 *
 * The incident window — not the daemon's day-scale STALE marking — is the clock:
 * an edge blocked minutes ago during an incident is still OBSERVED with an old
 * `lastObserved`, and that is exactly "went quiet at onset" at incident grain.
 */
function nodeActivity(
  graph: NeatGraph,
  nodeId: string,
  fromMs: number,
): { everObserved: boolean; lastActivityMs: number; liveInWindow: boolean } {
  let everObserved = false
  let lastActivityMs = Number.NEGATIVE_INFINITY
  let liveInWindow = false
  const scan = (edgeId: string): void => {
    const e = graph.getEdgeAttributes(edgeId) as GraphEdge
    if (isStructuralEdge(e.type)) return
    // Direct observation only — OBSERVED (live) or STALE (went quiet). INFERRED is a
    // stitch, not a direct observation, so it does not count as a node having run.
    if (e.provenance !== Provenance.OBSERVED && e.provenance !== Provenance.STALE) return
    everObserved = true
    if (e.lastObserved) {
      const t = Date.parse(e.lastObserved)
      if (!Number.isNaN(t)) {
        if (t > lastActivityMs) lastActivityMs = t
        if (e.provenance === Provenance.OBSERVED && t >= fromMs) liveInWindow = true
      }
    } else if (e.provenance === Provenance.OBSERVED) {
      liveInWindow = true // OBSERVED with no timestamp — cannot prove it is quiet.
    }
  }
  for (const edgeId of graph.inboundEdges(nodeId)) scan(edgeId)
  for (const edgeId of graph.outboundEdges(nodeId)) scan(edgeId)
  return { everObserved, lastActivityMs, liveInWindow }
}

/**
 * The declared dependencies of the failing victims (ADR-271): every node reachable
 * from a victim by following EXTRACTED CALLS / CONNECTS_TO edges — the path traffic
 * should take — mapped to the set of victims that declare a path to it. A
 * method/route target is rolled up to its owning service, so a declared call to a
 * service's endpoint counts as depending on the service. Multi-source BFS, bounded
 * by a per-victim visited set.
 */
function declaredDependenciesOfVictims(
  graph: NeatGraph,
  victims: readonly string[],
): Map<string, Set<string>> {
  const reached = new Map<string, Set<string>>()
  for (const victim of victims) {
    if (!graph.hasNode(victim)) continue
    const seen = new Set<string>([victim])
    const queue: string[] = [victim]
    while (queue.length > 0) {
      const cur = queue.shift() as string
      for (const edgeId of graph.outboundEdges(cur)) {
        const e = graph.getEdgeAttributes(edgeId) as GraphEdge
        if (e.provenance !== Provenance.EXTRACTED) continue
        // Declared dependency edges traffic follows, not structural ownership.
        if (e.type !== EdgeType.CALLS && e.type !== EdgeType.CONNECTS_TO) continue
        const dep = owningService(graph, e.target)
        if (dep !== victim) {
          const set = reached.get(dep) ?? new Set<string>()
          set.add(victim)
          reached.set(dep, set)
        }
        if (!seen.has(e.target)) {
          seen.add(e.target)
          queue.push(e.target)
        }
      }
    }
  }
  return reached
}

/**
 * Rank the incident store into the lead: culprit candidates by onset, then by
 * incidents inside the window, then recency; traffic sources apart. `graph` is
 * optional so the ranking still orders by onset when no graph is at hand (and the
 * silent-cause candidate source, ADR-271, is skipped without one).
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

  type SortableRow = IncidentLeadRow & { _order: number; _weight: number; _silent: boolean }
  const ranked: SortableRow[] = []
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
    const windowCount = a.times.filter((t) => t >= from).length
    ranked.push({
      node: a.node,
      count: a.times.length,
      windowCount,
      firstSeen: a.firstSeen,
      latest: a.latest,
      message: a.message,
      ...(a.kind ? { kind: a.kind } : {}),
      onset,
      _order: ONSET_ORDER[onset],
      _weight: windowCount,
      _silent: false,
    })
  }

  // Silent cause candidates (ADR-271): a declared node that emits no incident of
  // its own but on which the failing victims depend through declared topology, and
  // whose expected runtime signal went quiet at onset. The reachability gate — the
  // victims declare a path to it — is what keeps a quiet-but-unreached node (a
  // scaled-to-zero job, a healthy idle service) off the lead. A node that went
  // quiet around the window start is the declared root the failing set depends on;
  // its weight is the in-window incident volume of the victims that depend on it,
  // so it leads the symptoms it explains without leapfrogging unrelated faults.
  // v1 ships the went-quiet signal on service nodes; a never-observed node (too
  // noisy on a partly-instrumented system) and a database/workload-replica absence
  // are deferred.
  if (graph) {
    const victimWeight = new Map<string, number>()
    for (const r of ranked) victimWeight.set(r.node, r.windowCount)
    const deps = declaredDependenciesOfVictims(graph, [...victimWeight.keys()])
    for (const [dep, victimSet] of deps) {
      if (byNode.has(dep) || sources.has(dep)) continue // already an incident node
      if (nodeType(graph, dep) !== NodeType.ServiceNode) continue // v1: service nodes
      const act = nodeActivity(graph, dep, from)
      if (!act.everObserved) continue // never observed → deferred (noisy), not v1
      if (act.liveInWindow) continue // live traffic in the window → not silent
      if (!Number.isFinite(act.lastActivityMs)) continue
      // Lead only a node that went quiet AROUND onset — within one window before it
      // — not a chronically-dead declared dependency.
      if (act.lastActivityMs < from - windowMs) continue
      let weight = 0
      for (const v of victimSet) weight += victimWeight.get(v) ?? 0
      const when = new Date(act.lastActivityMs).toISOString()
      const n = victimSet.size
      ranked.push({
        node: dep,
        count: 0,
        windowCount: 0,
        firstSeen: when,
        latest: when,
        message: `Declared dependency went quiet at onset (last observed ${when}); ${n} failing ${n === 1 ? 'service depends' : 'services depend'} on it.`,
        onset: 'new',
        silent: true,
        dependents: n,
        _order: ONSET_ORDER['new'],
        _weight: weight,
        _silent: true,
      })
    }
  }

  ranked.sort(
    (x, y) =>
      x._order - y._order ||
      y._weight - x._weight ||
      // At equal onset and weight, a silent cause leads the symptoms it explains.
      Number(y._silent) - Number(x._silent) ||
      y.count - x.count ||
      y.latest.localeCompare(x.latest) ||
      x.node.localeCompare(y.node),
  )
  return IncidentLeadSchema.parse({
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), ms: windowMs },
    total: active.length,
    ranked: ranked.map(({ _order, _weight, _silent, ...row }) => row),
    trafficSources: [...sources.values()].sort((x, y) => y.count - x.count || x.node.localeCompare(y.node)),
  })
}
