import { proxyProfile } from '../../../lib/proxy'
import { FIXTURE_LOGS } from '../../../lib/fixtures'

// ADR-101 — logs come from the selected profile's daemon at the ROOT
// (`/logs`, no `/projects/:name` prefix). `source` is repeatable
// (?source=native&source=supabase); `service`/`since`/`limit` ride through
// verbatim, the same params MCP's get_logs and the CLI's `neat logs` read
// (logs.md §6 — one data path, identical params everywhere).
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const sources = url.searchParams.getAll('source')
  const qs = new URLSearchParams()
  for (const source of sources) qs.append('source', source)
  const service = url.searchParams.get('service')
  const since = url.searchParams.get('since')
  const limit = url.searchParams.get('limit')
  if (service) qs.set('service', service)
  if (since) qs.set('since', since)
  if (limit) qs.set('limit', limit)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return proxyProfile(request, `/logs${suffix}`, () => {
    // The fixture fallback (no reachable daemon, DEMO mode) has to honor the
    // same filters a real daemon's queryLogEntries would — otherwise the
    // Logs page's source chips look wired but silently do nothing offline.
    const logs =
      sources.length > 0
        ? FIXTURE_LOGS.logs.filter((l) => sources.includes(l.source))
        : FIXTURE_LOGS.logs
    return Response.json({ count: logs.length, total: logs.length, logs })
  })
}
