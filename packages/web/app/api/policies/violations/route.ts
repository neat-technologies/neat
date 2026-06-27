import { proxyProfile } from '../../../../lib/proxy'
import { FIXTURE_VIOLATIONS } from '../../../../lib/fixtures'

// ADR-101 — policy violations are evaluated by the selected profile's daemon at
// the ROOT (`/policies/violations`, no `/projects/:name` prefix).
export async function GET(request: Request): Promise<Response> {
  return proxyProfile(request, '/policies/violations', () => Response.json(FIXTURE_VIOLATIONS))
}
