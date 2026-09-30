import type { NeatGraph } from '../graph.js'
import type { SourceBaseline } from '@neat.is/types'
export type { SourceBaseline } from '@neat.is/types'

export interface SourceCommit {
  repository: string
  sha: string
}

interface State {
  generation: symbol
  baseline: SourceBaseline
  active: Set<symbol>
  conflicted: boolean
}

// Not graph attributes: evidence cannot survive a snapshot/load or be supplied
// by an incoming snapshot. Weak keys also keep project removal independent.
const states = new WeakMap<NeatGraph, State>()

function validSource(source: SourceCommit | undefined): source is SourceCommit {
  return (
    !!source &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository) &&
    /^[0-9a-f]{40}$/.test(source.sha)
  )
}

export function readSourceBaseline(graph: NeatGraph): SourceBaseline {
  return { ...(states.get(graph)?.baseline ?? { status: 'unverified' as const }) }
}

export function invalidateSourceBaseline(
  graph: NeatGraph,
  status: 'unverified' | 'unavailable' | 'syncing' = 'unverified',
): void {
  const active = states.get(graph)?.active ?? new Set<symbol>()
  states.set(graph, {
    generation: Symbol(),
    baseline: { status },
    active,
    conflicted: active.size > 0,
  })
}

export function beginSourceExtraction(graph: NeatGraph, source?: SourceCommit): symbol {
  const generation = Symbol()
  const active = states.get(graph)?.active ?? new Set<symbol>()
  const conflicted = active.size > 0
  active.add(generation)
  states.set(graph, {
    generation,
    baseline: validSource(source)
      ? { status: 'syncing', repository: source.repository }
      : { status: 'unverified' },
    active,
    conflicted,
  })
  return generation
}

export function finishSourceExtraction(
  graph: NeatGraph,
  generation: symbol,
  source: SourceCommit | undefined,
  result: { extractionErrors: number; skippedFiles: number },
): void {
  const state = states.get(graph)
  if (!state) return
  state.active.delete(generation)
  if (state.conflicted) {
    state.baseline = { status: 'unavailable' }
    return
  }
  // Another source pass or snapshot merge has superseded this producer.
  if (state.generation !== generation) return
  if (!validSource(source)) return
  state.baseline =
    result.extractionErrors === 0 && result.skippedFiles === 0
      ? { status: 'ready', repository: source.repository, sha: source.sha }
      : { status: 'unavailable' }
}
