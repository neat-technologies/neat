// Shared infrastructure for the tool modules: the project-aware path builder,
// the readiness-aware empty/missing-node fallbacks (#1101), and the POST helper.
// These are not a tool family — they are the plumbing every family reaches for,
// so they live in one place rather than being re-derived per module.

import { HttpError, ProjectNotFoundError, type HttpClient } from '../client.js'
import {
  formatEmptyResponse,
  formatErrorResponse,
  formatToolResponse,
  type ToolResponse,
} from '../format.js'
import type { GraphNode } from '@neat.is/types'

// Project-aware path builder. When `project` is set, route through
// /projects/<name>/...; otherwise hit the legacy root URL (which the core
// resolves to project=`default`). Keeping the legacy path means callers
// running an older core still talk to a known route.
export function projectPath(project: string | undefined, suffix: string): string {
  if (!project) return suffix
  return `/projects/${encodeURIComponent(project)}${suffix}`
}

// The slice of the per-project /health response the readiness probe reads.
// #883 puts the most recent extraction pass's coverage here; `skippedFiles`
// is the exact count of files that failed to parse that pass (0 = a clean,
// complete pass). The field is absent until a full pass has recorded one.
interface HealthReadiness {
  coverage?: { skippedFiles?: number }
}

// An empty result is ambiguous: "no such edges exist" reads identically to
// "the first extraction scan hasn't finished, so I haven't seen them yet."
// A dead daemon is already unambiguous — the transport raises an isError, not
// an empty 200 — but a reachable daemon mid-first-scan returns 200 with a
// partial graph. `/health` already carries the readiness signal (#883), so on
// the empty path we read it and append a one-clause reason. Best-effort: if
// the probe itself can't answer, we return undefined and leave the empty
// message plain rather than turning it into an error.
export async function readinessReason(
  client: HttpClient,
  project: string | undefined,
): Promise<string | undefined> {
  let health: HealthReadiness
  try {
    // The extraction coverage (#883) rides on the PER-PROJECT /health, which is
    // mounted only under /projects/:project. The unprefixed /health is the
    // daemon-wide probe and carries no coverage, so we name the project even
    // when the caller didn't: an unset project resolves to the documented
    // 'default' (ADR-026), which a per-project daemon maps to its one project.
    const named = project ?? 'default'
    health = await client.get<HealthReadiness>(projectPath(named, '/health'))
  } catch {
    return undefined
  }
  const coverage = health.coverage
  if (!coverage || typeof coverage.skippedFiles !== 'number') {
    // No full pass has recorded coverage yet — the first scan is still in
    // flight, so an empty answer can't be trusted as complete.
    return '(index still building — the first extraction pass has not finished yet, so this may be incomplete; retry once it settles.)'
  }
  if (coverage.skippedFiles > 0) {
    const n = coverage.skippedFiles
    return `(index partial — ${n} file${n === 1 ? '' : 's'} failed to parse in the last pass, so this may be incomplete.)`
  }
  // A clean, complete pass is on record — the empty result is a real answer,
  // not a still-building index.
  return '(graph is current — this is a real empty result, not a still-building index.)'
}

// Wrap an empty summary with the readiness clause so the agent can tell a
// genuinely-empty answer from a not-yet-indexed one. Falls back to the plain
// empty response when readiness can't be determined. The footer stays
// n/a · n/a and the three-part shape is unchanged.
export async function emptyWithReadiness(
  client: HttpClient,
  project: string | undefined,
  summary: string,
): Promise<ToolResponse> {
  const reason = await readinessReason(client, project)
  return reason
    ? formatToolResponse({ summary: `${summary} ${reason}` })
    : formatEmptyResponse(summary)
}

// Most tools want "node missing → friendly message, anything else → real error".
// The node-not-found 404 is itself an empty result, so it carries the same
// readiness clause: "node X not found" during a first scan means "not indexed
// yet," not "gone." client + project let the fallback probe /health.
export async function withMissingNodeFallback(
  client: HttpClient,
  project: string | undefined,
  fn: () => Promise<ToolResponse>,
  notFoundMessage: string,
): Promise<ToolResponse> {
  try {
    return await fn()
  } catch (err) {
    // A project-not-found 404 is NOT a missing node — the core doesn't serve
    // this project at all, so an empty "no results" would be a confident answer
    // about the wrong codebase (#884). Surface it as a real error. Checked
    // before the generic 404 since ProjectNotFoundError extends HttpError.
    if (err instanceof ProjectNotFoundError) {
      return formatErrorResponse(err.message)
    }
    if (err instanceof HttpError && err.status === 404) {
      return emptyWithReadiness(client, project, notFoundMessage)
    }
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

export async function postJson<T>(client: HttpClient, path: string, body: unknown): Promise<T> {
  // The base HttpClient interface only exposes get(). For POST we need to
  // reach into the underlying transport. Most callers pass the client built
  // by createHttpClient which has post; types are kept minimal so test
  // stubs don't have to implement post unless the tool needs it.
  const c = client as HttpClient & { post?: <U>(p: string, b: unknown) => Promise<U> }
  if (typeof c.post !== 'function') {
    throw new Error('HttpClient does not support POST — required for check_policies dry-run')
  }
  return c.post<T>(path, body)
}

// The /search response shape, shared by semantic_search and investigate (both
// hit GET /search), so neither family has to re-declare it or import the other.
export interface SearchResponse {
  query: string
  provider?: 'ollama' | 'transformers' | 'substring'
  matches: (GraphNode & { score?: number })[]
}
