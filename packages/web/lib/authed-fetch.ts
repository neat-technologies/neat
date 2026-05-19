'use client'

import { trackedFetch } from './proxy-client'

const TOKEN_KEY = 'neat:authToken'

function readToken(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const v = window.localStorage.getItem(TOKEN_KEY)
    return v && v.length > 0 ? v : null
  } catch {
    return null
  }
}

function clearToken(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
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
    clearToken()
    const path = window.location.pathname
    if (path !== '/login') {
      const next = encodeURIComponent(path + window.location.search)
      window.location.href = `/login?next=${next}`
    }
  }

  return res
}
