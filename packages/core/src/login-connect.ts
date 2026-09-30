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
// Before either, there is a question this step used to answer by itself: which
// project the repo belongs to. It assumed the one the login connected to, which
// is a real choice made silently — a second repo in a project is not free today
// (#1294), and a repo can have a project of its own instead. So it asks, every
// time, with no default and no recommendation (#1272).
//
// That makes one call here a write: creating a project is a POST, and so is
// provisioning it. Everything else still reads, prints, or at most opens a
// browser tab, so a control plane that is down or an older CP that doesn't serve
// these fields degrades to saying less rather than failing. The write happens
// only on an explicit keypress, and it reports each of its three outcomes
// separately — created and running, created but unprovisioned, or not created —
// because "your project exists but has no daemon" is a state the user has to be
// able to act on.

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
/** A project the control plane named back to us. */
export interface NamedProject {
  id: string
  name: string
}

/**
 * What happened when we tried to give this repo a project of its own.
 *
 * Four outcomes rather than ok/error, because creating and provisioning are two
 * calls and the middle state is real: `POST /me/projects` always succeeds for a
 * signed-in account, and `POST /me/projects/:id/provision` is where the
 * subscription gate answers 402. A user who is told "that didn't work" after the
 * first call succeeded will make a second project the next time they try.
 */
export type CreateProjectOutcome =
  /** Created, and a daemon is coming up. */
  | { ok: true; project: NamedProject }
  /** The project exists; provisioning it needs a plan. */
  | { ok: false; reason: 'needs-plan'; project: NamedProject; detail?: string }
  /** The project exists; provisioning failed for some other reason. */
  | { ok: false; reason: 'not-provisioned'; project: NamedProject; detail: string }
  /** Nothing was created. */
  | { ok: false; reason: 'not-created'; detail: string }

/**
 * A project name for a repo, as a DNS label.
 *
 * The control plane takes `[a-z0-9-]+` only, and repo names are freer than that
 * (`My.App_v2`), so this derives rather than passes through. A name that strips
 * to nothing still has to be a legal label.
 */
export function projectNameForRepo(repo: RepoRef): string {
  const slug = repo.name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'repo'
}

async function detailOf(res: Response): Promise<string> {
  const body = await res.text().catch(() => '')
  try {
    const parsed = JSON.parse(body) as { error?: string }
    if (parsed.error) return parsed.error
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return body.trim() || `HTTP ${res.status}`
}

/**
 * Create a project for this repo and provision its daemon.
 *
 * The only write in this module, and it runs only on an explicit choice. Both
 * calls are reported separately: a 402 on provision leaves a real project with
 * no daemon behind, and saying so is the difference between the user paying and
 * carrying on, or making a duplicate project tomorrow.
 */
export async function createProjectForRepo(
  fetchImpl: typeof fetch,
  cpUrl: string,
  accessToken: string,
  name: string,
): Promise<CreateProjectOutcome> {
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
  let project: NamedProject
  try {
    const res = await fetchImpl(`${cpUrl}/me/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(CP_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, reason: 'not-created', detail: await detailOf(res) }
    project = (await res.json()) as NamedProject
  } catch (err) {
    return { ok: false, reason: 'not-created', detail: err instanceof Error ? err.message : String(err) }
  }

  try {
    const res = await fetchImpl(`${cpUrl}/me/projects/${encodeURIComponent(project.id)}/provision`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(CP_TIMEOUT_MS),
    })
    if (res.status === 402) return { ok: false, reason: 'needs-plan', project, detail: await detailOf(res) }
    if (!res.ok) return { ok: false, reason: 'not-provisioned', project, detail: await detailOf(res) }
  } catch (err) {
    return {
      ok: false,
      reason: 'not-provisioned',
      project,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  return { ok: true, project }
}

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
  /**
   * The hosted daemon's base URL and push token (#1302).
   *
   * `neat sync --to` takes a URL, not a project name, and reads its token from
   * `--token`/`NEAT_REMOTE_TOKEN` and never from the profile — so the project
   * name this step used to print was not a command anyone could run. Both values
   * are in hand at the call site. Absent, the push route is left unsaid rather
   * than printed wrong.
   */
  endpoint?: string
  pushToken?: string
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
  // `--to` is a base URL and the token comes from the flag, never the profile
  // (#1302). Printing the project name here produced a command that fails on
  // `Failed to parse URL`. Without an endpoint there is no runnable push line to
  // print, so the step says where to find one instead of inventing it.
  const pushCmd = input.endpoint
    ? `${cmd} sync --to ${input.endpoint}${input.pushToken ? ` --token ${input.pushToken}` : ''}`
    : null
  const pushInto = (label: string): string[] =>
    pushCmd ? [`  ${pushCmd}`] : [`  Its daemon URL and token are on ${label} in the console: ${input.webUrl}`]

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
        for (const line of pushInto(input.project.name)) out(line)
      } else {
        out(`When you're ready, build it and push it to ${input.project.name}:`)
        out(`  ${cmd}`)
        for (const line of pushInto(input.project.name)) out(line)
      }
      out(`  Manage projects and repos:   ${input.webUrl}`)
      return
    }
    out(`  Push its graph to ${input.project.name}:`)
    for (const line of pushInto(input.project.name)) out(line)
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

  out(`${slug} isn't in ${input.project.name} — logging in connected your account, not this repo.`)
  out('')

  // Which project the repo belongs to was being decided for the user, silently,
  // in favour of the one the login happened to connect to. Ask it (#1272). No
  // default and no recommendation: a project each costs a daemon each, and a
  // shared project costs the collision below, and which of those is worse
  // depends on things the CLI can't see.
  const suggested = projectNameForRepo(repo)
  out('Where should this repo go?')
  out('')
  out(`1) A project of its own, called ${suggested}`)
  out(`2) ${input.project.name} — the project this login connected to`)
  for (const line of sharedProjectCaveat(bound)) out(`   ${line}`)
  out('3) Neither, for now')
  out('')

  const answer = readLine ? (await readLine('Choose 1, 2 or 3 (Enter skips): '))?.trim() : undefined

  if (answer === '1') {
    out('')
    const outcome = await createProjectForRepo(fetchImpl, input.cpUrl, input.accessToken, suggested)
    reportCreate(outcome, input.webUrl, cmd, input.project.name, out)
    return
  }

  // Both remaining routes point at a project; 2 is the one just connected to,
  // and anything else (including Enter) is the no-op.
  if (answer === '2') {
    out('')
    out(`Two ways into ${input.project.name} — either is fine, and you can do both:`)
    out('')
    // `github.installed` is absent on a control plane that predates it; when we
    // don't know, describe the destination rather than asserting a state.
    const installed = input.me?.github?.installed
    out(
      installed === false
        ? '  Bind it (install the GitHub App first) — hosted NEAT keeps it in sync:'
        : installed === true
          ? '  Bind it — hosted NEAT clones and extracts it, and keeps it in sync:'
          : '  Bind it through the console — hosted NEAT keeps it in sync:',
    )
    out(`    ${bindUrl(input.webUrl, input.project.id)}`)
    out('')
    const hasGraph = await (d.hasLocalGraph ?? hasLocalSnapshot)(cwd)
    if (hasGraph) {
      out('  Or push the graph on this machine now — a snapshot, not a subscription:')
      for (const line of pushInto(input.project.name)) out(`  ${line}`)
    } else {
      // `sync --to` pushes an existing snapshot; there's nothing to push in a
      // repo NEAT has never extracted, so name the step that comes first.
      out('  Or build a graph here and push it — a snapshot, not a subscription:')
      out(`    ${cmd}`)
      for (const line of pushInto(input.project.name)) out(`  ${line}`)
    }
    return
  }

  out('')
  out('No problem — when you want this repo in the graph:')
  out(`  Its own project:   ${input.webUrl}`)
  out(`  Or into ${input.project.name}: ${bindUrl(input.webUrl, input.project.id)}`)
}

/**
 * What to say about putting a second repo in a project someone else's files
 * already live in.
 *
 * Two repos in one project mint the same FileNode ids for the same relative
 * paths, so each sync's retire sweep can drop the other's files (#1294). That is
 * a real cost of choosing the shared project today, so it is stated on the
 * option rather than left for the user to discover in a graph that quietly
 * shrank. `null` means the control plane didn't answer — say the general thing
 * rather than a count we don't have.
 */
function sharedProjectCaveat(bound: BoundRepo[] | null): string[] {
  const hazard = "Two repos in one project can currently retire each other's files (#1294),"
  if (!bound) return [hazard, 'so a graph there may end up short of code until that is fixed.']
  if (bound.length === 0) return ['Nothing else is bound there yet.', `Adding a second repo later would hit #1294 — ${hazard.toLowerCase()}`]
  const names = bound.map((r) => `${r.owner}/${r.name}`).join(', ')
  return [
    `${bound.length} already there: ${names}.`,
    hazard,
    'so both graphs may end up short of code until that is fixed.',
  ]
}

/**
 * Report a project creation, telling the three end states apart.
 *
 * "Created and running", "created but needs a plan", and "nothing was created"
 * lead to different next actions, and conflating them costs the user either a
 * duplicate project or a wait for a daemon that was never asked for.
 */
function reportCreate(
  outcome: CreateProjectOutcome,
  webUrl: string,
  cmd: string,
  connectedTo: string,
  out: (line: string) => void,
): void {
  if (outcome.ok) {
    out(`Created ${outcome.project.name} and started its daemon.`)
    out('')
    // The profile this login wrote still points at the old project. Saying so
    // beats letting the next `neat` command read a graph they didn't mean.
    out(`This CLI is still pointed at ${connectedTo}. Switch it to the new project with:`)
    out(`  ${cmd} login --project ${outcome.project.name}`)
    out('')
    // That login prints the new daemon's URL and token, which is what a push
    // needs — this step can't print a `sync --to` line for a project whose
    // daemon it has never seen (#1302).
    out('Then bind this repo to it:')
    out(`  ${bindUrl(webUrl, outcome.project.id)}`)
    return
  }

  if (outcome.reason === 'needs-plan') {
    out(`Created ${outcome.project.name}, but starting a daemon for it needs a plan.`)
    out(`  Choose one:  ${webUrl}/checkout`)
    out('')
    out("The project is made and keeps its name, so there's nothing to redo here afterwards.")
    return
  }

  if (outcome.reason === 'not-provisioned') {
    out(`Created ${outcome.project.name}, but its daemon didn't start: ${outcome.detail}`)
    out('')
    out('The project exists — start it from the console rather than making a second one:')
    out(`  ${webUrl}`)
    return
  }

  out(`Couldn't create the project: ${outcome.detail}`)
  out(`Nothing was made, so this is safe to retry, or do it in the console: ${webUrl}`)
}
