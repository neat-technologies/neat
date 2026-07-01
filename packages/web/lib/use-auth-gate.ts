'use client'

import { useEffect } from 'react'
import { loadDaemonAuthConfig } from './public-read-mode'
import { getActiveAuthToken, readProfileToken } from './active-profile'
import { asProfileList } from './resolve-project'

/**
 * Resolve the per-profile bearer through daemon discovery when the synchronous
 * hints come up empty (#637). On a bare `/` entry — no `?project=` in the URL,
 * empty `neat:lastProject` — the gate has no profile label to key
 * `neat:authToken:<project>` off (ADR-101), so `getActiveAuthToken()` reads
 * nothing even though the first login left a token in storage.
 *
 * The shell resolves its profile through URL → localStorage → daemon discovery
 * (web-multi-project §2); the gate reads the token through the same chain. When
 * discovery yields a single profile, that is the daemon the shell will resolve
 * toward, so its stored bearer is the one that matters — return it and the gate
 * stays put. With no discovered profile, or more than one and no hint to
 * disambiguate between them, there is nothing to read here and the gate falls
 * through to its public-read / redirect decision.
 */
async function tokenForDiscoveredProfile(): Promise<string | null> {
  try {
    const res = await fetch('/api/profiles', { cache: 'no-store' })
    if (!res.ok) return null
    const profiles = asProfileList(await res.json())
    if (profiles.length !== 1) return null
    return readProfileToken(profiles[0].project)
  } catch {
    return null
  }
}

/**
 * Client-side auth gate. When the operator has not yet pasted a NEAT token at
 * /login, redirect there carrying the current path as `?next=`. Reverse-proxy
 * deployments that already terminate auth opt out via
 * `NEXT_PUBLIC_NEAT_AUTH_PROXY=true` (ADR-073 §3 — the bearer is delegated to
 * the deploy platform).
 *
 * Public-read reference deployments (ADR-073 §3a) also skip the redirect.
 * The dashboard renders read-only without forcing a login. The negotiation
 * happens against the daemon's `/api/config` endpoint and is cached after
 * the first call, so the latency hit is paid once per session.
 *
 * Mount this from any client-only page subtree that lives behind the bearer.
 * /login itself does not call it (the page is the destination of the redirect).
 */
export function useAuthGate(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (process.env.NEXT_PUBLIC_NEAT_AUTH_PROXY === 'true') return

    // ADR-101 — read the active profile's bearer (per-profile, not a single
    // `neat:authToken`); falls back to the profile the shell is resolving
    // toward so a stored token short-circuits the redirect on mount.
    if (getActiveAuthToken()) return

    const path = window.location.pathname
    if (path === '/login') return

    let cancelled = false
    void (async () => {
      // No synchronous hint on a bare `/` entry: fall to daemon discovery (the
      // same step-3 source the shell resolves through) to learn which
      // per-profile token key to read. A stored token for the resolvable
      // profile means the operator has already authenticated — don't bounce
      // them to /login (#637).
      const discovered = await tokenForDiscoveredProfile()
      if (cancelled) return
      if (discovered) return

      const cfg = await loadDaemonAuthConfig()
      if (cancelled) return
      if (cfg.publicRead) return

      const next = encodeURIComponent(path + window.location.search)
      window.location.href = `/login?next=${next}`
    })()
    return () => {
      cancelled = true
    }
  }, [])
}
