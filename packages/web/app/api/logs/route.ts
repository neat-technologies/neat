import { proxyProfile } from '../../../lib/proxy'
import { FIXTURE_LOGS } from '../../../lib/fixtures'

// ADR-101 — logs come from the selected profile's daemon at the ROOT
// (`/logs`, no `/projects/:name` prefix). `source`/`service`/`limit`/`since`
// are forwarded through unchanged — `source` repeatable — so the REST
// endpoint, MCP's get_logs, and the CLI's neat logs all filter on the same
// query semantics (docs/contracts/logs.md §6, ADR-132).
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const forwarded = new URLSearchParams()
  for (const key of ['source', 'service', 'limit', 'since']) {
    for (const value of url.searchParams.getAll(key)) forwarded.append(key, value)
  }
  const qs = forwarded.toString()
  return proxyProfile(request, `/logs${qs ? `?${qs}` : ''}`, () => Response.json(FIXTURE_LOGS))
}
