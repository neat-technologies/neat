// The machine index (ADR-273, docs/contracts/project-registry.md, #1513).
//
// `~/.neat/registry.json` (version 2) records where this machine has seen each
// project, keyed by the projectId in the project's own committed
// `.neat/project.json`. It is an index, not the identity, so it can always be
// rebuilt: every known path is re-read through project-identity.ts. Known paths
// come from the index itself, the daemon discovery directory, and the pre-273
// `~/.neat/projects.json`, which is only ever read (still the file `neat init`
// registers into until the resolution rewrite moves registration here).
//
// `machineInventory()` is what `neat list` renders: the rows split by binding,
// and the things the machine is holding that it shouldn't be: orphans (a
// `neat-out/` with no `.neat/project.json`), stale rows (path gone, daemon dead),
// names several rows share, and `@neat.is/mcp` processes whose parent died.
// Listing never kills anything; `reapOrphanedMcp()` is the opt-in.

import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import {
  RegistryIndexFileSchema,
  type RegistryIndexEntry,
  type RegistryIndexFile,
  type RegistryEntry,
  type RegistryFile,
  RegistryFileSchema,
} from '@neat.is/types'
import {
  discoverDaemons,
  isPidAlive,
  normalizeProjectPath,
  registryPath,
  withRegistryLock,
  writeAtomically,
  type DiscoveredDaemon,
  type DiscoveryProbe,
} from './registry.js'
import { readBinding, readProjectIdentity } from './project-identity.js'

export function registryIndexPath(): string {
  return path.join(path.dirname(registryPath()), 'registry.json')
}

// ── reading the files ────────────────────────────────────────────────────────

async function readIndexFile(): Promise<RegistryIndexFile | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(registryIndexPath(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  // A corrupt index is louder than a silent reset, but it is rebuildable: the
  // error says how.
  try {
    return RegistryIndexFileSchema.parse(JSON.parse(raw))
  } catch {
    throw new Error(`${registryIndexPath()} is not a valid registry; run \`neat list --rebuild\` to rebuild it from disk`)
  }
}

// The pre-273 registry, read only. Unreadable or absent reads as empty: it is a
// source of paths, never of truth.
async function readLegacyRegistry(): Promise<RegistryEntry[]> {
  try {
    const raw = await fs.readFile(registryPath(), 'utf8')
    return (RegistryFileSchema.parse(JSON.parse(raw)) as RegistryFile).projects
  } catch {
    return []
  }
}

async function pathExists(p: string): Promise<'yes' | 'gone' | 'unknown'> {
  try {
    await fs.stat(p)
    return 'yes'
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'unknown'
  }
}

// ── building rows ────────────────────────────────────────────────────────────

interface KnownPath {
  path: string
  projectId?: string
  // What an earlier source said about it, kept when the files don't say more.
  name?: string
  registeredAt?: string
  lastSeenAt?: string
  languages?: string[]
  status?: RegistryIndexEntry['status']
}

function daemonFor(p: string, daemons: Map<string, DiscoveredDaemon>): RegistryIndexEntry['daemon'] {
  const d = daemons.get(p)
  if (!d) return null
  return { pid: d.record.pid, port: d.record.ports.rest, startedAt: d.record.startedAt }
}

async function rowFor(
  known: KnownPath,
  daemons: Map<string, DiscoveredDaemon>,
  now: string,
): Promise<RegistryIndexEntry> {
  const base = {
    path: known.path,
    registeredAt: known.registeredAt ?? now,
    ...(known.lastSeenAt ? { lastSeenAt: known.lastSeenAt } : {}),
    languages: known.languages ?? [],
    daemon: daemonFor(known.path, daemons),
  }
  const fallbackName = known.name ?? path.basename(known.path)
  if ((await pathExists(known.path)) === 'gone') {
    // Nothing to re-read: keep what was known, marked broken.
    return {
      ...base,
      ...(known.projectId ? { projectId: known.projectId } : { legacy: true }),
      name: fallbackName,
      binding: 'local',
      status: 'broken',
    }
  }
  try {
    const identity = await readProjectIdentity(known.path)
    if (!identity) {
      return { ...base, name: fallbackName, binding: 'local', legacy: true, status: known.status ?? 'active' }
    }
    const binding = await readBinding(known.path)
    return {
      ...base,
      projectId: identity.projectId,
      name: identity.name,
      binding: binding.binding,
      ...(binding.org ? { org: binding.org } : {}),
      status: known.status ?? 'active',
    }
  } catch {
    // An identity or binding file NEAT can't read: the row stays, marked broken,
    // so the operator sees it rather than losing the project from the list.
    return { ...base, name: fallbackName, binding: 'local', legacy: true, status: 'broken' }
  }
}

async function knownPaths(current: RegistryIndexFile | undefined, daemons: DiscoveredDaemon[]): Promise<KnownPath[]> {
  const byPath = new Map<string, KnownPath>()
  const add = async (k: KnownPath) => {
    const key = await normalizeProjectPath(k.path)
    const prev = byPath.get(key)
    byPath.set(key, { ...k, ...prev, path: key })
  }
  for (const row of current?.projects ?? []) {
    await add({
      path: row.path,
      ...(row.projectId ? { projectId: row.projectId } : {}),
      name: row.name,
      registeredAt: row.registeredAt,
      ...(row.lastSeenAt ? { lastSeenAt: row.lastSeenAt } : {}),
      languages: row.languages,
      status: row.status === 'broken' ? 'active' : row.status,
    })
  }
  for (const e of await readLegacyRegistry()) {
    await add({
      path: e.path,
      name: e.name,
      registeredAt: e.registeredAt,
      ...(e.lastSeenAt ? { lastSeenAt: e.lastSeenAt } : {}),
      languages: e.languages,
      status: e.status === 'broken' ? 'active' : e.status,
    })
  }
  for (const d of daemons) await add({ path: d.record.projectPath, name: d.record.project })
  return [...byPath.values()]
}

/**
 * Re-read `.neat/project.json` and `binding.json` at every known path and write
 * the index. Rows keep what earlier sources said (registration time, languages,
 * a paused status) where the files don't say more. Under the registry lock, with
 * an atomic write. Returns the new index.
 */
export async function rebuildRegistryIndex(probe?: DiscoveryProbe): Promise<RegistryIndexFile> {
  return withRegistryLock(async () => {
    const current = await readIndexFile().catch(() => undefined)
    const discovered = await discoverDaemons(probe)
    // The daemon recorded for each path: a live one when there is one, else the
    // last record (a daemon that died without clearing it), so the row can say so.
    const daemons = new Map<string, DiscoveredDaemon>()
    for (const d of discovered) {
      const key = await normalizeProjectPath(d.record.projectPath)
      const prev = daemons.get(key)
      if (!prev || (d.live && !prev.live)) daemons.set(key, d)
    }
    const now = new Date().toISOString()
    const rows: RegistryIndexEntry[] = []
    for (const k of await knownPaths(current, discovered)) rows.push(await rowFor(k, daemons, now))
    rows.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
    const next: RegistryIndexFile = RegistryIndexFileSchema.parse({ version: 2, projects: rows })
    await writeAtomically(registryIndexPath(), JSON.stringify(next, null, 2) + '\n')
    return next
  })
}

/**
 * The machine index, refreshed from disk. The first read on a machine with no
 * `registry.json` builds it (migrating `projects.json` read-only); every later
 * read refreshes it, so a project inited since the last read shows.
 */
export async function readRegistryIndex(probe?: DiscoveryProbe): Promise<RegistryIndexFile> {
  return rebuildRegistryIndex(probe)
}

// ── the inventory `neat list` renders ────────────────────────────────────────

export interface OrphanedMcp {
  pid: number
  command: string
}

export interface MachineInventory {
  local: RegistryIndexEntry[]
  hosted: RegistryIndexEntry[]
  // A known path holding `neat-out/` with no `.neat/project.json` beside it.
  orphans: string[]
  // Rows whose path is gone, or whose recorded daemon pid is dead.
  stale: RegistryIndexEntry[]
  // Names several rows share, each with its rows.
  duplicates: Array<{ name: string; rows: RegistryIndexEntry[] }>
  orphanedMcp: OrphanedMcp[]
}

export interface InventoryProbe extends DiscoveryProbe {
  // `pid ppid command` lines for every process, or undefined where it can't be read.
  processes(): Promise<string | undefined>
}

function psLines(): Promise<string | undefined> {
  if (process.platform === 'win32') return Promise.resolve(undefined)
  return new Promise((resolve) => {
    execFile('ps', ['-Ao', 'pid=,ppid=,command='], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? undefined : stdout),
    )
  })
}

const defaultInventoryProbe: InventoryProbe = { isPidAlive, processes: psLines }

// An MCP server NEAT started is `node …@neat.is/mcp…` (npx or a global install)
// or `…/packages/mcp/dist/index…` (a checkout). Orphaned means its parent is
// gone: it was reparented to init (ppid 1), so no client is attached to it.
const MCP_COMMAND_RE = /@neat\.is\/mcp|packages\/mcp\/dist\/index/

export function orphanedMcpFrom(psOutput: string): OrphanedMcp[] {
  const out: OrphanedMcp[] = []
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    const command = m[3]!.trim()
    if (ppid !== 1 || !MCP_COMMAND_RE.test(command)) continue
    out.push({ pid, command })
  }
  return out
}

export async function machineInventory(probe: InventoryProbe = defaultInventoryProbe): Promise<MachineInventory> {
  const index = await readRegistryIndex(probe)
  const local: RegistryIndexEntry[] = []
  const hosted: RegistryIndexEntry[] = []
  const orphans: string[] = []
  const stale: RegistryIndexEntry[] = []
  const byName = new Map<string, RegistryIndexEntry[]>()
  for (const row of index.projects) {
    ;(row.binding === 'hosted' ? hosted : local).push(row)
    byName.set(row.name, [...(byName.get(row.name) ?? []), row])
    const exists = await pathExists(row.path)
    if (exists === 'gone' || (row.daemon && !probe.isPidAlive(row.daemon.pid))) stale.push(row)
    if (exists === 'yes' && !row.projectId && (await pathExists(path.join(row.path, 'neat-out'))) === 'yes') {
      orphans.push(row.path)
    }
  }
  const duplicates = [...byName.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([name, rows]) => ({ name, rows }))
  const ps = await probe.processes()
  return { local, hosted, orphans, stale, duplicates, orphanedMcp: ps ? orphanedMcpFrom(ps) : [] }
}

/**
 * Stop the orphaned `@neat.is/mcp` processes `machineInventory` found, with
 * SIGTERM. Only `neat list --reap` calls this. Returns the pids it signalled.
 */
export function reapOrphanedMcp(procs: readonly OrphanedMcp[]): number[] {
  const done: number[] = []
  for (const p of procs) {
    try {
      process.kill(p.pid, 'SIGTERM')
      done.push(p.pid)
    } catch {
      // Already gone, or not ours to signal: nothing to report.
    }
  }
  return done
}
