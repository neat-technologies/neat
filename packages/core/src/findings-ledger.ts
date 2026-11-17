// The findings ledger (ADR-279, docs/contracts/finding-triggers.md).
//
// A divergence and a reachable vulnerability are queries: computed from the graph
// on request, persisting nothing (ADR-060). What neither query can reproduce is
// that a finding was first present at a commit at a time. This module records
// that fact, one source-free row per (findingId, sha) in
// `<project>/neat-out/findings.ndjson`, and emits it as the `finding` bus event.
//
// It reads the graph through the pure queries (computeDivergences, the security
// scan) and writes only the ledger. It never mutates the graph.
//
// Everything here fails closed. A finding is recorded only against a commit the
// daemon can be sure of: the affected node has exactly one recorded declarer, and
// that repository's source baseline is `ready` at the same commit before and
// after the evaluation read the graph. Anything short of that records nothing,
// and the finding is recorded at a later evaluation once it holds.

import { createHash } from 'node:crypto'
import { promises as fs, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  FindingRowSchema,
  Provenance,
  serviceId,
  type Divergence,
  type FindingClearedRow,
  type FindingEventPayload,
  type FindingKind,
  type FindingPresentRow,
  type FindingRow,
  type SecurityCard,
  type SecurityScanResult,
} from '@neat.is/types'
import type { NeatGraph } from './graph.js'
import { EVENT_BUS_CHANNEL, emitNeatEvent, eventBus, type NeatEventEnvelope } from './events.js'
import { appendLedgerRecords } from './ledger-write.js'
import { SIDECAR_URL } from './durable-incident.js'
import { readSourceBaselines } from './extract/source-baseline.js'
import { computeDivergences, divergenceIdentity } from './divergences.js'
import { scanProjectCves } from './security-scan.js'

/** The bound of contract §3: the incident stream's. */
export const FINDINGS_MAX_BYTES = 16 * 1024 * 1024
export const FINDINGS_MAX_ROWS = 10_000

/** How long the loop waits after a trigger before it evaluates. A burst collapses into one evaluation. */
export const DEFAULT_FINDINGS_DEBOUNCE_MS = 1000

// ── identity (contract §2) ──────────────────────────────────────────────────
//
// One derivation serves the no-regression gate (pr-verdict.ts, ADR-277) and this
// ledger, so the id a pull request gate reports for a finding is the id the
// ledger records for the same finding on the live graph.

function sha256Hex(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex')
}

/** `sha256("divergence\0" + divergenceIdentity)`. */
export function divergenceFindingId(d: Divergence): string {
  return sha256Hex(`divergence\u0000${divergenceIdentity(d)}`)
}

/** The gate's vulnerability finding id: the advisory, the package name and the installed version. */
export function vulnerabilityFindingId(v: { advisoryId: string; package: string; version: string }): string {
  return sha256Hex(`vulnerability\u0000${v.advisoryId}\u0000${v.package}\u0000${v.version}`)
}

/** The gate's finding id for a security card. */
export function securityCardFindingId(card: SecurityCard): string {
  return vulnerabilityFindingId({
    advisoryId: card.advisory.id,
    package: card.dependency.name,
    version: card.dependency.version,
  })
}

// ── the ledger file ─────────────────────────────────────────────────────────

export class FindingsLedgerError extends Error {
  constructor(message = 'findings ledger unavailable') {
    super(message)
    this.name = 'FindingsLedgerError'
  }
}

// A finding the ledger currently records as present, for one repository.
interface OpenFinding {
  findingId: string
  kind: FindingKind
  repository: string
  // The commit of its latest row, and every commit recorded during this presence.
  sha: string
  shas: Set<string>
  // Its presence began as a baseline row, so nothing about it leaves the daemon
  // until it clears and comes back.
  baseline: boolean
  // Index of its latest row. Dropping that row would lose that it is present.
  latestIndex: number
}

export interface FindingsLedgerState {
  rows: FindingRow[]
  bytes: number
  open: Map<string, OpenFinding>
  /** The rows the trigger stream serves, in ledger order. */
  served: FindingEventPayload[]
}

function openKey(findingId: string, repository: string): string {
  return `${findingId}\u0000${repository}`
}

function isCleared(row: FindingRow): row is FindingClearedRow {
  return 'cleared' in row
}

function isBaseline(row: FindingRow): boolean {
  return 'baseline' in row
}

/**
 * Replay ledger text into what is present now and what the stream serves. Throws
 * FindingsLedgerError on anything it cannot read exactly: a line that is not
 * JSON, a row with a field outside the contract's list, a last line with no
 * newline.
 */
export function parseFindingsLedger(text: string): FindingsLedgerState {
  if (text.length > 0 && !text.endsWith('\n')) throw new FindingsLedgerError()
  const state: FindingsLedgerState = { rows: [], bytes: Buffer.byteLength(text, 'utf8'), open: new Map(), served: [] }
  for (const line of text.split('\n')) {
    if (!line) continue
    let row: FindingRow
    try {
      row = FindingRowSchema.parse(JSON.parse(line))
    } catch {
      throw new FindingsLedgerError()
    }
    const index = state.rows.length
    state.rows.push(row)
    if (isCleared(row)) {
      // Closes the presence it names. A cleared row whose presence is not in the
      // ledger is kept and not served: there is no telling whether the presence
      // was a baseline one.
      for (const [key, entry] of state.open) {
        if (entry.findingId !== row.findingId || !entry.shas.has(row.sha)) continue
        state.open.delete(key)
        if (!entry.baseline) state.served.push(row)
      }
      continue
    }
    const key = openKey(row.findingId, row.repository)
    const entry = state.open.get(key)
    if (entry) {
      // The same key twice within one presence is one fact; it is served once.
      if (entry.shas.has(row.sha)) continue
      entry.shas.add(row.sha)
      entry.sha = row.sha
      entry.latestIndex = index
      entry.baseline = isBaseline(row)
    } else {
      state.open.set(key, {
        findingId: row.findingId,
        kind: row.kind,
        repository: row.repository,
        sha: row.sha,
        shas: new Set([row.sha]),
        baseline: isBaseline(row),
        latestIndex: index,
      })
    }
    if (!isBaseline(row)) state.served.push(row as FindingPresentRow)
  }
  return state
}

/** The stream's event id for a row: `<findingId>:<sha>`. */
export function findingEventId(row: { findingId: string; sha: string }): string {
  return `${row.findingId}:${row.sha}`
}

const CURSOR = /^[0-9a-f]{64}:[0-9a-f]{40}$/

/**
 * Read the ledger before a trigger stream opens (contract §6). Returns the rows
 * to replay: every served row, or those after the exact cursor. A missing,
 * corrupt or over-bound ledger and an unknown cursor all refuse, the same way.
 *
 * A finding that clears and returns at one commit has two rows with one id. The
 * cursor resolves to the first of them, so a reader is sent a row again rather
 * than never sent one.
 */
export function loadFindingReplay(findingsPath: string, cursor?: string): FindingEventPayload[] {
  if (cursor !== undefined && !CURSOR.test(cursor)) throw new FindingsLedgerError('finding replay unavailable')
  try {
    if (statSync(findingsPath).size > FINDINGS_MAX_BYTES) throw new FindingsLedgerError()
    const state = parseFindingsLedger(readFileSync(findingsPath, 'utf8'))
    if (state.rows.length > FINDINGS_MAX_ROWS) throw new FindingsLedgerError()
    if (cursor === undefined) return state.served
    const at = state.served.findIndex((row) => findingEventId(row) === cursor)
    if (at < 0) throw new FindingsLedgerError()
    return state.served.slice(at + 1)
  } catch {
    throw new FindingsLedgerError('finding replay unavailable')
  }
}

// ── what qualifies, and against which commit (contract §1, §2) ──────────────

/** A qualifying finding in the graph right now, before it is tied to a commit. */
export interface FindingCandidate {
  findingId: string
  kind: FindingKind
  affectedNode: string
  divergenceType?: Divergence['type']
  advisoryId?: string
}

/**
 * Every divergence computeDivergences returns with its default options. The
 * affected node is the declaring side, as the gate has it.
 */
export function divergenceCandidates(graph: NeatGraph): FindingCandidate[] {
  return computeDivergences(graph).divergences.map((d) => ({
    findingId: divergenceFindingId(d),
    kind: 'divergence' as const,
    affectedNode: d.source,
    divergenceType: d.type,
  }))
}

/** The cards that qualify: `reachable-static` and `reachable-observed`. `imported` and `present` do not. */
export function vulnerabilityCandidates(scan: Pick<SecurityScanResult, 'findings'>): FindingCandidate[] {
  return scan.findings
    .filter((c) => c.reachability.level === 'reachable-static' || c.reachability.level === 'reachable-observed')
    .map((c) => ({
      findingId: securityCardFindingId(c),
      kind: 'vulnerability' as const,
      affectedNode: serviceId(c.service),
      advisoryId: c.advisory.id,
    }))
}

/**
 * The repository that declares a node, or null when that cannot be said for
 * sure: the node is not in the graph, it has no recorded declarer (a
 * runtime-only node, a snapshot older than v10, a pass that named no source), or
 * more than one repository declares it.
 */
export function declaringRepository(graph: NeatGraph, nodeId: string): string | null {
  if (!graph.hasNode(nodeId)) return null
  const declaredBy = (graph.getNodeAttributes(nodeId) as { declaredBy?: string[] }).declaredBy
  if (!Array.isArray(declaredBy) || declaredBy.length !== 1) return null
  return declaredBy[0] ?? null
}

interface BaselineRead {
  ready: Map<string, string>
  syncing: boolean
}

// The live graph's baselines. It is built from each bound repository's default
// branch, so a `ready` entry here is the default-branch commit (ADR-279 (c)). A
// ref view has its own graph and its own entries, and is never evaluated.
function readBaselines(graph: NeatGraph): BaselineRead {
  const ready = new Map<string, string>()
  let syncing = false
  for (const b of readSourceBaselines(graph)) {
    if (b.status === 'syncing') syncing = true
    if (b.status === 'ready' && b.state !== 'worktree') ready.set(b.repository, b.sha)
  }
  return { ready, syncing }
}

// ── evaluation (contract §3, §4) ────────────────────────────────────────────

export interface DurableFindingOptions {
  /** The hosted sidecar's append token. Defaults to NEAT_INCIDENT_DURABLE_TOKEN; unset means a local daemon. */
  token?: string
  fetchImpl?: typeof fetch
}

/** What one evaluator instance remembers between evaluations. Never persisted. */
export interface FindingsMemory {
  // Findings that were present when the ledger was created but got no row then:
  // they could not be tied to a commit, or the ledger had no room. They were
  // there before the ledger, so their first row is a baseline row too.
  deferredBaseline: Set<string>
}

export function createFindingsMemory(): FindingsMemory {
  return { deferredBaseline: new Set() }
}

export interface EvaluateFindingsInput {
  project: string
  graph: NeatGraph
  findingsPath: string
  /** The security scan. Defaults to scanProjectCves on the live graph. */
  scan?: (graph: NeatGraph) => Promise<SecurityScanResult>
  now?: () => number
  durable?: DurableFindingOptions
  memory?: FindingsMemory
  /** True once the caller has shut down: an evaluation still running then writes and emits nothing more. */
  stopped?: () => boolean
}

export interface EvaluateFindingsResult {
  // 'waiting': no ledger yet and no settled baseline to create it against.
  // 'unreadable': the ledger on disk could not be read exactly; nothing was written.
  status: 'evaluated' | 'created' | 'waiting' | 'unreadable'
  /** Rows appended by this evaluation, in order. */
  appended: FindingRow[]
  /** The rows among them that were emitted as `finding` events. */
  emitted: FindingEventPayload[]
  /** Rows dropped at the bound. */
  dropped: number
  /** Rows that did not fit even after dropping, and were left for a later evaluation. */
  deferred: number
}

interface Recordable extends FindingCandidate {
  repository: string
  sha: string
}

// On a hosted daemon the sidecar commits a row to the archive before the row is
// appended locally and before its event is emitted. A commit that does not
// succeed fails the write with no local fallback (the incident path's rule). A
// local daemon has no sidecar and this does nothing.
async function commitToSidecar(
  project: string,
  row: FindingRow,
  durable: DurableFindingOptions | undefined,
): Promise<void> {
  const token = durable?.token ?? process.env.NEAT_INCIDENT_DURABLE_TOKEN
  if (token === undefined) return
  if (Buffer.byteLength(token, 'utf8') < 32) throw new Error('durable finding sink unavailable')
  const response = await (durable?.fetchImpl ?? fetch)(`${SIDECAR_URL}/finding-append`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ project, row }),
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status !== 204) throw new Error('durable finding sink unavailable')
}

function lineBytes(row: FindingRow): number {
  return Buffer.byteLength(JSON.stringify(row), 'utf8') + 1
}

// Make room for `incoming` rows (contract §3, "Bound"). The rows of the oldest
// commits go first, a whole commit at a time, oldest by where the commit first
// appears in the ledger. The one row that says a finding is present now is never
// dropped, however old its commit: losing it would make the finding look new at
// the next evaluation. Returns the rows to keep and how many of `incoming` fit.
function fitToBound(state: FindingsLedgerState, incoming: FindingRow[]): { keep: FindingRow[]; fit: number } {
  const rows = state.rows
  let count = rows.length + incoming.length
  let bytes = state.bytes + incoming.reduce((n, r) => n + lineBytes(r), 0)
  if (count <= FINDINGS_MAX_ROWS && bytes <= FINDINGS_MAX_BYTES) return { keep: rows, fit: incoming.length }
  // Over: count what a rewrite would hold, which is each row as this module writes it.
  bytes = rows.reduce((n, r) => n + lineBytes(r), 0) + incoming.reduce((n, r) => n + lineBytes(r), 0)

  const pinned = new Set<number>()
  for (const entry of state.open.values()) pinned.add(entry.latestIndex)
  const commits: string[] = []
  const byCommit = new Map<string, number[]>()
  rows.forEach((row, i) => {
    let list = byCommit.get(row.sha)
    if (!list) {
      list = []
      byCommit.set(row.sha, list)
      commits.push(row.sha)
    }
    if (!pinned.has(i)) list.push(i)
  })
  const drop = new Set<number>()
  for (const sha of commits) {
    if (count <= FINDINGS_MAX_ROWS && bytes <= FINDINGS_MAX_BYTES) break
    for (const i of byCommit.get(sha)!) {
      drop.add(i)
      count--
      bytes -= lineBytes(rows[i]!)
    }
  }
  // Still over: every row left says a finding is present now. New rows wait.
  let fit = incoming.length
  while (fit > 0 && (count > FINDINGS_MAX_ROWS || bytes > FINDINGS_MAX_BYTES)) {
    fit--
    count--
    bytes -= lineBytes(incoming[fit]!)
  }
  return { keep: rows.filter((_, i) => !drop.has(i)), fit }
}

// Replace the ledger with `rows`, written through the scrubbing writer to a
// temp file and renamed over it, so a crash leaves the old ledger in place.
async function rewriteLedger(findingsPath: string, rows: FindingRow[]): Promise<void> {
  const tmp = `${findingsPath}.compact-${process.pid}.tmp`
  await fs.rm(tmp, { force: true })
  await fs.mkdir(path.dirname(findingsPath), { recursive: true })
  await fs.writeFile(tmp, '', 'utf8')
  await appendLedgerRecords(tmp, rows)
  await fs.rename(tmp, findingsPath)
}

async function readLedgerText(findingsPath: string): Promise<string | null> {
  try {
    return await fs.readFile(findingsPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * One evaluation: read what qualifies now, compare it with the ledger, append
 * what changed and emit it. Exposed for tests; the daemon runs it through
 * startFindingsLoop.
 */
export async function evaluateFindings(input: EvaluateFindingsInput): Promise<EvaluateFindingsResult> {
  const { graph, findingsPath, project } = input
  const now = input.now ?? Date.now
  const memory = input.memory ?? createFindingsMemory()
  const result: EvaluateFindingsResult = { status: 'evaluated', appended: [], emitted: [], dropped: 0, deferred: 0 }

  // The scan is the one step that waits (the advisory cache). The baselines are
  // read on both sides of it, and a repository counts as ready only when both
  // reads agree, so a pass that ran in between cannot lend its commit to cards
  // composed before it.
  const before = readBaselines(graph)
  let scan: SecurityScanResult | null = null
  // With no ready baseline nothing can be recorded or cleared, so the scan (and
  // the advisory lookup behind it) is not run at all. A local project with no
  // commit never runs it from here.
  if (before.ready.size > 0) {
    try {
      scan = await (input.scan ?? ((g: NeatGraph) => scanProjectCves(g)))(graph)
    } catch {
      scan = null
    }
  }
  const after = readBaselines(graph)
  const ready = new Map<string, string>()
  for (const [repository, sha] of after.ready) if (before.ready.get(repository) === sha) ready.set(repository, sha)
  const syncing = before.syncing || after.syncing
  // Vulnerabilities are known absent only on a clean, complete lookup. With
  // advisories off, the feed down or part of the snapshot stale, a missing card
  // says nothing, so no vulnerability is cleared on it.
  const scanComplete = scan !== null && scan.asOf !== null && scan.errors.length === 0 && scan.stale === 0

  const candidates = [...divergenceCandidates(graph), ...(scan ? vulnerabilityCandidates(scan) : [])].sort(
    (a, b) => (a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : a.affectedNode < b.affectedNode ? -1 : a.affectedNode > b.affectedNode ? 1 : 0),
  )
  const recordable = new Map<string, Recordable>()
  const unrecordable = new Set<string>()
  for (const c of candidates) {
    const repository = declaringRepository(graph, c.affectedNode)
    const sha = repository === null ? undefined : ready.get(repository)
    if (repository === null || sha === undefined) {
      unrecordable.add(c.findingId)
      continue
    }
    const key = openKey(c.findingId, repository)
    if (!recordable.has(key)) recordable.set(key, { ...c, repository, sha })
  }

  const text = await readLedgerText(findingsPath)
  let state: FindingsLedgerState
  let creating = false
  if (text === null) {
    // The ledger starts at the first evaluation that has a settled baseline to
    // record against. Starting it earlier (a hosted daemon before its first repo
    // sync, a pass in flight) would spend the baseline evaluation on a graph
    // whose findings cannot be recorded yet.
    if (ready.size === 0 || syncing) return { ...result, status: 'waiting' }
    creating = true
    state = parseFindingsLedger('')
  } else {
    try {
      state = parseFindingsLedger(text)
    } catch {
      return { ...result, status: 'unreadable' }
    }
  }

  const at = new Date(now()).toISOString()
  const incoming: Array<{ row: FindingRow; emit: boolean }> = []

  // Cleared: recorded as present, absent now. Only where absence is certain: the
  // finding is nowhere in this evaluation, and its repository is at a settled
  // commit (a pass in flight rewrites nodes, and a finding missing halfway
  // through one is not gone).
  for (const [key, entry] of state.open) {
    if (recordable.has(key) || unrecordable.has(entry.findingId)) continue
    if (!ready.has(entry.repository)) continue
    if (entry.kind === 'vulnerability' && !scanComplete) continue
    incoming.push({
      row: { findingId: entry.findingId, kind: entry.kind, sha: entry.sha, clearedAt: at, cleared: true },
      emit: !entry.baseline,
    })
  }

  for (const [key, c] of recordable) {
    const entry = state.open.get(key)
    // Already recorded at this commit during this presence.
    if (entry?.shas.has(c.sha)) continue
    // A baseline row: the finding was there when the ledger started. That holds
    // at later commits too, until it clears. A finding that was never a trigger
    // does not become one because its repository got a new commit.
    const baseline = creating || (entry ? entry.baseline : memory.deferredBaseline.has(c.findingId))
    const row: FindingPresentRow = {
      findingId: c.findingId,
      kind: c.kind,
      affectedNode: c.affectedNode,
      repository: c.repository,
      sha: c.sha,
      firstSeenAt: at,
      ...(c.divergenceType ? { divergenceType: c.divergenceType } : {}),
      ...(c.advisoryId ? { advisoryId: c.advisoryId } : {}),
    }
    const parsed = FindingRowSchema.safeParse(baseline ? { ...row, baseline: true } : row)
    // A row that does not fit the contract's shape (an over-long node id, an
    // advisory id outside the bounded alphabet) is not written.
    if (!parsed.success) continue
    incoming.push({ row: parsed.data, emit: !baseline })
  }

  const rows = incoming.map((i) => i.row)
  const { keep, fit } = fitToBound(state, rows)
  result.dropped = state.rows.length - keep.length
  result.deferred = incoming.length - fit
  const stopped = input.stopped ?? (() => false)

  // What was present before the ledger and has no row yet stays a baseline
  // finding for as long as it is present.
  const present = new Set(candidates.map((c) => c.findingId))
  for (const id of [...memory.deferredBaseline]) if (!present.has(id)) memory.deferredBaseline.delete(id)

  if (creating) {
    // The baseline evaluation. Every row is a baseline row, and the ledger
    // appears with all of them or not at all: a ledger holding half of them
    // would read the other half as new at the next evaluation.
    const baseline = rows.slice(0, fit)
    for (const row of baseline) {
      if (stopped()) return { ...result, status: 'waiting', dropped: 0, deferred: 0 }
      await commitToSidecar(project, row, input.durable)
    }
    await rewriteLedger(findingsPath, baseline)
    for (const id of unrecordable) memory.deferredBaseline.add(id)
    for (const row of rows.slice(fit)) memory.deferredBaseline.add(row.findingId)
    return { ...result, status: 'created', appended: baseline }
  }

  if (result.dropped > 0 && !stopped()) await rewriteLedger(findingsPath, keep)
  for (const { row, emit } of incoming.slice(0, fit)) {
    if (stopped()) break
    await commitToSidecar(project, row, input.durable)
    await appendLedgerRecords(findingsPath, [row])
    result.appended.push(row)
    memory.deferredBaseline.delete(row.findingId)
    if (!emit) continue
    const payload = row as FindingEventPayload
    emitNeatEvent({ type: 'finding', project, payload })
    result.emitted.push(payload)
  }
  return result
}

// ── the loop (contract §4) ──────────────────────────────────────────────────

export interface FindingsLoopInput extends Omit<EvaluateFindingsInput, 'memory'> {
  debounceMs?: number
  onEvaluated?: (r: EvaluateFindingsResult) => void
  onError?: (err: Error) => void
}

export interface FindingsLoopHandle {
  /** Ask for an evaluation. A burst of calls collapses into one. */
  schedule: () => void
  /** Evaluate now, or join the evaluation already running. */
  flush: () => Promise<void>
  stop: () => void
}

/**
 * Start evaluating one project's findings. An evaluation is scheduled after an
 * `extraction-complete`, a `stale-transition` and an OBSERVED `edge-added` for
 * this project on the bus, and whenever the caller asks (the dependency loop's
 * tick, a repo sync's pass), debounced. One evaluation runs at a time; a trigger
 * that lands during one runs a single trailing evaluation.
 */
export function startFindingsLoop(input: FindingsLoopInput): FindingsLoopHandle {
  const debounceMs = input.debounceMs ?? DEFAULT_FINDINGS_DEBOUNCE_MS
  const memory = createFindingsMemory()
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  let pending = false
  let stopped = false

  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  const run = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (running) {
      pending = true
      return running
    }
    running = (async () => {
      try {
        const r = await evaluateFindings({ ...input, memory, stopped: () => stopped })
        if (!stopped) input.onEvaluated?.(r)
      } catch (err) {
        if (!stopped) input.onError?.(err as Error)
      } finally {
        running = null
        if (pending && !stopped) {
          pending = false
          schedule()
        }
      }
    })()
    return running
  }
  const schedule = (): void => {
    if (stopped) return
    cancel()
    timer = setTimeout(() => {
      timer = null
      void run()
    }, debounceMs)
    timer.unref?.()
  }

  const listener = (envelope: NeatEventEnvelope): void => {
    if (envelope.project !== input.project) return
    if (envelope.type === 'extraction-complete' || envelope.type === 'stale-transition') schedule()
    else if (envelope.type === 'edge-added') {
      const edge = (envelope as NeatEventEnvelope<'edge-added'>).payload.edge
      if (edge.provenance === Provenance.OBSERVED) schedule()
    }
  }
  eventBus.on(EVENT_BUS_CHANNEL, listener)
  // The slot's boot extraction has already run by the time the loop starts.
  schedule()

  return {
    schedule,
    flush: async () => {
      cancel()
      await run()
    },
    stop: () => {
      stopped = true
      cancel()
      eventBus.off(EVENT_BUS_CHANNEL, listener)
    },
  }
}
