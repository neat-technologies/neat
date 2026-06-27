import { proxyProfile } from '../../../../../lib/proxy'
import { fixtureBlastRadius } from '../../../../../lib/fixtures'

// ADR-101 — blast-radius is computed by the selected profile's daemon at the
// ROOT (`/graph/blast-radius/:id`, no `/projects/:name` prefix).
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const depth = new URL(request.url).searchParams.get('depth') ?? '10'
  return proxyProfile(
    request,
    `/graph/blast-radius/${encodeURIComponent(params.id)}?depth=${encodeURIComponent(depth)}`,
    () => Response.json(fixtureBlastRadius(params.id)),
  )
}
