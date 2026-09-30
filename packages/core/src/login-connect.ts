// What happens after `neat login` succeeds — connecting the repo the user is
// standing in to the hosted project they just connected their account to.
//
// Logging in connects an *account*: it reads /me, resolves a running project's
// daemon credential, and writes a profile. It never looks at the working
// directory. Someone who arrived from the front door is standing in a repo they
// expect to see in the graph, so the run ends by telling them where that repo
// stands and offering the two routes that put it in (#1234):
//
//   bind   — the hosted daemon clones and extracts the repo itself, through the
//            GitHub App. Durable: it re-syncs on its own.
//   sync   — push the local EXTRACTED snapshot with `neat sync --to`. Immediate
//            and needs no GitHub App, but it is a snapshot, not a subscription.
//
// Nothing here writes to the graph or the profile. It reads, prints, and at most
// opens a browser tab, so a control plane that is down or an older CP that
// doesn't serve these fields degrades to saying less rather than failing.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import { commandPrefix } from './banner.js'
import path from 'node:path'

const execFileAsync = promisify(execFile)

/**
 * Is there an extracted snapshot here to push? `neat sync --to` pushes an
 * existing `neat-out/graph.json`; in a repo NEAT has never run on there is
 * nothing to send, and offering the push without saying so sends the user at a
 * command that exits on a missing file.
 */
export async function hasLocalSnapshot(cwd: string): Promise<boolean> {
  try {
    await fs.access(path.join(cwd, 'neat-out', 'graph.json'))
    return true
  } catch {
    return false
  }
}

const POLL_INTERVAL_MS = 3_000
const POLL_BUDGET_MS = 10 * 60_000
const CP_TIMEOUT_MS = 10_000

/** The slice of GET /me this step reads. `github` is absent on an older control plane. */
export interface MeAccount {
  projects?: Array<{ id: string; name: string; status: string }>
  github?: { installed?: boolean }
}

/** A repo bound to a hosted project (GET /me/projects/:id/repos). */
export interface BoundRepo {
  owner: string
  name: string
  syncStatus?: string
  detail?: string
  lastSyncAt?: string
}

export interface RepoRef {
  owner: string
  name: string
}

export interface ConnectDeps {
  fetchImpl?: typeof fetch
  out?: (line: string) => void
  readLine?: (prompt: string) => Promise<string | undefined>
  openBrowser?: (url: string) => boolean
  /** Resolve the current directory's GitHub repo; injected so tests never shell out. */
  detectRepo?: (cwd: string) => Promise<RepoRef | null>
  /** Does a local EXTRACTED snapshot exist to push? Injected for tests. */
  hasLocalGraph?: (cwd: string) => Promise<boolean>
  cwd?: string
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Aborts the zero-project wait (Ctrl-C). */
  signal?: AbortSignal
  /**
   * Run the local zero-to-graph orchestrator — the same one the door's local
   * path runs, through the same overrides seam. Absent in a non-interactive or
   * test context, in which case the step prints the commands instead of running
   * anything.
   */
  orchestrator?: (
    cwd: string,
    opts?: { project?: string; noInstrument?: boolean; yes?: boolean; headerShown?: boolean },
  ) => Promise<number>
}

/**
 * The GitHub repo this directory belongs to, or null when there isn't one.
 *
 * Reads `git remote get-url origin` and falls back to the first remote, so a
 * clone whose remote is named something else still resolves. Both URL forms are
 * accepted (`https://github.com/o/n.git`, `git@github.com:o/n.git`). Anything
 * that isn't GitHub returns null — the bind route only exists for GitHub, and
 * guessing an owner/name we can't bind would make the offer a lie.
 */
export async function detectGitHubRepo(cwd: string): Promise<RepoRef | null> {
  const read = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('git', args, { cwd, timeout: 5_000 })
      return stdout.trim()
    } catch {
      return null
    }
  }
  let url = await read(['remote', 'get-url', 'origin'])
  if (!url) {
    const names = await read(['remote'])
    const first = names?.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim()
    if (!first) return null
    url = await read(['remote', 'get-url', first])
  }
  if (!url) return null
  return parseGitHubRemote(url)
}

/** github.com owner/name out of an https or ssh remote URL; null for anything else. */
export function parseGitHubRemote(url: string): RepoRef | null {
  const trimmed = url.trim().replace(/\.git$/, '')
  const m =
    trimmed.match(/^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+)$/) ??
    trimmed.match(/^git@github\.com:([^/]+)\/([^/]+)$/) ??
    trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/)
  if (!m) return null
  const owner = m[1]!
  const name = m[2]!
  if (!owner || !name) return null
  return { owner, name }
}

async function cpGetJson<T>(
  fetchImpl: typeof fetch,
  cpUrl: string,
  path: string,
  accessToken: string,
): Promise<{ ok: true; body: T } | { ok: false }> {
  try {
    const res = await fetchImpl(`${cpUrl}${path}`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(CP_TIMEOUT_MS),
    })
    // 501 is an honest "the GitHub App isn't configured here"; treat every
    // non-2xx the same way — we simply know less, and say less.
    if (!res.ok) return { ok: false }
    return { ok: true, body: (await res.json()) as T }
  } catch {
    return { ok: false }
  }
}

/** Repos bound to this project, or null when the control plane can't say. */
export async function listBoundRepos(
  fetchImpl: typeof fetch,
  cpUrl: string,
  accessToken: string,
  projectId: string,
): Promise<BoundRepo[] | null> {
  const res = await cpGetJson<BoundRepo[]>(
    fetchImpl,
    cpUrl,
    `/me/projects/${encodeURIComponent(projectId)}/repos`,
    accessToken,
  )
  if (!res.ok || !Array.isArray(res.body)) return null
  return res.body
}

export type WaitResult =
  | { kind: 'project'; project: { id: string; name: string; status: string } }
  | { kind: 'aborted' }
  | { kind: 'timeout' }

/**
 * Send a fresh account to the console to create its first project, then wait for
 * one to come up.
 *
 * The console routes an account from `/onboarding` to wherever it needs to go, so
 * the CLI points at one URL and polls `/me` rather than modelling that flow
 * itself — no control-plane change, and nothing here decides who may provision.
 * Ctrl-C is a clean exit, not a crash: the signal ends the wait and the caller
 * returns 130.
 */
export async function waitForFirstProject(
  fetchImpl: typeof fetch,
  cpUrl: string,
  accessToken: string,
  deps: {
    sleep: (ms: number) => Promise<void>
    now: () => number
    signal?: AbortSignal
    pollMs?: number
    budgetMs?: number
  },
): Promise<WaitResult> {
  const pollMs = deps.pollMs ?? POLL_INTERVAL_MS
  const deadline = deps.now() + (deps.budgetMs ?? POLL_BUDGET_MS)
  for (;;) {
    if (deps.signal?.aborted) return { kind: 'aborted' }
    const me = await cpGetJson<MeAccount>(fetchImpl, cpUrl, '/me', accessToken)
    if (me.ok) {
      const running = (me.body.projects ?? []).find((p) => p.status === 'running')
      if (running) return { kind: 'project', project: running }
    }
    if (deps.now() >= deadline) return { kind: 'timeout' }
    await deps.sleep(pollMs)
    if (deps.signal?.aborted) return { kind: 'aborted' }
  }
}

/** `app.neat.is/config/repos?project=<id>` — the console's bind screen for one project. */
export function bindUrl(webUrl: string, projectId: string): string {
  return `${webUrl}/config/repos?project=${encodeURIComponent(projectId)}`
}

export function onboardingUrl(webUrl: string): string {
  return `${webUrl}/onboarding`
}

/**
 * Offer to build the local graph now, and run it if they say yes.
 *
 * The door's own local path runs this same orchestrator, through the same
 * overrides seam — so the instrument question is asked exactly once and the
 * answer reaches the run as the flag it stands for. Returns whether a graph now
 * exists, so the caller can say "now push it" rather than "build it, then push
 * it".
 *
 * No reader (non-interactive) means no offer: printing the two commands is the
 * honest fallback, not running an extraction nobody asked for.
 */
async function offerLocalExtraction(
  input: { project: { name: string } },
  d: ConnectDeps,
  out: (line: string) => void,
  readLine: ((prompt: string) => Promise<string | undefined>) | undefined,
): Promise<boolean> {
  const run = d.orchestrator
  if (!run || !readLine) return false
  const answer = (await readLine('Build it now? [Y/n] '))?.trim().toLowerCase()
  if (answer === 'n' || answer === 'no') return false
  out('')
  const code = await run(d.cwd ?? process.cwd(), {})
  return code === 0
}

/**
 * Tell the user where this directory stands against the project they just
 * connected, and offer the two routes that put it in the graph.
 *
 * Read-only and best-effort by design. Not a git repo, not a GitHub remote, or a
 * control plane that won't answer all leave the user with an accurate short
 * message instead of a wrong offer.
 */
export async function runPostLoginConnect(input: {
  cpUrl: string
  webUrl: string
  accessToken: string
  project: { id: string; name: string }
  me?: MeAccount
  deps: ConnectDeps
}): Promise<void> {
  const d = input.deps
  const out = d.out ?? ((line: string) => console.log(line))
  const fetchImpl = d.fetchImpl ?? fetch
  const cwd = d.cwd ?? process.cwd()
  const detect = d.detectRepo ?? detectGitHubRepo
  const readLine = d.readLine

  const repo = await detect(cwd)
  out('')

  const cmd = commandPrefix()
  const syncLine = `${cmd} sync --to ${input.project.name}`

  if (!repo) {
    // No GitHub remote to bind, so pushing the local graph is the only route.
    // The door only opens on a directory NEAT has never extracted, which makes
    // "no snapshot" the common case here rather than the edge one — offering
    // `sync --to` on its own sends the user at a command with nothing to push
    // (#1272).
    out("This directory has no GitHub remote, so it can't be bound to the project.")
    const hasGraph = await (d.hasLocalGraph ?? hasLocalSnapshot)(cwd)
    if (!hasGraph) {
      out(`A graph of this directory has to be built first, then pushed to ${input.project.name}.`)
      const built = await offerLocalExtraction(input, d, out, readLine)
      out('')
      if (built) {
        out(`Now push it to ${input.project.name}:`)
        out(`  ${syncLine}`)
      } else {
        out(`When you're ready, build it and push it to ${input.project.name}:`)
        out(`  ${cmd}`)
        out(`  ${syncLine}`)
      }
      out(`  Manage projects and repos:   ${input.webUrl}`)
      return
    }
    out(`  Push its graph instead:      ${syncLine}`)
    out(`  Manage projects and repos:   ${input.webUrl}`)
    return
  }

  const slug = `${repo.owner}/${repo.name}`
  const bound = await listBoundRepos(fetchImpl, input.cpUrl, input.accessToken, input.project.id)
  const match = bound?.find((r) => r.owner === repo.owner && r.name === repo.name)

  if (match) {
    const state = match.syncStatus ? ` (${match.syncStatus})` : ''
    out(`${slug} is bound to ${input.project.name}${state} — hosted NEAT extracts it for you.`)
    out(`  See the graph:  ${input.webUrl}`)
    return
  }

  out(`${slug} isn't part of ${input.project.name} yet — logging in connected your account, not this repo.`)
  out('')

  // `github.installed` is absent on a control plane that predates it; when we
  // don't know, describe the destination rather than asserting a state.
  const installed = input.me?.github?.installed
  const bindLine =
    installed === false
      ? '1) Install the GitHub App and bind this repo — hosted NEAT keeps it in sync'
      : installed === true
        ? '1) Bind this repo — hosted NEAT clones and extracts it, and keeps it in sync'
        : '1) Bind this repo through the console — hosted NEAT keeps it in sync'
  out(bindLine)
  out(`2) Push the graph on this machine now — a snapshot, not a subscription`)
  out('3) Neither, for now')

  const answer = readLine ? (await readLine('Choose 1, 2 or 3 (Enter skips): '))?.trim() : undefined

  if (answer === '1') {
    const url = bindUrl(input.webUrl, input.project.id)
    const opened = (d.openBrowser ?? (() => false))(url)
    out('')
    out(opened ? `Opened ${url}` : `Open this to bind the repo:\n  ${url}`)
    return
  }

  if (answer === '2') {
    const hasGraph = await (d.hasLocalGraph ?? hasLocalSnapshot)(cwd)
    out('')
    if (!hasGraph) {
      // `sync --to` pushes an existing snapshot; there's nothing to push in a
      // repo NEAT has never extracted, so name the step that comes first.
      out('There is no local graph to push yet. Build one, then push it:')
      out(`  ${cmd}`)
      out(`  ${syncLine}`)
      return
    }
    out('Push the local graph with:')
    out(`  ${syncLine}`)
    return
  }

  out('')
  out('No problem — when you want this repo in the graph:')
  out(`  Bind it:        ${bindUrl(input.webUrl, input.project.id)}`)
  out(`  Or push it:     ${syncLine}`)
}
