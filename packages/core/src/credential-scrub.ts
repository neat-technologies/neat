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

// Credentials that ride inside a value rather than under a header name: a
// signed URL in a log line, a bearer token echoed into an exception message, a
// `NPM_TOKEN=...` line in an EAS build log. Each pattern keeps the name or the
// scheme and replaces only the secret, so the record still says what failed.
// Every pattern is idempotent (a redacted value never matches again), which
// the at-rest rewrite (ledger-scrub.ts) relies on to tell a clean ledger from
// one that needs rewriting.
export const REDACTED = '[REDACTED]'

const VALUE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // PEM private key blocks, through the END line or the end of a truncated log.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, REDACTED],
  // JWTs (header.payload.signature, both base64url JSON objects).
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Provider tokens with a fixed, recognisable prefix.
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|sk-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/g,
    REDACTED,
  ],
  // The password in a URL's userinfo: scheme://user:secret@host.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/?#"'<>]+:)[^\s@/?#"'<>]+@/gi, `$1${REDACTED}@`],
  // Query parameters that carry a credential: ?token=, &access_token=, presigned
  // S3/GCS signatures. `key` covers Google's `?key=` API keys.
  [
    /([?&](?:access_token|refresh_token|id_token|token|api_key|apikey|api-key|key|secret|client_secret|password|passwd|pwd|auth|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)=)[^&#\s"'<>]+/gi,
    `$1${REDACTED}`,
  ],
  // `Bearer <token>` / `Basic <base64>`. The value must contain a digit, so
  // prose like "Basic authentication failed" is left alone.
  [/\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/-]{8,}=*/g, `$1 ${REDACTED}`],
  // JSON-shaped credential fields: "password": "...".
  [
    /("(?:password|passwd|secret|token|access_token|refresh_token|id_token|api_key|apiKey|client_secret|clientSecret|private_key|privateKey)"\s*:\s*")(?:[^"\\]|\\.)*"/gi,
    `$1${REDACTED}"`,
  ],
  // Env-style assignments of upper-case credential names, as a build log prints
  // them: NPM_TOKEN=..., AWS_SECRET_ACCESS_KEY=...
  [
    /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)[A-Z0-9_]*)(\s*=\s*)(["']?)[^\s"']+\3/g,
    `$1$2$3${REDACTED}$3`,
  ],
]

/** A string with any credential-shaped value inside it replaced by `[REDACTED]`. */
export function redactSecretValues(text: string): string {
  let out = text
  for (const [pattern, replacement] of VALUE_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

type AttrValue = ReturnType<typeof sanitizeAttributes>[string]

function redactAttrValue(v: AttrValue): AttrValue {
  if (typeof v === 'string') return redactSecretValues(v)
  if (Array.isArray(v) && v.some((x) => typeof x === 'string')) {
    return (v as unknown[]).map((x) => (typeof x === 'string' ? redactSecretValues(x) : x)) as AttrValue
  }
  return v
}

/**
 * An incident record with its credential-bearing attributes dropped and any
 * credential-shaped value in its message, stack trace, or remaining attributes
 * redacted. Returns the record itself when there is nothing to change, so a
 * clean record costs no copy.
 */
export function scrubIncidentEvent<T extends ErrorEvent>(ev: T): T {
  let changed = false
  const out: T = { ...ev }

  if (ev.attributes) {
    const kept = sanitizeAttributes(ev.attributes)
    if (Object.keys(kept).length !== Object.keys(ev.attributes).length) changed = true
    for (const [k, v] of Object.entries(kept)) {
      const red = redactAttrValue(v)
      if (red !== v && JSON.stringify(red) !== JSON.stringify(v)) {
        kept[k] = red
        changed = true
      }
    }
    if (Object.keys(kept).length > 0) out.attributes = kept
    else delete out.attributes
  }

  if (typeof ev.errorMessage === 'string') {
    const msg = redactSecretValues(ev.errorMessage)
    if (msg !== ev.errorMessage) {
      out.errorMessage = msg
      changed = true
    }
  }
  if (typeof ev.exceptionStacktrace === 'string') {
    const st = redactSecretValues(ev.exceptionStacktrace)
    if (st !== ev.exceptionStacktrace) {
      out.exceptionStacktrace = st
      changed = true
    }
  }

  return changed ? out : ev
}
