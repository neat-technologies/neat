import { CORE_URL, proxyGet } from '../../../../lib/proxy'
import { FIXTURE_VIOLATIONS } from '../../../../lib/fixtures'

// ADR-057 #5 — policies are evaluated per project per ADR-043.
export async function GET(request: Request): Promise<Response> {
  const project = new URL(request.url).searchParams.get('project') ?? ''
  const path = project && project !== 'default'
    ? `/projects/${encodeURIComponent(project)}/policies/violations`
    : '/policies/violations'
  return proxyGet(`${CORE_URL}${path}`, () => Response.json(FIXTURE_VIOLATIONS), request)
}
