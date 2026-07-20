// Vercel Drains REST API client (docs/contracts/connectors.md §9, ADR-146).
// Three calls, all through the shared junction (ADR-131) with a `vercel` rate
// bucket and the `fetchImpl` DI seam every connector uses for tests:
//
//   createDrain    POST   /v1/drains        provision the trace drain
//   deleteDrain    DELETE /v1/drains/{id}   deprovision it (idempotent)
//   testDelivery   POST   /v1/drains/test   validate config + endpoint reachability
//
// Unlike a pull client this issues no telemetry query — it configures the
// provider to push. The drain forwards traces as OTLP/HTTP `encoding: 'json'`
// (`{ resourceSpans: [...] }`) to `config.endpoint`, which the daemon's
// `/v1/traces` receiver decodes on its `application/json` path (otel.ts).

import { bearerAuthHeader, junctionFetch } from '../junction.js'
import type {
  VercelConnectorConfig,
  VercelCredentials,
  VercelDrainCreated,
  VercelDrainTestResult,
} from './types.js'

const DEFAULT_API_BASE_URL = 'https://api.vercel.com'
const DEFAULT_DRAIN_NAME = 'neat-otlp'

// `schemas: { trace: { version: 'v1' } }` is how POST /v1/drains selects
// distributed traces in OpenTelemetry format (verified against the live API).
const TRACE_SCHEMAS = { trace: { version: 'v1' } } as const

function apiBase(config: VercelConnectorConfig): string {
  return config.apiBaseUrl ?? DEFAULT_API_BASE_URL
}

// teamId rides as a query param on every Drains call (Drains are team-scoped).
function teamQuery(config: VercelConnectorConfig): string {
  return `?teamId=${encodeURIComponent(config.teamId)}`
}

// The delivery block, shared by create and test so both describe the exact same
// sink. `type: 'http'` + `encoding: 'json'` is the custom-endpoint OTLP/JSON
// variant (verified live: `type` is a per-variant constant, `encoding` for a
// trace drain is `json`/`ndjson`). The daemon's OTLP bearer travels as a custom
// delivery header — the receiver requires it (ADR-073 §4).
function drainDelivery(config: VercelConnectorConfig, otelToken: string): Record<string, unknown> {
  return {
    type: 'http',
    endpoint: config.endpoint,
    encoding: 'json',
    headers: bearerAuthHeader(otelToken),
    ...(config.secret ? { secret: config.secret } : {}),
  }
}

// Pull a short, secret-free message out of a Vercel error body (`{ error: {
// code, message } }`). The message names validation/HTTP detail — never the
// token, which only ever rode in the Authorization header.
async function describeError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: { message?: unknown } }
    const message = data?.error?.message
    return typeof message === 'string' && message.length > 0 ? ` — ${message}` : ''
  } catch {
    return ''
  }
}

/**
 * Provision the trace drain. Returns the created drain's id (stored back into
 * the entry's `options.drainId` so `remove` can tear it down) and its status.
 * Throws on any non-2xx or a response missing the id — a missing id is shape
 * drift, not a silent success (the #841 discipline).
 */
export async function createVercelDrain(
  config: VercelConnectorConfig,
  credentials: VercelCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<VercelDrainCreated> {
  const projectIds = config.projectIds ?? []
  const body = {
    name: config.drainName ?? DEFAULT_DRAIN_NAME,
    projects: projectIds.length > 0 ? 'some' : 'all',
    ...(projectIds.length > 0 ? { projectIds } : {}),
    schemas: TRACE_SCHEMAS,
    delivery: drainDelivery(config, credentials.otelToken),
    source: { kind: 'self-served' },
  }

  const res = await junctionFetch(
    `${apiBase(config)}/v1/drains${teamQuery(config)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearerAuthHeader(credentials.token) },
      body: JSON.stringify(body),
    },
    { provider: 'vercel', accountKey: config.teamId, fetchImpl },
  )

  if (!res.ok) {
    throw new Error(
      `vercel connector: create drain failed (${res.status} ${res.statusText}${await describeError(res)})`,
    )
  }
  const payload = (await res.json().catch(() => null)) as Partial<VercelDrainCreated> | null
  if (!payload || typeof payload.id !== 'string' || payload.id.length === 0) {
    throw new Error(
      'vercel connector: create drain returned no drain id — the Drains API response shape may have changed',
    )
  }
  return {
    id: payload.id,
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.disabledReason ? { disabledReason: payload.disabledReason } : {}),
  }
}

/**
 * Tear the drain down. Idempotent by contract (connectors.md §9): a 404 —
 * already gone — is success, not an error, so a re-run of `remove` (or a drain
 * a human deleted in the dashboard) never wedges.
 */
export async function deleteVercelDrain(
  config: VercelConnectorConfig,
  drainId: string,
  credentials: VercelCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await junctionFetch(
    `${apiBase(config)}/v1/drains/${encodeURIComponent(drainId)}${teamQuery(config)}`,
    { method: 'DELETE', headers: { ...bearerAuthHeader(credentials.token) } },
    { provider: 'vercel', accountKey: config.teamId, fetchImpl },
  )
  if (res.ok || res.status === 404) return
  throw new Error(
    `vercel connector: delete drain failed (${res.status} ${res.statusText}${await describeError(res)})`,
  )
}

/**
 * Validate the drain configuration without provisioning anything. Vercel's
 * `POST /v1/drains/test` both authenticates the API token and pings the
 * endpoint with a sample event, so a `status: 'success'` verdict means the
 * token is live *and* the daemon's OTLP endpoint is reachable and accepted the
 * drain's bearer. A bad token (401/403) and a bad request (4xx) are mapped to
 * `failure` with a distinct, secret-free reason; a reachable-but-rejecting
 * endpoint comes back in the 200 body's own `status`/`error`.
 */
export async function testVercelDrainDelivery(
  config: VercelConnectorConfig,
  credentials: VercelCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<VercelDrainTestResult> {
  const res = await junctionFetch(
    `${apiBase(config)}/v1/drains/test${teamQuery(config)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearerAuthHeader(credentials.token) },
      body: JSON.stringify({ schemas: TRACE_SCHEMAS, delivery: drainDelivery(config, credentials.otelToken) }),
    },
    { provider: 'vercel', accountKey: config.teamId, fetchImpl },
  )

  if (res.status === 401 || res.status === 403) {
    return { status: 'failure', error: `vercel rejected the API token (HTTP ${res.status})` }
  }
  if (!res.ok) {
    return {
      status: 'failure',
      error: `vercel drain validation failed (${res.status} ${res.statusText}${await describeError(res)})`,
    }
  }
  const payload = (await res.json().catch(() => null)) as VercelDrainTestResult | null
  return {
    ...(payload?.status ? { status: payload.status } : {}),
    ...(payload?.error ? { error: payload.error } : {}),
    ...(payload?.endpoint ? { endpoint: payload.endpoint } : {}),
  }
}
