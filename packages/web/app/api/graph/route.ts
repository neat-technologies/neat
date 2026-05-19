import { CORE_URL, proxyGet } from '../../../lib/proxy'
import { FIXTURE_GRAPH } from '../../../lib/fixtures'

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url)
  const project = searchParams.get('project')
  const path =
    project && project !== 'default'
      ? `/projects/${encodeURIComponent(project)}/graph`
      : '/graph'
  return proxyGet(`${CORE_URL}${path}`, () => Response.json(FIXTURE_GRAPH), request)
}
