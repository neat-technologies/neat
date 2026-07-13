'use client'

import { useEffect, useState } from 'react'

/**
 * Daemon auth-mode awareness (ADR-073 §3 amendment).
 *
 * The daemon exposes `GET /api/config` unauthenticated. It returns three
 * booleans — `publicRead`, `authProxy`, and `requiresAuth` — and nothing else.
 * The web shell reads it once on first interest and caches the result, so
 * subsequent checks are synchronous and don't fan out into N requests.
 *
 * `publicRead === true` means the daemon serves anonymous GETs (reference
 * deployments at e.g. try.neat.is). The dashboard renders read-only without
 * pushing the operator through /login. Mutation affordances render disabled.
 *
 * `authProxy === true` means an upstream reverse proxy already terminates
 * auth and the daemon-side bearer check is bypassed. Surfaced here so the
 * UI can also avoid the localStorage-token dance in that environment.
 *
 * `requiresAuth === false` means the daemon mounts no bearer hook at all — a
 * tokenless loopback dev daemon or a proxy-terminated one. Every request is
 * served anonymously, so there is no bearer to log in with and the gate must
 * not bounce the operator to /login (ADR-139). This is separate from
 * `publicRead`: a tokenless daemon is fully writable, so read-only rendering
 * stays keyed on `publicRead` alone.
 */
export interface DaemonAuthConfig {
  publicRead: boolean
  authProxy: boolean
  requiresAuth: boolean
}

let cached: DaemonAuthConfig | null = null
let inflight: Promise<DaemonAuthConfig> | null = null

// Conservative default: assume the daemon requires auth. When `/api/config` is
// unreachable we'd rather keep the login gate than skip it against a secured
// daemon we couldn't reach.
const DEFAULT_CONFIG: DaemonAuthConfig = { publicRead: false, authProxy: false, requiresAuth: true }

export async function loadDaemonAuthConfig(): Promise<DaemonAuthConfig> {
  if (cached) return cached
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetch('/api/config', { cache: 'no-store' })
      if (!res.ok) {
        cached = DEFAULT_CONFIG
        return cached
      }
      const body = (await res.json()) as Partial<DaemonAuthConfig>
      cached = {
        publicRead: body.publicRead === true,
        authProxy: body.authProxy === true,
        // Only an explicit `requiresAuth: false` opens the gate. A field-less
        // response (an older daemon) reads as "requires auth" — the safe side.
        requiresAuth: body.requiresAuth !== false,
      }
      return cached
    } catch {
      cached = DEFAULT_CONFIG
      return cached
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function getCachedDaemonAuthConfig(): DaemonAuthConfig | null {
  return cached
}

export function primeDaemonAuthConfig(cfg: DaemonAuthConfig): void {
  cached = cfg
}

export function resetDaemonAuthConfigForTests(): void {
  cached = null
  inflight = null
}

/**
 * React hook variant. Returns the cached config + a `ready` flag that flips
 * once the first read resolves. Until then `publicRead` reads `false` — the
 * conservative default. Callers that need to render differently *only* after
 * the negotiation finishes should gate on `ready`.
 */
export function useDaemonAuthConfig(): { config: DaemonAuthConfig; ready: boolean } {
  const [config, setConfig] = useState<DaemonAuthConfig>(cached ?? DEFAULT_CONFIG)
  const [ready, setReady] = useState(cached !== null)

  useEffect(() => {
    if (cached) {
      setConfig(cached)
      setReady(true)
      return
    }
    let cancelled = false
    void loadDaemonAuthConfig().then((cfg) => {
      if (cancelled) return
      setConfig(cfg)
      setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return { config, ready }
}

/**
 * Shorthand: `true` iff the daemon advertises `publicRead`. Renders mutation
 * affordances disabled, hides login redirects, surfaces the public-read
 * badge in the StatusBar.
 */
export function useReadOnly(): boolean {
  const { config } = useDaemonAuthConfig()
  return config.publicRead
}
