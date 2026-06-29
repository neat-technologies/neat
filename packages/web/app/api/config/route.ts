import { discoverProfiles, proxyGet } from '../../../lib/proxy'

// ADR-073 §3 amendment — `/api/config` is the daemon's auth-mode negotiation
// endpoint. Always unauthenticated, returns `{ publicRead, authProxy }`. Under
// ADR-101 there is no single core URL, so we resolve the daemon the same way
// the rest of the proxy does: the `?project=<label>` profile if named, else the
// first discovered daemon. With no daemon discovered, fall back to the
// conservative default so the browser still gets one stable answer.
export async function GET(request: Request): Promise<Response> {
  const project = new URL(request.url).searchParams.get('project')
  const profiles = await discoverProfiles()
  const endpoint =
    (project ? profiles.find((p) => p.project === project)?.endpoint : undefined) ??
    profiles[0]?.endpoint
  if (!endpoint) {
    return Response.json({ publicRead: false, authProxy: false })
  }
  return proxyGet(
    `${endpoint}/api/config`,
    () => Response.json({ publicRead: false, authProxy: false }),
    request,
  )
}
