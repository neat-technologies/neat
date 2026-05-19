import { CORE_URL, proxyGet } from '../../../../../lib/proxy'
import { fixtureBlastRadius } from '../../../../../lib/fixtures'

// ADR-057 #5 — blast-radius forwards `project` per ADR-026.
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const { searchParams } = new URL(request.url)
  const depth = searchParams.get('depth') ?? '10'
  const project = searchParams.get('project') ?? ''
  const base = project && project !== 'default'
    ? `/projects/${encodeURIComponent(project)}/graph/blast-radius`
    : '/graph/blast-radius'
  return proxyGet(
    `${CORE_URL}${base}/${encodeURIComponent(params.id)}?depth=${depth}`,
    () => Response.json(fixtureBlastRadius(params.id)),
    request,
  )
}
