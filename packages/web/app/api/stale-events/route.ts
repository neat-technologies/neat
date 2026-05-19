import { CORE_URL, proxyGet } from '../../../lib/proxy'

// ADR-057 #5 — stale-events stream is project-scoped per ADR-024 + ADR-026.
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url)
  const limit = searchParams.get('limit') ?? '50'
  const project = searchParams.get('project') ?? ''
  const base = project && project !== 'default'
    ? `/projects/${encodeURIComponent(project)}/stale-events`
    : '/stale-events'
  return proxyGet(
    `${CORE_URL}${base}?limit=${limit}`,
    () => Response.json({ events: [], count: 0, total: 0 }),
    request,
  )
}
