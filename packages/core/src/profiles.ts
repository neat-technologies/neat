// The client profile store — `~/.neat/profiles.json`, the per-user address book
// of the remote NEATs this machine talks to (client-profiles.md §4, ADR-102).
//
// A profile is exactly `{ name, endpoint, authToken? }`: the daemon's REST root
// and an optional bearer. It is how every NEAT client — the `neat` CLI, the
// `neat-mcp` server — answers "which NEAT am I talking to," the same code path
// whether the daemon is a local loopback one (endpoint, no token) or a hosted
// one (endpoint + token). This module owns the file; resolution precedence
// (§3) lives in the clients that consume it.
//
// This is a CLIENT config, not a daemon registry (§4): daemons never read it,
// never coordinate through it, and losing it costs convenience, not
// correctness. It is a sibling of `projects.json` and `connectors.json` and
// follows the same discipline — atomic tmp+fsync+rename writes under an
// exclusive-create lock, mode 0600 because `authToken` is a secret at rest.
//
// The `authToken` a hosted profile carries is the per-project daemon token
// (what the control plane's provision/rotate return): long-lived until rotated
// and accepted as `Authorization: Bearer <token>` on the daemon's REST root.
// The short-lived control-plane session token used during login is never
// persisted here — it authenticates the user just long enough to fetch the
// daemon token, then is discarded.

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PROFILES_CONFIG_VERSION = 1

// One remote NEAT this machine talks to. `endpoint` is a daemon REST root
// (ADR-096 — the project is the daemon; the name is only this profile's label).
export interface Profile {
  name: string
  endpoint: string
  authToken?: string
}

// The file shape. `active` names the profile a client uses when nothing more
// explicit is selected — the persisted counterpart of `--profile` / NEAT_PROFILE
// (§3 level 1). It is a pointer by name, so removing a profile clears it.
export interface ProfilesConfig {
  version: number
  active?: string
  profiles: Profile[]
}

// Resolve `~/.neat/` the same way the sibling stores do — per call, honoring a
// NEAT_HOME override — so a test setting NEAT_HOME (or HOME) before a run lands
// here too, and module-load order never matters.
function neatHome(): string {
  const override = process.env.NEAT_HOME
  if (override && override.length > 0) return path.resolve(override)
  return path.join(os.homedir(), '.neat')
}

export function profilesConfigPath(home: string = neatHome()): string {
  return path.join(home, 'profiles.json')
}

export function profilesConfigLockPath(home: string = neatHome()): string {
  return path.join(home, 'profiles.json.lock')
}

// Owner-read/write only. A file with group or other bits set is looser than the
// 0600 an at-rest bearer calls for — warn, but read it anyway: a
// mis-permissioned file is a hygiene problem, not a reason to lock a user out
// of their own hosted graph.
const MODE_MASK_LOOSER_THAN_0600 = 0o077

async function warnIfModeLooserThan0600(file: string): Promise<void> {
  // The POSIX bits are meaningless on Windows; skip rather than warn on reads.
  if (process.platform === 'win32') return
  try {
    const stat = await fs.stat(file)
    if ((stat.mode & MODE_MASK_LOOSER_THAN_0600) !== 0) {
      const mode = (stat.mode & 0o777).toString(8).padStart(3, '0')
      console.warn(
        `[neat] ${file} is mode 0${mode}, looser than the 0600 this file's token calls for — run \`chmod 600 ${file}\``,
      )
    }
  } catch {
    // Racing a delete between read and stat is harmless — the read already
    // succeeded; skip the warning rather than crash on it.
  }
}

/**
 * Read and validate `~/.neat/profiles.json`.
 *
 * - A missing file is the common, un-configured case → an empty profile list,
 *   never an error. A machine that has never logged into a hosted NEAT simply
 *   has no named profiles and falls through to local daemon discovery.
 * - A malformed file throws a clear error naming what's wrong, so a hand-edit
 *   typo is legible rather than a silent empty list.
 * - A file looser than 0600 is read but warns.
 */
export async function readProfilesConfig(home: string = neatHome()): Promise<ProfilesConfig> {
  const file = profilesConfigPath(home)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: PROFILES_CONFIG_VERSION, profiles: [] }
    }
    throw err
  }
  await warnIfModeLooserThan0600(file)

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`)
  }
  return validateConfig(parsed, file)
}

function validateConfig(parsed: unknown, file: string): ProfilesConfig {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} must be a JSON object with a "profiles" array`)
  }
  const obj = parsed as Record<string, unknown>

  const version = obj.version === undefined ? PROFILES_CONFIG_VERSION : obj.version
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new Error(`${file}: "version" must be an integer`)
  }

  const rawProfiles = obj.profiles
  if (!Array.isArray(rawProfiles)) {
    throw new Error(`${file}: "profiles" must be an array`)
  }
  const profiles = rawProfiles.map((entry, i) => validateEntry(entry, i, file))

  // Reject a duplicate name up front: names are the address a client selects by,
  // so two entries sharing one make selection ambiguous.
  const seen = new Set<string>()
  for (const p of profiles) {
    if (seen.has(p.name)) throw new Error(`${file}: duplicate profile name "${p.name}"`)
    seen.add(p.name)
  }

  let active: string | undefined
  if (obj.active !== undefined) {
    if (typeof obj.active !== 'string' || obj.active.length === 0) {
      throw new Error(`${file}: "active" must be a non-empty string when present`)
    }
    // A dangling `active` (points at a profile that isn't there) is treated as
    // unset rather than an error — the same graceful-skip the sibling stores use.
    active = seen.has(obj.active) ? obj.active : undefined
  }

  return { version, ...(active ? { active } : {}), profiles }
}

function validateEntry(entry: unknown, index: number, file: string): Profile {
  const where = `${file}: profiles[${index}]`
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`${where} must be an object`)
  }
  const e = entry as Record<string, unknown>

  const name = e.name
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${where}.name must be a non-empty string`)
  }

  const endpoint = e.endpoint
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new Error(`${where}.endpoint must be a non-empty string`)
  }
  // A profile endpoint is a daemon REST root — a real absolute URL. Catch the
  // common paste-mistakes (a bare host, a trailing path) at write/read time
  // rather than as an opaque fetch failure later.
  let parsedUrl: URL
  try {
    parsedUrl = new URL(endpoint)
  } catch {
    throw new Error(`${where}.endpoint must be an absolute URL (got "${endpoint}")`)
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`${where}.endpoint must be an http(s) URL (got "${parsedUrl.protocol}")`)
  }

  if (e.authToken !== undefined && (typeof e.authToken !== 'string' || e.authToken.length === 0)) {
    throw new Error(`${where}.authToken must be a non-empty string when present`)
  }

  return {
    name,
    endpoint,
    ...(typeof e.authToken === 'string' ? { authToken: e.authToken } : {}),
  }
}

/**
 * The named profile, or undefined if there is none by that name. This is the
 * primitive the client precedence chain (§3 level 1) calls once it has a name
 * from `--profile` / NEAT_PROFILE / the persisted `active` pointer.
 */
export async function resolveProfile(
  name: string,
  home: string = neatHome(),
): Promise<Profile | undefined> {
  const { profiles } = await readProfilesConfig(home)
  return profiles.find((p) => p.name === name)
}

/**
 * The active profile — the persisted default a bare client uses when nothing
 * more explicit is selected — or undefined when none is set. Returns undefined
 * (never throws) on a missing file so a client falls cleanly through to local
 * daemon discovery.
 */
export async function getActiveProfile(home: string = neatHome()): Promise<Profile | undefined> {
  const { active, profiles } = await readProfilesConfig(home)
  if (!active) return undefined
  return profiles.find((p) => p.name === active)
}

// Serialize a config to the on-disk shape, dropping an `active` that no longer
// points at a real profile so the file never carries a dangling pointer.
function serialize(config: ProfilesConfig): string {
  const names = new Set(config.profiles.map((p) => p.name))
  const active = config.active && names.has(config.active) ? config.active : undefined
  const out: ProfilesConfig = {
    version: config.version ?? PROFILES_CONFIG_VERSION,
    ...(active ? { active } : {}),
    profiles: config.profiles,
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

/**
 * Write `~/.neat/profiles.json` atomically: a tmp file created mode 0600 (so the
 * token bytes are never briefly world-readable), fsync'd, then renamed over the
 * target — atomic on POSIX, and the rename carries the tmp inode's mode with it.
 * Callers should hold the lock (see `withProfilesLock`) so a read-modify-write
 * can't race another client.
 */
async function writeConfigAtomic(config: ProfilesConfig, home: string): Promise<void> {
  const file = profilesConfigPath(home)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  const fd = await fs.open(tmp, 'w', 0o600)
  try {
    await fd.writeFile(serialize(config), 'utf8')
    await fd.sync()
  } finally {
    await fd.close()
  }
  await fs.rename(tmp, file)
}

// Exclusive-create lock — the same cross-platform flock stand-in the sibling
// stores use. `wx` fails if the lock file already exists; we retry briefly, then
// give up rather than hang a CLI forever behind a stale lock.
const LOCK_RETRY_MS = 50
const LOCK_TIMEOUT_MS = 5_000

async function acquireLock(lockPath: string): Promise<void> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const fd = await fs.open(lockPath, 'wx')
      await fd.writeFile(`${process.pid}\n`, 'utf8')
      await fd.close()
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out acquiring ${lockPath} after ${LOCK_TIMEOUT_MS}ms — ` +
            `if no other neat process is running, remove the stale lock file`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
    }
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  await fs.rm(lockPath, { force: true })
}

async function withProfilesLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = profilesConfigLockPath(home)
  await acquireLock(lockPath)
  try {
    return await fn()
  } finally {
    await releaseLock(lockPath)
  }
}

/**
 * Add or replace a profile by name, under the lock. When `makeActive` is set (or
 * this is the first profile written), the new profile also becomes active — the
 * common case for `neat login`, where connecting a machine to a hosted NEAT
 * should also point the local clients at it.
 */
export async function upsertProfile(
  profile: Profile,
  opts: { makeActive?: boolean; home?: string } = {},
): Promise<void> {
  const home = opts.home ?? neatHome()
  // Validate the caller's profile through the same gate a hand-edited file goes
  // through, so a bad endpoint is rejected before it reaches disk.
  const validated = validateEntry(profile, 0, profilesConfigPath(home))
  await withProfilesLock(home, async () => {
    const config = await readProfilesConfig(home)
    const others = config.profiles.filter((p) => p.name !== validated.name)
    const profiles = [...others, validated]
    const makeActive = opts.makeActive ?? config.profiles.length === 0
    const active = makeActive ? validated.name : config.active
    await writeConfigAtomic({ version: config.version, ...(active ? { active } : {}), profiles }, home)
  })
}

/**
 * Remove a profile by name, under the lock. Returns whether one was removed. A
 * removed profile that was active clears the active pointer (serialize drops a
 * dangling one) — a client then falls back to local discovery, never to a
 * silently different endpoint.
 */
export async function removeProfile(name: string, home: string = neatHome()): Promise<boolean> {
  return withProfilesLock(home, async () => {
    const config = await readProfilesConfig(home)
    const profiles = config.profiles.filter((p) => p.name !== name)
    if (profiles.length === config.profiles.length) return false
    const active = config.active === name ? undefined : config.active
    await writeConfigAtomic({ version: config.version, ...(active ? { active } : {}), profiles }, home)
    return true
  })
}

/**
 * Point the active pointer at an existing profile, under the lock. Throws if no
 * profile by that name exists — selecting a non-existent endpoint should fail
 * loudly, not silently set a dangling pointer.
 */
export async function setActiveProfile(name: string, home: string = neatHome()): Promise<void> {
  await withProfilesLock(home, async () => {
    const config = await readProfilesConfig(home)
    if (!config.profiles.some((p) => p.name === name)) {
      throw new Error(`no profile named "${name}" — run \`neat login\` or add it first`)
    }
    await writeConfigAtomic({ version: config.version, active: name, profiles: config.profiles }, home)
  })
}
