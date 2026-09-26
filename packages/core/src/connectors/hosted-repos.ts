// Hosted-profile repo source for the "add your repos" track (connectors.md §3a, INFRA-ADR-011, #19).
//
// The local daemon extracts its mounted /workspace. The hosted daemon has no mount — the code it should
// graph is the set of GitHub repos the customer bound to this project through the hosted GitHub App. This
// module is the daemon's side of that: it asks the control plane which repos are bound
// (GET /internal/projects/:id/repos), shallow-clones each with the short-lived GitHub App installation
// token the CP hands back in the clone URL, extracts the working tree into the project graph (the SAME
// extractFromDirectory the local /workspace path runs — never a hosted fork, per hosted-platform.md), and
// reports the outcome back so the dashboard's RepoStatus reflects reality.
//
// Same hosted-profile discipline as connectors/hosted.ts (its sibling): the credential is CP-brokered,
// short-lived, used within the call, never written to disk or the snapshot, and never logged. Delivery
// auth is the project auth token the daemon was provisioned with (NEAT_AUTH_TOKEN) — the CP verifies it
// against the project's sealed auth envelope, exactly as it does the connector /internal routes.

import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import type { NeatGraph } from '../graph.js'
import { extractFromDirectory } from '../extract.js'

// Mirror of the CP's repo-delivery shape (INFRA-ADR-011 repo half). Kept structural here so neat-core takes
// no dependency on the CP package — the same stance connectors/hosted.ts takes on DeliveredCredential.
interface RepoToSync {
  owner: string
  name: string
  /** The branch to clone; the CP resolves it from the installation. Optional — absent means clone the
   *  repository's own default branch. */
  defaultBranch?: string
  /** `https://x-access-token:<installationToken>@github.com/owner/name.git` — token minted per pull,
   *  short-lived. Never logged. */
  cloneUrl: string
  expiresAt?: string | null
  /** The CP's current status for the repo. The daemon syncs the ones still awaiting a pass ('syncing'); a
   *  terminal 'synced'/'failed' is left alone until the CP re-queues it (bind / push / resync flips it back
   *  to 'syncing'). Absent (an older CP that doesn't send it) is treated as "sync it". */
  syncStatus?: string
}

export interface HostedRepoSyncDeps {
  /** Control-plane base URL (NEAT_CP_URL). The daemon calls its `/internal` repo routes here. */
  cpUrl: string
  /** The control-plane project id (`prj_…`, NEAT_CP_PROJECT_ID) these repos belong to. */
  projectId: string
  /** The project auth token the daemon was provisioned with (NEAT_AUTH_TOKEN). Never logged. */
  daemonToken: string
  fetchImpl?: typeof fetch
}

/** Cap a CP call so a slow control plane can't stall the sync loop. */
const CP_REQUEST_TIMEOUT_MS = 10_000
/** Re-pull the bound-repo list on this cadence; the CP's `syncStatus` gates which actually re-clone. */
const DEFAULT_SYNC_INTERVAL_MS = 5 * 60_000
/** A single clone can't run forever — a wedged clone must not hold the pass open. */
const CLONE_TIMEOUT_MS = 5 * 60_000

/** Replace an inline `x-access-token:<token>@` so a clone URL never reaches a log or the CP verbatim. */
function scrubToken(s: string): string {
  return s.replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@')
}

async function cpGet<T>(pathname: string, deps: HostedRepoSyncDeps): Promise<T> {
  const f = deps.fetchImpl ?? fetch
  const res = await f(`${deps.cpUrl.replace(/\/+$/, '')}${pathname}`, {
    headers: { authorization: `Bearer ${deps.daemonToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(CP_REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`control plane ${pathname} → HTTP ${res.status}`)
  return (await res.json()) as T
}

interface StatusUpdate {
  syncStatus: 'synced' | 'failed'
  detail?: string
  lastSyncAt?: string
}

async function cpPostStatus(
  deps: HostedRepoSyncDeps,
  owner: string,
  name: string,
  body: StatusUpdate,
): Promise<void> {
  const f = deps.fetchImpl ?? fetch
  const url =
    `${deps.cpUrl.replace(/\/+$/, '')}/internal/projects/${deps.projectId}` +
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/status`
  const res = await f(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${deps.daemonToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CP_REQUEST_TIMEOUT_MS),
  })
  // A 404 means the binding is gone (the repo was unbound mid-sync) — a stale report is a no-op, not a
  // failure worth reporting back or retrying.
  if (!res.ok && res.status !== 404) throw new Error(`control plane status POST → HTTP ${res.status}`)
}

/**
 * Clone seam. The default uses isomorphic-git — a pure-JS shallow clone, so the daemon image needs no `git`
 * binary and the token never reaches a process argv. It's `import()`ed lazily inside the default so it stays
 * out of the CLI's startup path (only the hosted daemon ever calls it). Injected in tests, so no pass ever
 * touches the network or isomorphic-git. Never logs the URL (it carries the installation token).
 */
export type CloneRepo = (cloneUrl: string, ref: string | undefined, destDir: string) => Promise<void>

const defaultCloneRepo: CloneRepo = async (cloneUrl, ref, destDir) => {
  const [{ default: git }, httpMod, fs] = await Promise.all([
    import('isomorphic-git'),
    import('isomorphic-git/http/node'),
    import('node:fs'),
  ])
  const http = (httpMod as { default?: unknown }).default ?? httpMod
  // The CP delivers the token in the URL userinfo (x-access-token:<token>@github.com). Lift it out and pass
  // it via onAuth so isomorphic-git authenticates without the token surviving in the recorded remote URL.
  const parsed = new URL(cloneUrl)
  const password = parsed.password || parsed.username
  const username = parsed.password ? parsed.username : 'x-access-token'
  const cleanUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  const clone = git.clone({
    fs,
    http: http as never,
    dir: destDir,
    url: cleanUrl,
    // Absent ref → isomorphic-git clones the remote's default branch.
    ...(ref ? { ref } : {}),
    singleBranch: true,
    depth: 1,
    onAuth: () => ({ username, password }),
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`clone timed out after ${CLONE_TIMEOUT_MS}ms`)), CLONE_TIMEOUT_MS)
  })
  try {
    await Promise.race([clone, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface RepoSyncInput {
  deps: HostedRepoSyncDeps
  graph: NeatGraph
  /** The daemon's project name — for log lines only; the graph is the slot's own. */
  project: string
  /** Test seam: the clone impl (defaults to system git). */
  cloneRepo?: CloneRepo
  /** Test seam: the extractor (defaults to extractFromDirectory). */
  extract?: typeof extractFromDirectory
  /** How often to re-pull the bound-repo list (default 5 min). */
  intervalMs?: number
  /** Root under which each pass mkdtemp's a fresh clone dir (default os.tmpdir()). */
  tmpRoot?: string
  onSkip?: (repo: string, reason: string) => void
  onError?: (repo: string, err: Error) => void
  /** Test seam for the reported lastSyncAt. */
  now?: () => number
}

/**
 * True when a repo still needs a sync pass. 'synced'/'failed' are terminal until the CP re-queues them; an
 * absent status (an older CP that doesn't send one) is synced so the daemon still works against it.
 *
 * `syncAll` forces a sync regardless of status. The first pass after boot sets it, because a fresh process
 * on Cloud Run starts with an empty on-disk graph (#1215): the CP's `synced` describes a past instance that
 * held the code, not this one. Without the override the daemon would read `synced`, skip the repo, and show
 * 0 nodes forever after any redeploy/crash/scale-to-zero. Later passes leave it false so the CP re-queue
 * (bind / push / resync) stays the way to force a refresh.
 */
function needsSync(r: RepoToSync, syncAll: boolean): boolean {
  return syncAll || r.syncStatus === undefined || r.syncStatus === 'syncing'
}

async function syncOneRepo(r: RepoToSync, input: RepoSyncInput): Promise<void> {
  const { deps, graph } = input
  const cloneRepo = input.cloneRepo ?? defaultCloneRepo
  const extract = input.extract ?? extractFromDirectory
  const label = `${r.owner}/${r.name}`
  const tmpRoot = input.tmpRoot ?? os.tmpdir()
  let dir: string | undefined
  try {
    dir = await mkdtemp(path.join(tmpRoot, 'neat-repo-'))
    await cloneRepo(r.cloneUrl, r.defaultBranch, dir)
    // Extraction merges into the slot's live graph by scanPath-relative path, so a fresh clone dir each
    // pass upserts the same FileNodes and the ghost-retire sweep drops files removed from the repo.
    const extracted = await extract(graph, dir)
    // Report the extraction outcome so the dashboard shows a live result rather than the bind-time
    // "queued for sync" — the CP merges `detail` only when we send it.
    const nodes = extracted?.nodesAdded ?? 0
    const edges = extracted?.edgesAdded ?? 0
    await cpPostStatus(deps, r.owner, r.name, {
      syncStatus: 'synced',
      detail: `extracted ${nodes} node${nodes === 1 ? '' : 's'}, ${edges} edge${edges === 1 ? '' : 's'}`,
      lastSyncAt: new Date(input.now?.() ?? Date.now()).toISOString(),
    })
  } catch (err) {
    input.onError?.(label, err as Error)
    // Best-effort failure report — a pass never throws, so one bad repo can't stop the others or the loop.
    await cpPostStatus(deps, r.owner, r.name, {
      syncStatus: 'failed',
      detail: scrubToken((err as Error).message).slice(0, 300),
    }).catch(() => {})
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * One sync pass: pull the bound-repo list from the CP and sync each repo that still needs it. Never throws
 * — a control-plane read failure logs via `onSkip` and the pass ends, exactly as a connector discovery
 * failure leaves the slot intact. Exported so tests can await a deterministic pass.
 *
 * `opts.syncAll` forces every bound repo to sync regardless of its CP status (the boot pass, #1215). Returns
 * whether the CP list was actually read: `startRepoSync` uses this to keep sync-all armed until one full pass
 * over a readable list has run, so a CP that's unreachable at boot doesn't disarm it and leave the graph empty.
 */
export async function runRepoSyncPass(
  input: RepoSyncInput,
  opts: { syncAll?: boolean } = {},
): Promise<boolean> {
  let repos: RepoToSync[]
  try {
    repos = await cpGet<RepoToSync[]>(`/internal/projects/${input.deps.projectId}/repos`, input.deps)
  } catch (err) {
    input.onSkip?.('(all)', `control plane repo list unreadable — ${(err as Error).message}`)
    return false
  }
  if (!Array.isArray(repos)) return false
  for (const r of repos) {
    if (!needsSync(r, opts.syncAll ?? false)) continue
    await syncOneRepo(r, input)
  }
  return true
}

/**
 * Start the repo-sync loop: a boot pass (fire-and-forget, so a clone+extract never stalls slot bootstrap)
 * plus a repeating pass on `intervalMs`. Returns one stop that halts the schedule; an in-flight pass is
 * allowed to finish. Passes never overlap (a slow pass skips the next tick rather than piling up).
 */
export async function startRepoSync(input: RepoSyncInput): Promise<() => void> {
  const intervalMs = input.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS
  let stopped = false
  let running = false
  // The boot pass forces a sync of every bound repo (#1215); later passes revert to the CP-status gate.
  // Only cleared once a pass over a readable list has actually run, so a CP that's down at boot keeps
  // sync-all armed for the next tick rather than skipping the fresh, empty graph until the CP re-queues.
  let firstPass = true
  const tick = async () => {
    if (stopped || running) return
    running = true
    try {
      const listRead = await runRepoSyncPass(input, { syncAll: firstPass })
      if (listRead) firstPass = false
    } finally {
      running = false
    }
  }
  void tick()
  const timer = setInterval(() => {
    void tick()
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

export interface MaybeStartRepoSyncInput {
  graph: NeatGraph
  project: string
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  cloneRepo?: CloneRepo
  extract?: typeof extractFromDirectory
  intervalMs?: number
  tmpRoot?: string
  onSkip?: (repo: string, reason: string) => void
  onError?: (repo: string, err: Error) => void
}

/**
 * The daemon slot calls this unconditionally; it starts repo-sync only when the hosted-profile env is
 * present (NEAT_CP_URL + NEAT_CP_PROJECT_ID + NEAT_AUTH_TOKEN, all injected by the provisioner). Absent —
 * the local daemon — it's a no-op stop, so the slot's line is additive and the local path is unchanged
 * (hosted-platform.md: hosted wraps, never forks). Mirrors maybeStartHostedConnectors.
 */
export async function maybeStartRepoSync(input: MaybeStartRepoSyncInput): Promise<() => void> {
  const env = input.env ?? process.env
  const cpUrl = env.NEAT_CP_URL
  const projectId = env.NEAT_CP_PROJECT_ID
  const daemonToken = env.NEAT_AUTH_TOKEN
  if (!cpUrl || !projectId || !daemonToken) return () => {}
  return startRepoSync({
    deps: { cpUrl, projectId, daemonToken, ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) },
    graph: input.graph,
    project: input.project,
    ...(input.cloneRepo ? { cloneRepo: input.cloneRepo } : {}),
    ...(input.extract ? { extract: input.extract } : {}),
    ...(input.intervalMs !== undefined ? { intervalMs: input.intervalMs } : {}),
    ...(input.tmpRoot ? { tmpRoot: input.tmpRoot } : {}),
    ...(input.onSkip ? { onSkip: input.onSkip } : {}),
    ...(input.onError ? { onError: input.onError } : {}),
  })
}
