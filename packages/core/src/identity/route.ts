// Route template canonicalisation, the shared rules behind a RouteNode's id
// (identity.md, #1641 option B). Both static extraction (extract/routes.ts and the
// per-framework route extractors) and OTel ingest (ingest/route.ts) reduce a route
// path through these, so a declared route and an observed server span land on one
// id and fuse (ADR-204, ADR-253, ADR-275). Pure string/regex; no imports.

// Canonicalise a declared route path for use as a RouteNode's stable template:
// drop any query/hash, ensure a leading slash, drop a trailing slash (except
// root). The template keeps its declared params verbatim (`:id`, `{id}`) so an
// OBSERVED server span carrying the same `http.route` lands on the same node.
export function canonicalizeTemplate(raw: string): string {
  let p = raw.split('?')[0]!.split('#')[0]!
  if (!p.startsWith('/')) p = '/' + p
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p
}

// A path segment is dynamic when it names a parameter rather than a literal.
// Covers the router param syntaxes (`:id`, `{id}`, `[id]`, `[...slug]`), a
// reconstructed client interpolation (`:param`), and a concrete value a client
// URL carries in a param position (all-digits, uuid, long hex / Mongo id).
function isDynamicSegment(seg: string): boolean {
  if (seg.length === 0) return false
  if (seg.includes(':')) return true // :id (express/fastify) or reconstructed :param
  if (seg.startsWith('{') || seg.startsWith('[')) return true // {id} openapi; Next [id]/[...slug]/[[...slug]]
  if (/^\d+$/.test(seg)) return true // concrete numeric id
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true // uuid
  if (/^[0-9a-f]{24,}$/i.test(seg)) return true // mongo objectid / long hex token
  return false
}

// Normalise a path-template to a param-agnostic matching key: every dynamic
// segment collapses to `:param`, every literal segment lowercases. This is the
// comparison form both a server route's declared template and a client call's
// URL path reduce to, so `/users/:id` (server) matches `/users/123` and
// `/users/${userId}` (client). The declared template is kept intact on the
// node; only matching uses this reduction.
export function normalizePathTemplate(raw: string): string {
  const canonical = canonicalizeTemplate(raw)
  const segments = canonical.split('/').filter((s) => s.length > 0)
  const normalised = segments.map((seg) => (isDynamicSegment(seg) ? ':param' : seg.toLowerCase()))
  return '/' + normalised.join('/')
}

// A path segment that is a value, never a route literal: all digits, a UUID, or a
// long hex run (an object id, a hash), the value shapes routes.ts treats as
// dynamic. Some instrumentation fills `http.route` with the concrete path; a
// template carrying one of these is that, and minting it would create one route
// per request.
export const VALUE_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24,})$/i

// The route a SERVER span may mint when it fuses with no declared route (ADR-275).
// Only a template qualifies: it must be absolute and carry no value segment. It is
// canonicalized the way the static extractors canonicalize a declared route, so
// both land on one id.
export function observedRouteTemplate(template: string): string | undefined {
  if (!template.startsWith('/')) return undefined
  const t = canonicalizeTemplate(template)
  if (t.split('/').some((seg) => VALUE_SEGMENT.test(seg))) return undefined
  return t
}
