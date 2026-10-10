import { NodeType } from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import type { SourceBaseline } from '@neat.is/types'
export type { SourceBaseline } from '@neat.is/types'

export interface SourceCommit {
  repository: string
  sha: string
}

interface Entry {
  baseline: SourceBaseline
  // The pass that owns this entry's next verdict. A newer pass or an
  // invalidation replaces it, so an older pass can never restore its claim.
  generation: symbol
  // Services this repo's files belonged to when its pass finished. Node ids are
  // keyed by service, not repository, so two repos sharing a service name share
  // nodes, and neither one's evidence describes them alone.
  services: Set<string>
}

interface State {
  repos: Map<string, Entry>
  active: Set<symbol>
  conflicted: Set<symbol>
}

// Not graph attributes: evidence cannot survive a snapshot/load or be supplied
// by an incoming snapshot. Weak keys also keep project removal independent.
const states = new WeakMap<NeatGraph, State>()

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function validCommit(commit: SourceCommit | undefined, repository: string): commit is SourceCommit {
  return !!commit && commit.repository === repository && /^[0-9a-f]{40}$/.test(commit.sha)
}

function stateOf(graph: NeatGraph): State {
  let state = states.get(graph)
  if (!state) {
    state = { repos: new Map(), active: new Set(), conflicted: new Set() }
    states.set(graph, state)
  }
  return state
}

function setEntry(
  state: State,
  repository: string,
  baseline: SourceBaseline,
  generation: symbol = Symbol(),
): void {
  state.repos.set(repository, {
    baseline,
    generation,
    services: state.repos.get(repository)?.services ?? new Set(),
  })
}

/** One entry per repository with evidence, sorted by repository. Copies. */
export function readSourceBaselines(graph: NeatGraph): SourceBaseline[] {
  const state = states.get(graph)
  if (!state) return []
  return [...state.repos.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, entry]) => ({ ...entry.baseline }))
}

/**
 * Drop evidence. With a repository, only that repo's entry, superseding any
 * pass of its own in flight. Without one, every entry, because the write that
 * called it may have touched any repo's nodes; a pass running at the time is
 * marked conflicted, so it cannot restore a claim over a graph that changed
 * underneath it.
 */
export function invalidateSourceBaseline(
  graph: NeatGraph,
  repository?: string,
  status: 'unavailable' | 'syncing' = 'unavailable',
): void {
  if (repository !== undefined) {
    if (REPOSITORY.test(repository)) setEntry(stateOf(graph), repository, { status, repository })
    return
  }
  const state = states.get(graph)
  if (!state) return
  for (const generation of state.active) state.conflicted.add(generation)
  for (const name of state.repos.keys()) {
    setEntry(state, name, { status: 'unavailable', repository: name })
  }
}

/** Keep entries only for the repositories still bound to this project. */
export function retainSourceBaselines(graph: NeatGraph, repositories: Iterable<string>): void {
  const state = states.get(graph)
  if (!state) return
  const keep = new Set(repositories)
  for (const name of [...state.repos.keys()]) if (!keep.has(name)) state.repos.delete(name)
}

/**
 * Called when a pass starts. `source` is the repo the pass is scoped to
 * (ADR-233). A pass scoped to no repo may rewrite any repo's nodes, so it
 * invalidates every entry.
 */
export function beginSourceExtraction(
  graph: NeatGraph,
  source: string | undefined,
  commit?: SourceCommit,
): symbol {
  const generation = Symbol()
  const state = stateOf(graph)
  if (source === undefined) {
    invalidateSourceBaseline(graph)
    state.active.add(generation)
    return generation
  }
  state.active.add(generation)
  if (!REPOSITORY.test(source)) return generation
  setEntry(
    state,
    source,
    validCommit(commit, source)
      ? { status: 'syncing', repository: source }
      : { status: 'unavailable', repository: source },
    generation,
  )
  return generation
}

function servicesOf(graph: NeatGraph, repository: string): Set<string> {
  const services = new Set<string>()
  graph.forEachNode((_id, attrs) => {
    const node = attrs as { type?: string; source?: string; service?: string }
    if (node.type === NodeType.FileNode && node.source === repository && node.service) {
      services.add(node.service)
    }
  })
  return services
}

export function finishSourceExtraction(
  graph: NeatGraph,
  generation: symbol,
  source: string | undefined,
  commit: SourceCommit | undefined,
  result: { extractionErrors: number; skippedFiles: number },
): void {
  const state = states.get(graph)
  if (!state) return
  state.active.delete(generation)
  const conflicted = state.conflicted.delete(generation)
  if (source === undefined || !REPOSITORY.test(source)) return
  const entry = state.repos.get(source)
  // Another pass or invalidation has superseded this one.
  if (!entry || entry.generation !== generation) return
  entry.services = servicesOf(graph, source)
  let shared = false
  for (const [name, other] of state.repos) {
    if (name === source || ![...entry.services].some((s) => other.services.has(s))) continue
    shared = true
    setEntry(state, name, { status: 'unavailable', repository: name }, other.generation)
  }
  entry.baseline =
    !conflicted &&
    !shared &&
    validCommit(commit, source) &&
    result.extractionErrors === 0 &&
    result.skippedFiles === 0
      ? { status: 'ready', repository: source, sha: commit.sha }
      : { status: 'unavailable', repository: source }
}
