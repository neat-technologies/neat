import type { ErrorEvent } from '@neat.is/types'

// The credential scrub for incident records (#1182, #1184, #1187). One
// definition, applied where a record is written (appendRuntimeIncident, which
// every runtime incident goes through: OTel spans and connector incidents
// alike) and again where one is read, so neither a new producer nor a record
// written before the scrub existed can put a credential header into
// errors.ndjson or in front of an agent.

// Header attributes that carry credentials. Some auto-instrumentation copies
// request/response headers into span attributes wholesale — a `...req.headers`
// spread — which would otherwise persist a caller's session cookie or bearer
// token into the incident record at rest. NEAT's own instrumentation never
// emits these; the exposure rides in from a target's over-broad SDK, and NEAT
// is the store, so it drops them here (#1182).
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-amz-security-token',
  'x-csrf-token',
])

// The header name an attribute key carries — the segment after `.header.` for the
// OTel `http.request.header.<name>` / `http.response.header.<name>` forms, or the
// bare key itself for an SDK that names the header without a prefix.
function attrHeaderName(key: string): string {
  const lower = key.toLowerCase()
  const marker = '.header.'
  const at = lower.lastIndexOf(marker)
  return at >= 0 ? lower.slice(at + marker.length) : lower
}

function isSensitiveAttrKey(key: string): boolean {
  return SENSITIVE_HEADER_NAMES.has(attrHeaderName(key))
}

// Span attributes pass through so consumers can read source attribution
// (`code.filepath`, `code.lineno`, `code.function`) and other SDK-emitted
// context without ingest enumerating every key it cares about — with one
// exception: credential-bearing header attributes are dropped (see above), so
// a span that arrived carrying a cookie or bearer token doesn't persist it.
// Coerce the survivors to a JSON-safe shape — bigint values from the parsed
// span (long ids, high-cardinality counters) become strings so the record can
// be serialised to the ErrorEvent shape and round-tripped through
// ErrorEventSchema. All other types pass through unchanged.
export function sanitizeAttributes(
  attrs: Record<string, unknown>,
): Record<string, string | number | boolean | null | string[] | number[] | boolean[]> {
  const out: Record<string, string | number | boolean | null | string[] | number[] | boolean[]> = {}
  for (const [k, v] of Object.entries(attrs)) {
    if (isSensitiveAttrKey(k)) continue
    if (typeof v === 'bigint') out[k] = v.toString()
    else out[k] = v as string | number | boolean | null | string[] | number[] | boolean[]
  }
  return out
}

/**
 * An incident record with its credential-bearing attributes dropped. Returns the
 * record itself when there is nothing to drop, so a clean record costs no copy.
 */
export function scrubIncidentEvent<T extends ErrorEvent>(ev: T): T {
  if (!ev.attributes) return ev
  const scrubbed = sanitizeAttributes(ev.attributes)
  if (Object.keys(scrubbed).length === Object.keys(ev.attributes).length) return ev
  if (Object.keys(scrubbed).length > 0) return { ...ev, attributes: scrubbed }
  const { attributes: _dropped, ...rest } = ev
  return rest as T
}
