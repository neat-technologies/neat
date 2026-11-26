import type { ErrorEvent } from '@neat.is/types'

// The credential scrub for incident records (#1182, #1184, #1187). One
// definition, applied where a record is written (appendRuntimeIncident, which
// every runtime incident goes through: OTel spans and connector incidents
// alike) and again where one is read, so neither a new producer nor a record
// written before the scrub existed can put a credential header into
// errors.ndjson or in front of an agent. The same value redaction covers the
// free text on graph edges, evidence snippets and last-error messages (#1759).

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

// A credential name in any case and style: password, dbPassword, DB_PASSWORD,
// apiKey, api_key, SECRET_KEY, secretAccessKey, authToken. The name must end in
// the credential word (with an optional `key` after `secret`), so `tokenizer`
// or `password_reset_url` is not a credential name.
const CRED_NAME =
  '[A-Za-z0-9_$]*?(?:password|passwd|pwd|secret(?:_?key)?|token|api_?key|access_?key|client_?secret|private_?key|auth_?token|credentials?)'

// A non-empty quoted literal whose opening quote is capture group `n`, so the
// replacement can reuse it. Already redacted values and template interpolations
// are skipped, which keeps every pattern that uses it idempotent.
const quotedLiteral = (n: number): string =>
  `(["'\`])(?!\\[REDACTED\\]\\${n})(?!\\$\\{)(?:(?!\\${n})[^\\\\\\n]|\\\\.)+\\${n}`

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
  // npm config credentials, as npm prints them in an install error or a config
  // dump: //registry.npmjs.org/:_authToken=..., _auth=..., _password=...
  [/\b(_(?:authToken|auth|password)\s*=\s*)[^\s"']+/g, `$1${REDACTED}`],
  // Env-style assignments of upper-case credential names, as a build log prints
  // them: NPM_TOKEN=..., AWS_SECRET_ACCESS_KEY=... A value that goes on into a
  // call, an index or a member (`API_TOKEN = os.environ.get("API_TOKEN", "...")`,
  // `SECRET_KEY = os.environ["SECRET_KEY"]`) is an expression, not the secret, so
  // it is left for the patterns below that read the literal inside it.
  [
    /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)[A-Z0-9_]*)(\s*=\s*)(["']?)[^\s"'([{]+\3(?![\w$.([{"'])/g,
    `$1$2$3${REDACTED}$3`,
  ],
  // A credential name given a quoted literal in source, as an evidence snippet
  // carries it: an object key (`password: "..."`, `"apiKey": '...'`) or an
  // assignment (`const apiKey = "..."`, Python `api_key = "..."`), in any case.
  // Only a literal is replaced: `password: string` and `token: req.headers.x`
  // carry no value, and `==`, `===` and `=>` never match.
  [
    new RegExp(`(?<![A-Za-z0-9_$])(["']?)(${CRED_NAME})\\1(\\s*[:=]\\s*)${quotedLiteral(4)}`, 'gi'),
    `$1$2$1$3$4${REDACTED}$4`,
  ],
  // A literal fallback after an env read of a credential name:
  // `process.env.DB_PASSWORD || "..."`, `process.env["API_KEY"] ?? '...'`.
  [
    new RegExp(
      `(process\\.env(?:\\.${CRED_NAME}|\\[\\s*["'\`]${CRED_NAME}["'\`]\\s*\\])\\s*(?:\\|\\||\\?\\?)\\s*)${quotedLiteral(2)}`,
      'gi',
    ),
    `$1$2${REDACTED}$2`,
  ],
  // The Python form: `os.environ.get("SECRET", "...")`, `os.getenv('API_KEY', '...')`.
  [
    new RegExp(`(os\\.(?:environ\\.get|getenv)\\(\\s*(["'])${CRED_NAME}\\2\\s*,\\s*)${quotedLiteral(3)}`, 'gi'),
    `$1$3${REDACTED}$3`,
  ],
  // An unquoted `password=value` with nothing around the `=`, as a log line or a
  // connection-option string prints it, in any case. Spaced code assignments are
  // left to the literal pattern above.
  [new RegExp(`(?<![A-Za-z0-9_$])(${CRED_NAME}=)(?!\\[REDACTED\\])[^\\s"'\`&,;)\\]}]+`, 'gi'), `$1${REDACTED}`],
  // A password named in error prose: "... with password hunter2". Words that
  // describe the method ("with password authentication") are left alone.
  [
    /\b((?:with|using)\s+(?:the\s+)?password\s+)(["']?)(?!\[REDACTED\])(?!(?:authentication|auth|reset|login|hash|hashing|protection|policy|prompt|change|grant|flow|based|only|enabled|disabled|and|or|for|from|to|in|on|of)\b)[^\s"']+\2/gi,
    `$1$2${REDACTED}$2`,
  ],
]

/** A string with any credential-shaped value inside it replaced by `[REDACTED]`. */
export function redactSecretValues(text: string): string {
  let out = text
  for (const [pattern, replacement] of VALUE_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

// How far past a clip point the scrub still reads. A credential that starts
// inside the kept text but ends after the cut must still be seen whole, or the
// clip would keep its first characters unredacted (a URL cut before its `@`).
// Bounded so a 200 KB minified line costs a 1 KB scan, not a full one.
const CLIP_LOOKAHEAD = 1024

/**
 * Redact credential-shaped values, then keep at most `max` characters. The scrub
 * runs before the clip (on a bounded window past it), so a secret straddling the
 * cut is redacted rather than half kept. `cut` is how many characters were
 * dropped, counted after redaction; 0 when the text fit.
 */
export function redactAndClip(text: string, max: number): { text: string; cut: number } {
  const window = text.length > max + CLIP_LOOKAHEAD ? text.slice(0, max + CLIP_LOOKAHEAD) : text
  const red = redactSecretValues(window)
  const total = red.length + (text.length - window.length)
  if (total > max) return { text: red.slice(0, max), cut: total - max }
  // Redaction shrank the window enough that the whole text fits: scrub it all.
  return { text: window === text ? red : redactSecretValues(text), cut: 0 }
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

/**
 * Any JSON-shaped value with every credential-shaped string inside it redacted,
 * at any depth, using the same patterns as redactSecretValues. For ledger rows
 * that are not incident records: an extraction error whose parser quoted the
 * offending source line, an install's stderr, a source snippet. Returns the value
 * itself when there is nothing to change.
 */
export function scrubRecord<T>(value: T): T {
  if (typeof value === 'string') return redactSecretValues(value) as T
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((v) => {
      const s = scrubRecord(v)
      if (s !== v) changed = true
      return s
    })
    return (changed ? out : value) as T
  }
  if (value !== null && typeof value === 'object') {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const s = scrubRecord(v)
      if (s !== v) changed = true
      out[k] = s
    }
    return (changed ? out : value) as T
  }
  return value
}

/**
 * A graph edge's attributes with the credential scrub applied to the two pieces
 * of free text an edge carries: `evidence.snippet` (a source line, from static
 * extraction) and `signal.lastError.message` (a span's exception or HTTP failure
 * message, ADR-236). Everything else on an edge is an identifier, a count or a
 * path and is left alone. The producers scrub as they write (snippet(),
 * buildEdgeErrorExemplar); this is the snapshot-load pass for edges written
 * before they did. Returns the attributes themselves when there is nothing to
 * change, so a clean edge costs no copy.
 */
export function scrubEdgeText<T>(attrs: T): T {
  if (attrs === null || typeof attrs !== 'object') return attrs
  const edge = attrs as Record<string, unknown>
  let out: Record<string, unknown> | undefined

  const evidence = edge.evidence as Record<string, unknown> | undefined
  if (evidence && typeof evidence === 'object' && typeof evidence.snippet === 'string') {
    const red = redactSecretValues(evidence.snippet)
    if (red !== evidence.snippet) {
      out = { ...edge, evidence: { ...evidence, snippet: red } }
    }
  }

  const signal = edge.signal as Record<string, unknown> | undefined
  const lastError = signal?.lastError as Record<string, unknown> | undefined
  if (signal && lastError && typeof lastError === 'object' && typeof lastError.message === 'string') {
    const red = redactSecretValues(lastError.message)
    if (red !== lastError.message) {
      out = { ...(out ?? edge), signal: { ...signal, lastError: { ...lastError, message: red } } }
    }
  }

  return (out ?? attrs) as T
}

function isIncidentRecord(row: unknown): row is ErrorEvent {
  return row !== null && typeof row === 'object' && !Array.isArray(row)
    && typeof (row as { errorMessage?: unknown }).errorMessage === 'string'
}

/**
 * One ledger row, scrubbed. An incident record loses its credential headers
 * (scrubIncidentEvent) and every row, incident or not, has credential-shaped
 * values redacted wherever they sit (scrubRecord). The one scrub every ledger
 * writer and the at-rest rewrite apply.
 */
export function scrubLedgerRow<T>(row: T): T {
  return scrubRecord(isIncidentRecord(row) ? (scrubIncidentEvent(row) as T) : row)
}
