import { proxyProfile } from '../../../lib/proxy'
import { fixtureSearch } from '../../../lib/fixtures'

// ADR-101 — search runs against the selected profile's daemon at the ROOT
// (`/search`, no `/projects/:name` prefix).
//
// #809 — the daemon returns `{ matches: [{...node, score}] }` (flattened nodes),
// while the UI (and the demo fixture) read `{ results: [{ node, score }] }`.
// Normalize the live shape here so search works against a real daemon; the
// fixture path already matches and passes straight through.
export async function GET(request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams.get('q') ?? ''
  const res = await proxyProfile(
    request,
    `/search?q=${encodeURIComponent(q)}`,
    () => Response.json(fixtureSearch(q)),
  )
  let body: unknown
  try {
    body = await res.clone().json()
  } catch {
    return res
  }
  const b = body as { matches?: unknown; results?: unknown }
  const raw = Array.isArray(b.matches) ? b.matches : Array.isArray(b.results) ? b.results : null
  if (raw === null) return res
  const results = raw.map((m) => {
    const item = m as { node?: unknown; id?: string; type?: string; name?: string; score?: number }
    return item.node
      ? item
      : { node: { id: item.id, type: item.type, name: item.name }, score: item.score }
  })
  return Response.json({ results })
}
