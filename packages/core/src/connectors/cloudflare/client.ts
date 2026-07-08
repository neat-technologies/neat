// Workers Observability Telemetry Query API client (docs/connectors/cloudflare.md
// §Surfaces used #1). Read-only, ambient — this issues exactly one query per
// poll tick against telemetry Cloudflare already collects when a Worker
// deploys with `observability.enabled`; it never issues a synthetic request
// to the Worker itself (connectors.md §2).

import { randomUUID } from 'node:crypto'
import { bearerAuthHeader, junctionFetch } from '../junction.js'
import type { ConnectorContext } from '../types.js'
import type { CloudflareConnectorConfig, CloudflareTelemetryEvent, CloudflareTelemetryQueryResponse } from './types.js'

const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4'

// The API's own per-response event cap isn't documented (needs-endpoint-
// testing, docs/connectors/cloudflare.md); this is a conservative default
// kept well under any plausible limit, overridable per connector config.
const DEFAULT_EVENT_LIMIT = 1000

export interface TelemetryWindow {
  fromMs: number
  toMs: number
}

// `fetchImpl` defaults to the platform global (Node 20 ships `fetch`) and is
// the seam tests inject a fake response through — dependency injection, not
// a production mock (contracts.md Rule 5 / connectors.md §5 only bar mocks
// on the runtime poll path itself).
export async function queryWorkerInvocations(
  ctx: ConnectorContext,
  config: CloudflareConnectorConfig,
  window: TelemetryWindow,
  fetchImpl: typeof fetch = fetch,
): Promise<CloudflareTelemetryEvent[]> {
  const token = ctx.credentials.apiToken
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('cloudflare connector: ctx.credentials.apiToken must be a non-empty string')
  }

  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
  const url = `${baseUrl}/accounts/${config.accountId}/workers/observability/telemetry/query`

  const body = {
    // Cloudflare's schema requires an identifier per query even for an
    // ad-hoc, unsaved one — a fresh id per tick, never reused.
    queryId: `neat-connector-${randomUUID()}`,
    timeframe: { from: window.fromMs, to: window.toMs },
    view: 'events',
    limit: config.eventLimit ?? DEFAULT_EVENT_LIMIT,
    // Execute without persisting — this is a read, not a saved query
    // (connectors.md §2's "never writes on the read path" applies to
    // Cloudflare's own query-history state too).
    dry: true,
  }

  const res = await junctionFetch(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...bearerAuthHeader(token),
      },
      body: JSON.stringify(body),
    },
    // accountKey: the Cloudflare account id (ADR-131's own worked example) —
    // the Telemetry Query API's ~300/5min limit is enforced per account.
    { provider: 'cloudflare', accountKey: config.accountId, fetchImpl },
  )

  if (!res.ok) {
    throw new Error(
      `cloudflare connector: telemetry query failed (${res.status} ${res.statusText})`,
    )
  }

  const payload = (await res.json()) as CloudflareTelemetryQueryResponse
  if (!payload.success) {
    const message = payload.errors?.map((e) => e.message).join('; ') || 'unknown error'
    throw new Error(`cloudflare connector: telemetry query returned an error (${message})`)
  }

  // `success: true` with no `result.events.events` array at all is shape
  // drift — a real API-contract change, not the ordinary "no events this
  // window" case (which arrives as an *empty* array here and warrants no
  // warning). Silently treating both the same way hid an API change behind a
  // quiet [] return; this distinguishes them so a real drift is loud.
  const events = payload.result?.events?.events
  if (events === undefined) {
    console.warn(
      '[neat connector] cloudflare: telemetry query returned success:true but no result.events.events array — the response shape may have changed; treating as zero events this tick',
    )
    return []
  }
  return events
}
