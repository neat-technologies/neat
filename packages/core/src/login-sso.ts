// The browser / access-token side of `neat login` — the hosted "I have a NEAT
// account" path (client-profiles.md; the control-plane spec in neat-infra #19).
//
// Given the hosted control plane's base URL and the user's short-lived Supabase
// access token — obtained via a browser loopback (Method 1) or pasted directly
// (Method 2 / `--sso-token`, also the smoke path) — this reads the account's
// projects from GET /me, resolves the chosen project's per-project daemon
// credential from GET /me/projects/:id/cli-credential, writes the profile, and
// surfaces the OTLP instrumentation block.
//
// The access token is transient: it authenticates the user just long enough to
// fetch the daemon token, and is never written to disk. Only the long-lived
// daemon token lands in ~/.neat/profiles.json (client-profiles.md §6). The OTel
// token is app-paste creds, printed for the user, never persisted either.

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { upsertProfile } from './profiles.js'

// The control plane is api.neat.is; NEAT_CP_URL (or --cp-url) overrides it (e.g.
// the raw Cloud Run URL for staging before DNS is live). app.neat.is is the GUI,
// not the CP — the browser bridge page that hands the access token back lives on
// the GUI (NEAT_WEB_URL / --web-url).
const DEFAULT_CP_URL = 'https://api.neat.is'
const DEFAULT_WEB_URL = 'https://app.neat.is'
const CALLBACK_TIMEOUT_MS = 5 * 60_000

export function resolveCpUrl(env: NodeJS.ProcessEnv = process.env, override?: string): string {
  const v = override ?? env.NEAT_CP_URL
  return (v && v.length > 0 ? v : DEFAULT_CP_URL).replace(/\/+$/, '')
}

export function resolveWebUrl(env: NodeJS.ProcessEnv = process.env, override?: string): string {
  const v = override ?? env.NEAT_WEB_URL
  return (v && v.length > 0 ? v : DEFAULT_WEB_URL).replace(/\/+$/, '')
}

// GET /me → { user, org, projects } (control-plane spec). A project is usable
// only when status === "running" (it then carries restUrl and cli-credential
// returns 200); any other status is not yet provisioned.
type ProjectStatus = 'created' | 'provisioning' | 'running' | 'stopped' | 'failed'
interface CpProject {
  id: string
  name: string
  status: ProjectStatus
  restUrl?: string
}
interface CliCredential {
  endpoint: string
  authToken: string
  ingestEndpoint?: string
  otelToken?: string
}

export interface SsoDeps {
  fetchImpl?: typeof fetch
  out?: (line: string) => void
  err?: (line: string) => void
  // Open a URL in the browser; returns whether it launched. Injected for tests.
  openBrowser?: (url: string) => boolean
  // `~/.neat` override, for tests.
  home?: string
}

// An error carries the CLI exit code to surface (1 rejected/needs-action, 2
// misuse, 3 unreachable), matching the rest of `neat login`.
interface SsoError {
  code: number
  message: string
}

// ── the /me → cli-credential exchange ─────────────────────────────────────────

function pickProject(
  projects: CpProject[],
  want: string | undefined,
): { project: CpProject } | { error: SsoError } {
  if (want) {
    const p = projects.find((x) => x.id === want || x.name === want)
    if (!p) return { error: { code: 1, message: `no project named or id'd "${want}" on this account` } }
    return { project: p }
  }
  const running = projects.filter((p) => p.status === 'running')
  if (running.length === 1) return { project: running[0]! }
  if (running.length === 0) {
    const listed = projects.length
      ? ` (have: ${projects.map((p) => `${p.name} [${p.status}]`).join(', ')})`
      : ''
    return {
      error: {
        code: 1,
        message: `no running project to connect to — create + provision one in the console first${listed}`,
      },
    }
  }
  return {
    error: {
      code: 2,
      message: `several running projects — pass --project <name>: ${running.map((p) => p.name).join(', ')}`,
    },
  }
}

/**
 * Exchange a Supabase access token for a project's daemon credential:
 * GET /me → pick a running project → GET /me/projects/:id/cli-credential.
 * Returns the chosen project + its `{ endpoint, authToken, ingestEndpoint?,
 * otelToken? }`, or an error carrying the exit code to surface.
 */
export async function exchangeCredential(
  cpUrl: string,
  accessToken: string,
  opts: { project?: string },
  deps: SsoDeps,
): Promise<{ project: CpProject; cred: CliCredential } | { error: SsoError }> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const auth = { authorization: `Bearer ${accessToken}` }

  let meRes: Response
  try {
    meRes = await fetchImpl(`${cpUrl}/me`, { headers: auth })
  } catch (e) {
    return { error: { code: 3, message: `can't reach the control plane at ${cpUrl} — ${(e as Error).message}` } }
  }
  if (meRes.status === 401) return { error: { code: 1, message: 'your session is expired or invalid — log in again' } }
  if (!meRes.ok) return { error: { code: 1, message: `the control plane returned HTTP ${meRes.status} on /me` } }
  const me = (await meRes.json().catch(() => ({}))) as { projects?: unknown }
  const projects = (Array.isArray(me.projects) ? me.projects : []) as CpProject[]

  const picked = pickProject(projects, opts.project)
  if ('error' in picked) return picked
  const project = picked.project

  let credRes: Response
  try {
    credRes = await fetchImpl(`${cpUrl}/me/projects/${encodeURIComponent(project.id)}/cli-credential`, {
      headers: auth,
    })
  } catch (e) {
    return { error: { code: 3, message: `can't reach the control plane — ${(e as Error).message}` } }
  }
  if (credRes.status === 409) {
    return {
      error: {
        code: 1,
        message: `project "${project.name}" isn't provisioned yet (status: ${project.status}) — provision it first`,
      },
    }
  }
  if (credRes.status === 404) return { error: { code: 1, message: `project "${project.name}" was not found, or isn't yours` } }
  if (credRes.status === 401) return { error: { code: 1, message: 'your session is expired or invalid — log in again' } }
  if (!credRes.ok) return { error: { code: 1, message: `the control plane returned HTTP ${credRes.status} for the credential` } }

  const cred = (await credRes.json().catch(() => ({}))) as CliCredential
  if (!cred.endpoint || !cred.authToken) {
    return { error: { code: 1, message: 'the credential response was missing endpoint/authToken' } }
  }
  return { project, cred }
}

// ── the browser loopback (Method 1) ───────────────────────────────────────────

function defaultOpenBrowser(url: string): boolean {
  const platform = process.platform
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * Start a one-shot loopback listener on 127.0.0.1, open the browser to the GUI's
 * bridge page (`<webUrl>/cli/auth?callback=…&state=…`), and resolve with the
 * Supabase access token the page forwards to `…/callback?token=…&state=…`. The
 * `state` nonce is validated so only this CLI's own launch is accepted.
 */
export async function loopbackReceiveToken(
  webUrl: string,
  deps: SsoDeps,
  opts: { timeoutMs?: number } = {},
): Promise<{ token: string } | { error: SsoError }> {
  const out = deps.out ?? (() => {})
  const openFn = deps.openBrowser ?? defaultOpenBrowser
  const state = randomBytes(16).toString('hex')

  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const done = (r: { token: string } | { error: SsoError }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        server.close()
      } catch {
        // already closing
      }
      resolve(r)
    }

    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404)
        res.end()
        return
      }
      const token = reqUrl.searchParams.get('token')
      const gotState = reqUrl.searchParams.get('state')
      if (!token || gotState !== state) {
        res.writeHead(400, { 'content-type': 'text/html' })
        res.end('<h1>NEAT login failed</h1><p>Invalid or mismatched token. You can close this tab.</p>')
        done({ error: { code: 1, message: 'the browser returned an invalid or mismatched token' } })
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end("<h1>You're logged in to NEAT.</h1><p>You can close this tab and return to the terminal.</p>")
      done({ token })
    })

    server.on('error', (e) => done({ error: { code: 3, message: `couldn't start the local login listener — ${e.message}` } }))
    timer = setTimeout(
      () => done({ error: { code: 1, message: 'timed out waiting for the browser login' } }),
      opts.timeoutMs ?? CALLBACK_TIMEOUT_MS,
    )

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      const callback = `http://127.0.0.1:${port}/callback`
      const authUrl = `${webUrl}/cli/auth?callback=${encodeURIComponent(callback)}&state=${state}`
      out('Opening your browser to log in to NEAT…')
      out(`If it doesn't open, visit:\n  ${authUrl}`)
      openFn(authUrl)
    })
  })
}

// ── orchestration ─────────────────────────────────────────────────────────────

export interface SsoLoginOptions {
  cpUrl: string
  webUrl: string
  // A pasted/piped Supabase access token (Method 2 / smoke). When absent, the
  // browser loopback (Method 1) obtains one.
  ssoToken?: string
  name: string
  project?: string
  json: boolean
  timeoutMs?: number
}

/**
 * Run the hosted login: obtain the access token (pasted or via the browser),
 * exchange it for the project's daemon credential, write the profile + set it
 * active, and surface the OTLP block. Returns a CLI exit code.
 */
export async function runSsoLogin(opts: SsoLoginOptions, deps: SsoDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l))
  const err = deps.err ?? ((l: string) => console.error(l))

  let accessToken = opts.ssoToken
  if (!accessToken) {
    const lb = await loopbackReceiveToken(opts.webUrl, deps, { timeoutMs: opts.timeoutMs ?? CALLBACK_TIMEOUT_MS })
    if ('error' in lb) {
      err(`neat login: ${lb.error.message}`)
      return lb.error.code
    }
    accessToken = lb.token
  }

  const ex = await exchangeCredential(opts.cpUrl, accessToken, { project: opts.project }, deps)
  if ('error' in ex) {
    err(`neat login: ${ex.error.message}`)
    return ex.error.code
  }
  const { project, cred } = ex

  await upsertProfile(
    { name: opts.name, endpoint: cred.endpoint, authToken: cred.authToken },
    { makeActive: true, ...(deps.home ? { home: deps.home } : {}) },
  )

  if (opts.json) {
    out(
      JSON.stringify(
        {
          status: 'logged-in',
          profile: opts.name,
          project: project.name,
          endpoint: cred.endpoint,
          ...(cred.ingestEndpoint ? { ingestEndpoint: cred.ingestEndpoint } : {}),
        },
        null,
        2,
      ),
    )
  } else {
    out(`Logged in — profile "${opts.name}" → ${project.name} (${cred.endpoint})`)
    out('The neat CLI and the MCP server now read this hosted graph by default.')
    if (cred.ingestEndpoint && cred.otelToken) {
      out('')
      out('To fill the OBSERVED layer, instrument your app to send OpenTelemetry to the hosted daemon:')
      out(`  OTEL_EXPORTER_OTLP_ENDPOINT=${cred.ingestEndpoint}`)
      out(`  OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${cred.otelToken}`)
    }
    out('Run `neat logout` to switch back to your local daemon.')
  }
  return 0
}
