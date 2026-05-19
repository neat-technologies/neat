import { CORE_URL, proxyGet } from '../../../lib/proxy'
import { fixtureSearch } from '../../../lib/fixtures'

// ADR-057 #5 — search forwards `project` so results are scoped to the active
// graph instead of the daemon's default.
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q') ?? ''
  const project = searchParams.get('project') ?? ''
  const base = project && project !== 'default'
    ? `/projects/${encodeURIComponent(project)}/search`
    : '/search'
  return proxyGet(
    `${CORE_URL}${base}?q=${encodeURIComponent(q)}`,
    () => Response.json(fixtureSearch(q)),
    request,
  )
}
