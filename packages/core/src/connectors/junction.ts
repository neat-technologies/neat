// The connector junction (ADR-131, docs/contracts/connectors.md). Every
// connector's outbound call — `railway/client.ts`, `firebase/logging-api.ts`,
// `cloudflare/client.ts`, `supabase/client.ts`, `supabase/postgres-client.ts`
// — routes through `junctionFetch` (HTTP) or `dbJunction` (the Supabase
// `pg` path) instead of its own bare `fetch()`/`pg` query. Before this
// module, each connector reinvented the same thin, unprotected wrapper: no
// timeout, no retry, no rate-limiting, no shared credential-header
// convention, no shared outbound-health logging. None of that is a
// per-provider concern — it's the same discipline every outbound call needs,
// which is exactly why ADR-131 makes the outbound connection itself a
// junction, the same way `connectors/index.ts` is already the one junction
// every provider's inbound signal converges through on its way into the
// graph.
//
// Passive/ambient discipline (connectors.md §2) still holds: this module
// never issues a call a connector didn't already decide to make. What it
// adds is what happens *around* a call a connector was always going to
// make — bounding it in time, backing off instead of hammering a transient
// failure, and self-throttling per customer account so a retry storm can
// never look like the load-generation that principle forbids, even under
// retry.

// ── shared primitives: token-bucket rate limiting ──────────────────────────

/**
 * A token bucket's shape: `capacity` tokens available as burst, refilling
 * one token every `refillMs`. Keyed on `(provider, accountKey)` — never
 * global — so one customer's aggressive polling can never throttle
 * another's (ADR-131 decision #1's rate-limiting clause).
 */
export interface TokenBucketConfig {
  /** Maximum tokens the bucket can hold — the burst allowance. */
  capacity: number
  /** Milliseconds to refill exactly one token. */
  refillMs: number
}

interface TokenBucketState extends TokenBucketConfig {
  tokens: number
  updatedAt: number
}

// module-level — the one process-wide set of buckets every connector's call
// shares, keyed per (provider, accountKey) exactly as ADR-131 specifies.
const buckets = new Map<string, TokenBucketState>()

function bucketMapKey(provider: string, accountKey: string): string {
  return `${provider}\x00${accountKey}`
}

function getBucket(provider: string, accountKey: string, config: TokenBucketConfig): TokenBucketState {
  const key = bucketMapKey(provider, accountKey)
  const existing = buckets.get(key)
  if (existing && existing.capacity === config.capacity && existing.refillMs === config.refillMs) {
    return existing
  }
  // First sighting of this (provider, accountKey) pair, or a call-site
  // override changed the bucket's shape — start a fresh, full bucket rather
  // than reinterpreting old token state under a new capacity/refill rate.
  const fresh: TokenBucketState = { ...config, tokens: config.capacity, updatedAt: Date.now() }
  buckets.set(key, fresh)
  return fresh
}

function refillBucket(bucket: TokenBucketState, now: number): void {
  if (now <= bucket.updatedAt) return
  const elapsed = now - bucket.updatedAt
  const grant = elapsed / bucket.refillMs
  if (grant <= 0) return
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + grant)
  bucket.updatedAt = now
}

/**
 * Thrown when a bucket is exhausted and waiting for the next token would
 * exceed the call's remaining wall-clock budget — the bounded-wait counterpart
 * to blocking indefinitely. A connector's own poll tick (60s by default,
 * connectors/index.ts's DEFAULT_POLL_INTERVAL_MS) always has slack for a
 * short, self-imposed throttle wait; this only fires when the bucket is so
 * depleted that waiting would itself become the unbounded hang ADR-131's
 * wall-clock budget exists to prevent.
 */
export class RateLimitExceededError extends Error {
  constructor(provider: string, accountKey: string) {
    super(
      `junction: rate limit exceeded for ${provider}:${accountKey} — waiting for the next token would exceed this call's wall-clock budget`,
    )
    this.name = 'RateLimitExceededError'
  }
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * Blocks until the (provider, accountKey) bucket holds a token, or throws
 * `RateLimitExceededError` when the wait would blow the remaining budget.
 * Every retry re-acquires a token here too (not just the first attempt) —
 * the per-account bucket has to hold under retry for the ambient/passive
 * principle to survive a transient-failure storm (ADR-131 consequences).
 */
async function acquireToken(
  provider: string,
  accountKey: string,
  config: TokenBucketConfig,
  remainingBudgetMs: number,
): Promise<number> {
  const bucket = getBucket(provider, accountKey, config)
  refillBucket(bucket, Date.now())
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return 0
  }
  const waitMs = Math.ceil((1 - bucket.tokens) * bucket.refillMs)
  if (waitMs > remainingBudgetMs) {
    throw new RateLimitExceededError(provider, accountKey)
  }
  await delay(waitMs)
  refillBucket(bucket, Date.now())
  bucket.tokens = Math.max(0, bucket.tokens - 1)
  return waitMs
}

/**
 * Test-only seam — production code never calls this. Mirrors ingest.ts's
 * `resetUnidentifiedSpanWarnings`/`resetNoSourceMapWarnings` pattern: clears
 * every provider/account bucket so each test starts from a fresh, full
 * bucket instead of bleeding state across cases sharing this module.
 */
export function resetJunctionRateLimiters(): void {
  buckets.clear()
}

// ── per-provider default bucket sizes ───────────────────────────────────────
//
// ADR-131's Phase 1 surveys found exactly one hard number:  Cloudflare's
// Telemetry Query API at ~300 requests / 5 minutes. Railway's GraphQL API,
// Firebase's Cloud Logging `entries.list`, and Supabase's Management API
// each have a real limit the docs surveyed couldn't pin down — every one of
// docs/connectors/{railway,firebase,supabase}.md flags its own rate limit as
// "needs-endpoint-testing" / "unconfirmed" rather than citing a number. Those
// three therefore get the same conservative placeholder bucket, not three
// independently-guessed numbers dressed up as if they were documented —
// tightened once a live project confirms the real ceiling for each,
// exactly the discipline those docs already ask of every other unconfirmed
// surface. `supabase-postgres` is different again: pg_stat_statements is a
// raw Postgres connection, not a rate-limited REST API, so its bucket is a
// self-imposed ceiling against a retry storm hammering the customer's own
// database, not a provider-documented cap.
export const JUNCTION_DEFAULT_RATE_LIMITS: Record<string, TokenBucketConfig> = {
  // ~300 requests / 5 minutes (ADR-131). Burst capacity holds a third of
  // that ceiling; steady-state refill (1 token / 3s = 20/min = 100/5min)
  // stays well clear of the documented limit even under sustained polling.
  cloudflare: { capacity: 100, refillMs: 3_000 },
  // Placeholder pending a live project confirming the real cap
  // (docs/connectors/railway.md: "does not appear to publish one as of this
  // writing").
  railway: { capacity: 30, refillMs: 10_000 },
  // Placeholder pending a live rate-limit check (docs/connectors/
  // firebase.md: "needs-endpoint-testing against entries.list's live rate
  // limits").
  firebase: { capacity: 30, refillMs: 10_000 },
  // Placeholder pending a live rate-limit check (docs/connectors/supabase.md:
  // "the documented rate limit for this specific endpoint is unconfirmed").
  supabase: { capacity: 30, refillMs: 10_000 },
  // Not a documented API limit at all — a self-imposed ceiling on the raw
  // pg_stat_statements connection (see module header above).
  'supabase-postgres': { capacity: 20, refillMs: 3_000 },
  // Push provider (ADR-146): the Drains REST API is touched only by `neat
  // connector add/remove/test` (provision/deprovision/validate), never a poll
  // loop, so this bucket is exercised a handful of times per command. Kept
  // conservative pending a documented Drains-API rate limit.
  vercel: { capacity: 20, refillMs: 5_000 },
}

// Fallback for any provider not named above (a future connector that hasn't
// had its own bucket sized yet) — conservative, not tuned to any specific
// provider's documented limit.
const JUNCTION_GENERIC_RATE_LIMIT: TokenBucketConfig = { capacity: 20, refillMs: 5_000 }

function defaultRateLimitFor(provider: string): TokenBucketConfig {
  return JUNCTION_DEFAULT_RATE_LIMITS[provider] ?? JUNCTION_GENERIC_RATE_LIMIT
}

// ── shared primitives: backoff + outbound-health logging ──────────────────

export const JUNCTION_DEFAULT_TIMEOUT_MS = 10_000
export const JUNCTION_DEFAULT_MAX_ATTEMPTS = 3
export const JUNCTION_DEFAULT_INITIAL_BACKOFF_MS = 200
export const JUNCTION_DEFAULT_BACKOFF_MULTIPLIER = 4
// 30s — comfortably under connectors/index.ts's 60s DEFAULT_POLL_INTERVAL_MS,
// so even a fully-retried call (3 attempts, each up to the 10s timeout, plus
// backoff) can never make one poll tick pile up on the next.
export const JUNCTION_DEFAULT_MAX_ELAPSED_MS = 30_000
export const JUNCTION_DEFAULT_DB_TIMEOUT_MS = 10_000

async function backoff(
  attempt: number,
  initialBackoffMs: number,
  backoffMultiplier: number,
  remainingBudgetMs: number,
): Promise<void> {
  // attempt 1 -> initialBackoffMs (200ms default), attempt 2 ->
  // initialBackoffMs * multiplier (800ms default), ... — exponential,
  // capped so a retry's own wait never overruns what's left of the call's
  // wall-clock budget.
  const raw = initialBackoffMs * backoffMultiplier ** (attempt - 1)
  const capped = Math.max(0, Math.min(raw, remainingBudgetMs))
  await delay(capped)
}

// The four outcomes ADR-131 names, plus `failed` for the single-attempt,
// never-retried case (a 4xx, or a first attempt that used up the whole
// budget) — a superset of the ADR's list, not a departure from it.
export type JunctionOutcome = 'success' | 'retried-then-succeeded' | 'retried-then-failed' | 'rate-limited' | 'failed'

// Cloud Logging's / the Management API's own query strings carry real
// content in the URL (Supabase's `sql=` query param, in particular) —
// logging is stripped to origin + pathname so an outbound-health line never
// echoes a credential or a query body back into stderr.
function safeUrlLabel(url: string | URL): string {
  try {
    const u = typeof url === 'string' ? new URL(url) : url
    return `${u.origin}${u.pathname}`
  } catch {
    return String(url)
  }
}

// Structured outbound-health logging through the same mechanism the rest of
// NEAT already uses for a connector's own diagnostics — console.log/warn/error
// with a bracketed prefix (connectors/index.ts's `[neatd] connector poll
// failed (...)`, ingest.ts's `[neat] ...` / `[neatd] ...` lines). Not a new
// logging library — this is what a future `neat connector list --verbose`
// reads stderr/stdout for.
function logOutcome(
  provider: string,
  accountKey: string,
  outcome: JunctionOutcome,
  method: string,
  label: string,
  attempt: number,
  startedAt: number,
): void {
  const elapsedMs = Date.now() - startedAt
  const line = `[neat connector] ${provider}:${accountKey} ${method} ${label} — ${outcome} (attempt ${attempt}, ${elapsedMs}ms)`
  if (outcome === 'success' || outcome === 'retried-then-succeeded') {
    console.log(line)
  } else if (outcome === 'rate-limited') {
    console.warn(line)
  } else {
    console.error(line)
  }
}

// ── credential injection ────────────────────────────────────────────────────

/**
 * The one credential shape every connector so far shares (Railway, Firebase,
 * Cloudflare, and Supabase's Management API all carry `Authorization: Bearer
 * <token>` — see each provider's client.ts). Cuts the four near-identical
 * "build the auth header" blocks down to one (ADR-131 decision #1).
 */
export function bearerAuthHeader(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` }
}

// ── junctionFetch ───────────────────────────────────────────────────────────

export interface JunctionPolicy {
  /** 'railway' | 'firebase' | 'cloudflare' | 'supabase' | ... — half of the rate-limit bucket key and every outbound-health log line. */
  provider: string
  /**
   * Whatever identifies one customer's account to this provider — a Supabase
   * project ref, a Railway environment id, a Cloudflare account id, a GCP
   * project id for Firebase (ADR-131). An identifier, never a secret itself
   * — safe to log (contracts.md §6 governs the credential, not this).
   */
  accountKey: string
  /** AbortController timeout per attempt, ms. Default 10s. */
  timeoutMs?: number
  /** Total attempts including the first, before giving up. Default 3. */
  maxAttempts?: number
  /** Wall-clock budget for the whole call (all attempts + backoff + rate-limit waits), ms. Default 30s. */
  maxElapsedMs?: number
  /** First retry's backoff delay, ms. Default 200. */
  initialBackoffMs?: number
  /** Backoff growth factor per retry. Default 4 (200ms, 800ms, ...). */
  backoffMultiplier?: number
  /** Per-(provider, accountKey) token bucket. Defaults to this provider's entry in JUNCTION_DEFAULT_RATE_LIMITS. */
  rateLimit?: TokenBucketConfig
  /** Dependency-injection seam for tests — defaults to the platform global `fetch`, read at call time so tests can stub `globalThis.fetch` per call. */
  fetchImpl?: typeof fetch
}

/**
 * The one function every connector's outbound HTTP call goes through
 * (ADR-131). Times out and retries a transient failure with backoff, never
 * retries a 4xx, self-throttles per `(provider, accountKey)` even across
 * retries, and logs the call's outcome. Mirrors a bare `fetch()`'s contract
 * closely on purpose: on success *or* a non-retryable failure, this returns
 * the `Response` as-is — the caller's own `if (!res.ok) throw ...` still
 * constructs the same error it always did. This is a transport-layer
 * wrapper, not a second place that decides what a failed call means.
 */
export async function junctionFetch(url: string | URL, init: RequestInit = {}, policy: JunctionPolicy): Promise<Response> {
  const {
    provider,
    accountKey,
    timeoutMs = JUNCTION_DEFAULT_TIMEOUT_MS,
    maxAttempts = JUNCTION_DEFAULT_MAX_ATTEMPTS,
    maxElapsedMs = JUNCTION_DEFAULT_MAX_ELAPSED_MS,
    initialBackoffMs = JUNCTION_DEFAULT_INITIAL_BACKOFF_MS,
    backoffMultiplier = JUNCTION_DEFAULT_BACKOFF_MULTIPLIER,
    rateLimit = defaultRateLimitFor(provider),
    fetchImpl = fetch,
  } = policy

  const method = (init.method ?? 'GET').toUpperCase()
  const label = safeUrlLabel(url)
  const startedAt = Date.now()
  let attempt = 0
  let sawRetry = false

  for (;;) {
    attempt++
    const remainingBudget = maxElapsedMs - (Date.now() - startedAt)
    if (remainingBudget <= 0) {
      logOutcome(provider, accountKey, 'retried-then-failed', method, label, attempt - 1, startedAt)
      throw new Error(
        `junction: ${provider}:${accountKey} ${method} ${label} exceeded its wall-clock budget (${maxElapsedMs}ms) after ${attempt - 1} attempt(s)`,
      )
    }

    try {
      await acquireToken(provider, accountKey, rateLimit, remainingBudget)
    } catch (err) {
      if (err instanceof RateLimitExceededError) {
        logOutcome(provider, accountKey, 'rate-limited', method, label, attempt, startedAt)
      }
      throw err
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    try {
      const res = await fetchImpl(url, { ...init, signal: controller.signal })
      clearTimeout(timer)

      if (res.ok || res.status < 500) {
        // Success, or a non-retryable failure (4xx, or anything outside the
        // 5xx retry class) — never retried (ADR-131: "a 4xx never retries").
        logOutcome(provider, accountKey, sawRetry ? 'retried-then-succeeded' : 'success', method, label, attempt, startedAt)
        return res
      }

      // 5xx — transient by assumption, retry with backoff if attempts/budget remain.
      if (attempt >= maxAttempts) {
        logOutcome(provider, accountKey, sawRetry ? 'retried-then-failed' : 'failed', method, label, attempt, startedAt)
        return res
      }
      sawRetry = true
      await backoff(attempt, initialBackoffMs, backoffMultiplier, maxElapsedMs - (Date.now() - startedAt))
    } catch (err) {
      clearTimeout(timer)
      // Anything caught here is the fetch call itself failing — a network
      // error or this junction's own timeout abort — the same "network
      // errors, and timeout" retry class ADR-131 names alongside 5xx.
      if (attempt >= maxAttempts) {
        logOutcome(provider, accountKey, sawRetry ? 'retried-then-failed' : 'failed', method, label, attempt, startedAt)
        throw err
      }
      sawRetry = true
      await backoff(attempt, initialBackoffMs, backoffMultiplier, maxElapsedMs - (Date.now() - startedAt))
    }
  }
}

// ── dbJunction ───────────────────────────────────────────────────────────────

export interface DbJunctionPolicy {
  /** Provider name for the rate-limit bucket and log lines — e.g. 'supabase-postgres'. */
  provider: string
  /** Whatever identifies one customer's account/project — the pg-path analog of JunctionPolicy.accountKey. */
  accountKey: string
  /** Soft timeout, ms. Default 10s. See DbJunctionTimeoutError's doc comment for what "soft" means here. */
  timeoutMs?: number
  maxAttempts?: number
  maxElapsedMs?: number
  initialBackoffMs?: number
  backoffMultiplier?: number
  rateLimit?: TokenBucketConfig
}

/**
 * A `pg` query has no portable, version-safe cancel-on-timeout the way
 * `AbortController` gives `fetch` (node-postgres's own cancel path is a
 * separate wire message, not a drop-in `signal` option on `Client#query` for
 * the version range this workspace pins — see postgres-client.ts's header
 * comment on why `pg`'s default import is used at all). `dbJunction`'s
 * timeout is therefore "stop waiting and let the caller retry with a fresh
 * connection," not "cancel the in-flight query on the wire" — stated
 * honestly here rather than implying a cancellation guarantee this
 * dependency doesn't give.
 */
export class DbJunctionTimeoutError extends Error {
  constructor(ms: number) {
    super(`junction: db query exceeded its ${ms}ms timeout`)
    this.name = 'DbJunctionTimeoutError'
  }
}

function withTimeout<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DbJunctionTimeoutError(timeoutMs)), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    run().then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

// SQLSTATE classes/codes that mean "transient — try again": connection
// exception (08xxx) and cannot_connect_now (57P03), plus Node's own
// socket-level error codes for a connection that never got established at
// all. Everything else — auth failure (28xxx), insufficient privilege
// (42501), syntax error (42601) — is this surface's equivalent of a 4xx: a
// bad credential or a malformed query is not a transient condition
// (ADR-131), so it's never retried.
const RETRYABLE_NODE_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'EAI_AGAIN', 'EPIPE'])

function isRetryableDbError(err: unknown): boolean {
  if (err instanceof DbJunctionTimeoutError) return true
  const code = (err as { code?: unknown } | undefined)?.code
  if (typeof code !== 'string') return false
  if (code.startsWith('08') || code === '57P03') return true
  return RETRYABLE_NODE_ERROR_CODES.has(code)
}

/**
 * The `pg`-path counterpart to `junctionFetch` (ADR-131 decision #2) —
 * same retry/backoff and per-`(provider, accountKey)` rate-limit primitives,
 * adapted to a `run()` thunk (postgres-client.ts's connect/query/end
 * sequence) instead of a `fetch` call. Each retry re-opens its own
 * connection via `run()` — it never assumes the failed attempt's socket is
 * safely reusable.
 */
export async function dbJunction<T>(run: () => Promise<T>, policy: DbJunctionPolicy): Promise<T> {
  const {
    provider,
    accountKey,
    timeoutMs = JUNCTION_DEFAULT_DB_TIMEOUT_MS,
    maxAttempts = JUNCTION_DEFAULT_MAX_ATTEMPTS,
    maxElapsedMs = JUNCTION_DEFAULT_MAX_ELAPSED_MS,
    initialBackoffMs = JUNCTION_DEFAULT_INITIAL_BACKOFF_MS,
    backoffMultiplier = JUNCTION_DEFAULT_BACKOFF_MULTIPLIER,
    rateLimit = defaultRateLimitFor(provider),
  } = policy

  const startedAt = Date.now()
  let attempt = 0
  let sawRetry = false

  for (;;) {
    attempt++
    const remainingBudget = maxElapsedMs - (Date.now() - startedAt)
    if (remainingBudget <= 0) {
      logOutcome(provider, accountKey, 'retried-then-failed', 'QUERY', 'db', attempt - 1, startedAt)
      throw new Error(
        `junction: ${provider}:${accountKey} db query exceeded its wall-clock budget (${maxElapsedMs}ms) after ${attempt - 1} attempt(s)`,
      )
    }

    try {
      await acquireToken(provider, accountKey, rateLimit, remainingBudget)
    } catch (err) {
      if (err instanceof RateLimitExceededError) {
        logOutcome(provider, accountKey, 'rate-limited', 'QUERY', 'db', attempt, startedAt)
      }
      throw err
    }

    try {
      const result = await withTimeout(run, timeoutMs)
      logOutcome(provider, accountKey, sawRetry ? 'retried-then-succeeded' : 'success', 'QUERY', 'db', attempt, startedAt)
      return result
    } catch (err) {
      if (!isRetryableDbError(err) || attempt >= maxAttempts) {
        logOutcome(provider, accountKey, sawRetry ? 'retried-then-failed' : 'failed', 'QUERY', 'db', attempt, startedAt)
        throw err
      }
      sawRetry = true
      await backoff(attempt, initialBackoffMs, backoffMultiplier, maxElapsedMs - (Date.now() - startedAt))
    }
  }
}
