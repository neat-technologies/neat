// The registry of retained static layers (ADR-278, contracts/ref-views.md §2, §4).
//
// A project keeps one live graph. Beside it, per repository, it keeps a small
// number of static layers, each the EXTRACTED graph of one git state. A layer is
// keyed by (project, repository, state). This module is the map of those layers:
// who is building which, what is retained, what is pinned, and what gets evicted.
//
// It holds graphs and never writes into one. Building a layer and composing a
// view from it are the producers' work (extract/ref-view.ts). Layers are memory
// only: nothing here touches a file, and no layer is ever registered as a
// project graph, so the persist loop cannot reach one.

import type { RefStatus } from '@neat.is/types'
import type { NeatGraph } from './graph.js'

/**
 * Layers retained per project. A layer of a 4k-node repository is about 3 MB and
 * one of a 21k-node repository about 17 MB (ADR-278, one run each), so four is
 * tens of megabytes at the large end.
 */
export const DEFAULT_REF_LAYERS_PER_PROJECT = 4
/** A layer nobody has read for this long is dropped. */
export const DEFAULT_REF_LAYER_TTL_MS = 30 * 60_000

const SWEEP_INTERVAL_MS = 60_000
const MAX_TOMBSTONES = 256
const MAX_FAILED_PER_PROJECT = 16

// ── keys (ref-views.md §1) ───────────────────────────────────────────────────

export interface RefState {
  state: 'commit' | 'worktree'
  sha: string
  dirtyDigest?: string
}

export function commitKey(sha: string): string {
  return `commit:${sha}`
}

/** A dirty working tree's key. A clean one is its commit, so it has no key of its own. */
export function worktreeKey(sha: string, dirtyDigest: string): string {
  return `worktree:${sha}+${dirtyDigest}`
}

/** Read a state key. Null for anything that is not one, a branch or tag name included. */
export function parseRefKey(key: string): RefState | null {
  const commit = /^commit:([0-9a-f]{40})$/.exec(key)
  if (commit) return { state: 'commit', sha: commit[1]! }
  const worktree = /^worktree:([0-9a-f]{40})\+([0-9a-f]{64})$/.exec(key)
  if (worktree) return { state: 'worktree', sha: worktree[1]!, dirtyDigest: worktree[2]! }
  return null
}

// ── the live graph's mutation counter (ref-views.md §5.2) ────────────────────

const MUTATION_EVENTS = [
  'nodeAdded',
  'nodeDropped',
  'edgeAdded',
  'edgeDropped',
  'cleared',
  'edgesCleared',
  'attributesUpdated',
  'nodeAttributesUpdated',
  'edgeAttributesUpdated',
  'eachNodeAttributesUpdated',
  'eachEdgeAttributesUpdated',
] as const

const counters = new WeakMap<NeatGraph, { count: number }>()

/**
 * How many times `graph` has changed since this was first asked about it. A view
 * composed at one count is current exactly while the count stands. Counting
 * starts on the first call, which listens to the graph and writes nothing to it.
 */
export function mutationCount(graph: NeatGraph): number {
  let counter = counters.get(graph)
  if (!counter) {
    const fresh = { count: 0 }
    const bump = (): void => {
      fresh.count++
    }
    for (const event of MUTATION_EVENTS) graph.on(event, bump)
    counters.set(graph, fresh)
    counter = fresh
  }
  return counter.count
}

// ── layers ───────────────────────────────────────────────────────────────────

/** One repository's EXTRACTED graph at one git state, and how complete its extraction was. */
export interface StaticLayer {
  graph: NeatGraph
  extractionErrors: number
  skippedFiles: number
}

/**
 * The last view composed from a layer. It is reusable only while `live` is the
 * graph it was composed from and that graph's mutation count is still `mutation`.
 */
export interface ComposedView {
  graph: NeatGraph
  live: NeatGraph
  mutation: number
  hiddenRuntimeEdges: number
}

export interface RefLayerEntry {
  readonly project: string
  readonly repository: string
  /** The state key: `commit:<sha>` or `worktree:<sha>+<digest>`. */
  readonly key: string
  status: RefStatus
  /** Present once the build has landed, complete or not. */
  layer?: StaticLayer
  /** Why a failed build failed. */
  error?: string
  /** Settles when the build does. It never rejects. */
  settled: Promise<void>
  requestedAt: number
  lastReadAt: number
  pins: number
  /** The view last composed from this layer, replaced by the next compose. */
  view?: ComposedView
}

export type RefLookup =
  | { entry: RefLayerEntry }
  | { missing: 'ref_not_found' | 'ref_evicted' | 'ref_ambiguous' }

export interface RefRegistryOptions {
  maxLayersPerProject?: number
  ttlMs?: number
  now?: () => number
}

const idOf = (project: string, repository: string, key: string): string =>
  `${project}\u0000${repository}\u0000${key}`

export class RefRegistry {
  private readonly entries = new Map<string, RefLayerEntry>()
  // Keys whose layer was evicted, so a read can say so. Oldest first.
  private readonly tombstones = new Set<string>()
  private readonly maxLayers: number
  private readonly ttlMs: number
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(opts: RefRegistryOptions = {}) {
    this.maxLayers = Math.max(1, opts.maxLayersPerProject ?? DEFAULT_REF_LAYERS_PER_PROJECT)
    this.ttlMs = Math.max(1, opts.ttlMs ?? DEFAULT_REF_LAYER_TTL_MS)
    this.now = opts.now ?? Date.now
  }

  /**
   * The entry for a key, starting its build when there is none. A key that is
   * building, ready or incomplete is returned as it stands, so any number of
   * requests for one key share one build. A failed key is built again.
   */
  request(
    project: string,
    repository: string,
    key: string,
    build: () => Promise<StaticLayer>,
  ): RefLayerEntry {
    this.sweep()
    const id = idOf(project, repository, key)
    const existing = this.entries.get(id)
    if (existing && existing.status !== 'failed') return existing
    const at = this.now()
    const entry: RefLayerEntry = {
      project,
      repository,
      key,
      status: 'building',
      settled: Promise.resolve(),
      requestedAt: at,
      lastReadAt: at,
      pins: 0,
    }
    this.entries.set(id, entry)
    this.tombstones.delete(id)
    entry.settled = Promise.resolve()
      .then(build)
      .then(
        (layer) => {
          // Dropped while it was building (the project was cleared): nothing is retained.
          if (this.entries.get(id) !== entry) return
          entry.layer = layer
          entry.status = layer.extractionErrors > 0 || layer.skippedFiles > 0 ? 'incomplete' : 'ready'
          entry.lastReadAt = this.now()
          this.enforceCap(project)
        },
        (err: unknown) => {
          if (this.entries.get(id) !== entry) return
          entry.status = 'failed'
          entry.error = err instanceof Error ? err.message : String(err)
          this.trimFailed(project)
        },
      )
    this.startTimer()
    return entry
  }

  /**
   * Find the layer a read names. `key` is a state key. A project with two
   * repositories at one state has to name which, or the answer is ambiguous.
   */
  find(project: string, key: string, repository?: string): RefLookup {
    this.sweep()
    const matches = [...this.entries.values()].filter(
      (e) => e.project === project && e.key === key && (repository === undefined || e.repository === repository),
    )
    if (matches.length === 1) return { entry: matches[0]! }
    if (matches.length > 1) return { missing: 'ref_ambiguous' }
    const prefix = `${project}\u0000`
    const suffix = `\u0000${key}`
    for (const id of this.tombstones) {
      if (!id.startsWith(prefix) || !id.endsWith(suffix)) continue
      if (repository === undefined || id === idOf(project, repository, key)) return { missing: 'ref_evicted' }
    }
    return { missing: 'ref_not_found' }
  }

  /** Record a read. Eviction order and the TTL both run from the last read. */
  touch(entry: RefLayerEntry): void {
    entry.lastReadAt = this.now()
  }

  /** Hold a layer against eviction. Returns the release, which is safe to call twice. */
  pin(entry: RefLayerEntry): () => void {
    entry.pins++
    let released = false
    return () => {
      if (released) return
      released = true
      entry.pins = Math.max(0, entry.pins - 1)
      this.enforceCap(entry.project)
    }
  }

  /** A project's entries, most recently read first. */
  list(project: string): RefLayerEntry[] {
    this.sweep()
    return [...this.entries.values()]
      .filter((e) => e.project === project)
      .sort((a, b) => b.lastReadAt - a.lastReadAt || (a.key < b.key ? -1 : 1))
  }

  /** Milliseconds since `entry` was asked for and since it was last read. */
  ages(entry: RefLayerEntry): { ageMs: number; idleMs: number } {
    const at = this.now()
    return { ageMs: Math.max(0, at - entry.requestedAt), idleMs: Math.max(0, at - entry.lastReadAt) }
  }

  /** Drop every unpinned, settled entry that has gone unread past the TTL. */
  sweep(): void {
    const at = this.now()
    for (const [id, entry] of this.entries) {
      if (entry.status === 'building' || entry.pins > 0) continue
      if (at - entry.lastReadAt > this.ttlMs) this.evict(id, entry)
    }
    if (this.entries.size === 0) this.stopTimer()
  }

  /** Drop a project's entries, or every entry. Pins do not hold here: the project is going. */
  clear(project?: string): void {
    for (const [id, entry] of this.entries) {
      if (project !== undefined && entry.project !== project) continue
      entry.layer = undefined
      entry.view = undefined
      this.entries.delete(id)
    }
    if (project === undefined) this.tombstones.clear()
    if (this.entries.size === 0) this.stopTimer()
  }

  private evict(id: string, entry: RefLayerEntry): void {
    const held = entry.layer !== undefined
    entry.layer = undefined
    entry.view = undefined
    this.entries.delete(id)
    if (!held) return
    this.tombstones.add(id)
    while (this.tombstones.size > MAX_TOMBSTONES) {
      this.tombstones.delete(this.tombstones.values().next().value as string)
    }
  }

  // Over the count, the least recently read unpinned layer goes first. Pinned
  // layers stay, so a project whose layers are all pinned may sit over the count.
  private enforceCap(project: string): void {
    const held = [...this.entries.entries()]
      .filter(([, e]) => e.project === project && e.layer !== undefined)
      .sort(([, a], [, b]) => a.lastReadAt - b.lastReadAt)
    let over = held.length - this.maxLayers
    for (const [id, entry] of held) {
      if (over <= 0) break
      if (entry.pins > 0) continue
      this.evict(id, entry)
      over--
    }
  }

  private trimFailed(project: string): void {
    const failed = [...this.entries.entries()]
      .filter(([, e]) => e.project === project && e.status === 'failed')
      .sort(([, a], [, b]) => a.requestedAt - b.requestedAt)
    for (const [id, entry] of failed.slice(0, Math.max(0, failed.length - MAX_FAILED_PER_PROJECT))) {
      this.evict(id, entry)
    }
  }

  // The TTL also has to run on a daemon nobody is reading from.
  private startTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.sweep(), Math.min(SWEEP_INTERVAL_MS, this.ttlMs))
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  private stopTimer(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }
}
