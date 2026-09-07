// Resolve the daemon URL the MCP server talks to.
//
// Under the per-project daemon model (ADR-096 / docs/contracts/project-daemon.md)
// each project runs its own daemon on its own ports and records them in
// `<projectRoot>/neat-out/daemon.json`. The MCP server points at the daemon for
// the project it was launched in, so resolution walks up from the cwd to the
// nearest `neat-out/daemon.json` and uses its REST port. An explicit
// `NEAT_CORE_URL` / `NEAT_API_URL` still wins — that's how the hosted/prod
// substrate pins the MCP server at a fixed daemon — and the canonical loopback
// default catches the case where neither the env nor a daemon record is present.
//
// `NEAT_API_URL` is honored as an accepted alias so configs written by older
// `neat skill` versions — which emitted `NEAT_API_URL` — still reach the daemon
// (#488). `NEAT_CORE_URL` wins when both are set.
//
// Lives in its own module so the resolution is testable without importing
// index.ts, which starts the stdio transport on load.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import os from 'node:os'

const DEFAULT_BASE_URL = 'http://localhost:8080'

// The slice of `neat-out/daemon.json` the MCP server depends on. The full record
// (pid, projectPath, otlp/web ports, …) is owned by the daemon writer; the MCP
// server only needs the REST port and the liveness status. We read the file as
// plain JSON rather than importing the writer's type so this stays decoupled
// from the daemon package that owns the schema.
interface DaemonRecordShape {
  status?: unknown
  ports?: { rest?: unknown }
}

// Read the REST base URL out of a project's `neat-out/daemon.json`, walking up
// from `cwd` to the filesystem root to find the nearest one. Returns undefined
// for every failure mode — no file, unreadable, malformed JSON, a stopped
// daemon, or a missing/invalid REST port — so the caller falls through to the
// next precedence level rather than the MCP server failing to start.
function resolveFromDaemonRecord(cwd: string): string | undefined {
  let dir = cwd
  // Walk parents until the path stops changing (the filesystem root, where
  // dirname() is a fixed point).
  for (;;) {
    const url = readDaemonRecord(join(dir, 'neat-out', 'daemon.json'))
    if (url !== undefined) return url

    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function readDaemonRecord(path: string): string | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // No daemon.json here (the common case while walking up). Keep looking.
    return undefined
  }

  let record: DaemonRecordShape
  try {
    record = JSON.parse(raw) as DaemonRecordShape
  } catch {
    // A daemon.json that exists but is garbage: a daemon caught mid-write, a
    // truncated file. Treat it as absent rather than crashing the MCP server.
    return undefined
  }

  if (record == null || typeof record !== 'object') return undefined
  // A daemon that has marked itself stopped no longer answers on its ports.
  if (record.status === 'stopped') return undefined

  const rest = record.ports?.rest
  if (typeof rest !== 'number' || !Number.isInteger(rest) || rest <= 0 || rest > 65535) {
    return undefined
  }

  return `http://localhost:${rest}`
}

// The MCP server can point at a hosted NEAT through `~/.neat/profiles.json`, the
// client profile store `@neat.is/core` owns (client-profiles.md §4). The server
// depends only on `@neat.is/types`, not core, so — exactly as it does for
// daemon.json — it reads the file as plain JSON for the fields it needs rather
// than importing the store. Home resolves the way core's does: NEAT_HOME, else
// ~/.neat.
function neatHomeDir(): string {
  const override = process.env.NEAT_HOME
  if (override && override.length > 0) return override
  return join(os.homedir(), '.neat')
}

interface SelectedProfile {
  url: string
  authToken?: string
}

// Return the profile named `want`, or the file's `active` profile when `want`
// is undefined. Returns undefined for every failure mode — no file, unreadable,
// malformed, no such profile, a missing endpoint — so resolution falls through
// rather than the server failing to start, the same never-throws discipline
// `resolveFromDaemonRecord` keeps.
function readProfile(want: string | undefined): SelectedProfile | undefined {
  let raw: string
  try {
    raw = readFileSync(join(neatHomeDir(), 'profiles.json'), 'utf8')
  } catch {
    return undefined
  }
  let parsed: { active?: unknown; profiles?: unknown }
  try {
    parsed = JSON.parse(raw) as { active?: unknown; profiles?: unknown }
  } catch {
    return undefined
  }
  if (parsed == null || typeof parsed !== 'object') return undefined
  const list = Array.isArray(parsed.profiles) ? parsed.profiles : []
  const targetName = want ?? (typeof parsed.active === 'string' ? parsed.active : undefined)
  if (targetName === undefined) return undefined
  const found = list.find(
    (p): p is { name: string; endpoint: string; authToken?: unknown } =>
      p != null && typeof p === 'object' && (p as { name?: unknown }).name === targetName,
  )
  if (!found || typeof found.endpoint !== 'string' || found.endpoint.length === 0) return undefined
  const authToken =
    typeof found.authToken === 'string' && found.authToken.length > 0 ? found.authToken : undefined
  return { url: found.endpoint, ...(authToken ? { authToken } : {}) }
}

// How `resolveBaseUrl` arrived at its URL. The startup endpoint check
// (index.ts / endpoint-check.ts) reads this to word a precise error when the
// resolved URL turns out to be a foreign service: the :8080 fallback landing on
// someone else's server reads very differently from an explicit NEAT_CORE_URL
// pointing at the wrong place, and the fix differs too.
export type BaseUrlSource = 'profile' | 'env' | 'active' | 'daemon-record' | 'default'

export interface ResolvedBaseUrl {
  url: string
  source: BaseUrlSource
  // The bearer to reach `url`: a profile's own token at the profile levels, else
  // NEAT_AUTH_TOKEN for the env pin / local daemon / loopback (ADR-073 §3).
  authToken?: string
}

// The client-profiles.md §3 precedence, resolved as one decision so a hosted
// profile's endpoint and token travel together (§6). The MCP server has no CLI
// flag, so level 1 is NEAT_PROFILE only. Same never-throws guarantee as
// `resolveBaseUrl`; it also reports which level won so the caller can explain
// itself, and carries the bearer for that level.
export function resolveBaseUrlWithSource(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ResolvedBaseUrl {
  const t = env.NEAT_AUTH_TOKEN
  const envToken = t && t.length > 0 ? t : undefined

  // Level 1 — an explicitly named profile (NEAT_PROFILE). A name that resolves
  // to nothing falls through rather than failing the server to start.
  const named = env.NEAT_PROFILE
  if (named && named.length > 0) {
    const p = readProfile(named)
    if (p) return { url: p.url, source: 'profile', ...(p.authToken ? { authToken: p.authToken } : {}) }
  }

  // Level 2 — the explicit env pin.
  const override = env.NEAT_CORE_URL ?? env.NEAT_API_URL
  if (override) return { url: override, source: 'env', ...(envToken ? { authToken: envToken } : {}) }

  // Level 3 — the persisted `active` profile (the `neat login` default).
  const active = readProfile(undefined)
  if (active) {
    return { url: active.url, source: 'active', ...(active.authToken ? { authToken: active.authToken } : {}) }
  }

  // Level 4 — the per-project daemon record at/above the cwd.
  const fromRecord = resolveFromDaemonRecord(cwd)
  if (fromRecord !== undefined) {
    return { url: fromRecord, source: 'daemon-record', ...(envToken ? { authToken: envToken } : {}) }
  }

  // Level 5 — loopback.
  return { url: DEFAULT_BASE_URL, source: 'default', ...(envToken ? { authToken: envToken } : {}) }
}

export function resolveBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  return resolveBaseUrlWithSource(env, cwd).url
}
