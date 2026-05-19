import { CORE_URL, proxyGet } from '../../../lib/proxy'
import { FIXTURE_PROJECTS } from '../../../lib/fixtures'

// ADR-051 — registry endpoint. The list itself is not project-scoped (it's the
// list of projects), but we still accept the query param so the route surface
// is uniform with the rest of the proxy (ADR-057 #5).
export async function GET(request: Request): Promise<Response> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const project = new URL(request.url).searchParams.get('project')
  return proxyGet(`${CORE_URL}/projects`, () => Response.json(FIXTURE_PROJECTS), request)
}
