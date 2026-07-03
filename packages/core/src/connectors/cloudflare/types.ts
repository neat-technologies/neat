// Cloudflare Workers/Pages connector — provider-specific shapes
// (docs/connectors/cloudflare.md, ADR-129). v1 ships at whole-file grain: no
// route table, no Hono/itty-router recognizer — see the design doc's
// §Static extractor gap for why, and packages/core/src/extract/routes.ts is
// untouched by this cut.

import type { ObservedSignal } from '../types.js'

// Provider vocabulary for ObservedSignal.targetKind (connectors.md §1 — "the
// provider's own vocabulary", same shape as Supabase's 'supabase-table' /
// 'supabase-rpc').
export const CLOUDFLARE_TARGET_KIND = 'cloudflare-worker-invocation'

// One Cloudflare Worker/Pages script's mapping onto a NEAT service + file.
// Cloudflare's own telemetry only ever names the script (`$workers.scriptName`
// / `$metadata.service`) — it has no idea which repo, service, or file that
// script's code lives in. That mapping is genuinely not inferrable from the
// telemetry itself, so it's supplied here, once, at connector-configuration
// time (docs/connectors/cloudflare.md §Fusion): `service` is the NEAT
// manifest name (package.json#name) the design doc says gets paired against
// the Worker's `wrangler.toml`/`wrangler.jsonc` `name` field, and `entryFile`
// is the service-relative path to the file containing
// `export default { fetch(request, env, ctx) { ... } }`, resolved from that
// same manifest's `main` field the same way NEAT's Node installer already
// resolves an entry point.
export interface CloudflareWorkerMapping {
  service: string
  entryFile: string
}

export interface CloudflareConnectorConfig {
  accountId: string
  // Cloudflare script name → the NEAT service/file it maps to. One connector
  // instance covers every Worker/Pages script in one Cloudflare account's
  // telemetry; scripts with no entry here are honestly unresolved rather than
  // guessed at (see createCloudflareResolveTarget in connector.ts).
  workers: Record<string, CloudflareWorkerMapping>
  // Cap on how far an absent `since` backfills, ms. Cloudflare's docs don't
  // confirm the Telemetry Query API's own max lookback window
  // (docs/connectors/cloudflare.md flags this needs-endpoint-testing); default
  // below is a conservative hour, capped the same way connectors.md's
  // "Poll cadence and backfill" section requires for every provider.
  maxLookbackMs?: number
  // Events requested per query. The API's own per-response cap isn't
  // documented either; kept well under any plausible limit until a live
  // check confirms one. Pagination (the `offset` cursor) isn't implemented in
  // v1 — same needs-endpoint-testing gap, since the docs surveyed don't spell
  // out the cursor's exact semantics.
  eventLimit?: number
  // Override for tests; defaults to Cloudflare's real API host.
  baseUrl?: string
}

// --- Workers Observability Telemetry Query API response shapes ---
//
// Confirmed against
// developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/
// (fetched 2026-07-03) rather than assumed. Only the fields this connector
// actually reads are typed here — the live response carries substantially
// more (the `traces`/`calculations`/`invocations` views, per-event
// diagnostics-channel data, etc.) that v1 has no use for.
//
// Two fields name the Worker script per event: `$metadata.service` (present
// on every event type) and `$workers.scriptName` (present only when the
// `$workers` sub-object is, i.e. for genuine Workers Runtime events). Both
// are documented as "Worker script name" — map.ts prefers `$workers.scriptName`
// when present and falls back to `$metadata.service`.
export interface CloudflareTelemetryEventMetadata {
  service?: string
  trigger?: string
  url?: string
  statusCode?: number
  duration?: number
  traceDuration?: number
  startTime?: number
  endTime?: number
}

export interface CloudflareTelemetryWorkersMetadata {
  eventType?: string
  scriptName?: string
  outcome?: string
}

export interface CloudflareTelemetryEvent {
  timestamp?: number
  dataset?: string
  $metadata?: CloudflareTelemetryEventMetadata
  $workers?: CloudflareTelemetryWorkersMetadata
}

export interface CloudflareTelemetryQueryResponse {
  success: boolean
  errors?: { message: string }[]
  messages?: { message: string }[]
  result?: {
    events?: {
      count?: number
      events: CloudflareTelemetryEvent[]
    }
  }
}

// ObservedSignal, widened with the fields this connector's own mapping step
// carries for metadata/testing purposes — `method` (parsed from `trigger`),
// `statusCode`, `duration`. None of these are read by the generic
// connectors pipeline (connectors/index.ts only consumes the base
// ObservedSignal shape); they exist so map.ts's own output — and, through
// it, `CloudflareConnector.poll()` — stays inspectable for exactly what
// docs/connectors/cloudflare.md promises: "parses only the HTTP method token
// off the front of trigger ... for edge metadata — no attempt to match the
// remainder against a route table".
export interface CloudflareObservedSignal extends ObservedSignal {
  method: string
  statusCode?: number
  duration?: number
}
