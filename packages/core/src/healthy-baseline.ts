import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  ChangesSinceHealthySchema,
  EdgeType,
  NodeType,
  Provenance,
  type ChangesSinceHealthy,
  type ErrorEvent,
  type GraphEdge,
  type GraphNode,
  type HealthyChange,
  infraId,
} from '@neat.is/types'
import type { NeatGraph } from './graph.js'
import type { ObservedSignal } from './connectors/types.js'
import { canonicalJson, diffSpecs, specHash } from './spec-diff.js'
import { readErrorEvents } from './ingest.js'
import { FLAG_STORE_KIND } from './flags.js'
import { K8S_OBJECT_TARGET_KIND, parseK8sObjectName } from './connectors/kubernetes/types.js'

// The healthy baseline (ADR-270): what the system's declared objects looked like
// the last time it was healthy, so a card can lead with what changed since.
//
// Written after each Kubernetes poll, from what that poll read, never from a
// second copy of it: the live spec stays on the object's InfraNode
// (`observedSpec`, one copy, #1373) and the baseline records hashes.
//
//   <neat-out>/baselines/objects/<hash>.json   one file per distinct spec, content-addressed
//   <neat-out>/baselines.ndjson                one manifest per baseline, append-only:
//                                              { takenAt, objects, flags, erroringEdges }
//
// Healthy, for writing: every workload the poll read is Ready (the poll carries no
// deploy-fault incident) and no node has begun failing since the last baseline and
// is still failing. Held for NEAT_BASELINE_HOLD_MS (default 30 s) over at least two
// consecutive polls of the same state; a changed state starts the hold again. While healthy the baseline rolls: a legitimate deploy becomes
// the new healthy state. The read side's invariant protects the fault window: the
// base for a failure is the latest baseline written before its onset, so a
// baseline written after the failure began is never the base.

export const BASELINE_HOLD_MS_DEFAULT = 30_000
// A node counts as still failing while its latest incident is this recent.
const STILL_FAILING_MS = 5 * 60_000
// Incidents further apart than this start a new run, for a failure's onset.
const RUN_GAP_MS = 2 * 60_000

interface ObjectEntry {
  node: string
  hash: string
}
export interface BaselineManifest {
  takenAt: string
  objects: Record<string, ObjectEntry>
  flags: Record<string, string>
  erroringEdges: string[]
}

interface PollState {
  at: number
  objects: Record<string, ObjectEntry>
}
interface State {
  lastPoll?: PollState
  healthySince?: number
  healthyPolls: number
  last?: BaselineManifest
  loaded: boolean
}
const states = new Map<string, State>()

function stateFor(dir: string): State {
  let s = states.get(dir)
  if (!s) {
    s = { healthyPolls: 0, loaded: false }
    states.set(dir, s)
  }
  return s
}

/** Forget in-memory state (tests). */
export function resetBaselineState(): void {
  states.clear()
}

function holdMs(): number {
  const v = Number(process.env.NEAT_BASELINE_HOLD_MS)
  return Number.isFinite(v) && v >= 0 ? v : BASELINE_HOLD_MS_DEFAULT
}

function manifestPath(dir: string): string {
  return path.join(dir, 'baselines.ndjson')
}
function objectPath(dir: string, hash: string): string {
  return path.join(dir, 'baselines', 'objects', `${hash}.json`)
}

async function readManifests(dir: string): Promise<BaselineManifest[]> {
  let raw: string
  try {
    raw = await fs.readFile(manifestPath(dir), 'utf8')
  } catch {
    return []
  }
  const out: BaselineManifest[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as BaselineManifest)
    } catch {
      // A torn last line from a crash is skipped; the rest stand.
    }
  }
  return out
}

// `k8s:<kind>/<namespace>/<name>`: the identity a later watch's fingerprints (#1496)
// share, so they land in the same manifest.
function objectId(kind: string, namespace: string | undefined, name: string): string {
  return `k8s:${kind}/${namespace ?? ''}/${name}`
}

function k8sObjectOf(graph: NeatGraph, nodeId: string): { kind: string; name: string; namespace?: string; spec: unknown; hash: string } | null {
  if (!graph.hasNode(nodeId)) return null
  const n = graph.getNodeAttributes(nodeId) as { type?: string; kind?: string; name?: string; namespace?: string; observedSpec?: Record<string, unknown> }
  if (n.type !== NodeType.InfraNode || typeof n.kind !== 'string' || !n.kind.startsWith('k8s-') || !n.observedSpec) return null
  const spec = n.observedSpec['operational'] ?? n.observedSpec
  const hash = typeof n.observedSpec['specHash'] === 'string' ? (n.observedSpec['specHash'] as string) : specHash(spec)
  return { kind: n.kind, name: n.name ?? nodeId, ...(n.namespace ? { namespace: n.namespace } : {}), spec, hash }
}

// Each served flag's state, hashed, keyed `flag:<store>/<key>`.
function flagStates(graph: NeatGraph): Map<string, { node: string; state: unknown }> {
  const out = new Map<string, { node: string; state: unknown }>()
  graph.forEachNode((id, attrs) => {
    const n = attrs as GraphNode & { kind?: string; name?: string; flags?: Array<Record<string, unknown>> }
    if (n.type !== NodeType.InfraNode || n.kind !== FLAG_STORE_KIND || !Array.isArray(n.flags)) return
    for (const f of n.flags) {
      if (typeof f['key'] !== 'string') continue
      out.set(`flag:${n.name ?? id}/${f['key']}`, {
        node: id,
        state: { declared: f['declared'] ?? null, observed: f['observed'] ?? null, observedVariant: f['observedVariant'] ?? null },
      })
    }
  })
  return out
}

function erroringEdges(graph: NeatGraph): string[] {
  const out: string[] = []
  graph.forEachEdge((id, attrs) => {
    const e = attrs as GraphEdge
    if (e.provenance === Provenance.OBSERVED && e.type !== EdgeType.CONTAINS && (e.signal?.errorCount ?? 0) > 0) out.push(id)
  })
  return out.sort()
}

// Nodes whose incidents began after `since` and are still arriving at `now`.
function failingSince(incidents: readonly ErrorEvent[], since: number, now: number): boolean {
  const first = new Map<string, number>()
  const last = new Map<string, number>()
  for (const ev of incidents) {
    const t = Date.parse(ev.timestamp)
    if (!Number.isFinite(t)) continue
    const k = ev.affectedNode || ev.service
    first.set(k, Math.min(first.get(k) ?? t, t))
    last.set(k, Math.max(last.get(k) ?? t, t))
  }
  for (const [k, f] of first) if (f > since && now - (last.get(k) ?? 0) <= STILL_FAILING_MS) return true
  return false
}

async function writeObject(dir: string, hash: string, spec: unknown): Promise<void> {
  const file = objectPath(dir, hash)
  try {
    await fs.access(file)
    return
  } catch {
    // not written yet
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, canonicalJson(spec))
}

/**
 * After a Kubernetes poll: record what it read, and write a baseline when the
 * system has been healthy long enough and its state differs from the last one.
 * `dir` is the project's neat-out directory. Never throws into the poll.
 */
export async function observeK8sPoll(
  graph: NeatGraph,
  signals: readonly ObservedSignal[],
  opts: { dir: string; errorsPath?: string; now?: number },
): Promise<BaselineManifest | null> {
  try {
    const now = opts.now ?? Date.now()
    const st = stateFor(opts.dir)
    if (!st.loaded) {
      const all = await readManifests(opts.dir)
      st.last = all.at(-1)
      st.loaded = true
    }
    const objects: Record<string, ObjectEntry> = {}
    const specs = new Map<string, unknown>()
    for (const s of signals) {
      if (!s.infraSpec || s.targetKind !== K8S_OBJECT_TARGET_KIND) continue
      const parsed = parseK8sObjectName(s.targetName)
      if (!parsed) continue
      const { kind, name } = parsed
      const node = infraId(kind, name)
      const obj = k8sObjectOf(graph, node)
      if (!obj) continue
      const id = objectId(kind, s.infraSpec.namespace, name)
      objects[id] = { node, hash: obj.hash }
      specs.set(obj.hash, obj.spec)
    }
    if (Object.keys(objects).length === 0) return null
    // A changed state starts its hold afresh: a new spec becomes the baseline only
    // after it has itself been healthy for the hold, so the poll right after a
    // change (an injection still Ready by Kubernetes) never writes it.
    const changed = st.lastPoll !== undefined && canonicalJson(st.lastPoll.objects) !== canonicalJson(objects)
    st.lastPoll = { at: now, objects }
    if (changed) {
      st.healthyPolls = 0
      delete st.healthySince
    }

    const faulted = signals.some((s) => s.incident !== undefined)
    const incidents = opts.errorsPath ? await readErrorEvents(opts.errorsPath) : []
    const since = st.last ? Date.parse(st.last.takenAt) : Number.NEGATIVE_INFINITY
    const healthy = !faulted && !(st.last && failingSince(incidents, since, now))
    if (!healthy) {
      st.healthyPolls = 0
      delete st.healthySince
      return null
    }
    st.healthyPolls += 1
    st.healthySince ??= now
    if (st.healthyPolls < 2 || now - st.healthySince < holdMs()) return null

    const flags: Record<string, string> = {}
    const flagSpecs = new Map<string, unknown>()
    for (const [id, f] of flagStates(graph)) {
      const h = specHash(f.state)
      flags[id] = h
      flagSpecs.set(h, f.state)
    }
    const next: BaselineManifest = { takenAt: new Date(now).toISOString(), objects, flags, erroringEdges: erroringEdges(graph) }
    if (st.last && canonicalJson({ ...st.last, takenAt: '' }) === canonicalJson({ ...next, takenAt: '' })) return null
    for (const [h, spec] of [...specs, ...flagSpecs]) await writeObject(opts.dir, h, spec)
    await fs.mkdir(opts.dir, { recursive: true })
    await fs.appendFile(manifestPath(opts.dir), JSON.stringify(next) + '\n')
    st.last = next
    return next
  } catch {
    return null
  }
}

/**
 * The onset of a node's current failure: the earliest incident of its latest
 * run, a run being incidents no more than two minutes apart. Undefined when the
 * node has none.
 */
export function failureOnset(incidents: readonly ErrorEvent[], nodeId: string): string | undefined {
  const svc = nodeId.replace(/^service:/, '')
  const times = incidents
    .filter((e) => e.affectedNode === nodeId || e.service === svc)
    .map((e) => Date.parse(e.timestamp))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a)
  if (times.length === 0) return undefined
  let onset = times[0]!
  for (const t of times.slice(1)) {
    if (onset - t > RUN_GAP_MS) break
    onset = t
  }
  return new Date(onset).toISOString()
}

// Undirected hop distance from `from` to every node within reach.
function distancesFrom(graph: NeatGraph, from: string, maxDepth = 12): Map<string, number> {
  const dist = new Map<string, number>([[from, 0]])
  if (!graph.hasNode(from)) return dist
  let frontier = [from]
  for (let d = 1; d <= maxDepth && frontier.length > 0; d++) {
    const next: string[] = []
    for (const n of frontier) {
      for (const m of graph.neighbors(n)) {
        if (dist.has(m)) continue
        dist.set(m, d)
        next.push(m)
      }
    }
    frontier = next
  }
  return dist
}

// A ConfigMap the graph joins to nothing is reached through the workloads whose
// spec names it (env valueFrom, envFrom, a volume): one hop past the nearest.
function configMapDistance(graph: NeatGraph, name: string, dist: Map<string, number>): number | undefined {
  let best: number | undefined
  graph.forEachNode((id, attrs) => {
    const n = attrs as { kind?: string; observedSpec?: Record<string, unknown> }
    if (n.kind !== 'k8s-deployment' || !n.observedSpec) return
    const s = canonicalJson(n.observedSpec['operational'] ?? {})
    if (!s.includes(`configMap ${name}`) && !s.includes(`"name":"${name}"`)) return
    const d = dist.get(id)
    if (d !== undefined && (best === undefined || d + 1 < best)) best = d + 1
  })
  return best
}

async function readObject(dir: string, hash: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(objectPath(dir, hash), 'utf8'))
  } catch {
    return undefined
  }
}

const CHANGE_ORDER: Record<HealthyChange['change'], number> = { modified: 0, removed: 0, added: 1, 'started-erroring': 2 }

/**
 * What changed since the latest healthy baseline written before `at`. The
 * current side is the live graph: each object's `observedSpec`, the flag store,
 * the erroring edges. With `from`, changes are ranked by graph distance to it.
 */
export async function changesSinceHealthy(
  graph: NeatGraph,
  dir: string,
  opts: { at?: string; from?: string } = {},
): Promise<ChangesSinceHealthy> {
  const at = opts.at ?? new Date().toISOString()
  const atMs = Date.parse(at)
  const base = (await readManifests(dir)).filter((m) => Date.parse(m.takenAt) < atMs).at(-1)
  const empty = { at, base: null, ...(opts.from ? { from: opts.from } : {}), changes: [], provenance: Provenance.OBSERVED }
  if (!base) return ChangesSinceHealthySchema.parse(empty)

  const changes: HealthyChange[] = []
  // Objects: the latest poll's set when this process has one, else every k8s
  // object node carrying a live spec.
  const live = new Map<string, ObjectEntry & { spec: unknown }>()
  const lastPoll = states.get(dir)?.lastPoll?.objects
  const fromGraph = (node: string): (ObjectEntry & { spec: unknown }) | null => {
    const o = k8sObjectOf(graph, node)
    return o ? { node, hash: o.hash, spec: o.spec } : null
  }
  if (lastPoll) {
    for (const [id, e] of Object.entries(lastPoll)) {
      const o = fromGraph(e.node)
      if (o) live.set(id, o)
    }
  } else {
    graph.forEachNode((id) => {
      const o = k8sObjectOf(graph, id)
      if (o) live.set(objectId(o.kind, o.namespace, o.name), { node: id, hash: o.hash, spec: o.spec })
    })
  }
  for (const [id, b] of Object.entries(base.objects)) {
    const cur = live.get(id)
    if (!cur) {
      if (lastPoll) changes.push({ id, kind: 'object', node: b.node, change: 'removed', fields: [], hashBefore: b.hash })
      continue
    }
    if (cur.hash === b.hash) continue
    const before = await readObject(dir, b.hash)
    changes.push({
      id,
      kind: 'object',
      node: b.node,
      change: 'modified',
      fields: before === undefined ? [] : diffSpecs(before, cur.spec),
      hashBefore: b.hash,
      hashAfter: cur.hash,
    })
  }
  for (const [id, cur] of live) {
    if (!(id in base.objects)) changes.push({ id, kind: 'object', node: cur.node, change: 'added', fields: [], hashAfter: cur.hash })
  }
  // Flags.
  for (const [id, f] of flagStates(graph)) {
    const h = specHash(f.state)
    const was = base.flags[id]
    if (was === h) continue
    const before = was ? await readObject(dir, was) : undefined
    changes.push({
      id,
      kind: 'flag',
      node: f.node,
      change: was ? 'modified' : 'added',
      fields: was && before !== undefined ? diffSpecs(before, f.state) : [],
      ...(was ? { hashBefore: was } : {}),
      hashAfter: h,
    })
  }
  // Edges that went from no errors to some.
  const wasErroring = new Set(base.erroringEdges)
  for (const id of erroringEdges(graph)) {
    if (wasErroring.has(id)) continue
    const e = graph.getEdgeAttributes(id) as GraphEdge
    changes.push({ id, kind: 'edge', node: e.source, change: 'started-erroring', fields: [{ path: '/errorCount', before: 0, after: e.signal?.errorCount ?? 0 }] })
  }

  if (opts.from) {
    const dist = distancesFrom(graph, opts.from)
    for (const c of changes) {
      let d = dist.get(c.node)
      if (c.kind === 'edge' && graph.hasEdge(c.id)) d = Math.min(d ?? Infinity, dist.get(graph.target(c.id)) ?? Infinity)
      if ((d === undefined || !Number.isFinite(d)) && c.node.startsWith('infra:k8s-configmap:')) {
        d = configMapDistance(graph, c.node.slice('infra:k8s-configmap:'.length), dist)
      }
      if (d !== undefined && Number.isFinite(d)) c.distance = d
    }
  }
  changes.sort(
    (x, y) =>
      (x.distance ?? Infinity) - (y.distance ?? Infinity) ||
      CHANGE_ORDER[x.change] - CHANGE_ORDER[y.change] ||
      x.id.localeCompare(y.id),
  )
  return ChangesSinceHealthySchema.parse({ ...empty, base: { takenAt: base.takenAt }, changes })
}
