// Connector configuration — `~/.neat/connectors.json` read + env-ref
// resolution (docs/contracts/connector-config.md, ADR-130).
//
// This is the file family sibling to the machine-level project registry
// (registry.ts): per-user, machine-local, never version-controlled. Where the
// project registry says which projects exist, `connectors.json` says which
// built connectors are turned on for them and where each one's credential
// comes from. It is
// the one file in the family that references real secrets, so it is mode
// `0600` and — by default — holds a *pointer* to a secret (an env-var
// reference resolved only at daemon-read time), never the secret itself
// (contract §1, §2).
//
// This module owns two of the contract's three seams: reading/validating the
// file (`readConnectorsConfig`) and resolving a `credential` env-ref to a
// value in memory (`resolveCredential`). The provider dispatch table
// (connectors/registry.ts) turns a resolved entry into a `ConnectorRegistration`;
// the daemon (daemon.ts) triggers the read at slot bootstrap and hands the
// registrations to `startConnectorPollLoop`. This file never writes the
// snapshot and never lets a resolved secret reach disk (contract §6,
// connectors.md §6, contracts.md Rule 13).

import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'

// Only bump 1 → 2 when the on-disk shape changes in a way an old reader
// couldn't ignore. A file with no `version` reads as 1 (the shape below).
export const CONNECTORS_CONFIG_VERSION = 1

/**
 * A credential, before resolution. Either a single env-ref/plaintext string
 * (single-field providers — `"$RAILWAY_TOKEN"`), or a per-field map of them
 * (multi-field providers — `{ managementToken: "$SUPABASE_MGMT_TOKEN",
 * postgresConnectionString: "$SUPABASE_DB_URL" }`). A leading `$` marks the
 * string as the name of an environment variable; anything else is a literal
 * (contract §2).
 */
export type CredentialRef = string | Record<string, string>

/**
 * One entry in `~/.neat/connectors.json`. Mirrors the contract §1 schema
 * exactly — `credentials`/`config`/`enabled`/`addedAt` are deliberately
 * absent; the shape converged on a single `credential` ref plus opaque
 * `options`, and every listed entry is active (there is no `enabled` gate).
 */
export interface ConnectorEntry {
  // Addressable handle, auto-slugged from provider (disambiguated by project
  // when a provider repeats). The CLI's `remove <id>` / `test <id>` use it.
  id: string
  // 'supabase' | 'railway' | 'firebase' | 'cloudflare' | ... — validated
  // against the dispatch table (registry.ts), not hardcoded here.
  provider: string
  // Matches a registered project's `name`; omitted binds to whichever project
  // the daemon is bootstrapping (one daemon per project, ADR-096).
  project?: string
  // Env-ref by default (see resolveCredential).
  credential: CredentialRef
  // Provider-shaped, non-secret config (project ref, service-id mappings,
  // poll cadence). Opaque here; the dispatch table maps it onto each
  // provider's own config type.
  options?: Record<string, unknown>
}

export interface ConnectorsConfig {
  version: number
  connectors: ConnectorEntry[]
}

/**
 * A credential after env-ref resolution — values in memory only. `single`
 * for a one-string credential (the dispatch table knows which record key it
 * lands under); `fields` for a multi-field credential (the keys are already
 * the provider's own).
 */
export type ResolvedCredential =
  | { kind: 'single'; value: string }
  | { kind: 'fields'; fields: Record<string, string> }

/**
 * Thrown when a `$VAR` credential reference names an environment variable
 * that isn't set. Kept distinct from every other failure so a caller can
 * tell "you forgot to `export`" apart from "your token is wrong" (contract
 * §4). The message names the variable *with* its `$` — `"$SUPABASE_KEY is
 * unset"` — so a log line points straight at what to set.
 */
export class EnvRefUnsetError extends Error {
  readonly ref: string
  readonly varName: string
  constructor(ref: string, varName: string) {
    super(`${ref} is unset`)
    this.name = 'EnvRefUnsetError'
    this.ref = ref
    this.varName = varName
  }
}

// Resolve `~/.neat/` the same way registry.ts does, per call, so a test
// overriding NEAT_HOME (or HOME) before a run lands here too — module-load
// order never matters.
function neatHome(): string {
  const override = process.env.NEAT_HOME
  if (override && override.length > 0) return path.resolve(override)
  return path.join(os.homedir(), '.neat')
}

export function connectorsConfigPath(home: string = neatHome()): string {
  return path.join(home, 'connectors.json')
}

// Owner-read/write only. Anything with group or other bits set is looser than
// the contract's `0600` guarantee and gets a warning (not a refusal — a
// mis-permissioned file is a hygiene problem, not a reason to leave a
// connector dark).
const MODE_MASK_LOOSER_THAN_0600 = 0o077

async function warnIfModeLooserThan0600(file: string): Promise<void> {
  // The POSIX bits are meaningless on Windows; skip the check there rather
  // than warn on every read.
  if (process.platform === 'win32') return
  try {
    const stat = await fs.stat(file)
    if ((stat.mode & MODE_MASK_LOOSER_THAN_0600) !== 0) {
      const mode = (stat.mode & 0o777).toString(8).padStart(3, '0')
      console.warn(
        `[neat] ${file} is mode 0${mode}, looser than the 0600 this file's secrets call for — run \`chmod 600 ${file}\``,
      )
    }
  } catch {
    // Racing a delete between read and stat is harmless — the read already
    // succeeded; skip the permission warning rather than crash on it.
  }
}

/**
 * Read and validate `~/.neat/connectors.json`.
 *
 * - A missing file is the common, un-configured case → an empty connector
 *   list, never an error (the daemon just starts no poll loops).
 * - A malformed file throws a clear error naming what's wrong. The daemon's
 *   read path catches it and leaves the slot's connectors empty rather than
 *   crashing the whole daemon (contract §6, `project-registry.md`'s
 *   graceful-skip discipline).
 * - A file looser than `0600` is read but warns.
 */
export async function readConnectorsConfig(
  home: string = neatHome(),
): Promise<ConnectorsConfig> {
  const file = connectorsConfigPath(home)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: CONNECTORS_CONFIG_VERSION, connectors: [] }
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

function validateConfig(parsed: unknown, file: string): ConnectorsConfig {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} must be a JSON object with a "connectors" array`)
  }
  const obj = parsed as Record<string, unknown>
  const version = obj.version === undefined ? CONNECTORS_CONFIG_VERSION : obj.version
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new Error(`${file}: "version" must be an integer`)
  }
  const rawConnectors = obj.connectors
  if (!Array.isArray(rawConnectors)) {
    throw new Error(`${file}: "connectors" must be an array`)
  }
  const connectors = rawConnectors.map((entry, i) => validateEntry(entry, i, file))
  return { version, connectors }
}

function validateEntry(entry: unknown, index: number, file: string): ConnectorEntry {
  const where = `${file}: connectors[${index}]`
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`${where} must be an object`)
  }
  const e = entry as Record<string, unknown>
  const id = e.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${where}.id must be a non-empty string`)
  }
  const provider = e.provider
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new Error(`${where}.provider must be a non-empty string`)
  }
  if (e.project !== undefined && typeof e.project !== 'string') {
    throw new Error(`${where}.project must be a string when present`)
  }
  const credential = validateCredentialRef(e.credential, `${where}.credential`)
  let options: Record<string, unknown> | undefined
  if (e.options !== undefined) {
    if (typeof e.options !== 'object' || e.options === null || Array.isArray(e.options)) {
      throw new Error(`${where}.options must be an object when present`)
    }
    options = e.options as Record<string, unknown>
  }
  return {
    id,
    provider,
    ...(typeof e.project === 'string' ? { project: e.project } : {}),
    credential,
    ...(options ? { options } : {}),
  }
}

function validateCredentialRef(raw: unknown, where: string): CredentialRef {
  if (typeof raw === 'string') {
    if (raw.length === 0) throw new Error(`${where} must be a non-empty string`)
    return raw
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const fields = raw as Record<string, unknown>
    const keys = Object.keys(fields)
    if (keys.length === 0) throw new Error(`${where} object must have at least one field`)
    for (const key of keys) {
      const v = fields[key]
      if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`${where}.${key} must be a non-empty string`)
      }
    }
    return fields as Record<string, string>
  }
  throw new Error(`${where} must be a string or an object of strings`)
}

/**
 * Resolve one credential ref to values held only in memory.
 *
 * A `$`-prefixed string is an environment-variable reference — resolved
 * against `env` (default `process.env`) at the moment the daemon builds a
 * registration; an unset variable throws `EnvRefUnsetError`. Any other string
 * is an explicit plaintext literal (the opt-in at-rest fallback, contract
 * §2), passed through unchanged. A field map resolves each value the same
 * way.
 */
export function resolveCredential(
  ref: CredentialRef,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCredential {
  if (typeof ref === 'string') {
    return { kind: 'single', value: resolveRef(ref, env) }
  }
  const fields: Record<string, string> = {}
  for (const [key, value] of Object.entries(ref)) {
    fields[key] = resolveRef(value, env)
  }
  return { kind: 'fields', fields }
}

// A leading `$` (with at least one char after it) marks an env-ref; the value
// must be set and non-empty. Everything else — including a bare `"$"` — is a
// plaintext literal.
function resolveRef(value: string, env: NodeJS.ProcessEnv): string {
  if (value.length > 1 && value.startsWith('$')) {
    const varName = value.slice(1)
    const resolved = env[varName]
    if (resolved === undefined || resolved.length === 0) {
      throw new EnvRefUnsetError(value, varName)
    }
    return resolved
  }
  return value
}

/**
 * Whether a connector entry belongs to the project a daemon slot is
 * bootstrapping. An entry with no `project` binds to whatever project is
 * being bootstrapped (the single-daemon-per-project common case); an entry
 * naming a project matches only that one. A non-match is skipped, never
 * errored (contract §6).
 */
export function connectorMatchesProject(entry: ConnectorEntry, project: string): boolean {
  return entry.project === undefined || entry.project === project
}

// ─────────────────────────────────────────────────────────────────────────
// Writing `~/.neat/connectors.json` — atomic, 0600, flock (contract §1).
//
// This is the write half of the seam the reader above owns: `neat connector
// add/remove` (cli, connectors-cli.ts) call these to mutate the file, never
// touching disk themselves. Every write matches the project registry's
// discipline — tmp + fsync + rename so a reader never sees a half-written
// file, an exclusive lock so two concurrent writers can't clobber each other
// — plus the one guarantee this file's secrets demand and the project
// registry doesn't: mode `0600`, set explicitly on the bytes we create rather
// than left to the umask.
// ─────────────────────────────────────────────────────────────────────────

const LOCK_TIMEOUT_MS = 5_000
const LOCK_RETRY_MS = 50
const CONNECTORS_FILE_MODE = 0o600

export function connectorsConfigLockPath(home: string = neatHome()): string {
  return `${connectorsConfigPath(home)}.lock`
}

// tmp + fchmod(0600) + fsync + rename. The mode is stamped on the temp file's
// own fd before the rename swaps it into place, so the secret-bearing file is
// never even briefly readable by group/other — rename is atomic on POSIX and
// carries the temp inode's 0600 across. Mirrors registry.ts's writeAtomically,
// with the explicit mode this file's contents require.
async function writeConnectorsFileAtomically(target: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  const fd = await fs.open(tmp, 'w', CONNECTORS_FILE_MODE)
  try {
    await fd.chmod(CONNECTORS_FILE_MODE)
    await fd.writeFile(contents, 'utf8')
    await fd.sync()
  } finally {
    await fd.close()
  }
  await fs.rename(tmp, target)
}

// Exclusive-create lock, the cross-platform flock(LOCK_EX) equivalent the
// project registry uses (registry.ts) — deliberately not the registry's own
// daemon-aware classifier, because the daemon only ever *reads* this file, so
// a live daemon is never the lock holder here. A plain timeout is the whole
// story.
async function acquireConnectorsLock(lockPath: string, timeoutMs = LOCK_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  for (;;) {
    try {
      const fd = await fs.open(lockPath, 'wx')
      await fd.close()
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (Date.now() >= deadline) {
        throw new Error(
          `neat connectors: timed out after ${timeoutMs}ms waiting for ${lockPath}. ` +
            'Another neat command is writing the connector config; if none is, remove the file by hand.',
        )
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS))
    }
  }
}

async function withConnectorsLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const lock = connectorsConfigLockPath(home)
  await acquireConnectorsLock(lock)
  try {
    return await fn()
  } finally {
    await fs.unlink(lock).catch(() => {})
  }
}

/**
 * Overwrite `~/.neat/connectors.json` with `config`, atomically and at `0600`.
 * Re-validates the shape on the way out so a caller mutating the in-memory
 * object can't write a file the reader would then reject. Not lock-wrapped
 * itself — the read-modify-write helpers below hold the lock across their
 * whole cycle.
 */
export async function writeConnectorsConfig(
  config: ConnectorsConfig,
  home: string = neatHome(),
): Promise<void> {
  const validated = validateConfig(config, connectorsConfigPath(home))
  const body = JSON.stringify({ version: validated.version, connectors: validated.connectors }, null, 2) + '\n'
  await writeConnectorsFileAtomically(connectorsConfigPath(home), body)
}

/**
 * Add `entry`, or replace the existing entry with the same `id` in place. The
 * whole read-modify-write runs under the file lock so a concurrent `add` /
 * `remove` can't lose an entry. Returns whether an existing entry was replaced
 * (`false` means it was appended) so the CLI can word its confirmation.
 */
export async function upsertConnectorEntry(
  entry: ConnectorEntry,
  home: string = neatHome(),
): Promise<{ replaced: boolean }> {
  return withConnectorsLock(home, async () => {
    const config = await readConnectorsConfig(home)
    const idx = config.connectors.findIndex((c) => c.id === entry.id)
    const replaced = idx >= 0
    if (replaced) config.connectors[idx] = entry
    else config.connectors.push(entry)
    await writeConnectorsConfig(config, home)
    return { replaced }
  })
}

/**
 * Remove the entry with `id`. Returns the removed entry, or `undefined` when
 * no entry carried that id (the CLI turns that into a clear "no such id").
 */
export async function removeConnectorEntry(
  id: string,
  home: string = neatHome(),
): Promise<ConnectorEntry | undefined> {
  return withConnectorsLock(home, async () => {
    const config = await readConnectorsConfig(home)
    const idx = config.connectors.findIndex((c) => c.id === id)
    if (idx < 0) return undefined
    const [removed] = config.connectors.splice(idx, 1)
    await writeConnectorsConfig(config, home)
    return removed
  })
}
