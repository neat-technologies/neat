import { proxyProfile } from '../../../lib/proxy'
import { FIXTURE_CONNECTORS } from '../../../lib/fixtures'

// ADR-101 / ADR-137 — connector status comes from the selected profile's
// daemon at the ROOT (`/connectors`, no `/projects/:name` prefix), the same
// dual-mount-at-root pattern every other proxy route here follows. Read-only:
// the daemon's own in-memory connector-plane state, never a resolved secret.
export async function GET(request: Request): Promise<Response> {
  return proxyProfile(request, '/connectors', () => Response.json(FIXTURE_CONNECTORS))
}
