// `neat connect <provider>` — connect a provider to your HOSTED NEAT project over OAuth: the CLI equivalent
// of the console's "Connect" button. It asks the hosted control plane for the provider's consent URL, opens
// the browser, and polls until the connection lands.
//
// This is distinct from `neat connector add`, which configures a connector for a LOCAL/self-hosted daemon by
// credential. `connect` talks to the control plane, not a daemon, so it needs the hosted CP URL + a NEAT API
// key + the hosted project id. Those come from the environment (NEAT_CP_URL / NEAT_API_KEY /
// NEAT_CP_PROJECT_ID) today, and from the active profile once `neat login` persists them. Every side effect
// (fetch, the browser opener, the clock) is injected so the whole flow is testable with no network.

import { spawn } from 'node:child_process'
import { resolveCpUrl } from './login-sso.js'

export interface HostedConnectDeps {
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  openBrowser?: (url: string) => boolean
  out?: (line: string) => void
  err?: (line: string) => void
  /** Poll cadence and ceiling (tests shrink them). */
  pollMs?: number
  timeoutMs?: number
  sleepImpl?: (ms: number) => Promise<void>
}

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

interface HostedCreds {
  cpUrl: string
  apiKey: string
  projectId: string
}

function resolveCreds(env: NodeJS.ProcessEnv): HostedCreds | { error: string } {
  const apiKey = env.NEAT_API_KEY
  const projectId = env.NEAT_CP_PROJECT_ID
  if (!apiKey) return { error: 'not logged in — run `neat login`, or set NEAT_API_KEY (a neat_pat_… key)' }
  if (!projectId) return { error: 'no hosted project — run `neat login`, or set NEAT_CP_PROJECT_ID' }
  return { cpUrl: resolveCpUrl(env).replace(/\/+$/, ''), apiKey, projectId }
}

interface ConnectionListItem {
  provider?: string
  status?: string
}

/**
 * `neat connect …` entry point. `rawArgs` is argv past the `connect` token. Returns a process exit code and
 * never calls `process.exit` itself, so the caller (and tests) own control flow.
 */
export async function runConnectCommand(rawArgs: string[], deps: HostedConnectDeps = {}): Promise<number> {
  const env = deps.env ?? process.env
  const out = deps.out ?? ((l) => console.log(l))
  const err = deps.err ?? ((l) => console.error(l))
  const fetchImpl = deps.fetchImpl ?? fetch
  const open = deps.openBrowser ?? defaultOpenBrowser
  const pollMs = deps.pollMs ?? 2000
  const timeoutMs = deps.timeoutMs ?? 180_000
  const sleep = deps.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  const provider = rawArgs.find((a) => !a.startsWith('-'))
  if (!provider || rawArgs.includes('-h') || rawArgs.includes('--help')) {
    out('usage: neat connect <provider>   connect a provider to your hosted NEAT project over OAuth')
    out("  Opens the provider's consent screen in your browser and waits for the connection to land.")
    out('  Needs a hosted login (`neat login`) or NEAT_CP_URL + NEAT_API_KEY + NEAT_CP_PROJECT_ID.')
    out('  For a local/self-hosted daemon, use `neat connector add` instead.')
    return provider ? 0 : 2
  }

  const creds = resolveCreds(env)
  if ('error' in creds) {
    err(`neat connect: ${creds.error}`)
    return 2
  }

  const connectionsUrl = `${creds.cpUrl}/me/projects/${encodeURIComponent(creds.projectId)}/connections`

  // Leg 1 — ask the control plane for the provider's OAuth consent URL.
  let authorizeUrl: string
  try {
    const res = await fetchImpl(`${connectionsUrl}/${encodeURIComponent(provider)}/authorize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${creds.apiKey}` },
    })
    if (res.status === 401) {
      err('neat connect: not authorized — run `neat login` (or check NEAT_API_KEY).')
      return 1
    }
    if (res.status === 404 || res.status === 501) {
      err(`neat connect: ${provider} isn't available to connect over OAuth yet.`)
      return 1
    }
    if (!res.ok) {
      err(`neat connect: couldn't start connecting ${provider} (HTTP ${res.status}).`)
      return 1
    }
    const body = (await res.json().catch(() => ({}))) as { authorizeUrl?: string }
    if (!body.authorizeUrl) {
      err(`neat connect: the control plane returned no authorize URL for ${provider}.`)
      return 1
    }
    authorizeUrl = body.authorizeUrl
  } catch (e) {
    err(`neat connect: couldn't reach the control plane at ${creds.cpUrl} — ${(e as Error).message}`)
    return 1
  }

  out(`Opening ${provider}'s consent screen in your browser…`)
  if (!open(authorizeUrl)) out('Could not open a browser automatically — open this URL to authorize:')
  out(`  ${authorizeUrl}`)
  out('Waiting for you to authorize…')

  // Poll the control plane until the provider connection lands (the callback seals it server-side).
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(pollMs)
    try {
      const res = await fetchImpl(connectionsUrl, { headers: { authorization: `Bearer ${creds.apiKey}` } })
      if (res.ok) {
        const conns = (await res.json().catch(() => [])) as ConnectionListItem[]
        const hit = Array.isArray(conns) ? conns.find((c) => c.provider === provider) : undefined
        if (hit) {
          out(`✓ ${provider} connected${hit.status ? ` (${hit.status})` : ''}.`)
          return 0
        }
      }
    } catch {
      // Transient reachability blip — keep polling until the deadline.
    }
  }
  err(
    `neat connect: timed out waiting for ${provider}. If you authorized, run \`neat connect ${provider}\` ` +
      'again to re-check — the connection may still land.',
  )
  return 1
}
