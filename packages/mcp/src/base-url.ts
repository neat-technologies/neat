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

export function resolveBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const override = env.NEAT_CORE_URL ?? env.NEAT_API_URL
  if (override) return override

  return resolveFromDaemonRecord(cwd) ?? DEFAULT_BASE_URL
}
