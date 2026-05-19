import { CORE_URL, proxyGet } from '../../../lib/proxy'
import { FIXTURE_INCIDENTS } from '../../../lib/fixtures'

// ADR-057 #5 — incidents are scoped to a project per ADR-026's dual-mount.
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url)
  const limit = searchParams.get('limit') ?? '50'
  const project = searchParams.get('project') ?? ''
  const base = project && project !== 'default'
    ? `/projects/${encodeURIComponent(project)}/incidents`
    : '/incidents'
  return proxyGet(
    `${CORE_URL}${base}?limit=${limit}`,
    () => Response.json(FIXTURE_INCIDENTS),
    request,
  )
}
