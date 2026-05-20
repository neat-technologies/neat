import { CORE_URL, proxyGet } from '../../../lib/proxy'
import { FIXTURE_HEALTH } from '../../../lib/fixtures'

// ADR-057 #5 — health is project-aware so the dashboard reflects the project
// the operator is actually viewing. Always routes to /projects/<name>/health
// (issue #343) — daemon-wide /health doesn't carry the per-project shape
// (node count, last update) the StatusBar consumes.
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url)
  const project = searchParams.get('project') || 'default'
  const path = `/projects/${encodeURIComponent(project)}/health`
  return proxyGet(`${CORE_URL}${path}`, () => Response.json(FIXTURE_HEALTH), request)
}
