/**
 * Machine-level project registry + machine-wide daemon discovery.
 *
 * This module owns two surfaces under `~/.neat/`:
 *
 *  1. The legacy project registry at `~/.neat/projects.json` (ADR-048). One
 *     file, per-user, machine-local, not synced. Under the project-daemon
 *     contract (ADR-096) it is no longer the coordination point — it is read
 *     once for migration and otherwise left to the additive writes the daemon
 *     and orchestrator still perform. The read-modify-write helpers below keep
 *     their atomic-write + exclusive-lock machinery for that legacy surface.
 *
 *  2. The machine-wide daemon discovery directory at `~/.neat/daemons/`
 *     (ADR-096 §6). One file per running daemon — `<project>.json` — each owned
 *     solely by the daemon that wrote it (on start) and removes it (on graceful
 *     stop). Discovery is **append-only and lock-free**: a reader scans the
 *     directory and reconciles liveness; it never acquires a shared lock, so it
 *     can never deadlock against a daemon (#506). Losing or rebuilding the
 *     directory costs discovery convenience, not correctness — each project's
 *     own `neat-out/daemon.json` stays authoritative.
 *
 * `neat ps` / `neat list` and the per-daemon `pause` / `resume` / `uninstall`
 * verbs read discovery, falling back to the legacy registry where no daemon
 * file is present yet (the migration window before every daemon self-describes).
 *
 * The legacy lock is a file we exclusively-create (`O_EXCL`), hold while we
 * mutate, and unlink on the way out. Crude but cross-platform; matches what
 * `proper-lockfile` does internally without pulling the dep in. It never sits
 * on the discovery path.
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
// #366 / ADR-096 §6 — machine-wide daemon discovery, lock-free.
//
// Each running daemon drops a `<project>.json` file into `~/.neat/daemons/`
// on start and removes it on graceful stop. The file is a copy of that
// project's authoritative `neat-out/daemon.json` record. A daemon owns only
// its own file — there is no shared file and no shared lock. Discovery reads
// the directory and reconciles liveness; it never acquires a lock, so it can
// never deadlock against a daemon mid-write the way the registry lock did
// (#506). The shape mirrors what the daemon writes (keystone #508); we read it
// as plain JSON rather than importing the daemon's writer so the two stay
// decoupled, and validate defensively so a malformed file is skipped, not
// fatal.
// ─────────────────────────────────────────────────────────────────────────

export interface DaemonPorts {
  rest: number
  otlp: number
  web: number
}

export interface DaemonRecord {
  project: string
  // Project root whose `neat-out/` holds the authoritative record.
  projectPath: string
  pid: number
  status: 'running' | 'stopped'
  ports: DaemonPorts
  // ISO8601.
  startedAt: string
  neatVersion: string
}

// A discovered daemon plus the liveness verdict the reader reconciled. `live`
// is true only when the record claims `running` AND its pid is actually alive
// — a daemon that crashed without clearing its file reads as `running` but
// `live: false`, so `neat ps` never reports a ghost as up.
export interface DiscoveredDaemon {
  record: DaemonRecord
  live: boolean
  // Where the discovery copy was read from. Useful for diagnostics and for the
  // per-daemon verbs that clean a stale file.
  source: string
}

export function daemonsDir(): string {
  return path.join(neatHome(), 'daemons')
}

function isFiniteInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

// Parse one discovery file's contents into a DaemonRecord, or undefined when
// the shape doesn't hold. Defensive on purpose: discovery is convenience, so a
// half-written or hand-edited file is skipped rather than crashing `neat ps`.
function parseDaemonRecord(raw: string): DaemonRecord | undefined {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof obj !== 'object' || obj === null) return undefined
  const r = obj as Record<string, unknown>
  const ports = r.ports as Record<string, unknown> | undefined
  if (
    typeof r.project !== 'string' ||
    typeof r.projectPath !== 'string' ||
    !isFiniteInt(r.pid) ||
    (r.status !== 'running' && r.status !== 'stopped') ||
    typeof r.startedAt !== 'string' ||
    typeof r.neatVersion !== 'string' ||
    !ports ||
    !isFiniteInt(ports.rest) ||
    !isFiniteInt(ports.otlp) ||
    !isFiniteInt(ports.web)
  ) {
    return undefined
  }
  return {
    project: r.project,
    projectPath: r.projectPath,
    pid: r.pid,
    status: r.status,
    ports: { rest: ports.rest, otlp: ports.otlp, web: ports.web },
    startedAt: r.startedAt,
    neatVersion: r.neatVersion,
  }
}

// Liveness for a discovered daemon. Exported (via the default probe) so the
// verbs and tests reconcile the same way: `running` claim AND pid alive.
export function isPidAlive(pid: number): boolean {
  return isPidAliveDefault(pid)
}

export interface DiscoveryProbe {
  isPidAlive(pid: number): boolean
}

const defaultDiscoveryProbe: DiscoveryProbe = { isPidAlive: isPidAliveDefault }

/**
 * Scan `~/.neat/daemons/` and return every well-formed discovery record with
 * its reconciled liveness. Lock-free: a plain directory read, no rendezvous.
 *
 * A missing directory (no daemon has ever started under this model) yields an
 * empty list — first run, nothing to discover. Malformed or unreadable files
 * are skipped silently; discovery degrades to "fewer entries," never an error.
 */
export async function discoverDaemons(
  probe: DiscoveryProbe = defaultDiscoveryProbe,
): Promise<DiscoveredDaemon[]> {
  const dir = daemonsDir()
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: DiscoveredDaemon[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(dir, name)
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    const record = parseDaemonRecord(raw)
    if (!record) continue
    const live = record.status === 'running' && probe.isPidAlive(record.pid)
    out.push({ record, live, source: file })
  }
  out.sort((a, b) => a.record.project.localeCompare(b.record.project))
  return out
}

/**
 * Remove a daemon's discovery file. A daemon owns its own file, so this is for
 * the per-daemon verbs reconciling a record whose daemon is gone (a crashed
 * daemon that never cleared its own file) — never a rendezvous another process
 * coordinates through. Best-effort: an already-absent file is success.
 */
export async function removeDaemonRecord(source: string): Promise<void> {
  await fs.unlink(source).catch(() => {})
}

// ─────────────────────────────────────────────────────────────────────────
// #366 / ADR-096 §8 — migration off the global registry.
//
// Installs carrying `~/.neat/projects.json` map their registered projects onto
// per-project daemons on first run under this model. The discovery directory is
// authoritative for "what's running"; the registry is read once to surface
// projects that were registered before any daemon self-described, so the
// machine-wide verbs still see them during the migration window. The registry
// is no longer the coordination surface — nothing here writes it back.
// ─────────────────────────────────────────────────────────────────────────

// A unified view for the machine-wide verbs: a discovered daemon when one is
// present, otherwise a legacy registry entry projected into the same shape so
// `neat ps` / `neat list` render one table regardless of which surface the
// project lives on yet.
export interface MachineProject {
  project: string
  projectPath: string
  // 'running' / 'stopped' come from a live discovery record; 'registered'
  // marks a legacy registry entry with no daemon file yet (migration window).
  state: 'running' | 'stopped' | 'registered'
  // Present only when a discovery record backs this row.
  ports?: DaemonPorts
  // Legacy registry status when the row came from the registry; undefined for
  // a discovery-backed row.
  registryStatus?: RegistryStatus
  pid?: number
}

/**
 * The machine-wide project view the CLI verbs render. Discovery wins: every
 * `~/.neat/daemons/` record becomes a row (running or stopped per liveness).
 * Legacy registry entries whose path isn't already covered by a discovery
 * record are folded in as `registered` rows so a pre-#508 install still lists
 * its projects. Keyed on resolved path so a registry entry and its daemon
 * record collapse to one row.
 *
 * Read-only on both surfaces. The registry is read once for migration; nothing
 * here writes it back, in keeping with ADR-096 §8.
 */
export async function listMachineProjects(
  probe: DiscoveryProbe = defaultDiscoveryProbe,
): Promise<MachineProject[]> {
  const discovered = await discoverDaemons(probe)
  const byPath = new Map<string, MachineProject>()
  for (const d of discovered) {
    const key = await normalizeProjectPath(d.record.projectPath)
    byPath.set(key, {
      project: d.record.project,
      projectPath: d.record.projectPath,
      state: d.live ? 'running' : 'stopped',
      ports: d.record.ports,
      pid: d.record.pid,
    })
  }

  // Migration read: legacy registry entries not already covered by a daemon
  // record. Read once, never written back.
  let legacy: RegistryEntry[] = []
  try {
    legacy = (await readRegistry()).projects
  } catch {
    // A corrupt legacy file shouldn't sink discovery — the daemons we found are
    // still valid. Skip the legacy fold.
    legacy = []
  }
  for (const entry of legacy) {
    const key = await normalizeProjectPath(entry.path)
    if (byPath.has(key)) continue
    byPath.set(key, {
      project: entry.name,
      projectPath: entry.path,
      state: 'registered',
      registryStatus: entry.status,
    })
  }

  return [...byPath.values()].sort((a, b) => a.project.localeCompare(b.project))
}

// Find a discovery record by project name, with its reconciled liveness. The
// per-daemon verbs key on the project name the operator types; discovery is the
// source of truth for whether a daemon is running and which pid to signal.
export async function findDaemonByProject(
  name: string,
  probe: DiscoveryProbe = defaultDiscoveryProbe,
): Promise<DiscoveredDaemon | undefined> {
  const discovered = await discoverDaemons(probe)
  return discovered.find((d) => d.record.project === name)
}

// Signal a running daemon to shut down via its discovery-recorded pid. SIGTERM
// is the graceful-stop signal every daemon already wires (neatd.ts) — the
// daemon clears its own discovery file on the way out. Returns true when the
// signal was delivered, false when the pid was already gone (nothing to stop).
export function signalDaemonStop(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch (err) {
    // ESRCH → already gone; treat as a no-op success of intent. EPERM and the
    // rest surface as "couldn't signal" so the verb can report honestly.
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw err
  }
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

// ─────────────────────────────────────────────────────────────────────────
// #463 — prune dead-path entries so the registry doesn't accumulate zombies.
//
// Ephemeral tmp-dir projects (smoke runs, throwaway demos) leave entries whose
// `path` is gone from disk. Without pruning the daemon logs an ENOENT warning
// for each on every startup forever and `/api/health` lists them as permanent
// `broken` rows. Pruning removes user-facing state, so it's deliberately
// conservative: we only ever drop an entry on a *definite* ENOENT (the path is
// genuinely gone). A transient stat failure — EACCES, EBUSY, an unmounted
// drive — leaves the entry untouched; it isn't dead, just unreachable.
//
// Two modes:
//  - Auto-prune (daemon bootstrap / reload) gates removal on a staleness TTL.
//    An ENOENT entry is only dropped if its `lastSeenAt` is older than the TTL,
//    so a recently-active project whose path is temporarily unavailable stays.
//  - `neat prune` is explicit user intent, so it drops any ENOENT entry
//    immediately regardless of age.
// ─────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000
// Default 7 days, mirroring NEAT_STALE_THRESHOLDS' env-override shape.
export const DEFAULT_PRUNE_TTL_MS = 7 * DAY_MS

export function pruneTtlMs(): number {
  const raw = process.env.NEAT_REGISTRY_PRUNE_TTL_MS
  if (!raw) return DEFAULT_PRUNE_TTL_MS
  const n = Number.parseInt(raw, 10)
  if (Number.isFinite(n) && n >= 0) return n
  console.warn(
    `[neat] NEAT_REGISTRY_PRUNE_TTL_MS could not be parsed (${raw}); using default ${DEFAULT_PRUNE_TTL_MS}ms`,
  )
  return DEFAULT_PRUNE_TTL_MS
}

// Classify a single path: 'gone' (definite ENOENT), 'present' (stat succeeded,
// directory exists), or 'unknown' (a transient/ambiguous error — never prune).
// Exported so the daemon and tests can probe the same logic.
export type PathStatus = 'gone' | 'present' | 'unknown'

async function statPathStatus(p: string): Promise<PathStatus> {
  try {
    const stat = await fs.stat(p)
    return stat.isDirectory() ? 'present' : 'unknown'
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'unknown'
  }
}

export interface PruneOptions {
  // Override the staleness gate. Auto-prune passes a TTL; `neat prune` passes
  // `ttlMs: 0` to drop any ENOENT entry immediately. Default is the env-driven
  // TTL.
  ttlMs?: number
  // Override the path probe (tests drive ENOENT / EACCES / present branches
  // without a real filesystem). Defaults to a real stat.
  statPath?: (p: string) => Promise<PathStatus>
  // Clock injection for the staleness comparison; defaults to Date.now().
  now?: () => number
}

/**
 * Remove registry entries whose `path` is definitely gone (ENOENT). Goes
 * through the same lock + atomic-write path as every other mutation — never a
 * raw rewrite — so the contract's atomicity invariant holds.
 *
 * Staleness gate: an ENOENT entry is dropped only when `ttlMs` is 0 (explicit
 * `neat prune`) or its `lastSeenAt` (falling back to `registeredAt`) is older
 * than `ttlMs`. A fresh ENOENT entry under a non-zero TTL is left in place — the
 * daemon still marks it `broken`, the TTL is the safety margin before removal.
 *
 * Returns the entries that were removed.
 */
export async function pruneRegistry(opts: PruneOptions = {}): Promise<RegistryEntry[]> {
  const ttlMs = opts.ttlMs ?? pruneTtlMs()
  const statPath = opts.statPath ?? statPathStatus
  const now = opts.now ?? Date.now

  return withLock(async () => {
    const reg = await readRegistry()
    const removed: RegistryEntry[] = []
    const kept: RegistryEntry[] = []
    for (const entry of reg.projects) {
      const status = await statPath(entry.path)
      if (status !== 'gone') {
        // Present, or a transient/ambiguous error — keep it. We only prune on a
        // definite ENOENT.
        kept.push(entry)
        continue
      }
      // Path is gone. Drop it immediately when there's no TTL gate, otherwise
      // only once it's been quiet longer than the TTL.
      if (ttlMs <= 0) {
        removed.push(entry)
        continue
      }
      const lastSeen = Date.parse(entry.lastSeenAt ?? entry.registeredAt)
      const age = now() - (Number.isFinite(lastSeen) ? lastSeen : 0)
      if (age > ttlMs) {
        removed.push(entry)
      } else {
        kept.push(entry)
      }
    }
    if (removed.length === 0) return []
    reg.projects = kept
    await writeRegistry(reg)
    return removed
  })
}

