import { proxyProfile } from '../../../lib/proxy'
import { FIXTURE_INCIDENTS } from '../../../lib/fixtures'

// ADR-101 — incidents come from the selected profile's daemon at the ROOT
// (`/incidents`, no `/projects/:name` prefix).
export async function GET(request: Request): Promise<Response> {
  const limit = new URL(request.url).searchParams.get('limit') ?? '50'
  return proxyProfile(
    request,
    `/incidents?limit=${encodeURIComponent(limit)}`,
    () => Response.json(FIXTURE_INCIDENTS),
  )
}
