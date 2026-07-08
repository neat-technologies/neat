import { proxyProfile } from '../../../lib/proxy'
import { FIXTURE_DIVERGENCES } from '../../../lib/fixtures'

// ADR-101 — divergences are computed by the selected profile's daemon at the
// ROOT (`/graph/divergences`, no `/projects/:name` prefix). Read-only, derived
// (divergence-query.md). The optional `type` / `minConfidence` filters ride
// through verbatim so the page can narrow the result set server-side.
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const qs = new URLSearchParams()
  const type = url.searchParams.get('type')
  const minConfidence = url.searchParams.get('minConfidence')
  if (type) qs.set('type', type)
  if (minConfidence) qs.set('minConfidence', minConfidence)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return proxyProfile(
    request,
    `/graph/divergences${suffix}`,
    () => Response.json(FIXTURE_DIVERGENCES),
  )
}
