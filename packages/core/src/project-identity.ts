import { existsSync, promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

// A project's identity and this machine's binding to it (ADR-273,
// docs/contracts/project-identity.md).
//
//   <repo>/.neat/project.json   committed: { schemaVersion, projectId, name }
//   <repo>/.neat/binding.json   gitignored: { schemaVersion, binding, org? }
//   <repo>/.neat/.gitignore     keeps binding.json and connectors.json out of commits
//
// projectId is `prj_` + a ULID, minted once and never changed by NEAT; name is for
// people and may repeat. This module is the one place those files are read and
// written; the CLI, the MCP server and the registry call into it.

export const NEAT_DIR = '.neat'
export const PROJECT_FILE = 'project.json'
export const BINDING_FILE = 'binding.json'
export const PROJECT_SCHEMA_VERSION = 1
export const BINDING_SCHEMA_VERSION = 1
// What .neat/.gitignore keeps out of commits: this machine's binding and the
// project's connector references.
export const NEAT_DIR_IGNORES = ['binding.json', 'connectors.json']

export interface ProjectIdentity {
  schemaVersion: 1
  projectId: string
  name: string
}

export type BindingKind = 'local' | 'hosted'

export interface ProjectBinding {
  schemaVersion: 1
  binding: BindingKind
  org?: string
  daemonHint?: { port: number }
}

export class ProjectIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectIdentityError'
  }
}

// ── ids ──────────────────────────────────────────────────────────────────────

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const PROJECT_ID_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/

/**
 * `prj_` + a ULID: 48 bits of millisecond time then 80 random bits, in
 * Crockford base32 (26 characters). Time-ordered, collision-free in practice,
 * and readable. No dependency: the encoding is a few lines.
 */
export function mintProjectId(now: number = Date.now(), rand: Buffer = randomBytes(10)): string {
  let time = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  let bits = 0n
  for (const b of rand.subarray(0, 10)) bits = (bits << 8n) | BigInt(b)
  let random = ''
  for (let i = 0; i < 16; i++) {
    random = CROCKFORD[Number(bits & 31n)] + random
    bits >>= 5n
  }
  return `prj_${time}${random}`
}

// ── paths ────────────────────────────────────────────────────────────────────

export function neatDir(root: string): string {
  return path.join(root, NEAT_DIR)
}
export function projectFilePath(root: string): string {
  return path.join(root, NEAT_DIR, PROJECT_FILE)
}
export function bindingFilePath(root: string): string {
  return path.join(root, NEAT_DIR, BINDING_FILE)
}

// ── reading ──────────────────────────────────────────────────────────────────

async function readJson(file: string): Promise<unknown | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new ProjectIdentityError(`${file} is not valid JSON`)
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// One validator per file, shared by the async and sync readers.
function parseIdentity(v: unknown, file: string): ProjectIdentity {
  if (!isObj(v)) throw new ProjectIdentityError(`${file} must be a JSON object`)
  if (v['schemaVersion'] !== PROJECT_SCHEMA_VERSION) {
    throw new ProjectIdentityError(
      `${file} has schemaVersion ${JSON.stringify(v['schemaVersion'])}; this NEAT reads version ${PROJECT_SCHEMA_VERSION}`,
    )
  }
  const projectId = v['projectId']
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) {
    throw new ProjectIdentityError(`${file} has no valid projectId (expected prj_ followed by a 26-character ULID)`)
  }
  const name = v['name']
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ProjectIdentityError(`${file} has no name`)
  }
  return { schemaVersion: 1, projectId, name }
}

const ABSENT_BINDING: ProjectBinding & { absent: boolean } = { schemaVersion: 1, binding: 'local', absent: true }

function parseBinding(v: unknown, file: string): ProjectBinding & { absent: boolean } {
  if (!isObj(v)) throw new ProjectIdentityError(`${file} must be a JSON object`)
  if (v['schemaVersion'] !== BINDING_SCHEMA_VERSION) {
    throw new ProjectIdentityError(
      `${file} has schemaVersion ${JSON.stringify(v['schemaVersion'])}; this NEAT reads version ${BINDING_SCHEMA_VERSION}`,
    )
  }
  const binding = v['binding']
  if (binding !== 'local' && binding !== 'hosted') {
    throw new ProjectIdentityError(`${file}: binding must be "local" or "hosted"`)
  }
  const org = typeof v['org'] === 'string' && v['org'].length > 0 ? v['org'] : undefined
  if (binding === 'hosted' && !org) throw new ProjectIdentityError(`${file}: a hosted binding needs an org`)
  const hint = v['daemonHint']
  const port = isObj(hint) && typeof hint['port'] === 'number' ? hint['port'] : undefined
  return {
    schemaVersion: 1,
    binding,
    ...(org ? { org } : {}),
    ...(port !== undefined ? { daemonHint: { port } } : {}),
    absent: false,
  }
}

/** The project's identity at `root`, or undefined when it has none. */
export async function readProjectIdentity(root: string): Promise<ProjectIdentity | undefined> {
  const file = projectFilePath(root)
  const v = await readJson(file)
  return v === undefined ? undefined : parseIdentity(v, file)
}

/**
 * How this machine reaches the project at `root`. A missing binding.json is
 * `local`, and `absent` says so, so a caller can tell the user instead of
 * assuming silently.
 */
export async function readProjectBinding(root: string): Promise<ProjectBinding & { absent: boolean }> {
  const file = bindingFilePath(root)
  const v = await readJson(file)
  return v === undefined ? { ...ABSENT_BINDING } : parseBinding(v, file)
}

// ── synchronous twins (the MCP server resolves at module load) ───────────────

function readJsonSync(file: string): unknown | undefined {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new ProjectIdentityError(`${file} is not valid JSON`)
  }
}

export function readProjectIdentitySync(root: string): ProjectIdentity | undefined {
  const file = projectFilePath(root)
  const v = readJsonSync(file)
  return v === undefined ? undefined : parseIdentity(v, file)
}

export function readBindingSync(root: string): ProjectBinding & { absent: boolean } {
  const file = bindingFilePath(root)
  const v = readJsonSync(file)
  return v === undefined ? { ...ABSENT_BINDING } : parseBinding(v, file)
}

export function findProjectRootSync(start: string): string | undefined {
  let dir = path.resolve(start)
  for (;;) {
    if (existsSync(projectFilePath(dir))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** `readProjectBinding` under the name the other Phase 0 work orders use. */
export const readBinding = readProjectBinding

/**
 * The nearest directory at or above `start` that holds a `.neat/project.json`,
 * or undefined. Stops at the filesystem root.
 */
export async function findProjectRoot(start: string): Promise<string | undefined> {
  let dir = path.resolve(start)
  for (;;) {
    try {
      await fs.access(projectFilePath(dir))
      return dir
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

// ── writing ──────────────────────────────────────────────────────────────────

async function writeAtomic(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, contents, 'utf8')
  await fs.rename(tmp, file)
}

// .neat/.gitignore lists binding.json and connectors.json; an existing file keeps
// its own lines and gains only what is missing.
async function ensureNeatDirIgnores(root: string): Promise<boolean> {
  const file = path.join(neatDir(root), '.gitignore')
  let current = ''
  try {
    current = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()))
  const missing = NEAT_DIR_IGNORES.filter((l) => !have.has(l))
  if (missing.length === 0) return false
  const prefix = current.length === 0 ? '# Per-machine NEAT state (ADR-273): never committed.\n' : current.endsWith('\n') ? current : `${current}\n`
  await writeAtomic(file, `${prefix}${missing.join('\n')}\n`)
  return true
}

export interface EnsureIdentityResult {
  identity: ProjectIdentity
  binding: ProjectBinding
  // What this call created, for the caller's report.
  createdIdentity: boolean
  createdBinding: boolean
  renamed: boolean
  writtenFiles: string[]
}

/**
 * Give the project at `root` its identity, or keep the one it has (ADR-273).
 * Mints a projectId only when no .neat/project.json exists; a re-run keeps the id.
 * `name` sets the display name on first mint; on a re-run it renames only when
 * `rename` is set (an explicit --project). Writes a local binding.json only when
 * none exists, and makes sure .neat/.gitignore keeps the per-machine files out of
 * commits. Idempotent.
 */
export async function ensureProjectIdentity(
  root: string,
  opts: { name: string; rename?: boolean; now?: number },
): Promise<EnsureIdentityResult> {
  const writtenFiles: string[] = []
  const name = opts.name.trim()
  if (name.length === 0) throw new ProjectIdentityError('a project needs a name')

  let identity = await readProjectIdentity(root)
  let createdIdentity = false
  let renamed = false
  if (!identity) {
    identity = { schemaVersion: 1, projectId: mintProjectId(opts.now), name }
    createdIdentity = true
  } else if (opts.rename && identity.name !== name) {
    identity = { ...identity, name }
    renamed = true
  }
  if (createdIdentity || renamed) {
    await writeAtomic(projectFilePath(root), `${JSON.stringify(identity, null, 2)}\n`)
    writtenFiles.push(projectFilePath(root))
  }

  const current = await readProjectBinding(root)
  let createdBinding = false
  if (current.absent) {
    await writeAtomic(bindingFilePath(root), `${JSON.stringify({ schemaVersion: 1, binding: 'local' }, null, 2)}\n`)
    writtenFiles.push(bindingFilePath(root))
    createdBinding = true
  }
  const { absent: _absent, ...binding } = current.absent ? { ...current, absent: false } : current

  if (await ensureNeatDirIgnores(root)) writtenFiles.push(path.join(neatDir(root), '.gitignore'))

  return { identity, binding, createdIdentity, createdBinding, renamed, writtenFiles }
}

/**
 * Set how this machine reaches the project at `root` (project-identity.md §2):
 * `local`, or `hosted` in `org`. The one writer of binding.json besides `init`.
 */
export async function writeProjectBinding(root: string, b: { binding: BindingKind; org?: string }): Promise<ProjectBinding> {
  if (b.binding === 'hosted' && (!b.org || b.org.trim().length === 0)) {
    throw new ProjectIdentityError('a hosted binding needs an org')
  }
  const value: ProjectBinding = { schemaVersion: 1, binding: b.binding, ...(b.binding === 'hosted' ? { org: b.org!.trim() } : {}) }
  await writeAtomic(bindingFilePath(root), `${JSON.stringify(value, null, 2)}\n`)
  await ensureNeatDirIgnores(root)
  return value
}

/** One line for a run's report: what `ensureProjectIdentity` did. */
export function identityReportLine(r: EnsureIdentityResult): string {
  const id = `${r.identity.name} (${r.identity.projectId})`
  if (r.createdIdentity) return `project identity: minted ${id} in ${NEAT_DIR}/${PROJECT_FILE}, binding ${r.binding.binding}`
  if (r.renamed) return `project identity: renamed to ${id}`
  return `project identity: ${id}, binding ${r.binding.binding}`
}

// ── the binding line (project-identity.md §6) ────────────────────────────────

/**
 * What a client is talking to: the resolved project, how it was reached, and the
 * daemon that answered. `projectId` is absent only for a legacy project that has
 * no .neat/project.json yet (§3 level 4).
 */
export interface ResolvedIdentity {
  name: string
  projectId?: string
  binding: BindingKind | 'pinned'
  org?: string
  // The endpoint URL, or `pid:<pid>:<port>` for a local daemon reported by process.
  daemon: string
}

/**
 * The one line every daemon response, MCP result and error, `neat://status` and
 * CLI read verb carries:
 * `project=<name> (<projectId>) · binding=<local | hosted@<org> | pinned> · daemon=<daemon>`.
 * One renderer, so every surface prints it the same way (#1373).
 */
export function bindingLine(id: ResolvedIdentity): string {
  const binding = id.binding === 'hosted' ? `hosted@${id.org ?? '?'}` : id.binding
  return `project=${id.name} (${id.projectId ?? 'no id yet'}) · binding=${binding} · daemon=${id.daemon}`
}
