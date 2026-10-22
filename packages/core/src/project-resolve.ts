import path from 'node:path'
import {
  bindingLine,
  findProjectRootSync,
  readBindingSync,
  readProjectIdentitySync,
  ProjectIdentityError,
  type BindingKind,
  type ResolvedIdentity,
} from './project-identity.js'
import { discoverDaemonsSync, findProjectByPathSync, readRegistrySync, type DiscoveredDaemon } from './registry.js'
import { getActiveProfileSync, resolveProfileSync, type Profile } from './profiles.js'

// Which project a command means, and where its daemon is (ADR-273,
// docs/contracts/project-identity.md §3–§4). One resolution for the CLI and the
// MCP server; neither re-implements a step (#1373). The logic is synchronous: it
// reads a few small local files, and the MCP server resolves at module load. The
// async exports are thin wrappers for the CLI.
//
//   1. --profile / NEAT_PROFILE, or the env pin NEAT_CORE_URL / NEAT_API_URL
//   2. --project <projectId | name> / NEAT_PROJECT
//   3. the nearest .neat/project.json at or above the cwd
//   4. a registration from before ADR-273 covering the cwd (notice, no write)
//   5. an error — no default project, no sole-daemon guess
//
// Then by the project's binding: local → this machine's daemon for the project;
// hosted → the account's endpoint and bearer. The global active profile never
// routes a local project.

export type TargetSource = 'profile' | 'env' | 'project' | 'cwd' | 'legacy'

export interface ResolvedProject {
  name: string
  projectId?: string
  // The directory holding .neat/project.json (or the legacy registration's path).
  root?: string
  binding: BindingKind
  org?: string
  // True when the project has no .neat/project.json yet (level 4).
  legacy: boolean
  // The binding.json was absent and the project is read as local.
  bindingAbsent?: boolean
  source: 'project' | 'cwd' | 'legacy'
}

export interface ProjectTarget {
  endpoint: string
  authToken?: string
  source: TargetSource
  // Absent for an explicit pin that named no project.
  project?: ResolvedProject
  // The line every answer carries (project-identity.md §6).
  line: string
  // Something to tell the user on stderr (a legacy project, an absent binding).
  notices: string[]
  // The project name the answering local daemon serves under, for a verb's
  // `/projects/<name>` segment. Absent for a pin or a hosted daemon.
  daemonProject?: string
}

export class TargetResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TargetResolutionError'
  }
}

// An explicitly named profile the store doesn't have: reported, never swapped for
// another endpoint (client-profiles.md §3 level 1).
export class UnknownProfileError extends TargetResolutionError {
  constructor(name: string) {
    super(`no profile named "${name}" in ~/.neat/profiles.json — run \`neat login\` first, or drop --profile / NEAT_PROFILE`)
    this.name = 'UnknownProfileError'
  }
}

export interface ResolveOptions {
  project?: string
  profile?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
}

function runningList(live: DiscoveredDaemon[]): string {
  return live.map((d) => `  ${d.record.project} → http://localhost:${d.record.ports.rest}  (${d.record.projectPath})`).join('\n')
}

function fromRoot(root: string, source: 'project' | 'cwd'): ResolvedProject {
  const identity = readProjectIdentitySync(root)
  if (!identity) throw new TargetResolutionError(`${root} has no .neat/project.json`)
  const b = readBindingSync(root)
  return {
    name: identity.name,
    projectId: identity.projectId,
    root,
    binding: b.binding,
    ...(b.org ? { org: b.org } : {}),
    legacy: false,
    ...(b.absent ? { bindingAbsent: true } : {}),
    source,
  }
}

/**
 * Levels 2–5: which project the command means. Never consults a profile.
 */
export async function resolveProject(opts: ResolveOptions = {}): Promise<ResolvedProject> {
  return resolveProjectSync(opts)
}

export function resolveProjectSync(opts: ResolveOptions = {}): ResolvedProject {
  const env = opts.env ?? process.env
  const cwd = path.resolve(opts.cwd ?? process.cwd())
  const wanted = opts.project ?? env.NEAT_PROJECT

  // Level 2 — a named project, by id or by name.
  if (wanted && wanted.length > 0) {
    let rows: Array<{ name: string; path: string }> = []
    try {
      rows = readRegistrySync().projects
    } catch {
      rows = []
    }
    const matches: ResolvedProject[] = []
    for (const row of rows) {
      let identity: ReturnType<typeof readProjectIdentitySync>
      try {
        identity = readProjectIdentitySync(row.path)
      } catch {
        identity = undefined
      }
      if (identity && (identity.projectId === wanted || identity.name === wanted)) {
        matches.push(fromRoot(row.path, 'project'))
      } else if (!identity && row.name === wanted) {
        matches.push({ name: row.name, root: row.path, binding: 'local', legacy: true, source: 'project' })
      }
    }
    if (matches.length === 1) return matches[0]!
    if (matches.length > 1) {
      const list = matches.map((m) => `  ${m.projectId ?? '(no id yet)'}  ${m.root}`).join('\n')
      throw new TargetResolutionError(`"${wanted}" names ${matches.length} projects on this machine; pass the projectId instead:\n${list}`)
    }
    throw new TargetResolutionError(`no project "${wanted}" is registered on this machine — run \`neat init\` in it, or check \`neat list\``)
  }

  // Level 3 — the nearest .neat/project.json.
  const root = findProjectRootSync(cwd)
  if (root) return fromRoot(root, 'cwd')

  // Level 4 — a registration from before ADR-273.
  let legacy: ReturnType<typeof findProjectByPathSync>
  try {
    legacy = findProjectByPathSync(cwd)
  } catch {
    legacy = undefined
  }
  if (legacy) return { name: legacy.name, root: legacy.path, binding: 'local', legacy: true, source: 'legacy' }

  // Level 5 — nothing here.
  const live = liveDaemons()
  const running = live.length > 0 ? `\nRunning NEAT daemons:\n${runningList(live)}` : ''
  throw new TargetResolutionError(`no NEAT project here — run \`neat init\`, or pass --project <name>.${running}`)
}

function liveDaemons(): DiscoveredDaemon[] {
  try {
    return discoverDaemonsSync().filter((d) => d.live)
  } catch {
    return []
  }
}

function localDaemonFor(p: ResolvedProject): DiscoveredDaemon | undefined {
  const live = liveDaemons()
  return (
    (p.projectId ? live.find((d) => d.record.projectId === p.projectId) : undefined) ??
    live.find((d) => p.root !== undefined && path.resolve(d.record.projectPath) === path.resolve(p.root)) ??
    (p.legacy ? live.find((d) => d.record.project === p.name) : undefined)
  )
}

function hostedProfileFor(p: ResolvedProject): Profile | undefined {
  try {
    return (p.org ? resolveProfileSync(p.org) : undefined) ?? getActiveProfileSync()
  } catch {
    return undefined
  }
}

/**
 * The whole resolution: the project and the endpoint to reach it, as one
 * decision, with the binding line to print.
 */
export async function resolveProjectTarget(opts: ResolveOptions = {}): Promise<ProjectTarget> {
  return resolveProjectTargetSync(opts)
}

export function resolveProjectTargetSync(opts: ResolveOptions = {}): ProjectTarget {
  const env = opts.env ?? process.env

  // Level 1 — an explicit profile or env pin is used as given.
  const named = opts.profile ?? env.NEAT_PROFILE
  if (named && named.length > 0) {
    const profile = resolveProfileSync(named)
    if (!profile) throw new UnknownProfileError(named)
    const id: ResolvedIdentity = { name: profile.name, binding: 'pinned', daemon: profile.endpoint }
    return { endpoint: profile.endpoint, ...(profile.authToken ? { authToken: profile.authToken } : {}), source: 'profile', line: bindingLine(id), notices: [] }
  }
  const pin = env.NEAT_API_URL ?? env.NEAT_CORE_URL
  if (pin && pin.length > 0) {
    const token = env.NEAT_AUTH_TOKEN
    const id: ResolvedIdentity = { name: env.NEAT_PROJECT ?? 'pinned', binding: 'pinned', daemon: pin }
    return { endpoint: pin, ...(token ? { authToken: token } : {}), source: 'env', line: bindingLine(id), notices: [] }
  }

  const project = resolveProjectSync(opts)
  const notices: string[] = []
  if (project.legacy) {
    notices.push(`${project.name} has no .neat/project.json yet — run \`neat init\` in ${project.root ?? 'it'} to give it a project identity`)
  } else if (project.bindingAbsent) {
    notices.push(`no .neat/binding.json — treating ${project.name} as local`)
  }

  if (project.binding === 'hosted') {
    const profile = hostedProfileFor(project)
    if (!profile) {
      throw new TargetResolutionError(`${project.name} is hosted (in ${project.org}); log in with \`neat login\` to reach it, or \`neat project set-local\` to make it local here`)
    }
    const id: ResolvedIdentity = { name: project.name, ...(project.projectId ? { projectId: project.projectId } : {}), binding: 'hosted', ...(project.org ? { org: project.org } : {}), daemon: profile.endpoint }
    return {
      endpoint: profile.endpoint,
      ...(profile.authToken ? { authToken: profile.authToken } : {}),
      source: project.source,
      project,
      line: bindingLine(id),
      notices,
    }
  }

  const daemon = localDaemonFor(project)
  if (!daemon) {
    throw new TargetResolutionError(`${project.name}'s daemon isn't running — start it with \`neat up\` in ${project.root ?? 'the project'}`)
  }
  const endpoint = `http://localhost:${daemon.record.ports.rest}`
  const id: ResolvedIdentity = { name: project.name, ...(project.projectId ? { projectId: project.projectId } : {}), binding: 'local', daemon: endpoint }
  return { endpoint, source: project.source, project, line: bindingLine(id), notices, daemonProject: daemon.record.project }
}

/** NEAT_LEGACY_ROUTING=1 restores the pre-ADR-273 resolution (project-identity.md §7). */
export function legacyRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NEAT_LEGACY_ROUTING === '1'
}

export const LEGACY_ROUTING_NOTICE =
  'NEAT_LEGACY_ROUTING=1: using the pre-ADR-273 resolution (the logged-in profile routes every bare command). This switch is temporary and will be removed.'

/** The line a client prints when no project resolved (project-identity.md §6). */
export const UNRESOLVED_LINE = 'project=(none) · binding=(unresolved) · daemon=(none)'

// ── honest routing (project-identity.md §5) ──────────────────────────────────

/** A command that acts on this machine was run on a hosted-bound project. */
export class HostedBindingError extends TargetResolutionError {
  constructor(name: string, org: string | undefined) {
    super(
      `${name} is hosted (runs in ${org ?? 'its org'}); it isn't yours to start here. ` +
        'Use `neat open` to connect to it, or `neat project set-local` to make it local on this machine.',
    )
    this.name = 'HostedBindingError'
  }
}

/**
 * For a command that acts on this machine (`up`, `watch`, the bare orchestrator):
 * throws HostedBindingError when the project at or above `dir` is bound to hosted,
 * so the command stops before it writes, starts or prints anything that reads as
 * ready (§5). A directory with no project, or an identity file that can't be read,
 * is left to the command's own handling.
 */
export function assertLocalBinding(dir: string): void {
  let root: string | undefined
  let name: string | undefined
  let binding: ReturnType<typeof readBindingSync>
  try {
    root = findProjectRootSync(dir)
    if (!root) return
    name = readProjectIdentitySync(root)?.name
    binding = readBindingSync(root)
  } catch (err) {
    // An identity file that can't be read is the command's own to report; any
    // other failure is a bug and surfaces.
    if (err instanceof ProjectIdentityError) return
    throw err
  }
  if (binding.binding === 'hosted') throw new HostedBindingError(name ?? path.basename(root), binding.org)
}
