// Maps one Telemetry Query API invocation record to an ObservedSignal at
// whole-file grain (docs/connectors/cloudflare.md §Fusion, ADR-129).
//
// The only route-shaped field this API exposes is `$metadata.trigger`
// ("GET /users", "POST /orders", or a non-HTTP trigger like "queue message").
// v1 parses the leading HTTP method token off it for metadata only — the
// remainder is never matched against a route table, because no static route
// recognizer exists yet for the in-Worker router shapes (Hono, itty-router,
// manual `fetch(request)` dispatch) that would make such a match meaningful
// (design doc's §Static extractor gap). A trigger that isn't HTTP-shaped
// (cron, queue, alarm, ...) carries no method to parse and is out of scope
// for this cut (§Out of scope) — dropped here, honestly, rather than
// fabricating a method or forcing it through as an unresolvable signal.

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

export function parseHttpMethodFromTrigger(trigger: string | undefined): string | null {
  if (!trigger) return null
  const match = LEADING_TOKEN_RE.exec(trigger.trim())
  const token = match?.[1]
  if (!token) return null
  const method = token.toUpperCase()
  return HTTP_METHODS.has(method) ? method : null
}

// 5xx is treated as the unambiguous failure threshold for this connector's
// own errorCount, mirroring the span-derived `isError` convention elsewhere
// in ingest.ts (a bare 4xx is often correct app behavior — an auth probe, a
// conditional fetch — and isn't held against the edge's own error tally).
const ERROR_STATUS_THRESHOLD = 500

export function mapEventToSignal(event: CloudflareTelemetryEvent): CloudflareObservedSignal | null {
  const metadata = event.$metadata
  const workers = event.$workers

  const method = parseHttpMethodFromTrigger(metadata?.trigger)
  if (!method) return null

  // `$workers.scriptName` and `$metadata.service` are both documented as
  // "Worker script name" — prefer the Workers-Runtime-specific field when
  // present, fall back to the always-present metadata field.
  const scriptName = workers?.scriptName ?? metadata?.service
  if (!scriptName) return null

  const timestampMs = event.timestamp ?? metadata?.startTime
  if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) return null

  const statusCode = metadata?.statusCode
  const isError = typeof statusCode === 'number' && statusCode >= ERROR_STATUS_THRESHOLD

  return {
    targetKind: CLOUDFLARE_TARGET_KIND,
    targetName: scriptName,
    callCount: 1,
    errorCount: isError ? 1 : 0,
    lastObservedIso: new Date(timestampMs).toISOString(),
    method,
    ...(typeof statusCode === 'number' ? { statusCode } : {}),
    ...(typeof metadata?.duration === 'number' ? { duration: metadata.duration } : {}),
  }
}
