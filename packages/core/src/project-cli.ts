import {
  bindingLine,
  readBinding,
  readProjectIdentity,
  writeProjectBinding,
  ProjectIdentityError,
} from './project-identity.js'
import { resolveProject, TargetResolutionError } from './project-resolve.js'
import { discoverDaemons } from './registry.js'
import { runProjectClone } from './project-clone.js'
import { promoteProject, resolvePromoteCreds } from './project-promote.js'

// `neat project` — a project's binding on this machine (ADR-273, WO-0.7/1.1).
//
//   neat project set-local  [--project <id|name>]
//   neat project set-hosted --org <org> [--project <id|name>]
//   neat project clone      <name | prj_id> [path]
//   neat project promote    --org <org> [--project <id|name>]
//
// set-local / set-hosted are the manual flip of .neat/binding.json — the escape
// hatch the honest-routing error names; they move nothing. `clone` (WO-1.2) gives
// a checkout a hosted project's identity. `promote` (WO-1.1) is the migration: it
// registers the project with the control plane, re-keys its connectors, then flips
// the binding to hosted last — leaving it local on any failure.
// Config-style, off the query allowlist.

const USAGE = [
  'usage: neat project set-local  [--project <id|name>]',
  '       neat project set-hosted --org <org> [--project <id|name>]',
  '       neat project clone    <name | prj_id> [path]',
  '       neat project promote  --org <org> [--project <id|name>]',
  '',
  'set-local / set-hosted set how this machine reaches the project (.neat/binding.json),',
  'moving nothing. promote migrates a local project to hosted in <org>: register, re-key',
  'its connectors, then flip the binding — leaving it local on any failure.',
]

export interface ProjectCliDeps {
  cwd?: string
  out?: (line: string) => void
  err?: (line: string) => void
  // promote / clone: the env their CP creds (NEAT_API_KEY, NEAT_CP_URL) resolve
  // from, and the fetch they call the control plane with — injected so tests
  // drive a local CP stub and never touch the network.
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
}

function parse(argv: string[]): { sub?: string; project?: string; org?: string; help: boolean; unknown?: string } {
  const out: { sub?: string; project?: string; org?: string; help: boolean; unknown?: string } = { help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--project') out.project = argv[++i]
    else if (a.startsWith('--project=')) out.project = a.slice('--project='.length)
    else if (a === '--org') out.org = argv[++i]
    else if (a.startsWith('--org=')) out.org = a.slice('--org='.length)
    else if (!out.sub && !a.startsWith('-')) out.sub = a
    else out.unknown ??= a
  }
  return out
}

// `neat project promote` — register with the control plane, re-key connectors,
// flip the binding to hosted last. Idempotent and atomic: already-hosted is a
// no-op, and any failure before the flip leaves the project local.
async function runPromote(
  root: string,
  org: string,
  deps: Pick<ProjectCliDeps, 'env' | 'fetchImpl'>,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const identity = await readProjectIdentity(root)
  const before = await readBinding(root)
  if (!before.absent && before.binding === 'hosted') {
    out(`neat project: ${identity!.name} is already hosted@${before.org}`)
    return 0
  }
  const creds = resolvePromoteCreds(deps.env ?? process.env)
  if ('error' in creds) {
    err(`neat project promote: ${creds.error}`)
    return 2
  }
  const outcome = await promoteProject(root, org, {
    cpUrl: creds.cpUrl,
    apiKey: creds.apiKey,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  })
  for (const s of outcome.steps) out(`neat project: ${s}`)
  if (!outcome.ok) {
    err(`neat project promote: ${outcome.error} — ${identity!.name} is still local`)
    return 1
  }
  out(
    bindingLine({
      name: identity!.name,
      projectId: identity!.projectId,
      binding: 'hosted',
      org,
      daemon: '(your hosted login)',
    }),
  )
  return 0
}

export async function runProjectCommand(argv: string[], deps: ProjectCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l))
  const err = deps.err ?? ((l: string) => console.error(l))
  // `clone` (WO-1.2) takes its own positionals; hand it everything after the word.
  const at = argv.indexOf('clone')
  if (at !== -1 && argv.slice(0, at).every((a) => a.startsWith('-'))) {
    return runProjectClone(argv.slice(at + 1), {
      ...(deps.cwd ? { cwd: deps.cwd } : {}),
      ...(deps.env ? { env: deps.env } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      out,
      err,
    })
  }
  const args = parse(argv)
  if (args.help || !args.sub) {
    for (const l of USAGE) (args.help ? out : err)(l)
    return args.help ? 0 : 2
  }
  if (args.sub !== 'set-local' && args.sub !== 'set-hosted' && args.sub !== 'promote') {
    err(`neat project: unknown subcommand \`${args.sub}\``)
    for (const l of USAGE) err(l)
    return 2
  }
  if (args.unknown !== undefined) {
    err(`neat project: unexpected argument \`${args.unknown}\``)
    return 2
  }
  if ((args.sub === 'set-hosted' || args.sub === 'promote') && (!args.org || args.org.length === 0)) {
    err(`neat project ${args.sub}: --org <org> is required — the org the hosted project runs in`)
    return 2
  }

  let root: string
  try {
    const p = await resolveProject({ ...(args.project ? { project: args.project } : {}), ...(deps.cwd ? { cwd: deps.cwd } : {}) })
    if (p.legacy || !p.root) {
      err(`neat project: ${p.name} has no .neat/project.json yet — run \`neat init\` in ${p.root ?? 'it'} first`)
      return 2
    }
    root = p.root
  } catch (e) {
    if (e instanceof TargetResolutionError || e instanceof ProjectIdentityError) {
      err(`neat project: ${e.message}`)
      return 2
    }
    throw e
  }

  if (args.sub === 'promote') {
    return runPromote(
      root,
      args.org!,
      { ...(deps.env ? { env: deps.env } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) },
      out,
      err,
    )
  }

  const identity = await readProjectIdentity(root)
  const before = await readBinding(root)
  const binding =
    args.sub === 'set-hosted'
      ? await writeProjectBinding(root, { binding: 'hosted', org: args.org! })
      : await writeProjectBinding(root, { binding: 'local' })
  const name = identity!.name
  const where = binding.binding === 'hosted' ? `hosted@${binding.org}` : 'local'
  if (!before.absent && before.binding === binding.binding && before.org === binding.org) {
    out(`neat project: ${name} is already ${where}`)
  } else {
    out(`neat project: ${name} is now ${where} on this machine`)
  }

  // Say what the flip means for this machine's daemon, without touching it.
  const live = (await discoverDaemons().catch(() => [])).filter(
    (d) => d.live && (d.record.projectId === identity!.projectId || d.record.projectPath === root),
  )
  if (binding.binding === 'hosted' && live.length > 0) {
    out(`neat project: its local daemon (pid ${live[0]!.record.pid}, :${live[0]!.record.ports.rest}) is still running but no longer answers this project's commands`)
  }
  if (binding.binding === 'local' && live.length === 0) {
    out('neat project: start its daemon here with `neat up`')
  }
  out(
    bindingLine({
      name,
      projectId: identity!.projectId,
      binding: binding.binding,
      ...(binding.org ? { org: binding.org } : {}),
      daemon: binding.binding === 'local' ? (live[0] ? `http://localhost:${live[0].record.ports.rest}` : '(not running)') : '(your hosted login)',
    }),
  )
  return 0
}
