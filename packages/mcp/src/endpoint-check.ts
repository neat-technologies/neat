// Startup guard: confirm the resolved daemon URL actually speaks NEAT before the
// MCP server commits to it.
//
// `resolveBaseUrl` (base-url.ts) honors NEAT_CORE_URL/NEAT_API_URL, else walks up
// to a project's `neat-out/daemon.json`, else falls back to the canonical
// `http://localhost:8080`. That last fallback is a foot-gun: launched outside any
// NEAT project, on a machine where some *other* service happens to own :8080 (an
// otel-demo frontend, a stray dev server), resolution silently lands on a foreign
// server. Every tool call then comes back as an opaque HTML/404 the agent can't
// read — it looks like NEAT is broken when in fact the server never reached NEAT.
//
// So once, at boot, we probe the resolved URL's `/health`. NEAT's `/health` is a
// stable identity signal: every daemon answers `{ ok: true, uptimeMs: <n>, ... }`
// JSON (docs/contracts/rest-api.md, issue #343), it is mounted ahead of any
// project route so a real daemon never 404s it, and it is cheap.

import type { BaseUrlSource } from './base-url.js'

// A short, self-contained deadline for the boot probe — independent of the
// per-tool NEAT_CORE_TIMEOUT_MS. If a daemon is too slow to answer /health in
// this window we treat the endpoint as merely unreachable (not foreign) and let
// the server start; the per-request path reports a clean, bounded error later.
const PROBE_TIMEOUT_MS = 2500

export type EndpointCheck =
  | { kind: 'neat' }
  | { kind: 'unreachable'; detail: string }
  | { kind: 'foreign'; status: number; contentType: string }

export interface CheckOptions {
  bearerToken?: string
  timeoutMs?: number
  // Injectable for tests; defaults to the global fetch.
  fetchImpl?: typeof fetch
}

// Probe the resolved endpoint's /health once and classify it. Never throws —
// a boot check that itself blew up would be worse than the papercut it guards.
export async function checkEndpointIsNeat(
  baseUrl: string,
  opts: CheckOptions = {},
): Promise<EndpointCheck> {
  const root = baseUrl.replace(/\/$/, '')
  const doFetch = opts.fetchImpl ?? fetch
  const headers: Record<string, string> =
    opts.bearerToken && opts.bearerToken.length > 0
      ? { authorization: `Bearer ${opts.bearerToken}` }
      : {}

  let res: Response
  try {
    res = await doFetch(`${root}/health`, {
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? PROBE_TIMEOUT_MS),
    })
  } catch (err) {
    // Connection refused, DNS failure, or our own timeout — no HTTP response at
    // all. A daemon that isn't up yet lives here; never call this "not NEAT".
    return { kind: 'unreachable', detail: errMessage(err) }
  }

  // 401/403 means *something* is enforcing auth on this port — far more likely a
  // real NEAT daemon this server holds the wrong (or no) token for than a foreign
  // service. 5xx is an ambiguous gateway/boot hiccup. Neither is a foreign
  // signal, so don't fail startup on them.
  if (res.status === 401 || res.status === 403 || res.status >= 500) {
    return { kind: 'unreachable', detail: `HTTP ${res.status}` }
  }

  const contentType = res.headers.get('content-type') ?? 'unknown'
  const body = await res.text().catch(() => '')
  if (isNeatHealth(body)) return { kind: 'neat' }
  return { kind: 'foreign', status: res.status, contentType }
}

// NEAT's /health — daemon-wide and per-project alike — always answers
// `{ ok: true, uptimeMs: <number>, ... }`. That pair is the signature: present on
// every real daemon, absent from an arbitrary foreign body (HTML, or some other
// service's JSON).
function isNeatHealth(body: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return false
  }
  if (parsed === null || typeof parsed !== 'object') return false
  const rec = parsed as Record<string, unknown>
  return rec.ok === true && typeof rec.uptimeMs === 'number'
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// The actionable message the server prints (and exits on) when the resolved
// endpoint answered but is not NEAT. Worded per resolution source so the fix is
// specific — the :8080 fallback hitting a foreign server is the common case.
export function describeForeignEndpoint(
  url: string,
  source: BaseUrlSource,
  check: { status: number; contentType: string },
): string {
  const how: Record<BaseUrlSource, string> = {
    env: 'from NEAT_CORE_URL / NEAT_API_URL',
    'daemon-record':
      'from a neat-out/daemon.json record found while walking up from the working directory',
    default:
      'from the default http://localhost:8080 — no NEAT_CORE_URL was set and no neat-out/daemon.json was found walking up from the working directory',
  }
  const fix: Record<BaseUrlSource, string> = {
    env: 'Check that NEAT_CORE_URL points at a running NEAT daemon.',
    'daemon-record':
      'The REST port recorded in that daemon.json is now answered by something else — the record is stale. Restart the project daemon, or set NEAT_CORE_URL to its address.',
    default:
      "Another service — not NEAT — is answering on :8080. Run the MCP server from inside a NEAT project so it can discover neat-out/daemon.json, or set NEAT_CORE_URL to your daemon's address.",
  }
  return [
    `NEAT MCP server: resolved the daemon at ${url} (${how[source]}), but it does not look like NEAT — ` +
      `a probe of ${url}/health returned HTTP ${check.status} (${check.contentType}), not NEAT's health JSON.`,
    fix[source],
    'If this really is your NEAT daemon (for example behind a proxy that rewrites /health), set NEAT_SKIP_ENDPOINT_CHECK=1 to bypass this check.',
  ].join('\n\n')
}
