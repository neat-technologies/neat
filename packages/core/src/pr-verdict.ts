// The PR verdict, computed where the source, the extractor and the OBSERVED
// graph already are (ADR-235).
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
import {
  Provenance,
  parseFileId,
  serviceId,
  PrVerdictBodySchema,
  type ErrorEvent,
  type Divergence,
  type SecurityDiff,
  type SecurityDiffEntry,
  type GateCondition,
  type GateFinding,
  type GateFindingLocus,
  type GateInput,
  type NoRegressionGateVerdict,
} from '@neat.is/types'
import { defaultCloneCommit, scrubCloneToken, type CloneCommit } from './connectors/hosted-repos.js'
import { computeDivergences, newDivergences } from './divergences.js'
import { divergenceFindingId, vulnerabilityFindingId } from './findings-ledger.js'
import { scanDiffGraphs } from './security-diff.js'
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
  // Divergences the head introduces over the base (ADR-277), keyed on identity. Raw across all
  // types over the EXTRACTED-only scratch graphs; the gate (G3) decides which types count.
  newDivergences: number
  // The no-regression gate verdict (ADR-277): four tri-state conditions + the findings a
  // PR-Sniper run can target. Additive to the rendered body.
  gate: NoRegressionGateVerdict
  durationMs: number
}

/** A verdict that could not be produced, carrying the HTTP status the route answers with. */
export class PrVerdictError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 422 | 429 | 504,
    readonly stage?: PrVerdictStage,
    /** For a 400: the schema's issues, returned as `details`. */
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'PrVerdictError'
  }
}

/**
 * Validate a request body against `PrVerdictBodySchema` (rest-api.md §Schema validation: every POST body
 * parses through a Zod schema from `@neat.is/types`, failures are 400 with the issues in `details`). Beyond
 * the schema, the changed-files list is capped.
 */
export function parsePrVerdictRequest(body: unknown): PrVerdictRequest {
  const parsed = PrVerdictBodySchema.safeParse(body)
  if (!parsed.success) {
    throw new PrVerdictError('invalid pr-verdict body', 400, undefined, parsed.error.issues)
  }
  const { changedFiles, tone, ...rest } = parsed.data
  return {
    ...rest,
    ...(changedFiles ? { changedFiles: changedFiles.slice(0, MAX_CHANGED_FILES) } : {}),
    ...(tone ? { tone } : {}),
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
  /** No-regression gate inputs the gate cannot compute itself (ADR-277): the repo's test outcome
   *  (absent makes the tests condition unknown) and the blast-radius ceiling. */
  gate?: GateInput
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
    // The work carries the same deadline: every stage gives up when it passes, and the checkouts are removed
    // on the way out. So the work settles at the deadline even when a clone has stalled, `busy` clears, and
    // the next request is served instead of refused until a restart. The timer below is the backstop for
    // the in-memory steps between stages.
    const deadline = (deps.now ?? Date.now)() + timeoutMs
    const work = computePrVerdict(req, ctx, deps, deadline).finally(() => {
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
  deadline: number,
): Promise<PrVerdictResult> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const cloneCommit = deps.cloneCommit ?? defaultCloneCommit
  const extract = deps.extract ?? extractFromDirectory
  const root = await fs.mkdtemp(path.join(deps.tmpRoot ?? os.tmpdir(), 'neat-pr-'))
  // Both checkouts sit in a directory named after the repository, as a plain
  // clone would, under different parents. A package.json with no name is a
  // service named after its directory (#1557), so the same leaf name keeps it
  // the same service on both sides instead of reading as one removed and one added.
  const baseDir = path.join(root, 'base', req.name)
  const headDir = path.join(root, 'head', req.name)

  // Run one stage against what is left of the deadline. A stage that can't be cancelled — a fetch, an
  // extraction — is abandoned, not stopped: it finishes or fails on its own, against checkouts that the
  // `finally` below has already removed.
  const stage = async <T>(name: PrVerdictStage, run: () => Promise<T>): Promise<T> => {
    const left = deadline - now()
    if (left <= 0) throw new PrVerdictError(`verdict ran out of time before ${name}`, 504, name)
    const work = run()
    work.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PrVerdictError(`verdict ran out of time during ${name}`, 504, name)), left)
    })
    try {
      return await Promise.race([work, expired])
    } catch (err) {
      if (err instanceof PrVerdictError) throw err
      const why = scrubCloneToken((err as Error).message ?? String(err)).slice(0, 300)
      throw new PrVerdictError(`${name} failed — ${why}`, 422, name)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  // The pass names its source like a repo-sync pass does (ADR-233) and stays quiet: these graphs belong to
  // no project, so there is no extraction for anyone to be told about.
  const extractOpts = { source: `${req.owner}/${req.name}`, announce: false }

  try {
    await fs.mkdir(baseDir, { recursive: true })
    await fs.mkdir(headDir, { recursive: true })
    await stage('clone-base', () => cloneCommit(req.cloneUrl, req.baseSha, baseDir))
    await stage('clone-head', () => cloneCommit(req.cloneUrl, req.headSha, headDir))

    // One scratch graph per commit. Neither is registered under a project name, so nothing that serves the
    // project — REST, MCP, the persist loop, the event bus — can reach them.
    const baseGraph = makeGraph()
    const headGraph = makeGraph()
    await stage('extract-base', () => extract(baseGraph, baseDir, extractOpts))
    await stage('extract-head', () => extract(headGraph, headDir, extractOpts))

    const base = graphFromExport(baseGraph.export())
    const head = graphFromExport(headGraph.export())
    // Base-versus-head divergence delta (ADR-277): the divergences the head introduces over the
    // base, keyed on identity so a moved line is not new. This is the raw primitive across all
    // types over the EXTRACTED-only scratch graphs; the gate verdict (G3) decides which types
    // count for "no new divergence".
    const introducedDivergences = newDivergences(
      computeDivergences(baseGraph).divergences,
      computeDivergences(headGraph).divergences,
    )
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

    // No-regression gate (ADR-277): the four conditions + the Sniper-targetable findings, from the same
    // base/head graphs. security is computed here (scanDiffGraphs over the two graphs), never an input;
    // the advisory lookup is the one I/O step, so a failure or advisories-off makes security `unknown`,
    // never pass. tests is an input via ctx.gate (absent => unknown). Additive to the rendered body.
    let securityDiff: SecurityDiff | null
    try {
      securityDiff = await scanDiffGraphs(baseGraph, headGraph, { base: req.baseSha, head: req.headSha })
    } catch {
      securityDiff = null
    }
    const affectedServices = new Set(
      changedFiles.map((id) => parseFileId(id)?.service).filter((s): s is string => Boolean(s)),
    ).size
    const gate = buildGateVerdict({
      introducedDivergences,
      securityDiff,
      observedBreaks,
      affectedFiles: changedFiles.length,
      affectedServices,
      gate: ctx.gate,
    })

    const { marker, body: rendered } = renderVerdict({
      graph: head,
      delta,
      changedFiles,
      divergences,
      observedBreaks,
      tone: req.tone ?? 'loud',
    })
    // The Action finds its own sticky comment by this marker. A hosted comment that carried it would be taken
    // for the Action's on a repo running both, and the two would overwrite each other. The caller stamps its
    // own marker; `marker` stays in the response so a caller can recognise an Action comment.
    const body = rendered.startsWith(marker) ? rendered.slice(marker.length).replace(/^(?:\r?\n)+/, '') : rendered
    return {
      marker,
      body,
      base: { sha: req.baseSha, nodes: baseGraph.order, edges: baseGraph.size },
      head: { sha: req.headSha, nodes: headGraph.order, edges: headGraph.size },
      changedFiles: changedFiles.length,
      observedBreaks: observedBreaks.length,
      divergences: divergences.length,
      newDivergences: introducedDivergences.length,
      gate,
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

// ── the no-regression gate verdict (ADR-277) ─────────────────────────────────

// The blast-radius ceiling when the caller configures none. Proposed defaults; the caller
// (the action's workflow, a host) overrides via GateInput.blastRadius.
const DEFAULT_BLAST_RADIUS = { maxFiles: 50, maxServices: 10 }

// Divergence types the gate counts for "no new divergence". missing-observed and
// missing-extracted are the declared-versus-observed edge family: over the EXTRACTED-only
// scratch graphs they fire for every declared edge as "not seen yet", so counting them would
// fail the gate on any PR that adds a call. They do not count; the remaining types (a new
// config mismatch, a compat violation, a host mismatch, ...) are real regressions.
const UNCOUNTED_DIVERGENCE_TYPES: ReadonlySet<string> = new Set(['missing-observed', 'missing-extracted'])

function sha256Hex(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex')
}

// A `file:line` or bare-`file` string into a repo-relative locus. Strips a leading slash and
// rejects a path with a `..` segment (Sniper rejects those at admission); null when unusable.
function parseLocusString(loc: string): GateFindingLocus | null {
  const m = /^(.*):(\d+)$/.exec(loc)
  const file = (m ? m[1]! : loc).replace(/^\/+/, '')
  if (file.length === 0 || file.split('/').includes('..')) return null
  return m ? { file, line: Number(m[2]) } : { file }
}

function divergenceFinding(d: Divergence): GateFinding {
  const provenance = 'provenance' in d && d.provenance ? d.provenance : Provenance.EXTRACTED
  const locus = 'location' in d && typeof d.location === 'string' ? parseLocusString(d.location) : null
  return {
    findingId: divergenceFindingId(d),
    kind: 'divergence',
    // The declaring side is the one an agent edits (the target is often an external entity).
    affectedNode: d.source,
    locus,
    provenance,
  }
}

function vulnerabilityFinding(entry: SecurityDiffEntry): GateFinding | null {
  const card = entry.after
  if (!card) return null
  const importer = card.reachability.importers[0]
  const locus: GateFindingLocus | null = importer
    ? { file: importer.file.replace(/^\/+/, ''), line: importer.line, ...(importer.symbol ? { symbol: importer.symbol } : {}) }
    : null
  const fixedIn =
    card.fix.action?.kind === 'bump-to-fixedIn' ? card.fix.action.to : (card.fix.fixedIn?.[0] ?? undefined)
  return {
    findingId: vulnerabilityFindingId({ advisoryId: entry.advisoryId, package: entry.package, version: card.dependency.version }),
    kind: 'vulnerability',
    // The importing service (the scope seed); the precise import site is in `locus`.
    affectedNode: serviceId(card.service),
    locus,
    provenance: card.reachability.observed.length > 0 ? Provenance.OBSERVED : Provenance.EXTRACTED,
    advisoryId: entry.advisoryId,
    ...(fixedIn ? { fixedIn } : {}),
  }
}

function observedBreakFinding(b: { id: string }): GateFinding {
  return {
    findingId: sha256Hex(`observed-break\u0000${b.id}`),
    kind: 'observed-break',
    affectedNode: b.id,
    locus: null,
    provenance: Provenance.OBSERVED,
  }
}

export interface GateVerdictInput {
  introducedDivergences: Divergence[]
  // null when the scan could not run at all; its `asOf` is null when advisories are off or unavailable.
  securityDiff: SecurityDiff | null
  observedBreaks: Array<{ id: string }>
  affectedFiles: number
  affectedServices: number
  gate?: GateInput
}

/**
 * Assemble the four tri-state conditions and the parallel findings list (ADR-277). A condition
 * that cannot be evaluated is `unknown`, and `passed` is true only when all four are `pass`
 * (fail-closed). observed-break findings ride the list but never affect a condition or `passed`.
 */
export function buildGateVerdict(input: GateVerdictInput): NoRegressionGateVerdict {
  const ceiling = input.gate?.blastRadius ?? DEFAULT_BLAST_RADIUS
  const counted = input.introducedDivergences.filter((d) => !UNCOUNTED_DIVERGENCE_TYPES.has(d.type))
  const introducedVulns = input.securityDiff?.introduced ?? []

  const blastRadius: GateCondition = {
    name: 'blast-radius',
    status: input.affectedFiles <= ceiling.maxFiles && input.affectedServices <= ceiling.maxServices ? 'pass' : 'fail',
    detail: `${input.affectedFiles} file(s), ${input.affectedServices} service(s) (ceiling ${ceiling.maxFiles}/${ceiling.maxServices})`,
  }
  const tests: GateCondition = {
    name: 'tests',
    status: input.gate?.tests ?? 'unknown',
    detail: input.gate?.tests ? `test suite: ${input.gate.tests}` : 'no test outcome provided',
  }
  const noNewDivergence: GateCondition = {
    name: 'no-new-divergence',
    status: counted.length === 0 ? 'pass' : 'fail',
    detail: counted.length === 0 ? 'no new divergence' : `${counted.length} new divergence(s)`,
  }
  let security: GateCondition
  if (!input.securityDiff || input.securityDiff.asOf === null) {
    security = {
      name: 'security',
      status: 'unknown',
      detail: input.securityDiff?.advisories === 'disabled' ? 'advisories disabled' : 'advisory lookup unavailable',
    }
  } else {
    security = {
      name: 'security',
      status: introducedVulns.length === 0 ? 'pass' : 'fail',
      detail:
        introducedVulns.length === 0
          ? 'no known vulnerability introduced'
          : `${introducedVulns.length} known vulnerabilit${introducedVulns.length === 1 ? 'y' : 'ies'} introduced`,
    }
  }

  const conditions = [blastRadius, tests, noNewDivergence, security]
  const findings: GateFinding[] = [
    ...counted.map(divergenceFinding),
    ...introducedVulns.map(vulnerabilityFinding).filter((f): f is GateFinding => f !== null),
    ...input.observedBreaks.map(observedBreakFinding),
  ]
  return { conditions, findings, passed: conditions.every((c) => c.status === 'pass') }
}

// ── the no-regression gate over two checkouts, for the CI path (ADR-277) ──────
//
// The hosted verdict (computePrVerdict) assembles the gate from the base and head
// graphs it already extracts. The action has no host in CI, so the hidden `neat
// gate` verb does the same assembly from two checkouts on disk. This is that
// assembly, factored out so the two paths compute one gate the same way.

export interface GateCheckoutsDeps {
  extract?: typeof extractFromDirectory
  scanDiff?: typeof scanDiffGraphs
}

export interface GateCheckoutsInput {
  // The PR's base commit and its head commit, each checked out on disk. The caller
  // gives them the same leaf directory name, so a package.json with no name is the
  // same service on both sides (#1557) rather than one removed and one added.
  baseDir: string
  headDir: string
  // Names the extraction source. Cosmetic here (the graphs are scratch), kept so a
  // nameless package resolves to the same service name on both sides.
  source?: string
  // What the gate can't read from the two graphs: the test outcome (absent => the
  // tests condition is unknown) and the blast-radius ceiling.
  gate?: GateInput
  deps?: GateCheckoutsDeps
}

/**
 * The no-regression gate verdict (ADR-277) for a pull request, computed from two checkouts: extract the
 * base and the head into scratch graphs and assemble the four conditions and the findings exactly as the
 * hosted verdict does, minus the live OBSERVED graph. A CI run has no connected daemon, so observed
 * breaks are empty here. A runtime break is a Sniper target found on the hosted path, never a gate
 * condition. Security is the one network step (the advisory lookup); a failure leaves it `unknown`, never
 * pass. Nothing is persisted: both graphs are scratch and dropped when the process exits.
 */
export async function gateFromCheckouts(input: GateCheckoutsInput): Promise<NoRegressionGateVerdict> {
  const extract = input.deps?.extract ?? extractFromDirectory
  const scanDiff = input.deps?.scanDiff ?? scanDiffGraphs
  const extractOpts = { source: input.source ?? 'pr-gate', announce: false }

  const baseGraph = makeGraph()
  const headGraph = makeGraph()
  await extract(baseGraph, input.baseDir, extractOpts)
  await extract(headGraph, input.headDir, extractOpts)

  const head = graphFromExport(headGraph.export())
  const introducedDivergences = newDivergences(
    computeDivergences(baseGraph).divergences,
    computeDivergences(headGraph).divergences,
  )
  const changedPaths = await changedPathsBetween(input.baseDir, input.headDir)
  const changedFiles = changedFileNodeIds(head, changedPaths)
  const affectedServices = new Set(
    changedFiles.map((id) => parseFileId(id)?.service).filter((s): s is string => Boolean(s)),
  ).size

  // The advisory lookup is the one I/O step; a failure or advisories-off makes the
  // security condition `unknown` (via buildGateVerdict), never a silent pass.
  let securityDiff: SecurityDiff | null
  try {
    securityDiff = await scanDiff(baseGraph, headGraph, { base: 'base', head: 'head' })
  } catch {
    securityDiff = null
  }

  return buildGateVerdict({
    introducedDivergences,
    securityDiff,
    observedBreaks: [],
    affectedFiles: changedFiles.length,
    affectedServices,
    gate: input.gate,
  })
}
