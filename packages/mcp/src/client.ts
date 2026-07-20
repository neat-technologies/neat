// Thin HTTP client for the neat-core REST surface. Tools call out via this
// instead of fetch() directly so tests can swap in a stub implementation
// without monkey-patching globals.

export interface HttpClient {
  get<T>(path: string): Promise<T>
  // POST is optional on the interface so test stubs that only need GET don't
  // have to implement it. Production createHttpClient always provides it.
  post?<T>(path: string, body: unknown): Promise<T>
}

// A daemon that has bound its port but isn't answering yet — mid-boot, wedged
// mid-extraction, deadlocked, or sitting behind a proxy that black-holes the
// request — accepts the TCP connection and then never writes a response. With
// no deadline on the fetch, undici only gives up at its 5-minute headers
// timeout, which to an interactive agent is indistinguishable from a hang. The
// MCP surface must stay queryable "at all times": a slow or wedged daemon has
// to surface as a clean, bounded error the agent can act on, never an open-
// ended wait. So every request carries a deadline; when it trips we translate
// the abort into a plain-language error the tool layer formats as isError.
const DEFAULT_TIMEOUT_MS = 30_000

function resolveTimeoutMs(explicit?: number): number {
  if (typeof explicit === 'number' && explicit > 0) return explicit
  const fromEnv = Number(process.env.NEAT_CORE_TIMEOUT_MS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  return DEFAULT_TIMEOUT_MS
}

// AbortSignal.timeout rejects the fetch with a DOMException named
// 'TimeoutError'; a caller-triggered abort surfaces as 'AbortError'. Match on
// the name rather than the type so this holds across Node's DOMException /
// Error representations.
function isTimeoutAbort(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  method: string,
  path: string,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    if (isTimeoutAbort(err)) {
      throw new RequestTimeoutError(
        `Timed out after ${timeoutMs}ms waiting for neat-core on ${method} ${path} — ` +
          `the daemon may be starting up, busy, or wedged. Confirm it is reachable ` +
          `(curl its /health endpoint) or raise NEAT_CORE_TIMEOUT_MS.`,
      )
    }
    throw err
  }
}

// ADR-073 §3 — the MCP server is a first-party read client, so it carries the
// operator's bearer on every call the same way the CLI does. `bearerToken`
// comes from `NEAT_AUTH_TOKEN` (sourced once in index.ts). Empty / undefined
// keeps the header off, so an unauthenticated loopback dev daemon still works.
// `timeoutMs` bounds every request; it defaults to NEAT_CORE_TIMEOUT_MS or 30s
// and is overridable for tests.
export function createHttpClient(
  baseUrl: string,
  bearerToken?: string,
  timeoutMs?: number,
): HttpClient {
  const root = baseUrl.replace(/\/$/, '')
  const deadline = resolveTimeoutMs(timeoutMs)
  const authHeader: Record<string, string> =
    bearerToken && bearerToken.length > 0
      ? { authorization: `Bearer ${bearerToken}` }
      : {}
  return {
    async get<T>(path: string): Promise<T> {
      const res = await fetchWithTimeout(
        `${root}${path}`,
        { headers: { ...authHeader } },
        deadline,
        'GET',
        path,
      )
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new HttpError(res.status, `${res.status} ${res.statusText} on GET ${path}: ${body}`)
      }
      return (await res.json()) as T
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      const res = await fetchWithTimeout(
        `${root}${path}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeader },
          body: JSON.stringify(body),
        },
        deadline,
        'POST',
        path,
      )
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new HttpError(res.status, `${res.status} ${res.statusText} on POST ${path}: ${text}`)
      }
      return (await res.json()) as T
    },
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

// Thrown when a request exceeds its deadline. Not an HttpError — there was no
// HTTP response — so the tool layer's 404 fallback doesn't swallow it; it lands
// in the generic branch and surfaces as a formatted isError the agent can read.
export class RequestTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestTimeoutError'
  }
}
