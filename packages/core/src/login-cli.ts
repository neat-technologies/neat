// `neat login` / `neat logout` — connect this machine to a hosted NEAT by
// writing a client profile (client-profiles.md §4) and setting it active, so the
// CLI and the MCP server both resolve there (§3). A config command family, not a
// query verb: it parses its own argv and keeps its own exit codes (0 done, 1 the
// endpoint or token was rejected, 2 misuse, 3 the endpoint was unreachable).
//
// v1 is the paste flow: the user gives the hosted daemon's endpoint and token —
// the same pair the hosted console surfaces as "point your CLI at this daemon".
// The browser loopback flow writes the same profile once the control plane's
// credential exchange is live, and will reuse `runLoginCommand`'s core.

import readline from 'node:readline/promises'
import {
  upsertProfile,
  getActiveProfile,
  removeProfile,
  clearActiveProfile,
} from './profiles.js'

export interface LoginCliDeps {
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  out?: (line: string) => void
  err?: (line: string) => void
  // Read a line the user types (the endpoint). Undefined → non-interactive; the
  // default reads from the terminal only when stdin is a TTY.
  readLine?: (prompt: string) => Promise<string | undefined>
  // Read a secret without echoing it (the token). Undefined → non-interactive.
  readSecret?: (prompt: string) => Promise<string | undefined>
  // `~/.neat` override, for tests. Undefined → the real per-user store.
  home?: string
  // Test seams for the endpoint probe's cold-start retry.
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

// A warm daemon answers /health in well under a second; a hosted daemon scaled
// to zero cold-starts in tens of seconds. One attempt is capped short, but a
// timeout (as opposed to a refused connection) is retried over a longer total
// budget — the old flat 5s cap reported a valid-but-cold daemon as unreachable.
const PROBE_ATTEMPT_TIMEOUT_MS = 30_000
const PROBE_TOTAL_BUDGET_MS = 120_000
const PROBE_RETRY_PAUSE_MS = 2_000
const DEFAULT_PROFILE_NAME = 'hosted'

// ── login ────────────────────────────────────────────────────────────────────

interface ParsedLoginArgs {
  endpoint?: string
  token?: string
  name: string
  json: boolean
  help: boolean
  error?: string
}

// Reads a `--flag value` or `--flag=value` string flag; returns the value and
// the index to continue from (past a consumed separate token).
function readFlagValue(argv: string[], i: number): { value: string | undefined; next: number } {
  const arg = argv[i]!
  const eq = arg.indexOf('=')
  if (eq !== -1) return { value: arg.slice(eq + 1), next: i }
  return { value: argv[i + 1], next: i + 1 }
}

function parseLoginArgs(argv: string[]): ParsedLoginArgs {
  const parsed: ParsedLoginArgs = { name: DEFAULT_PROFILE_NAME, json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '-h' || arg === '--help') parsed.help = true
    else if (arg === '--json') parsed.json = true
    else if (arg === '--endpoint' || arg.startsWith('--endpoint=')) {
      const { value, next } = readFlagValue(argv, i)
      parsed.endpoint = value
      i = next
    } else if (arg === '--token' || arg.startsWith('--token=')) {
      const { value, next } = readFlagValue(argv, i)
      parsed.token = value
      i = next
    } else if (arg === '--name' || arg.startsWith('--name=')) {
      const { value, next } = readFlagValue(argv, i)
      if (value && value.length > 0) parsed.name = value
      i = next
    } else {
      parsed.error = `unknown argument "${arg}"`
      break
    }
  }
  return parsed
}

function printLoginHelp(out: (line: string) => void): void {
  out('usage: neat login [--endpoint <url>] [--token <token>] [--name <name>] [--json]')
  out('  Connect this machine to a hosted NEAT and make it the default for the')
  out('  neat CLI and the MCP server. Omit --endpoint / --token to be prompted')
  out('  (the token is read without echo). --name labels the profile (default')
  out('  "hosted"). The token can also come from NEAT_LOGIN_TOKEN.')
  out('  Exit 0 on success, 1 rejected token/endpoint, 2 misuse, 3 unreachable.')
}

type Probe =
  | { kind: 'ok' }
  | { kind: 'unauthorized'; status: number }
  | { kind: 'not-neat'; status: number }
  | { kind: 'unreachable'; detail: string }

// True when the error is our own request timeout (AbortSignal.timeout) rather
// than a connection/DNS failure. A cold hosted daemon stalls the first request
// for tens of seconds, so a timeout is worth retrying — a refused connection or
// an unknown host is not.
function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: string })?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

// One `/health` round-trip. Returns a terminal Probe, or 'timeout' to tell the
// caller it may retry (a possible cold start).
async function probeOnce(
  fetchImpl: typeof fetch,
  root: string,
  token: string,
  timeoutMs: number,
): Promise<Probe | { kind: 'timeout' }> {
  let res: Response
  try {
    res = await fetchImpl(`${root}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    if (isTimeoutError(err)) return { kind: 'timeout' }
    return { kind: 'unreachable', detail: (err as Error).message }
  }
  if (res.status === 401 || res.status === 403) return { kind: 'unauthorized', status: res.status }
  if (!res.ok) return { kind: 'not-neat', status: res.status }
  const contentType = res.headers.get('content-type') ?? ''
  // A NEAT /health returns JSON; a random 200 from a foreign server does not.
  if (!contentType.includes('json')) return { kind: 'not-neat', status: res.status }
  return { kind: 'ok' }
}

// Confirm the endpoint is a reachable NEAT daemon that accepts the token, the
// same `/health` probe `neat doctor` uses: a secured daemon answers 401/403 to a
// bad bearer, so a wrong token fails here rather than being stored and failing on
// the first read. A fast connection/DNS error fails immediately (a wrong URL),
// but a request timeout is retried within a longer budget — a hosted daemon
// scaled to zero cold-starts in tens of seconds, and the old flat cap reported
// that valid daemon as unreachable.
async function probeDaemon(
  fetchImpl: typeof fetch,
  endpoint: string,
  token: string,
  hooks: { sleep: (ms: number) => Promise<void>; now: () => number; onWaiting: () => void },
): Promise<Probe> {
  const root = endpoint.replace(/\/$/, '')
  const deadline = hooks.now() + PROBE_TOTAL_BUDGET_MS
  let warned = false
  for (;;) {
    const result = await probeOnce(fetchImpl, root, token, PROBE_ATTEMPT_TIMEOUT_MS)
    if (result.kind !== 'timeout') return result
    // A timeout, not a refused connection — treat it as a possible cold start
    // and keep waiting within the budget, telling the user why once.
    if (!warned) {
      hooks.onWaiting()
      warned = true
    }
    if (hooks.now() >= deadline) {
      return { kind: 'unreachable', detail: `no response after ${Math.round(PROBE_TOTAL_BUDGET_MS / 1000)}s` }
    }
    await hooks.sleep(PROBE_RETRY_PAUSE_MS)
  }
}

export async function runLoginCommand(argv: string[], deps: LoginCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line))
  const err = deps.err ?? ((line: string) => console.error(line))
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetchImpl ?? fetch
  const readLine = deps.readLine ?? defaultReadLine
  const readSecret = deps.readSecret ?? defaultReadSecret
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? Date.now

  const args = parseLoginArgs(argv)
  if (args.help) {
    printLoginHelp(out)
    return 0
  }
  if (args.error) {
    err(`neat login: ${args.error}`)
    return 2
  }

  let endpoint = args.endpoint
  if (!endpoint) endpoint = (await readLine('Hosted NEAT endpoint (https://…): '))?.trim()
  if (!endpoint) {
    err('neat login: an endpoint is required — pass --endpoint <url> or run interactively')
    return 2
  }

  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    err(`neat login: --endpoint must be an absolute URL (got "${endpoint}")`)
    return 2
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    err(`neat login: --endpoint must be an http(s) URL (got "${url.protocol}")`)
    return 2
  }

  const envToken = env.NEAT_LOGIN_TOKEN
  let token = args.token ?? (envToken && envToken.length > 0 ? envToken : undefined)
  if (!token) token = (await readSecret('Daemon token: '))?.trim()
  if (!token) {
    err('neat login: a token is required — pass --token, set NEAT_LOGIN_TOKEN, or run interactively')
    return 2
  }

  const probe = await probeDaemon(fetchImpl, endpoint, token, {
    sleep,
    now,
    onWaiting: () => err('Waking the hosted daemon — a cold instance can take up to a minute…'),
  })
  if (probe.kind === 'unreachable') {
    err(`neat login: can't reach ${endpoint} — ${probe.detail}`)
    return 3
  }
  if (probe.kind === 'unauthorized') {
    err(`neat login: ${endpoint} rejected the token (HTTP ${probe.status}). Check the token and try again.`)
    return 1
  }
  if (probe.kind === 'not-neat') {
    err(`neat login: ${endpoint} answered but does not look like a NEAT daemon (HTTP ${probe.status}).`)
    return 1
  }

  await upsertProfile(
    { name: args.name, endpoint, authToken: token },
    { makeActive: true, ...(deps.home ? { home: deps.home } : {}) },
  )

  if (args.json) {
    out(JSON.stringify({ status: 'logged-in', profile: args.name, endpoint }, null, 2))
  } else {
    out(`Logged in — profile "${args.name}" → ${endpoint}`)
    out('The neat CLI and the MCP server now read this hosted graph by default.')
    out('Run `neat logout` to switch back to your local daemon.')
  }
  return 0
}

// ── logout ───────────────────────────────────────────────────────────────────

interface ParsedLogoutArgs {
  name?: string
  help: boolean
  error?: string
}

function parseLogoutArgs(argv: string[]): ParsedLogoutArgs {
  const parsed: ParsedLogoutArgs = { help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '-h' || arg === '--help') parsed.help = true
    else if (arg === '--name' || arg.startsWith('--name=')) {
      const { value, next } = readFlagValue(argv, i)
      parsed.name = value
      i = next
    } else {
      parsed.error = `unknown argument "${arg}"`
      break
    }
  }
  return parsed
}

export async function runLogoutCommand(argv: string[], deps: LoginCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line))
  const err = deps.err ?? ((line: string) => console.error(line))
  const home = deps.home

  const args = parseLogoutArgs(argv)
  if (args.help) {
    out('usage: neat logout [--name <name>]')
    out('  With no argument, clears the active hosted profile so the CLI and MCP')
    out('  server go back to your local daemon (the stored profile is kept).')
    out('  --name <name> removes that profile from ~/.neat/profiles.json entirely.')
    return 0
  }
  if (args.error) {
    err(`neat logout: ${args.error}`)
    return 2
  }

  // `--name` removes a specific profile outright.
  if (args.name !== undefined) {
    if (args.name.length === 0) {
      err('neat logout: --name needs a profile name')
      return 2
    }
    const removed = await removeProfile(args.name, home ?? undefined)
    if (!removed) {
      err(`neat logout: no profile named "${args.name}"`)
      return 1
    }
    out(`Removed profile "${args.name}".`)
    return 0
  }

  const active = await getActiveProfile(home ?? undefined)
  if (!active) {
    out('Not logged in to a hosted NEAT — the CLI is already using your local daemon.')
    return 0
  }
  await clearActiveProfile(home ?? undefined)
  out(`Logged out of "${active.name}" (${active.endpoint}). The CLI is back on your local daemon.`)
  return 0
}

// ── default interactive readers (used when deps don't override) ────────────────

// Prompt for a line, echoed, from the terminal. Returns undefined when stdin is
// not a TTY so a scripted `neat login` fails with the "pass --endpoint" hint
// rather than hanging on a prompt nobody can answer.
async function defaultReadLine(prompt: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(prompt)
  } finally {
    rl.close()
  }
}

// Prompt for a secret WITHOUT echoing it — the token must not land in the
// terminal scrollback. Returns undefined when stdin is not a TTY. Control keys
// are matched by code point so no literal control bytes sit in this source.
async function defaultReadSecret(prompt: string): Promise<string | undefined> {
  const stdin = process.stdin
  if (!stdin.isTTY) return undefined
  process.stdout.write(prompt)
  return new Promise<string>((resolve) => {
    const chars: string[] = []
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const cleanup = (): void => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
    }
    const onData = (ch: string): void => {
      const code = ch.charCodeAt(0)
      if (ch === '\n' || ch === '\r' || code === 4) {
        // Enter or Ctrl-D — done.
        cleanup()
        process.stdout.write('\n')
        resolve(chars.join(''))
      } else if (code === 3) {
        // Ctrl-C — abort the login without writing anything.
        cleanup()
        process.stdout.write('\n')
        process.exit(130)
      } else if (code === 127 || ch === '\b') {
        // Backspace / delete.
        chars.pop()
      } else {
        chars.push(ch)
      }
    }
    stdin.on('data', onData)
  })
}
