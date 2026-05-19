import { CORE_URL, proxyGet } from '../../../lib/proxy'
import { FIXTURE_HEALTH } from '../../../lib/fixtures'

// ADR-057 #5 — health is project-aware so the dashboard reflects the project
// the operator is actually viewing.
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url)
  const project = searchParams.get('project') ?? ''
  const path = project && project !== 'default'
    ? `/projects/${encodeURIComponent(project)}/health`
    : '/health'
  return proxyGet(`${CORE_URL}${path}`, () => Response.json(FIXTURE_HEALTH), request)
}
