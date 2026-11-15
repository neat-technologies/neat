// Project registry — owns the per-project state that lives alongside the
// graph map: snapshot/error/stale paths, scan path, optional search index.
//
// Routes use it via `resolve(project)`. Server / watch construct it once at
// boot and pass it to buildApi. Tests can mock it with a small literal.

import path from 'node:path'
import type { NeatGraph } from './graph.js'
import { DEFAULT_PROJECT, getGraph } from './graph.js'
import type { SearchIndex } from './search-types.js'

export interface ProjectPaths {
  snapshotPath: string
  errorsPath: string
  staleEventsPath: string
  embeddingsCachePath: string
  // Policy-violations log per ADR-041 § Append-only ndjson sidecars. Lives
  // in the same neat-out directory as the other ndjson sidecars; daemons
  // wire PolicyViolationsLog to it.
  policyViolationsPath: string
}

// Default project keeps the legacy filenames so existing M5 / β / γ users
// see no behaviour change. Named projects fan out by name (ADR-026).
export function pathsForProject(project: string, baseDir: string): ProjectPaths {
  if (project === DEFAULT_PROJECT) {
    return {
      snapshotPath: path.join(baseDir, 'graph.json'),
      errorsPath: path.join(baseDir, 'errors.ndjson'),
      staleEventsPath: path.join(baseDir, 'stale-events.ndjson'),
      embeddingsCachePath: path.join(baseDir, 'embeddings.json'),
      policyViolationsPath: path.join(baseDir, 'policy-violations.ndjson'),
    }
  }
  return {
    snapshotPath: path.join(baseDir, `${project}.json`),
    errorsPath: path.join(baseDir, `errors.${project}.ndjson`),
    staleEventsPath: path.join(baseDir, `stale-events.${project}.ndjson`),
    embeddingsCachePath: path.join(baseDir, `embeddings.${project}.json`),
    policyViolationsPath: path.join(baseDir, `policy-violations.${project}.ndjson`),
  }
}

export interface ProjectContext {
  name: string
  graph: NeatGraph
  scanPath?: string
  paths: ProjectPaths
  searchIndex?: SearchIndex
}

export class Projects {
  private contexts = new Map<string, ProjectContext>()

  upsert(ctx: ProjectContext): void {
    this.contexts.set(ctx.name, ctx)
  }

  set(
    name: string,
    init: Omit<ProjectContext, 'name' | 'graph'> & { graph?: NeatGraph },
  ): ProjectContext {
    const ctx: ProjectContext = {
      name,
      graph: init.graph ?? getGraph(name),
      scanPath: init.scanPath,
      paths: init.paths,
      searchIndex: init.searchIndex,
    }
    this.contexts.set(name, ctx)
    return ctx
  }

  get(name: string): ProjectContext | undefined {
    return this.contexts.get(name)
  }

  has(name: string): boolean {
    return this.contexts.has(name)
  }

  list(): string[] {
    return [...this.contexts.keys()].sort()
  }

  attachSearchIndex(name: string, index: SearchIndex | undefined): void {
    const ctx = this.contexts.get(name)
    if (ctx) ctx.searchIndex = index
  }
}

// Parses NEAT_PROJECTS=a,b,c; trims whitespace, drops empty entries.
// `default` is implicit (always loaded), so callers usually filter it out
// before iterating extra projects.
export function parseExtraProjects(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p !== DEFAULT_PROJECT)
}
