import { proxyProfile } from '../../../lib/proxy'
import { FIXTURE_GRAPH } from '../../../lib/fixtures'

// ADR-101 — resolve the active profile from `?project=<label>` and proxy to its
// daemon at the ROOT (`/graph`, no `/projects/:name` prefix).
export async function GET(request: Request): Promise<Response> {
  return proxyProfile(request, '/graph', () => Response.json(FIXTURE_GRAPH))
}
