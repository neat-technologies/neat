import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bearerAuthHeader,
  dbJunction,
  junctionFetch,
  RateLimitExceededError,
  resetJunctionRateLimiters,
} from '../src/connectors/junction.js'

// The junction is the one place every connector's outbound call goes
// through (ADR-131) — these tests exercise the junction's own logic (retry,
// timeout, rate limiting, the credential helper) against a fake `fetch`/`run`,
// never a real provider. See connectors-{railway,firebase,cloudflare,supabase}
// .test.ts for proof each connector's own poll()/signal-mapping behavior is
// unaffected by routing through it.

describe('bearerAuthHeader', () => {
  it('builds the common Authorization: Bearer <token> shape every connector shares', () => {
    expect(bearerAuthHeader('abc123')).toEqual({ Authorization: 'Bearer abc123' })
  })
})

describe('junctionFetch — retry with backoff', () => {
  beforeEach(() => {
    resetJunctionRateLimiters()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries a transient 5xx and succeeds once the provider recovers', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      if (calls === 1) return new Response('server error', { status: 503, statusText: 'Service Unavailable' })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    const promise = junctionFetch(
      'https://example.test/x',
      {},
      { provider: 'test-retry', accountKey: 'acct-1', fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    await vi.runAllTimersAsync()
    const res = await promise

    expect(res.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('retries a network error the same way it retries a 5xx', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      if (calls === 1) throw new TypeError('fetch failed')
      return new Response('ok', { status: 200 })
    })

    const promise = junctionFetch(
      'https://example.test/x',
      {},
      { provider: 'test-network-retry', accountKey: 'acct-1', fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    await vi.runAllTimersAsync()
    const res = await promise

    expect(res.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('never retries a 4xx — a bad credential or malformed query is not transient', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad request', { status: 400, statusText: 'Bad Request' }))

    const res = await junctionFetch(
      'https://example.test/x',
      {},
      { provider: 'test-4xx', accountKey: 'acct-1', fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    expect(res.status).toBe(400)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('gives up after maxAttempts on a persistent 5xx, returning the last response rather than hanging', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 502, statusText: 'Bad Gateway' }))

    const promise = junctionFetch(
      'https://example.test/x',
      {},
      { provider: 'test-exhaust', accountKey: 'acct-1', maxAttempts: 3, fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    await vi.runAllTimersAsync()
    const res = await promise

    expect(res.status).toBe(502)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
})

describe('junctionFetch — timeout', () => {
  beforeEach(() => {
    resetJunctionRateLimiters()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('aborts a hung request once the per-attempt timeout elapses, then retries', async () => {
    let calls = 0
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      calls++
      const thisCall = calls
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'))
        })
        // The first attempt never resolves on its own — only the junction's
        // own timeout abort settles it. The second attempt succeeds right
        // away, proving the retry actually reissues the call.
        if (thisCall === 2) resolve(new Response('ok', { status: 200 }))
      })
    })

    const promise = junctionFetch(
      'https://example.test/slow',
      {},
      {
        provider: 'test-timeout',
        accountKey: 'acct-1',
        timeoutMs: 1_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    )

    await vi.runAllTimersAsync()
    const res = await promise

    expect(res.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('junctionFetch — per-(provider, accountKey) rate limiting', () => {
  beforeEach(() => {
    resetJunctionRateLimiters()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('enforces a separate token bucket per accountKey, never throttling one customer for another\'s traffic', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }))
    const rateLimit = { capacity: 1, refillMs: 5_000 }

    // First call on acct-a drains its single token immediately.
    await junctionFetch(
      'https://example.test/a',
      {},
      { provider: 'test-rl', accountKey: 'acct-a', rateLimit, fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // A different account's bucket is untouched — resolves without waiting.
    let otherSettled = false
    const otherPromise = junctionFetch(
      'https://example.test/b',
      {},
      { provider: 'test-rl', accountKey: 'acct-b', rateLimit, fetchImpl: fetchImpl as unknown as typeof fetch },
    ).then((r) => {
      otherSettled = true
      return r
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(otherSettled).toBe(true)
    await otherPromise
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    // A second call on the SAME account has to wait out the bucket's refill.
    let settled = false
    const secondPromise = junctionFetch(
      'https://example.test/a',
      {},
      { provider: 'test-rl', accountKey: 'acct-a', rateLimit, fetchImpl: fetchImpl as unknown as typeof fetch },
    ).then((r) => {
      settled = true
      return r
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(4_000)
    await secondPromise
    expect(settled).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('throws RateLimitExceededError rather than waiting past the call\'s wall-clock budget', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }))
    const rateLimit = { capacity: 1, refillMs: 60_000 }

    await junctionFetch(
      'https://example.test/a',
      {},
      { provider: 'test-rl-budget', accountKey: 'acct-1', rateLimit, fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    await expect(
      junctionFetch(
        'https://example.test/a',
        {},
        {
          provider: 'test-rl-budget',
          accountKey: 'acct-1',
          rateLimit,
          maxElapsedMs: 1_000,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(RateLimitExceededError)
  })
})

describe('dbJunction', () => {
  beforeEach(() => {
    resetJunctionRateLimiters()
  })

  it('retries a transient connection error and succeeds on the next attempt', async () => {
    let attempts = 0
    const run = vi.fn(async () => {
      attempts++
      if (attempts === 1) {
        const err = new Error('connection terminated unexpectedly') as Error & { code: string }
        err.code = '08006' // connection_failure — SQLSTATE class 08
        throw err
      }
      return 'ok'
    })

    const result = await dbJunction(run, { provider: 'test-db-retry', accountKey: 'db-1', initialBackoffMs: 1 })

    expect(result).toBe('ok')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('never retries a non-transient error — a bad credential or malformed query stays a single attempt', async () => {
    const err = new Error('password authentication failed for user "neat_reader"') as Error & { code: string }
    err.code = '28P01' // invalid_password
    const run = vi.fn(async () => {
      throw err
    })

    await expect(dbJunction(run, { provider: 'test-db-4xx', accountKey: 'db-2' })).rejects.toThrow(err.message)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('gives up after maxAttempts on a persistent transient error', async () => {
    const err = new Error('could not connect to server') as Error & { code: string }
    err.code = 'ECONNREFUSED'
    const run = vi.fn(async () => {
      throw err
    })

    await expect(
      dbJunction(run, { provider: 'test-db-exhaust', accountKey: 'db-3', maxAttempts: 3, initialBackoffMs: 1 }),
    ).rejects.toThrow(err.message)
    expect(run).toHaveBeenCalledTimes(3)
  })
})
