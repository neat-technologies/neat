import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  PROJECT_ID_RE,
  ProjectIdentityError,
  bindingLine,
  writeProjectBinding,
  writeProjectIdentity,
} from './project-identity.js'
import { resolveCpUrl } from './login-sso.js'

// `neat project clone` — a hosted project's identity into a local checkout
// (ADR-273, WO-1.2, #1521).
//
//   neat project clone <name | prj_id> [path]
//
// Looks the project up in the control plane's `GET /me` by its `neatProjectId`
// (or by name when exactly one project has it), then writes `.neat/project.json`
// with that id — never a new one — and a `local` `binding.json` into `path`
// (the cwd by default). The checkout and the hosted project are then one project
// with two bindings: hosted for whoever runs it there, local here. Nothing is
// pulled down: graph sync is out of scope (ADR-273 decision 2), and connectors
// are re-keyed separately.

export const CLONE_USAGE = [
  'usage: neat project clone <name | prj_id> [path]',
  '',
  "Gives a local checkout a hosted project's identity: writes .neat/project.json with",
  'its project id and a local .neat/binding.json, so this checkout and the hosted',
  'project are the same project. Needs NEAT_API_KEY (a neat_pat_… key).',
]

export interface CloneDeps {
  cwd?: string
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  out?: (line: string) => void
  err?: (line: string) => void
}

// The fields of a `GET /me` project clone reads (neat-infra#215).
interface CpProject {
  id: string
  name: string
  displayName?: string
  neatProjectId?: string
  status?: string
}

function label(p: CpProject): string {
  return p.displayName && p.displayName.length > 0 ? p.displayName : p.name
}

type Picked = { project: CpProject } | { error: string }

/** The one hosted project `ref` names: a `prj_` id, else a name exactly one project has. */
export function pickClonedProject(projects: CpProject[], ref: string): Picked {
  if (PROJECT_ID_RE.test(ref)) {
    const p = projects.find((x) => x.neatProjectId === ref)
    return p ? { project: p } : { error: `no hosted project with id ${ref} in your account` }
  }
  const named = projects.filter((x) => x.name === ref || x.displayName === ref)
  if (named.length === 0) {
    const listed = projects.map((x) => label(x)).join(', ')
    return { error: `no hosted project named "${ref}"${listed ? ` (yours: ${listed})` : ''}` }
  }
  if (named.length > 1) {
    const ids = named.map((x) => `${label(x)} (${x.neatProjectId ?? 'no project id'})`).join(', ')
    return { error: `several hosted projects are named "${ref}": ${ids}. Pass the prj_ id instead.` }
  }
  return { project: named[0]! }
}

export async function runProjectClone(argv: string[], deps: CloneDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l))
  const err = deps.err ?? ((l: string) => console.error(l))
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetchImpl ?? fetch
  const cwd = deps.cwd ?? process.cwd()

  const positional = argv.filter((a) => !a.startsWith('-'))
  if (argv.includes('--help') || argv.includes('-h')) {
    for (const l of CLONE_USAGE) out(l)
    return 0
  }
  const unknown = argv.find((a) => a.startsWith('-'))
  if (unknown !== undefined) {
    err(`neat project clone: unexpected argument \`${unknown}\``)
    return 2
  }
  const [ref, target, extra] = positional
  if (!ref || extra !== undefined) {
    for (const l of CLONE_USAGE) err(l)
    return 2
  }

  const root = path.resolve(cwd, target ?? '.')
  const stat = await fs.stat(root).catch(() => undefined)
  if (!stat?.isDirectory()) {
    err(`neat project clone: ${root} is not a directory`)
    return 2
  }

  const apiKey = env.NEAT_API_KEY
  if (!apiKey) {
    err('neat project clone: not logged in — set NEAT_API_KEY (a neat_pat_… key) or run `neat login`')
    return 2
  }
  const cpUrl = resolveCpUrl(env)

  let res: Response
  try {
    res = await fetchImpl(`${cpUrl}/me`, { headers: { authorization: `Bearer ${apiKey}` } })
  } catch (e) {
    err(`neat project clone: can't reach the control plane at ${cpUrl} — ${(e as Error).message}`)
    return 1
  }
  if (res.status === 401) {
    err('neat project clone: not authorized — your key is expired or invalid; run `neat login` or check NEAT_API_KEY')
    return 1
  }
  if (!res.ok) {
    err(`neat project clone: the control plane returned HTTP ${res.status} on /me`)
    return 1
  }
  const me = (await res.json().catch(() => ({}))) as { projects?: unknown }
  const projects = (Array.isArray(me.projects) ? me.projects : []).filter(
    (p): p is CpProject => typeof p === 'object' && p !== null && typeof (p as CpProject).id === 'string' && typeof (p as CpProject).name === 'string',
  )

  const picked = pickClonedProject(projects, ref)
  if ('error' in picked) {
    err(`neat project clone: ${picked.error}`)
    return 1
  }
  const project = picked.project
  if (!project.neatProjectId || !PROJECT_ID_RE.test(project.neatProjectId)) {
    err(
      `neat project clone: ${label(project)} has no NEAT project id yet. It was created in the console, not promoted from a checkout. ` +
        'Promote a checkout to it with `neat project promote`, or `neat init` here for a new local project.',
    )
    return 1
  }

  try {
    const identity = await writeProjectIdentity(root, { projectId: project.neatProjectId, name: label(project) })
    await writeProjectBinding(root, { binding: 'local' })
    out(`neat project clone: ${identity.name} (${identity.projectId}) is now local in ${root}`)
    out('neat project clone: start its daemon here with `neat up`; the hosted graph is not copied down')
    out(bindingLine({ name: identity.name, projectId: identity.projectId, binding: 'local', daemon: '(not running)' }))
    return 0
  } catch (e) {
    if (e instanceof ProjectIdentityError) {
      err(`neat project clone: ${e.message}`)
      return 1
    }
    throw e
  }
}
