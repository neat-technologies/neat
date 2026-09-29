// Is this endpoint a reachable NEAT daemon that accepts this token?
//
// The `/health` round-trip `neat doctor` and both halves of `neat login` share.
// It lived in login-cli.ts while the pasted-endpoint path was its only caller;
// the browser path needs the identical check before it reports success, and
// login-cli.ts already imports login-sso.ts, so the probe moved here rather than
// being duplicated or imported backwards.
//
// The cold-start budget is the load-bearing part. A hosted tenant on Cloud Run
// scales to zero, so a *healthy* daemon can stall the first request for tens of
// seconds. A flat timeout reports that daemon as unreachable, which is how a
// sleeping project comes to look like a broken one.

const PROBE_ATTEMPT_TIMEOUT_MS = 30_000
const PROBE_TOTAL_BUDGET_MS = 120_000
const PROBE_RETRY_PAUSE_MS = 2_000

export type Probe =
  | { kind: 'ok' }
  | { kind: 'unauthorized'; status: number }
  | { kind: 'not-neat'; status: number }
  | { kind: 'unreachable'; detail: string }

// True when the error is our own request timeout (AbortSignal.timeout) rather
// than a connection/DNS failure. A cold hosted daemon stalls the first request
// for tens of seconds, so a timeout is worth retrying — a refused connection or
// an unknown host is not.
function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: string })?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

// One `/health` round-trip. Returns a terminal Probe, or 'timeout' to tell the
// caller it may retry (a possible cold start).
async function probeOnce(
  fetchImpl: typeof fetch,
  root: string,
  token: string,
  timeoutMs: number,
): Promise<Probe | { kind: 'timeout' }> {
  let res: Response
  try {
    res = await fetchImpl(`${root}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    if (isTimeoutError(err)) return { kind: 'timeout' }
    return { kind: 'unreachable', detail: (err as Error).message }
  }
  if (res.status === 401 || res.status === 403) return { kind: 'unauthorized', status: res.status }
  if (!res.ok) return { kind: 'not-neat', status: res.status }
  const contentType = res.headers.get('content-type') ?? ''
  // A NEAT /health returns JSON; a random 200 from a foreign server does not.
  if (!contentType.includes('json')) return { kind: 'not-neat', status: res.status }
  return { kind: 'ok' }
}

/**
 * Confirm the endpoint is a reachable NEAT daemon that accepts the token, the
 * same `/health` probe `neat doctor` uses: a secured daemon answers 401/403 to a
 * bad bearer, so a wrong token fails here rather than being stored and failing on
 * the first read. A fast connection/DNS error fails immediately (a wrong URL),
 * but a request timeout is retried within a longer budget — a hosted daemon
 * scaled to zero cold-starts in tens of seconds, and the old flat cap reported
 * that valid daemon as unreachable.
 */
export async function probeDaemon(
  fetchImpl: typeof fetch,
  endpoint: string,
  token: string,
  hooks: { sleep: (ms: number) => Promise<void>; now: () => number; onWaiting: () => void },
): Promise<Probe> {
  const root = endpoint.replace(/\/$/, '')
  const deadline = hooks.now() + PROBE_TOTAL_BUDGET_MS
  let warned = false
  for (;;) {
    const result = await probeOnce(fetchImpl, root, token, PROBE_ATTEMPT_TIMEOUT_MS)
    if (result.kind !== 'timeout') return result
    // A timeout, not a refused connection — treat it as a possible cold start
    // and keep waiting within the budget, telling the user why once.
    if (!warned) {
      hooks.onWaiting()
      warned = true
    }
    if (hooks.now() >= deadline) {
      return { kind: 'unreachable', detail: `no response after ${Math.round(PROBE_TOTAL_BUDGET_MS / 1000)}s` }
    }
    await hooks.sleep(PROBE_RETRY_PAUSE_MS)
  }
}
