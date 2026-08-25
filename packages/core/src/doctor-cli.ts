// `neat doctor` — a read-only preflight that answers "why isn't this working?"
// in one command. Getting to a live graph takes a few separate things — the
// right Node, a project set up in this directory, the daemon actually up — and
// when one is missing nothing points at which. Doctor probes each and prints a
// line per check, with a fix on the ones that failed.
//
// It's a diagnostic command alongside the `connector` family (cli-surface.md),
// not one of the locked query verbs. Two properties set it apart from the query
// verbs and from `neat ps`: it is the command you reach for *because* something
// is down, so it must run even when the daemon is unreachable and never throw
// on the way; and it does a real HTTP `/health` round-trip rather than reading
// a pid, so it catches a daemon whose process is alive but whose REST surface
// isn't answering.
//
// Exit code is its own thing (cli-surface.md §neat doctor): 0 when every check
// passes, 1 when any check fails. It deliberately never exits 3 — a daemon
// being down is a normal finding doctor reports, not a fatal error that aborts
// the run.
//
// v1 checks the daemon path only: Node runtime, project-in-this-directory, and
// daemon reachability. The dashboard/web-port probe and an index-readiness line
// are held back for later (the readiness signal rides with the empty-result
// work). Handlers take their cwd, environment, `fetch`, and record reader as
// injected deps so the whole surface is testable without a live daemon.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readDaemonRecord, type DaemonRecord } from './daemon.js'
import { resolveAuthToken } from './cli-client.js'

// ── deps / injection ─────────────────────────────────────────────────────────

export interface DoctorCliDeps {
  cwd?: string
  env?: NodeJS.ProcessEnv
  // The running Node version. Defaults to this process's; a test overrides it to
  // exercise the below-floor branch without a second Node.
  nodeVersion?: string
  // Test seam for the daemon `/health` probe. Undefined → the platform `fetch`.
  fetchImpl?: typeof fetch
  // Test seam for the per-directory daemon record read. Undefined → the real
  // `neat-out/daemon.json` reader.
  readRecord?: (scanPath: string) => Promise<DaemonRecord | null>
  out?: (line: string) => void
}

interface ResolvedDeps {
  cwd: string
  env: NodeJS.ProcessEnv
  nodeVersion: string
  fetchImpl: typeof fetch
  readRecord: (scanPath: string) => Promise<DaemonRecord | null>
  out: (line: string) => void
}

function resolveDeps(deps: DoctorCliDeps): ResolvedDeps {
  return {
    cwd: deps.cwd ?? process.cwd(),
    env: deps.env ?? process.env,
    nodeVersion: deps.nodeVersion ?? process.versions.node,
    fetchImpl: deps.fetchImpl ?? fetch,
    readRecord: deps.readRecord ?? readDaemonRecord,
    out: deps.out ?? ((line: string) => console.log(line)),
  }
}

// ── check result shape ───────────────────────────────────────────────────────

export interface DoctorCheck {
  name: string
  ok: boolean
  detail: string
  // A one-line remediation, present only when the check failed.
  fix?: string
}

const NODE_FLOOR = 20
const HEALTH_TIMEOUT_MS = 3000

// ── individual checks ────────────────────────────────────────────────────────

function checkNode(nodeVersion: string): DoctorCheck {
  const major = Number.parseInt(nodeVersion.split('.')[0] ?? '', 10)
  const ok = Number.isFinite(major) && major >= NODE_FLOOR
  return ok
    ? { name: 'node', ok, detail: `v${nodeVersion} (>= ${NODE_FLOOR} required)` }
    : {
        name: 'node',
        ok,
        detail: `v${nodeVersion} — NEAT needs Node ${NODE_FLOOR} or newer`,
        fix: `install Node ${NODE_FLOOR}.x (e.g. \`nvm install ${NODE_FLOOR}\`) and re-run`,
      }
}

// Does `<cwd>/neat-out/` exist? First run writes it and it survives across
// restarts, so it's the honest "is this a NEAT project" signal — independent of
// whether a daemon happens to be running right now.
async function neatOutExists(cwd: string): Promise<boolean> {
  try {
    const st = await fs.stat(path.join(cwd, 'neat-out'))
    return st.isDirectory()
  } catch {
    return false
  }
}

async function checkProject(
  cwd: string,
  record: DaemonRecord | null,
): Promise<DoctorCheck> {
  if (record) {
    return {
      name: 'project',
      ok: true,
      detail: `"${record.project}" — set up in this directory (daemon record on REST ${record.ports.rest})`,
    }
  }
  // No daemon.json (a stopped daemon clears its own on graceful exit), so lean
  // on neat-out/ to tell "set up but not running" from "not a project here".
  if (await neatOutExists(cwd)) {
    return {
      name: 'project',
      ok: true,
      detail: 'set up in this directory (no live daemon record — it may be stopped)',
    }
  }
  return {
    name: 'project',
    ok: false,
    detail: 'no NEAT project in this directory',
    fix: 'set one up: `neat .`',
  }
}

// The daemon URL doctor probes. Resolution mirrors the query verbs' precedence
// without importing them (which would cycle through cli.ts): an explicit env
// pin wins, then the directory's own recorded REST port, then the loopback
// default.
function resolveHealthUrl(env: NodeJS.ProcessEnv, record: DaemonRecord | null): string {
  const explicit = env.NEAT_API_URL ?? env.NEAT_CORE_URL
  if (explicit && explicit.length > 0) return explicit.replace(/\/$/, '')
  if (record) return `http://localhost:${record.ports.rest}`
  return 'http://localhost:8080'
}

interface HealthBody {
  ok?: boolean
  project?: string
  projects?: Array<{ name?: string; nodeCount?: number; edgeCount?: number }>
}

function summariseHealth(url: string, body: HealthBody): string {
  const projects = body.projects ?? []
  const nodes = projects.reduce((n, p) => n + (p.nodeCount ?? 0), 0)
  const edges = projects.reduce((n, p) => n + (p.edgeCount ?? 0), 0)
  const proj = body.project ?? projects[0]?.name
  const graph = projects.length > 0 ? ` — ${nodes} nodes / ${edges} edges` : ''
  return `up at ${url}${proj ? ` (project "${proj}"${graph})` : ''}`
}

async function checkDaemon(deps: ResolvedDeps, record: DaemonRecord | null): Promise<DoctorCheck> {
  const url = resolveHealthUrl(deps.env, record)
  const token = resolveAuthToken(deps.env)
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}
  try {
    const res = await deps.fetchImpl(`${url}/health`, {
      headers,
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    if (res.status === 401 || res.status === 403) {
      return {
        name: 'daemon',
        ok: false,
        detail: `up at ${url}, but rejected the request (${res.status})`,
        fix: 'set NEAT_AUTH_TOKEN to the daemon\'s token',
      }
    }
    if (!res.ok) {
      return {
        name: 'daemon',
        ok: false,
        detail: `reachable at ${url} but /health returned ${res.status}`,
        fix: 'check the daemon logs',
      }
    }
    const body = (await res.json().catch(() => ({}))) as HealthBody
    return { name: 'daemon', ok: true, detail: summariseHealth(url, body) }
  } catch {
    // Connection refused, DNS, or the 3s timeout — the daemon isn't answering.
    // This is a finding, not a crash: report it and keep going.
    return {
      name: 'daemon',
      ok: false,
      detail: `down — nothing answering at ${url}`,
      fix: 'start it: `neat .`  (or `neat watch`)',
    }
  }
}

// ── run + render ─────────────────────────────────────────────────────────────

export async function runDoctorChecks(deps: DoctorCliDeps = {}): Promise<DoctorCheck[]> {
  const d = resolveDeps(deps)
  const record = await d.readRecord(d.cwd).catch(() => null)
  return [checkNode(d.nodeVersion), await checkProject(d.cwd, record), await checkDaemon(d, record)]
}

// Longest check name, for aligning the human table.
const NAME_COL = 'project'.length

function renderHuman(checks: DoctorCheck[], out: (line: string) => void): void {
  out('neat doctor — checking this project\'s setup')
  out('')
  for (const c of checks) {
    const mark = c.ok ? '✓' : '✗' // ✓ / ✗
    out(`  ${mark}  ${c.name.padEnd(NAME_COL)}  ${c.detail}`)
    if (!c.ok && c.fix) out(`  ${' '.repeat(NAME_COL + 3)}fix: ${c.fix}`)
  }
  out('')
  const failed = checks.filter((c) => !c.ok).length
  out(failed === 0 ? 'all good.' : `${failed} check${failed === 1 ? '' : 's'} failed.`)
}

// The whole command: parse `--json`, run the checks, print, return the exit
// code (0 = all pass, 1 = any fail). Unknown flags are a misuse — exit 2,
// matching the rest of the CLI — handled before any probe runs.
export async function runDoctorCommand(argv: string[], deps: DoctorCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line))
  let json = false
  for (const arg of argv) {
    if (arg === '--json') json = true
    else if (arg === '-h' || arg === '--help') {
      out('usage: neat doctor [--json]')
      out('  Probe this directory\'s NEAT setup: Node version, project, daemon.')
      out('  Exit 0 when every check passes, 1 when any fails.')
      return 0
    } else {
      out(`neat doctor: unknown argument "${arg}"`)
      return 2
    }
  }

  const checks = await runDoctorChecks(deps)
  if (json) out(JSON.stringify({ ok: checks.every((c) => c.ok), checks }, null, 2))
  else renderHuman(checks, out)

  return checks.every((c) => c.ok) ? 0 : 1
}
