import { proxyProfile } from '../../../lib/proxy'
import { fixtureSearch } from '../../../lib/fixtures'

// ADR-101 — search runs against the selected profile's daemon at the ROOT
// (`/search`, no `/projects/:name` prefix).
export async function GET(request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams.get('q') ?? ''
  return proxyProfile(
    request,
    `/search?q=${encodeURIComponent(q)}`,
    () => Response.json(fixtureSearch(q)),
  )
}
