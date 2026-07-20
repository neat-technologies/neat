// Maps one Telemetry Query API invocation record to an ObservedSignal
// (docs/connectors/cloudflare.md §Fusion, ADR-129).
//
// The only route-shaped field this API exposes is `$metadata.trigger`
// ("GET /users", "POST /orders", or a non-HTTP trigger like "queue message").
// The leading HTTP method token is parsed off it, and — now that a static
// route recognizer exists for at least one in-Worker router shape (Hono,
// ADR-133 §5) — the remainder is carried as `path` too, so
// `createCloudflareResolveTarget` (connector.ts) can attempt a route-grain
// match against that Worker's own RouteNodes. When no match resolves, the
// signal still fuses at whole-file grain — the same "sharpens automatically
// once the static side supports it" pattern the rest of the connectors plane
// already follows (route-match.ts's own client↔route matching). A trigger
// that isn't HTTP-shaped (cron, queue, alarm, ...) carries no method to parse
// and is out of scope for this cut (§Out of scope) — dropped here, honestly,
// rather than fabricating a method or forcing it through as an unresolvable
// signal.

import { CLOUDFLARE_TARGET_KIND, type CloudflareObservedSignal, type CloudflareTelemetryEvent } from './types.js'

// The HTTP methods a `trigger` string's leading token can actually name
// (RFC 7231 + CONNECT/TRACE). A closed vocabulary, the same discipline
// routes.ts's own ROUTER_METHODS set applies to router registrations, so a
// non-HTTP trigger ("queue message", a cron expression, "scheduled") never
// misparses its own leading word as a method.
const HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
  'CONNECT',
])

const LEADING_TOKEN_RE = /^(\S+)\s+\S/

export function parseHttpMethodFromTrigger(trigger: unknown): string | null {
  // `trigger` is typed a string upstream, but this maps a raw JSON response —
  // a shape drift that hands us a number or object here drops honestly rather
  // than throwing on `.trim()` (connectors.md §4 honest-miss discipline).
  if (typeof trigger !== 'string') return null
  const match = LEADING_TOKEN_RE.exec(trigger.trim())
  const token = match?.[1]
  if (!token) return null
  const method = token.toUpperCase()
  return HTTP_METHODS.has(method) ? method : null
}

// The path portion of an HTTP-shaped trigger — everything after the leading
// method token, e.g. "GET /users/123" → "/users/123". Only called once
// `parseHttpMethodFromTrigger` has already confirmed the leading token is a
// real method, so there's no risk of misreading a non-HTTP trigger's own
// text as a path. A query string, if present, rides along; route matching
// canonicalises it away the same way a declared RouteNode template does
// (routes.ts's `canonicalizeTemplate`).
export function parsePathFromTrigger(trigger: string): string | undefined {
  const trimmed = trigger.trim()
  const spaceIdx = trimmed.indexOf(' ')
  if (spaceIdx === -1) return undefined
  const rest = trimmed.slice(spaceIdx + 1).trim()
  return rest.length > 0 ? rest : undefined
}

// 5xx is treated as the unambiguous failure threshold for this connector's
// own errorCount, mirroring the span-derived `isError` convention elsewhere
// in ingest.ts (a bare 4xx is often correct app behavior — an auth probe, a
// conditional fetch — and isn't held against the edge's own error tally).
const ERROR_STATUS_THRESHOLD = 500

export function mapEventToSignal(event: CloudflareTelemetryEvent | null | undefined): CloudflareObservedSignal | null {
  // A shape-drifted response can hand a poll tick a null/garbage array slot;
  // drop it honestly rather than throwing on `.$metadata` (connectors.md §4).
  if (!event || typeof event !== 'object') return null
  const metadata = event.$metadata
  const workers = event.$workers

  const method = parseHttpMethodFromTrigger(metadata?.trigger)
  if (!method) return null

  // `$workers.scriptName` and `$metadata.service` are both documented as
  // "Worker script name" — prefer the Workers-Runtime-specific field when
  // present, fall back to the always-present metadata field. A non-string
  // value (shape drift) drops honestly rather than riding through as a
  // non-string targetName the graph would then have to carry.
  const scriptName = workers?.scriptName ?? metadata?.service
  if (typeof scriptName !== 'string' || scriptName.length === 0) return null

  const timestampMs = event.timestamp ?? metadata?.startTime
  if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) return null
  // A finite-but-out-of-range epoch (a value in ns/µs, or a bogus one) makes
  // an Invalid Date whose `.toISOString()` throws — drop it honestly rather
  // than fabricating a timestamp or crashing the whole tick.
  const observedAt = new Date(timestampMs)
  if (Number.isNaN(observedAt.getTime())) return null

  const statusCode = metadata?.statusCode
  const isError = typeof statusCode === 'number' && statusCode >= ERROR_STATUS_THRESHOLD
  const path = metadata?.trigger ? parsePathFromTrigger(metadata.trigger) : undefined

  return {
    targetKind: CLOUDFLARE_TARGET_KIND,
    targetName: scriptName,
    callCount: 1,
    errorCount: isError ? 1 : 0,
    lastObservedIso: observedAt.toISOString(),
    method,
    ...(path ? { path } : {}),
    ...(typeof statusCode === 'number' ? { statusCode } : {}),
    ...(typeof metadata?.duration === 'number' ? { duration: metadata.duration } : {}),
  }
}
