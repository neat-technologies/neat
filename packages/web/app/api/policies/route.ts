import { proxyProfile } from '../../../lib/proxy'
import { FIXTURE_POLICIES } from '../../../lib/fixtures'

// ADR-101 — the policy rule list comes from the selected profile's daemon at
// the ROOT (`/policies`, no `/projects/:name` prefix). This is the read-only
// list of rules pinned into an agent's context (policy-schema.md); the
// violation view lives at `/api/policies/violations`.
export async function GET(request: Request): Promise<Response> {
  return proxyProfile(request, '/policies', () => Response.json(FIXTURE_POLICIES))
}
