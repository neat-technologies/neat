import { proxyProfile } from '../../../../../lib/proxy'
import { fixtureNodeDetail } from '../../../../../lib/fixtures'

// ADR-101 — node detail comes from the selected profile's daemon at the ROOT
// (`/graph/node/:id`, no `/projects/:name` prefix).
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  return proxyProfile(
    request,
    `/graph/node/${encodeURIComponent(params.id)}`,
    () => Response.json(fixtureNodeDetail(params.id)),
  )
}
