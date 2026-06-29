import { proxyProfile } from '../../../lib/proxy'
import { FIXTURE_HEALTH } from '../../../lib/fixtures'

// ADR-101 — health probes the selected profile's daemon at the ROOT (`/health`,
// no `/projects/:name` prefix). A per-project daemon serves its one project, so
// the daemon-wide `/health` IS that project's readiness. resolveProfile uses
// this route as its reachability probe before auto-selecting (#419).
export async function GET(request: Request): Promise<Response> {
  return proxyProfile(request, '/health', () => Response.json(FIXTURE_HEALTH))
}
