/**
 * Machine-level project registry (ADR-048).
 *
 * One file: `~/.neat/projects.json`. Per-user, machine-local. Not synced.
 * `registry.ts` is the only module that opens it. Everything else — `init`,
 * `daemon`, `cli` — calls into the helpers below.
 *
 * Two safety properties matter:
 *  1. Atomic writes. We tmp + fsync + rename so the daemon never sees a torn
 *     file when init races against it.
 *  2. Cross-process exclusion. We hold an exclusive lock on
 *     `~/.neat/projects.json.lock` for the read-modify-write window. Two
 *     concurrent `neat init` runs cannot both win and overwrite each other.
 *
 * The lock is a file we exclusively-create (`O_EXCL`), hold while we mutate,
 * and unlink on the way out. Crude but cross-platform; matches what
 * `proper-lockfile` does internally without pulling the dep in.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  RegistryFileSchema,
  type RegistryEntry,
  type RegistryFile,
  type RegistryStatus,
} from '@neat.is/types'

const LOCK_TIMEOUT_MS = 5_000
const LOCK_RETRY_MS = 50

// Resolve `~/.neat/` per call so tests can override `HOME` / `NEAT_HOME`
// before each run without module-load order mattering.
function neatHome(): string {
  const override = process.env.NEAT_HOME
  if (override && override.length > 0) return path.resolve(override)
  return path.join(os.homedir(), '.neat')
}

export function registryPath(): string {
  return path.join(neatHome(), 'projects.json')
}

export function registryLockPath(): string {
  return path.join(neatHome(), 'projects.json.lock')
}

// The daemon writes its PID here on startup (daemon.ts). It's the authoritative
// "is a neat daemon running" signal — more reliable than matching the lock's
// own PID, since the daemon holds the registry lock only for brief read-modify-
// write windows and an init that contends usually catches an orphaned lock
// rather than the daemon mid-write.
function daemonPidPath(): string {
  return path.join(neatHome(), 'neatd.pid')
}

// ─────────────────────────────────────────────────────────────────────────
// #432 — distinguish a live daemon from a genuinely stale lock.
//
// `neat init` used to hang the full timeout on any contended lock and then
// print one remediation: "remove the file by hand." That advice is actively
// dangerous when a neat daemon is alive — the daemon grabs the lock for its
// own registry writes, so hand-removing it races the daemon and corrupts the
// registry for the live process. The lock now carries the holder PID, and the
// timeout (or first contention with a live daemon) resolves to a message that
// names who holds it and what's safe to do.
// ─────────────────────────────────────────────────────────────────────────

export type LockHolder =
  | { kind: 'daemon'; pid: number }
  | { kind: 'command'; pid: number }
  | { kind: 'stale' }

// Probes the holder-resolution logic depends on, broken out so tests can drive
// each branch without a real daemon or live PIDs.
export interface LockHolderProbe {
  // POSIX liveness via `process.kill(pid, 0)`: true if the process exists
  // (including EPERM — alive but owned by another user), false if it's gone.
  isPidAlive(pid: number): boolean
  // PID recorded in `~/.neat/neatd.pid`, or undefined if there's no pidfile.
  daemonPidFromFile(): Promise<number | undefined>
  // Whether the daemon's always-open `/health` endpoint answers. Confirms a
  // live neatd.pid is actually our daemon and not a reused PID.
  daemonResponds(): Promise<boolean>
}

function isPidAliveDefault(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH → no such process (dead). EPERM → exists but owned by another user
    // (alive). Treat anything else as not-alive: we'd rather under-claim a live
    // holder than wrongly block on a lock we can't verify.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readPidFile(file: string): Promise<number | undefined> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    const pid = Number.parseInt(raw.trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

const defaultLockHolderProbe: LockHolderProbe = {
  isPidAlive: isPidAliveDefault,
  daemonPidFromFile: () => readPidFile(daemonPidPath()),
  async daemonResponds(): Promise<boolean> {
    const base = process.env.NEAT_API_URL ?? 'http://localhost:8080'
    try {
      // `/health` stays unauthenticated in every mode (auth.ts), so a reachable
      // daemon answers it even with a bearer token set. Any HTTP response — not
      // just 2xx — means a daemon owns the port. A short timeout keeps the
      // fail-fast path well under a second.
      await fetch(`${base}/health`, { signal: AbortSignal.timeout(750) })
      return true
    } catch {
      return false
    }
  },
}

// Read the PID a lock holder recorded when it created the lock. Undefined for a
// legacy empty lock, an unreadable file, or a lock unlinked out from under us.
async function readLockPid(lockPath: string): Promise<number | undefined> {
  return readPidFile(lockPath)
}

// Decide who holds (or orphaned) the lock. A live daemon dominates: while neatd
// is alive, hand-removing the lock is never safe, so we surface the daemon
// message even when the lock itself is an empty orphan. We never classify our
// own process as the blocking daemon — a daemon serializing two of its own
// registry writes contends with itself briefly and should just retry.
export async function classifyLockHolder(
  lockPath: string,
  probe: LockHolderProbe = defaultLockHolderProbe,
): Promise<LockHolder> {
  const lockPid = await readLockPid(lockPath)
  const daemonPid = await probe.daemonPidFromFile()
  if (
    daemonPid !== undefined &&
    daemonPid !== process.pid &&
    probe.isPidAlive(daemonPid) &&
    // The lock already names the daemon, or the daemon answers on its port.
    // Either confirms a live daemon is in the picture (the second guards
    // against a stale pidfile whose PID got reused).
    (daemonPid === lockPid || (await probe.daemonResponds()))
  ) {
    return { kind: 'daemon', pid: daemonPid }
  }
  if (lockPid !== undefined && lockPid !== process.pid && probe.isPidAlive(lockPid)) {
    return { kind: 'command', pid: lockPid }
  }
  return { kind: 'stale' }
}

export function lockHolderMessage(holder: LockHolder, lockPath: string, timeoutMs: number): string {
  switch (holder.kind) {
    case 'daemon':
      return (
        `The neat daemon (pid ${holder.pid}) is holding the registry lock. ` +
        'Register this project through the daemon, or stop neatd and re-run `neat init`.'
      )
    case 'command':
      return (
        `Another neat command (pid ${holder.pid}) is holding the registry lock. ` +
        "Wait for it to finish, or check `ps` if you're not sure what's running."
      )
    case 'stale':
      return (
        `neat registry: timed out after ${timeoutMs}ms waiting for ${lockPath}. ` +
        'Another neat process is holding the lock; if no such process exists, remove the file by hand.'
      )
  }
}

/**
 * Path normalisation per ADR-048 #7. Two `init` calls from different relative
 * paths to the same dir must collapse to one entry. `path.resolve` handles
 * relative-to-cwd; we pass it through `fs.realpath` when the dir exists so
 * symlinked paths land on the same canonical entry too.
 */
export async function normalizeProjectPath(input: string): Promise<string> {
  const resolved = path.resolve(input)
  try {
    return await fs.realpath(resolved)
  } catch {
    return resolved
  }
}

/**
 * tmp + fsync + rename. The fsync on the data fd guarantees the bytes are on
 * disk before rename swaps the inode; rename itself is atomic on POSIX.
 *
 * Exported so the init flow and test harnesses can use the same helper.
 */
export async function writeAtomically(target: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  const fd = await fs.open(tmp, 'w')
  try {
    await fd.writeFile(contents, 'utf8')
    await fd.sync()
  } finally {
    await fd.close()
  }
  await fs.rename(tmp, target)
}

async function acquireLock(
  lockPath: string,
  timeoutMs: number = LOCK_TIMEOUT_MS,
  probe: LockHolderProbe = defaultLockHolderProbe,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  let probedHolder = false
  while (true) {
    try {
      const fd = await fs.open(lockPath, 'wx')
      try {
        // Stamp the lock with our PID so a contender can name who holds it and
        // tell a live holder apart from a stale file. Best-effort: an empty
        // lock still excludes correctly, it just can't be diagnosed.
        await fd.writeFile(`${process.pid}\n`, 'utf8')
      } finally {
        await fd.close()
      }
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw err
      // A live daemon holds the registry continuously enough that spinning the
      // full timeout is pointless — surface the routed remediation on the first
      // contention. Peer commands and stale locks fall through to the retry:
      // peers clear on their own, and a stale lock wants the timeout's guidance.
      if (!probedHolder) {
        probedHolder = true
        const holder = await classifyLockHolder(lockPath, probe)
        if (holder.kind === 'daemon') throw new Error(lockHolderMessage(holder, lockPath, timeoutMs))
      }
      if (Date.now() >= deadline) {
        const holder = await classifyLockHolder(lockPath, probe)
        throw new Error(lockHolderMessage(holder, lockPath, timeoutMs))
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS))
    }
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  await fs.unlink(lockPath).catch(() => {})
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = registryLockPath()
  await acquireLock(lock)
  try {
    return await fn()
  } finally {
    await releaseLock(lock)
  }
}

/**
 * Read the registry from disk. Returns an empty registry if the file does
 * not exist yet — first run, never registered anything.
 *
 * Throws on parse / schema errors. The contract is single-source-of-truth;
 * a corrupt file is louder than a silent reset.
 */
export async function readRegistry(): Promise<RegistryFile> {
  const file = registryPath()
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, projects: [] }
    }
    throw err
  }
  const parsed = JSON.parse(raw)
  return RegistryFileSchema.parse(parsed)
}

async function writeRegistry(reg: RegistryFile): Promise<void> {
  // Re-parse before writing to surface schema drift introduced by callers
  // mutating the in-memory object directly.
  const validated = RegistryFileSchema.parse(reg)
  await writeAtomically(registryPath(), JSON.stringify(validated, null, 2) + '\n')
}

export interface AddProjectOptions {
  name: string
  path: string
  languages?: string[]
  status?: RegistryStatus
}

export class ProjectNameCollisionError extends Error {
  readonly projectName: string
  constructor(name: string) {
    super(`neat registry: a project named "${name}" is already registered`)
    this.name = 'ProjectNameCollisionError'
    this.projectName = name
  }
}

/**
 * Register a project, or update its `lastSeenAt` if the same path is already
 * registered under the same name (idempotent re-init).
 *
 * Hard error on name collision against a different path — ADR-046 #7. The
 * caller can recover by passing `--project <new-name>`.
 */
export async function addProject(opts: AddProjectOptions): Promise<RegistryEntry> {
  const resolvedPath = await normalizeProjectPath(opts.path)
  return withLock(async () => {
    const reg = await readRegistry()
    const byName = reg.projects.find((p) => p.name === opts.name)
    const byPath = reg.projects.find((p) => p.path === resolvedPath)

    if (byName && byName.path !== resolvedPath) {
      throw new ProjectNameCollisionError(opts.name)
    }

    const now = new Date().toISOString()

    if (byName && byName.path === resolvedPath) {
      // Idempotent re-register: same name, same path. Refresh languages /
      // status if the caller passed new ones.
      byName.lastSeenAt = now
      if (opts.languages) byName.languages = opts.languages
      if (opts.status) byName.status = opts.status
      await writeRegistry(reg)
      return byName
    }

    if (byPath && byPath.name !== opts.name) {
      // Same dir already registered under a different name. Treat as a
      // collision so the user is forced to decide which name wins.
      throw new ProjectNameCollisionError(byPath.name)
    }

    const entry: RegistryEntry = {
      name: opts.name,
      path: resolvedPath,
      registeredAt: now,
      languages: opts.languages ?? [],
      status: opts.status ?? 'active',
    }
    reg.projects.push(entry)
    await writeRegistry(reg)
    return entry
  })
}

export async function getProject(name: string): Promise<RegistryEntry | undefined> {
  const reg = await readRegistry()
  return reg.projects.find((p) => p.name === name)
}

export async function listProjects(): Promise<RegistryEntry[]> {
  const reg = await readRegistry()
  return reg.projects
}

export async function setStatus(name: string, status: RegistryStatus): Promise<RegistryEntry> {
  return withLock(async () => {
    const reg = await readRegistry()
    const entry = reg.projects.find((p) => p.name === name)
    if (!entry) throw new Error(`neat registry: no project named "${name}"`)
    entry.status = status
    await writeRegistry(reg)
    return entry
  })
}

export async function touchLastSeen(name: string, at: string = new Date().toISOString()): Promise<void> {
  await withLock(async () => {
    const reg = await readRegistry()
    const entry = reg.projects.find((p) => p.name === name)
    if (!entry) return
    entry.lastSeenAt = at
    await writeRegistry(reg)
  })
}

/**
 * Remove the registry entry for `name`. Per ADR-048 #6: this only removes the
 * registry row. It does **not** touch `neat-out/`, `policy.json`, or any user
 * file in the project directory. SDK-install rollback is a separate flow
 * (`neat-rollback.patch`) that the caller opts in to.
 */
export async function removeProject(name: string): Promise<RegistryEntry | undefined> {
  return withLock(async () => {
    const reg = await readRegistry()
    const idx = reg.projects.findIndex((p) => p.name === name)
    if (idx < 0) return undefined
    const [removed] = reg.projects.splice(idx, 1)
    await writeRegistry(reg)
    return removed
  })
}

