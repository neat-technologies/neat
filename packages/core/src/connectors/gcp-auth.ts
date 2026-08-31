// GCP service-account token source — the first refreshable-credential resolver
// (docs/contracts/connector-config.md §9, ADR-223).
//
// The GCP connectors (cloud-run, firebase, gcp-lb) consume a short-lived OAuth
// access token (~1h) and perform no auth handshake of their own. A static
// env-ref credential resolves once at slot bootstrap and then goes stale — a
// long-running daemon polls with a dead token after an hour. This module is the
// fix: it mints a fresh access token from a service-account key via the OAuth2
// JWT-bearer flow, caches it, and re-mints before it expires. The poll loop
// calls the returned CredentialSource each tick; the connector still receives an
// already-minted `{ projectId, accessToken }` and never sees the refresh.
//
// The JWT-bearer flow was confirmed live against Google's own docs rather than
// recalled (ADR-223 §Context, ADR-150/152 discipline):
//   https://developers.google.com/identity/protocols/oauth2/service-account
//   - token endpoint: POST https://oauth2.googleapis.com/token
//   - grant_type: urn:ietf:params:oauth:grant-type:jwt-bearer
//   - JWT header: { alg: "RS256", typ: "JWT" }
//   - claims: iss (client_email), scope (space-delimited), aud (the token
//     endpoint exactly), iat, exp (<= iat + 3600); sub only for domain-wide
//     delegation, unused here
//   - POST body: application/x-www-form-urlencoded, grant_type + assertion
//   - response: { access_token, token_type: "Bearer", expires_in }
//
// No new dependency: the JWT is signed with Node's built-in `crypto` (RS256),
// and the token exchange goes through the shared junction like every other
// outbound connector call (connectors.md §Authority, ADR-131).

import { createSign } from 'node:crypto'
import { junctionFetch } from './junction.js'
import type { CredentialSource } from './types.js'

// The default OAuth2 token endpoint (`aud` claim + POST target). A service-
// account key carries its own `token_uri`, which is this value in practice; the
// key's value wins when present, and `opts.tokenUri` overrides both for tests.
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'

// The maximum lifetime Google allows for the assertion JWT (`exp <= iat + 3600`).
const ASSERTION_LIFETIME_S = 3600
// Re-mint this long before the access token's stated expiry, so a token is never
// handed to a poll on the edge of expiring (clock skew + request latency margin).
const DEFAULT_REFRESH_SKEW_MS = 60_000

/**
 * The fields this module reads from a service-account key JSON. A real key
 * carries more (type, private_key_id, client_id, auth_uri, ...), all ignored —
 * these three are what the JWT-bearer exchange and the GCP connectors need.
 */
export interface GcpServiceAccountKey {
  client_email: string
  private_key: string
  // The GCP project the connectors key their signal + rate-limit bucket on
  // (not a secret). Standard on every SA key JSON.
  project_id: string
  // Optional per-key override of the token endpoint; defaults to DEFAULT_TOKEN_URI.
  token_uri?: string
}

/**
 * Parse and validate a service-account key JSON string. Throws a clear,
 * secret-free error naming the missing field rather than failing opaquely at
 * sign time. The private key is never logged or echoed — only its absence is
 * reported.
 */
export function parseServiceAccountKey(json: string): GcpServiceAccountKey {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new Error('gcp service-account key: not valid JSON')
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('gcp service-account key: expected a JSON object')
  }
  const obj = raw as Record<string, unknown>
  const clientEmail = obj['client_email']
  const privateKey = obj['private_key']
  const projectId = obj['project_id']
  if (typeof clientEmail !== 'string' || clientEmail.length === 0) {
    throw new Error('gcp service-account key: missing client_email')
  }
  if (typeof privateKey !== 'string' || privateKey.length === 0) {
    throw new Error('gcp service-account key: missing private_key')
  }
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new Error('gcp service-account key: missing project_id')
  }
  const key: GcpServiceAccountKey = { client_email: clientEmail, private_key: privateKey, project_id: projectId }
  if (typeof obj['token_uri'] === 'string' && (obj['token_uri'] as string).length > 0) {
    key.token_uri = obj['token_uri'] as string
  }
  return key
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// Build and RS256-sign the assertion JWT for the JWT-bearer grant. Pure given
// `nowMs` — the caller owns the clock so tests are deterministic.
export function buildServiceAccountAssertion(
  key: GcpServiceAccountKey,
  scope: string,
  tokenUri: string,
  nowMs: number,
): string {
  const iat = Math.floor(nowMs / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = {
    iss: key.client_email,
    scope,
    aud: tokenUri,
    iat,
    exp: iat + ASSERTION_LIFETIME_S,
  }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  const signature = createSign('RSA-SHA256').update(signingInput).end().sign(key.private_key)
  return `${signingInput}.${base64url(signature)}`
}

export interface MintedToken {
  accessToken: string
  // Absolute epoch-ms the token expires — derived from the response's
  // `expires_in` at mint time, so the cache can decide when to re-mint.
  expiresAtMs: number
}

export interface GcpTokenSourceOptions {
  // Dependency-injection seam for tests — defaults to the platform `fetch`,
  // threaded into the junction the same way every connector's fetchImpl is.
  fetchImpl?: typeof fetch
  // Injectable clock (epoch-ms); defaults to Date.now. Lets a test advance time
  // past a token's expiry to prove the re-mint.
  now?: () => number
  // Override the token endpoint (the key's `token_uri`, else DEFAULT_TOKEN_URI).
  tokenUri?: string
  // Re-mint this long before stated expiry (default 60s).
  refreshSkewMs?: number
}

/**
 * One token exchange: sign the assertion, POST it through the junction, parse
 * the access token + its lifetime. Never retried at this layer beyond the
 * junction's own transient-failure retry; a rejected key (a 400 `invalid_grant`)
 * throws, secret-free.
 */
export async function mintGcpAccessToken(
  key: GcpServiceAccountKey,
  scope: string,
  opts: GcpTokenSourceOptions = {},
): Promise<MintedToken> {
  const now = opts.now ?? Date.now
  const tokenUri = opts.tokenUri ?? key.token_uri ?? DEFAULT_TOKEN_URI
  const mintedAtMs = now()
  const assertion = buildServiceAccountAssertion(key, scope, tokenUri, mintedAtMs)
  const body = new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }).toString()

  const res = await junctionFetch(
    tokenUri,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
    // accountKey: the GCP project id — an identifier, safe to log, the same
    // per-(provider, accountKey) rate-limit bucket key the GCP connectors use.
    { provider: 'gcp-auth', accountKey: key.project_id, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) },
  )
  if (!res.ok) {
    // No body echo — a token-endpoint error body can restate the assertion.
    throw new Error(`gcp token mint failed: ${res.status} ${res.statusText}`)
  }
  const json = (await res.json()) as { access_token?: unknown; expires_in?: unknown }
  const accessToken = json.access_token
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('gcp token mint returned no access_token')
  }
  const expiresInS = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : ASSERTION_LIFETIME_S
  return { accessToken, expiresAtMs: mintedAtMs + expiresInS * 1000 }
}

/**
 * A cached, self-refreshing token source over a service-account key. The
 * returned `CredentialSource` mints on first call and re-mints only when the
 * cached token is within `refreshSkewMs` of expiry — so the poll loop can call
 * it every tick cheaply. It hands back `{ projectId, accessToken }`, the exact
 * record shape the GCP connectors already read, so no connector changes.
 *
 * Concurrent calls share one in-flight mint (a burst of ticks never fans out
 * into parallel token requests).
 */
export function createGcpTokenSource(
  key: GcpServiceAccountKey,
  scope: string,
  opts: GcpTokenSourceOptions = {},
): CredentialSource {
  const now = opts.now ?? Date.now
  const skewMs = opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS
  let cached: MintedToken | null = null
  let inFlight: Promise<MintedToken> | null = null

  const fresh = (): boolean => cached !== null && now() < cached.expiresAtMs - skewMs

  return async (): Promise<Record<string, unknown>> => {
    if (!fresh()) {
      if (!inFlight) {
        inFlight = mintGcpAccessToken(key, scope, opts)
          .then((minted) => {
            cached = minted
            return minted
          })
          .finally(() => {
            inFlight = null
          })
      }
      await inFlight
    }
    return { projectId: key.project_id, accessToken: cached!.accessToken }
  }
}
