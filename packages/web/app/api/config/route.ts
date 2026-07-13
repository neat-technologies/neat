import { discoverProfiles, firstReachableEndpoint, proxyGet } from '../../../lib/proxy'

// This route resolves a live daemon by reading the discovery directory, so it
// must never be served from a build-time cache. It already reads `request.url`,
// which marks it dynamic today, but the dependency is on runtime state rather
// than the URL — pin it explicitly so a future refactor that stops touching the
// URL can't silently make it cacheable.
export const dynamic = 'force-dynamic'

// ADR-073 §3a / ADR-139 — `/api/config` is the daemon's auth-mode negotiation
// endpoint. Always unauthenticated, returns `{ publicRead, authProxy,
// requiresAuth }`. Under ADR-101 there is no single core URL, so we resolve the
// daemon the same way the rest of the proxy does: the `?project=<label>`
// profile if named, else the first *running* discovered daemon
// (web-multi-project §2.3 — never blindly the first profile, or the browser
// negotiates auth against a stopped daemon while a live one waits later in the
// list). With no daemon discovered, fall back to the conservative default so
// the browser still gets one stable answer — `requiresAuth: true` there keeps
// the login gate in place when we can't confirm the daemon is open.
export async function GET(request: Request): Promise<Response> {
  const project = new URL(request.url).searchParams.get('project')
  const profiles = await discoverProfiles()
  const endpoint =
    (project ? profiles.find((p) => p.project === project)?.endpoint : undefined) ??
    firstReachableEndpoint(profiles)
  if (!endpoint) {
    return Response.json({ publicRead: false, authProxy: false, requiresAuth: true })
  }
  return proxyGet(
    `${endpoint}/api/config`,
    () => Response.json({ publicRead: false, authProxy: false, requiresAuth: true }),
    request,
  )
}
