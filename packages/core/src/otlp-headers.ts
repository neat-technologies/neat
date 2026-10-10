// The OTLP bearer header, in the form OTEL_EXPORTER_OTLP_HEADERS requires.
//
// Header values in that variable are URL-encoded (OTLP exporter spec, W3C
// Baggage syntax), so the space after `Bearer` is `%20`. Lenient parsers accept
// a raw space; a strict one (`parse_env_headers(…, liberal=False)` in the Python
// SDK, older Python SDKs by default) drops the whole header, the exporter sends
// no Authorization, and the daemon answers 401 with nothing in the app saying
// why (#1339). The token is encoded too, so a `+`, `/` or `=` survives; every
// parser decodes it back.

export const OTLP_BEARER_PREFIX = 'Authorization=Bearer%20'

/** `Authorization=Bearer%20<token>`, ready for OTEL_EXPORTER_OTLP_HEADERS. */
export function otlpBearerHeader(token: string): string {
  return OTLP_BEARER_PREFIX + encodeURIComponent(token)
}
