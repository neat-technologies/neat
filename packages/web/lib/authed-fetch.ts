'use client'

import { trackedFetch } from './proxy-client'
import { loadDaemonAuthConfig } from './public-read-mode'
import {
  getActiveAuthToken,
  getActiveProfile,
  clearProfileToken,
  readInitialProfileName,
} from './active-profile'

// ADR-101 — the bearer is per-profile, not a single `neat:authToken`. The
// active profile's token (hosted: on the profile; local: the per-profile
// store) is what we attach. Local default is no token.
function readToken(): string | null {
  return getActiveAuthToken()
}

function clearToken(): void {
  clearProfileToken(getActiveProfile()?.project ?? readInitialProfileName())
}

/**
 * Build an SSE endpoint URL carrying the operator's bearer (ADR-073 §3).
 *
 * `EventSource` cannot set request headers, so a bearer-protected daemon would
 * 401 every stream the dashboard opens. We pass the token through as the
 * `access_token` query param instead; the Next.js `/api/events` route promotes
 * it back to `Authorization: Bearer <token>` before forwarding to the daemon,
 * so the token never reaches the daemon as a query string. Returns the URL
 * unchanged when no token is stored (dev daemon, public-read).
 */
export function authedEventSourceUrl(path: string): string {
  const token = readToken()
  if (!token) return path
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}access_token=${encodeURIComponent(token)}`
}

/**
 * Browser-side fetch that attaches the operator's NEAT token (when present)
 * and redirects to /login when the daemon rejects it. Composes onto
 * `trackedFetch` so the toast / debug-panel wiring from ADR-058 still fires.
 *
 * Server components and route handlers should keep calling raw `fetch` —
 * they don't have access to localStorage and can't act on a 401 anyway.
 */
export async function authedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const token = readToken()
  const headers = new Headers(init?.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const res = await trackedFetch(url, { ...init, headers })

  if (res.status === 401 && typeof window !== 'undefined') {
    // ADR-073 §3a — public-read deployments serve anonymous GETs; a 401 on
    // a read just means the operator hit a write endpoint without the
    // bearer. Surface the 401 to the caller instead of bouncing them to
    // /login, which they have no reason to visit.
    const cfg = await loadDaemonAuthConfig()
    if (cfg.publicRead) return res

    clearToken()
    const path = window.location.pathname
    if (path !== '/login') {
      const next = encodeURIComponent(path + window.location.search)
      window.location.href = `/login?next=${next}`
    }
  }

  return res
}
