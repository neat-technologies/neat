import { CORE_URL, proxyGet } from '../../../../../lib/proxy'
import { fixtureNodeDetail } from '../../../../../lib/fixtures'

// ADR-057 #5 — node detail forwards `project` per ADR-026.
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const project = new URL(request.url).searchParams.get('project') ?? ''
  const base = project && project !== 'default'
    ? `/projects/${encodeURIComponent(project)}/graph/node`
    : '/graph/node'
  return proxyGet(
    `${CORE_URL}${base}/${encodeURIComponent(params.id)}`,
    () => Response.json(fixtureNodeDetail(params.id)),
    request,
  )
}
