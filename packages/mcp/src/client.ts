// Thin HTTP client for the neat-core REST surface. Tools call out via this
// instead of fetch() directly so tests can swap in a stub implementation
// without monkey-patching globals.

export interface HttpClient {
  get<T>(path: string): Promise<T>
  // POST is optional on the interface so test stubs that only need GET don't
  // have to implement it. Production createHttpClient always provides it.
  post?<T>(path: string, body: unknown): Promise<T>
}

// ADR-073 §3 — the MCP server is a first-party read client, so it carries the
// operator's bearer on every call the same way the CLI does. `bearerToken`
// comes from `NEAT_AUTH_TOKEN` (sourced once in index.ts). Empty / undefined
// keeps the header off, so an unauthenticated loopback dev daemon still works.
export function createHttpClient(baseUrl: string, bearerToken?: string): HttpClient {
  const root = baseUrl.replace(/\/$/, '')
  const authHeader =
    bearerToken && bearerToken.length > 0
      ? { authorization: `Bearer ${bearerToken}` }
      : {}
  return {
    async get<T>(path: string): Promise<T> {
      const res = await fetch(`${root}${path}`, { headers: { ...authHeader } })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new HttpError(res.status, `${res.status} ${res.statusText} on GET ${path}: ${body}`)
      }
      return (await res.json()) as T
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      const res = await fetch(`${root}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader },
        body: JSON.stringify(body),
      })
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
