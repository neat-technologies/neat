import { proxyProfile } from '../../../../../lib/proxy'
import { fixtureRootCause } from '../../../../../lib/fixtures'

// ADR-101 — root-cause is computed by the selected profile's daemon at the ROOT
// (`/graph/root-cause/:id`, no `/projects/:name` prefix).
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  return proxyProfile(
    request,
    `/graph/root-cause/${encodeURIComponent(params.id)}`,
    () => Response.json(fixtureRootCause(params.id)),
  )
}
