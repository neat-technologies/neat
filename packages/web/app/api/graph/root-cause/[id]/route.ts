import { CORE_URL, proxyGet } from '../../../../../lib/proxy'
import { fixtureRootCause } from '../../../../../lib/fixtures'

// ADR-057 #5 — root-cause forwards `project` per ADR-026.
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const project = new URL(request.url).searchParams.get('project') ?? ''
  const base = project && project !== 'default'
    ? `/projects/${encodeURIComponent(project)}/graph/root-cause`
    : '/graph/root-cause'
  return proxyGet(
    `${CORE_URL}${base}/${encodeURIComponent(params.id)}`,
    () => Response.json(fixtureRootCause(params.id)),
    request,
  )
}
