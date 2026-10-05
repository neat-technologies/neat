// The PR verdict, computed where the source, the extractor and the OBSERVED
// graph already are (ADR-234).
//
// neat-action posts a verdict-first comment on a pull request: what the PR adds
// and removes in the graph, and — against a connected host — what production
// actually runs through the things it touches. Producing it takes the engine:
// the PR's base and head are each extracted, and the two graphs diffed, before
// a host is asked anything. The hosted control plane has no engine and may not
// grow one, so on hosted NEAT the tenant daemon does this work and hands back
// the finished comment.
//
// What this module does for one request:
//   1. clone the base commit and the head commit, depth 1, into temp dirs;
//   2. extract each into its own scratch graph — never the project's graph;
//   3. diff them with the Action's own logic;
//   4. read the OBSERVED half from the project's live graph, which is only read;
//   5. render with the Action's own renderer, and return the markdown.
//
// The diffing, formatting and rendering are imported from the Action's module,
// not reimplemented: the hosted comment and the Action's comment are one
// implementation and cannot disagree.
//
// Bounds: one verdict at a time per daemon, one scratch graph per commit, a
// wall-clock limit, and temp dirs removed whatever happens.

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  changedFileNodeIds,
  changedNodeIds,
  changedNodesForObservedScan,
  diffGraphs,
  formatDivergences,
  graphFromExport,
  observedBreakFrom,
  renderVerdict,
} from '@neat.is/action/src/graph.mjs'
import type { ErrorEvent } from '@neat.is/types'
import { defaultCloneCommit, scrubCloneToken, type CloneCommit } from './connectors/hosted-repos.js'
import { computeDivergences } from './divergences.js'
import { extractFromDirectory } from './extract.js'
import { makeGraph, type NeatGraph } from './graph.js'
import { getObservedDependencies } from './traverse.js'

/** Two shallow clones and two extractions of a large repo fit comfortably; a wedged clone does not. */
export const DEFAULT_PR_VERDICT_TIMEOUT_MS = 240_000

/** A changed-files list longer than this is a PR nobody reads a comment on; cap what is matched. */
const MAX_CHANGED_FILES = 3000

export type PrVerdictStage = 'clone-base' | 'clone-head' | 'extract-base' | 'extract-head'

export interface PrVerdictRequest {
  owner: string
  name: string
  baseSha: string
  headSha: string
  /** `https://x-access-token:<token>@github.com/<owner>/<name>.git`. Used for the two clones, then gone. */
  cloneUrl: string
  /** Repo-relative paths the PR changes, from the caller. Absent → the two trees are compared. */
  changedFiles?: string[]
  tone?: 'loud' | 'professional'
}

export interface PrVerdictResult {
  marker: string
  body: string
  base: { sha: string; nodes: number; edges: number }
  head: { sha: string; nodes: number; edges: number }
  changedFiles: number
  observedBreaks: number
  divergences: number
  durationMs: number
}

/** A verdict that could not be produced, carrying the HTTP status the route answers with. */
export class PrVerdictError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 422 | 429 | 504,
    readonly stage?: PrVerdictStage,
  ) {
    super(message)
    this.name = 'PrVerdictError'
  }
}

const SHA = /^[0-9a-f]{40}$/
// An owner or repo name as GitHub allows them — and nothing that could be a path.
const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?$/

/**
 * Validate a request body. The clone URL is held to the repo the request names, over https, on github.com:
 * the route runs a clone on the caller's word, so the word is checked rather than followed.
 */
export function parsePrVerdictRequest(body: unknown): PrVerdictRequest {
  const bad = (what: string): never => {
    throw new PrVerdictError(what, 400)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) bad('body must be a JSON object')
  const b = body as Record<string, unknown>
  const str = (k: string): string => {
    const v = b[k]
    if (typeof v !== 'string' || v.length === 0) bad(`${k} is required`)
    return v as string
  }
  const owner = str('owner')
  const name = str('name')
  const baseSha = str('baseSha')
  const headSha = str('headSha')
  const cloneUrl = str('cloneUrl')
  if (!SLUG.test(owner)) bad('owner is not a GitHub account name')
  if (!SLUG.test(name)) bad('name is not a GitHub repository name')
  if (!SHA.test(baseSha)) bad('baseSha must be a full 40-character commit SHA')
  if (!SHA.test(headSha)) bad('headSha must be a full 40-character commit SHA')

  let url: URL | undefined
  try {
    url = new URL(cloneUrl)
  } catch {
    bad('cloneUrl is not a URL')
  }
  const repoPath = url!.pathname.replace(/\.git$/, '').replace(/\/+$/, '')
  if (url!.protocol !== 'https:' || url!.hostname !== 'github.com' || url!.port !== '') {
    bad('cloneUrl must be an https://github.com URL')
  }
  if (repoPath.toLowerCase() !== `/${owner}/${name}`.toLowerCase()) {
    bad('cloneUrl does not point at owner/name')
  }

  let changedFiles: string[] | undefined
  if (b.changedFiles !== undefined) {
    if (!Array.isArray(b.changedFiles) || b.changedFiles.some((f) => typeof f !== 'string')) {
      bad('changedFiles must be an array of paths')
    }
    changedFiles = (b.changedFiles as string[]).slice(0, MAX_CHANGED_FILES)
  }
  if (b.tone !== undefined && b.tone !== 'loud' && b.tone !== 'professional') {
    bad('tone must be "loud" or "professional"')
  }
  return {
    owner,
    name,
    baseSha,
    headSha,
    cloneUrl,
    ...(changedFiles ? { changedFiles } : {}),
    ...(b.tone ? { tone: b.tone as 'loud' | 'professional' } : {}),
  }
}

export interface PrVerdictDeps {
  /** Test seam: the single-commit clone (defaults to isomorphic-git). */
  cloneCommit?: CloneCommit
  /** Test seam: the extractor (defaults to extractFromDirectory). */
  extract?: typeof extractFromDirectory
  /** Root the temp clone dirs are made under (default os.tmpdir()). */
  tmpRoot?: string
  timeoutMs?: number
  now?: () => number
}

export interface PrVerdictContext {
  /** The project's live graph. Read for OBSERVED; never written. */
  liveGraph: NeatGraph
  /** The project's recorded incidents, for symbol-grain divergences — the same read `/graph/divergences` does. */
  incidents?: ErrorEvent[]
}

export type PrVerdictRunner = (req: PrVerdictRequest, ctx: PrVerdictContext) => Promise<PrVerdictResult>

/**
 * A runner that computes one verdict at a time. A request that arrives while one is running is refused with
 * 429 rather than queued: each verdict holds two checkouts and two graphs, and a tenant is sized for one.
 */
export function createPrVerdictRunner(deps: PrVerdictDeps = {}): PrVerdictRunner {
  let busy = false
  return async (req, ctx) => {
    if (busy) throw new PrVerdictError('a verdict is already being computed on this daemon', 429)
    busy = true
    const timeoutMs = deps.timeoutMs ?? DEFAULT_PR_VERDICT_TIMEOUT_MS
    // The work is not cancellable mid-clone, so on a timeout the caller is answered and the work is left to
    // finish and clean up after itself; `busy` stays set until it has, so abandoned work can't pile up.
    const work = computePrVerdict(req, ctx, deps).finally(() => {
      busy = false
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new PrVerdictError(`verdict did not finish within ${timeoutMs}ms`, 504)),
        timeoutMs,
      )
    })
    try {
      return await Promise.race([work, timeout])
    } finally {
      if (timer) clearTimeout(timer)
      work.catch(() => {})
    }
  }
}

async function computePrVerdict(
  req: PrVerdictRequest,
  ctx: PrVerdictContext,
  deps: PrVerdictDeps,
): Promise<PrVerdictResult> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const cloneCommit = deps.cloneCommit ?? defaultCloneCommit
  const extract = deps.extract ?? extractFromDirectory
  const root = await fs.mkdtemp(path.join(deps.tmpRoot ?? os.tmpdir(), 'neat-pr-'))
  const baseDir = path.join(root, 'base')
  const headDir = path.join(root, 'head')

  const stage = async <T>(name: PrVerdictStage, run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (err) {
      const why = scrubCloneToken((err as Error).message ?? String(err)).slice(0, 300)
      throw new PrVerdictError(`${name} failed — ${why}`, 422, name)
    }
  }

  try {
    await fs.mkdir(baseDir)
    await fs.mkdir(headDir)
    await stage('clone-base', () => cloneCommit(req.cloneUrl, req.baseSha, baseDir))
    await stage('clone-head', () => cloneCommit(req.cloneUrl, req.headSha, headDir))

    // One scratch graph per commit. Neither is registered under a project name, so nothing that serves the
    // project — REST, MCP, the persist loop, the event bus — can reach them.
    const baseGraph = makeGraph()
    const headGraph = makeGraph()
    await stage('extract-base', () => extract(baseGraph, baseDir))
    await stage('extract-head', () => extract(headGraph, headDir))

    const base = graphFromExport(baseGraph.export())
    const head = graphFromExport(headGraph.export())
    const delta = diffGraphs(base, head)
    const changedPaths = req.changedFiles ?? (await changedPathsBetween(baseDir, headDir))
    const changedFiles = changedFileNodeIds(head, changedPaths)

    // The OBSERVED half, from the live graph — the same two questions the Action asks a host over HTTP
    // (action-hosted-seam.md), asked in process and handed to the same formatters.
    const divergences = formatDivergences(
      computeDivergences(ctx.liveGraph, { incidents: ctx.incidents ?? [] }),
      changedNodeIds(base, head),
    )
    const observedBreaks = []
    for (const node of changedNodesForObservedScan(base, head)) {
      if (!ctx.liveGraph.hasNode(node.id)) continue
      const found = observedBreakFrom(node, getObservedDependencies(ctx.liveGraph, node.id))
      if (found) observedBreaks.push(found)
    }

    const { marker, body } = renderVerdict({
      graph: head,
      delta,
      changedFiles,
      divergences,
      observedBreaks,
      tone: req.tone ?? 'loud',
    })
    return {
      marker,
      body,
      base: { sha: req.baseSha, nodes: baseGraph.order, edges: baseGraph.size },
      head: { sha: req.headSha, nodes: headGraph.order, edges: headGraph.size },
      changedFiles: changedFiles.length,
      observedBreaks: observedBreaks.length,
      divergences: divergences.length,
      durationMs: now() - startedAt,
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

const SKIP_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', 'neat-out'])

/** Every file under `dir`, repo-relative with forward slashes, mapped to a content hash. */
async function hashTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const walk = async (rel: string): Promise<void> => {
    const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(child)
      } else if (entry.isFile()) {
        const bytes = await fs.readFile(path.join(dir, child)).catch(() => null)
        if (bytes) out.set(child, createHash('sha1').update(bytes).digest('hex'))
      }
    }
  }
  await walk('')
  return out
}

/**
 * The paths that differ between two checkouts — added, removed or changed. The fallback when the caller
 * sent no changed-files list. It is a direct comparison of the two commits: with depth-1 clones there is no
 * merge base, so files that moved on the base branch after the PR branched show up here too. The caller's
 * list, taken from the PR itself, is the better source.
 */
export async function changedPathsBetween(baseDir: string, headDir: string): Promise<string[]> {
  const [base, head] = await Promise.all([hashTree(baseDir), hashTree(headDir)])
  const changed: string[] = []
  for (const [file, hash] of head) if (base.get(file) !== hash) changed.push(file)
  for (const file of base.keys()) if (!head.has(file)) changed.push(file)
  return changed.sort().slice(0, MAX_CHANGED_FILES)
}
