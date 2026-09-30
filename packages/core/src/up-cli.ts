// `neat up` — start or recover the daemon for the project you're standing in.
//
// A query verb that can't reach its daemon exits 3 and starts nothing: reads stay
// reads (#1250). This is the command that message points at. It does the one
// thing the bare run does as its fourth step — make sure this project has a live
// daemon — without extracting, instrumenting, or registering anything, and says
// what it found: already running, started, or why it would not come up.
//
// A config-style command alongside `doctor` (cli-surface.md §neat up), not one of
// the locked query verbs. Loopback only: a daemon this machine doesn't run isn't
// ours to start. Its collaborators are injected so the surface is testable
// without spawning a process.

import path from 'node:path'
import type { RegistryEntry } from '@neat.is/types'
import { findProjectByPath, getProject } from './registry.js'
import {
  DEFAULT_DAEMON_READY_TIMEOUT_MS,
  NEAT_PORTS,
  daemonLogPath,
  daemonProgressLine,
  describeDaemonTimeout,
  ensureProjectDaemon,
  formatPortCollisionMessage,
  type EnsureDaemonOptions,
  type EnsureDaemonOutcome,
} from './orchestrator.js'

// Where a query verb run from here would go. `local` is false when that is a
// daemon on another machine — a hosted profile, a remote pin.
export interface UpTarget {
  endpoint: string
  local: boolean
  // What chose the endpoint, in words — for the message.
  via: string
}

export interface UpCliDeps {
  cwd?: string
  env?: NodeJS.ProcessEnv
  resolveTarget: (opts: { project?: string; profile?: string }) => Promise<UpTarget>
  ensureDaemon?: (opts: EnsureDaemonOptions) => Promise<EnsureDaemonOutcome>
  out?: (line: string) => void
  err?: (line: string) => void
}

interface UpArgs {
  project?: string
  profile?: string
  json: boolean
  help: boolean
  unknown?: string
}

function parseUpArgs(argv: string[], env: NodeJS.ProcessEnv): UpArgs {
  const args: UpArgs = { json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--json') args.json = true
    else if (a === '-h' || a === '--help') args.help = true
    else if (a === '--project') args.project = argv[++i]
    else if (a.startsWith('--project=')) args.project = a.slice('--project='.length)
    else if (a === '--profile') args.profile = argv[++i]
    else if (a.startsWith('--profile=')) args.profile = a.slice('--profile='.length)
    else if (args.unknown === undefined) args.unknown = a
  }
  if (!args.project && env.NEAT_PROJECT && env.NEAT_PROJECT.length > 0) args.project = env.NEAT_PROJECT
  return args
}

const USAGE = [
  'usage: neat up [--project <name>] [--json]',
  '',
  "Start this project's daemon, or recover it if it died. Does nothing when it is",
  'already running. Extracts and instruments nothing — run `neat` for that.',
]

export async function runUpCommand(argv: string[], deps: UpCliDeps): Promise<number> {
  const cwd = deps.cwd ?? process.cwd()
  const env = deps.env ?? process.env
  const out = deps.out ?? ((line: string) => console.log(line))
  const err = deps.err ?? ((line: string) => console.error(line))
  const ensure = deps.ensureDaemon ?? ensureProjectDaemon

  const args = parseUpArgs(argv, env)
  if (args.help) {
    for (const line of USAGE) out(line)
    return 0
  }
  if (args.unknown !== undefined) {
    err(`neat up: unexpected argument \`${args.unknown}\``)
    for (const line of USAGE) err(line)
    return 2
  }

  // Which project. The name wins when given; otherwise the one this directory
  // belongs to. A registry that can't be read is no project, not a crash.
  let entry: RegistryEntry | undefined
  try {
    entry = args.project ? await getProject(args.project) : await findProjectByPath(cwd)
  } catch {
    entry = undefined
  }
  if (!entry) {
    err(
      args.project
        ? `neat up: no project named "${args.project}" is registered on this machine — \`neat list\` shows what is.`
        : "neat up: This directory isn't a NEAT project yet — run `npx neat.is` here first, or pass --project <name>.",
    )
    return 2
  }

  // Where queries from here go. If that's a daemon on another machine, starting a
  // local one would leave every query still pointed somewhere else.
  let target: UpTarget
  try {
    target = await deps.resolveTarget({ project: entry.name, profile: args.profile })
  } catch (e) {
    err(`neat up: ${(e as Error).message}`)
    return 2
  }
  if (!target.local) {
    err(`neat up: queries from here go to ${target.endpoint}, through ${target.via}.`)
    err("neat up: that daemon doesn't run on this machine, so it isn't yours to start.")
    return 2
  }

  const project = entry.name
  const outcome = await ensure({
    project,
    projectPath: entry.path,
    // `--json` prints one object and nothing else, so progress stays quiet there.
    ...(args.json
      ? {}
      : { onProgress: (event) => out(`neat up: ${daemonProgressLine(project, event)}`) }),
  })
  const log = daemonLogPath(entry.path)

  if (args.json) {
    const ports = 'ports' in outcome ? outcome.ports : undefined
    out(
      JSON.stringify({
        project: entry.name,
        path: entry.path,
        status: outcome.status,
        ...(ports ? { endpoint: `http://localhost:${ports.rest}`, ports } : {}),
        ...(outcome.status === 'spawn-failed' ? { error: outcome.message } : {}),
        log,
      }),
    )
  }

  switch (outcome.status) {
    case 'already-running':
      if (!args.json) {
        out(`neat up: ${entry.name} is already running — http://localhost:${outcome.ports.rest}`)
      }
      return 0
    case 'spawned':
      if (!args.json) {
        out(`neat up: started ${entry.name} — http://localhost:${outcome.ports.rest}`)
        out(`neat up: traces on :${outcome.ports.otlp}, log at ${path.relative(cwd, log) || log}`)
      }
      return 0
    case 'timed-out':
      if (!args.json) {
        for (const line of await describeDaemonTimeout(outcome, entry.path, DEFAULT_DAEMON_READY_TIMEOUT_MS)) err(line)
      }
      return 1
    case 'peer-timeout':
      if (!args.json) {
        err('neat up: another `neat` is starting this project, and its daemon did not come up in time.')
        err(`neat up: see ${log}`)
      }
      return 1
    case 'spawn-failed':
      if (!args.json) err(`neat up: could not start the daemon — ${outcome.message}`)
      return 1
    case 'no-ports':
      if (!args.json) for (const line of formatPortCollisionMessage(NEAT_PORTS[0])) err(line)
      return 3
  }
}
