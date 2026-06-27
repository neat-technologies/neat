import { proxyProfile } from '../../../lib/proxy'

// ADR-101 — the stale-events feed comes from the selected profile's daemon at
// the ROOT (`/stale-events`, no `/projects/:name` prefix).
export async function GET(request: Request): Promise<Response> {
  const limit = new URL(request.url).searchParams.get('limit') ?? '50'
  return proxyProfile(
    request,
    `/stale-events?limit=${encodeURIComponent(limit)}`,
    () => Response.json({ events: [], count: 0, total: 0 }),
  )
}
