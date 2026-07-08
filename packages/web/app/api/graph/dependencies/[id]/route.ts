import { proxyProfile } from '../../../../../lib/proxy'
import { fixtureDependencies } from '../../../../../lib/fixtures'

// ADR-101 — transitive dependencies are computed by the selected profile's
// daemon at the ROOT (`/graph/dependencies/:id`, no `/projects/:name` prefix).
// The node-scoped "what does this depend on, transitively?" query — the sibling
// of blast-radius (what depends on it). Surfaced as an Inspector action.
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const depth = new URL(request.url).searchParams.get('depth') ?? '10'
  return proxyProfile(
    request,
    `/graph/dependencies/${encodeURIComponent(params.id)}?depth=${encodeURIComponent(depth)}`,
    () => Response.json(fixtureDependencies(params.id)),
  )
}
