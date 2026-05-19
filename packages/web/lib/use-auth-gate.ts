'use client'

import { useEffect } from 'react'

/**
 * Client-side auth gate. When the operator has not yet pasted a NEAT token at
 * /login, redirect there carrying the current path as `?next=`. Reverse-proxy
 * deployments that already terminate auth opt out via
 * `NEXT_PUBLIC_NEAT_AUTH_PROXY=true` (ADR-073 §3 — the bearer is delegated to
 * the deploy platform).
 *
 * Mount this from any client-only page subtree that lives behind the bearer.
 * /login itself does not call it (the page is the destination of the redirect).
 */
export function useAuthGate(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (process.env.NEXT_PUBLIC_NEAT_AUTH_PROXY === 'true') return

    let token: string | null = null
    try {
      token = window.localStorage.getItem('neat:authToken')
    } catch {
      /* private mode — fall through to the redirect */
    }
    if (token) return

    const path = window.location.pathname
    if (path === '/login') return

    const next = encodeURIComponent(path + window.location.search)
    window.location.href = `/login?next=${next}`
  }, [])
}
