import { ENV_UNKNOWN, Provenance, normalizeEnv, observedEdgeId, type EdgeTypeValue, type GraphEdge } from '@neat.is/types'
import type { NeatGraph } from './graph.js'

// The environment dimension of runtime evidence (ADR-280). Code nodes have no
// environment; an OBSERVED, INFERRED or STALE edge does (decision 2), absent on
// the edge when it is `unknown`. Every read of runtime evidence goes through
// these helpers so that it is asked for one environment (decision 3) and never
// merges two by forgetting. Pure reads; nothing here writes a graph.

/** The production environment a project starts with (ADR-280 decision 4, ruling (c)). */
export const DEFAULT_PRODUCTION_ENV = 'production'

/** OBSERVED, INFERRED or STALE: the edges that carry an environment. */
export function isRuntimeEdge(e: GraphEdge): boolean {
  return e.provenance === Provenance.OBSERVED || e.provenance === Provenance.INFERRED || e.provenance === Provenance.STALE
}

/** The environment a runtime edge belongs to. `unknown` when it names none. */
export function edgeEnv(e: GraphEdge): string {
  return e.env ?? ENV_UNKNOWN
}

/** A runtime edge of exactly this environment. */
export function isRuntimeEdgeIn(e: GraphEdge, env: string): boolean {
  return isRuntimeEdge(e) && edgeEnv(e) === env
}

/**
 * The runtime edges among `edgeIds` that belong to `env`. The environment is
 * required: there is no form of this accessor that returns every environment's
 * edges together.
 */
export function runtimeEdgesIn(graph: NeatGraph, edgeIds: Iterable<string>, env: string): GraphEdge[] {
  const out: GraphEdge[] = []
  for (const id of edgeIds) {
    const e = graph.getEdgeAttributes(id) as GraphEdge
    if (isRuntimeEdgeIn(e, env)) out.push(e)
  }
  return out
}

/** Whether the OBSERVED twin of a static hop exists in this environment. */
export function hasObservedIn(graph: NeatGraph, source: string, target: string, type: EdgeTypeValue, env: string): boolean {
  return graph.hasEdge(observedEdgeId(source, target, type, env))
}

/** Every environment the graph holds runtime evidence for, sorted. Empty for a static-only graph. */
export function runtimeEnvironments(graph: NeatGraph): string[] {
  const envs = new Set<string>()
  graph.forEachEdge((_id, attrs) => {
    const e = attrs as GraphEdge
    if (isRuntimeEdge(e)) envs.add(edgeEnv(e))
  })
  return [...envs].sort()
}

export interface EnvironmentRequest {
  /** The environment the caller names. Normalised the way ingest normalises it. */
  env?: string
  /** The project's production environment (its `productionEnv` setting). */
  productionEnv?: string
}

export type EnvironmentResolution = { env: string } | { refused: true; environments: string[] }

/**
 * Which environment a read answers for (ADR-280 decision 4, ruling (c)):
 * the named one; else the project's production environment if the graph has
 * evidence in it; else the only environment present (`unknown` for a graph with
 * none or with unlabelled evidence only); else a refusal that lists them.
 */
export function resolveEnvironment(graph: NeatGraph, req: EnvironmentRequest = {}): EnvironmentResolution {
  if (req.env !== undefined) return { env: normalizeEnv(req.env) }
  const present = runtimeEnvironments(graph)
  const production = normalizeEnv(req.productionEnv ?? DEFAULT_PRODUCTION_ENV)
  if (present.includes(production)) return { env: production }
  if (present.length <= 1) return { env: present[0] ?? ENV_UNKNOWN }
  return { refused: true, environments: present }
}

/** A read that names no environment, on a project with several and none of them its production one. */
export class EnvironmentRequiredError extends Error {
  readonly code = 'environment_required'
  constructor(readonly environments: string[]) {
    super(`this project has runtime evidence in several environments and none is its production environment; name one of: ${environments.join(', ')}`)
    this.name = 'EnvironmentRequiredError'
  }
}

/** `resolveEnvironment`, throwing `EnvironmentRequiredError` on a refusal. */
export function environmentFor(graph: NeatGraph, req: EnvironmentRequest = {}): string {
  const r = resolveEnvironment(graph, req)
  if ('refused' in r) throw new EnvironmentRequiredError(r.environments)
  return r.env
}

/** The field an answer carries to say which environment it is for: absent for `unknown`. */
export function envField(env: string): { env?: string } {
  return env === ENV_UNKNOWN ? {} : { env }
}
