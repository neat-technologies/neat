import { describe, expect, it } from 'vitest'
import { checkEndpointIsNeat, describeForeignEndpoint } from '../src/endpoint-check.js'

// #1069 — the MCP server used to trust whatever URL resolveBaseUrl() landed on.
// Outside a NEAT project the resolver falls back to :8080, and when another
// service holds that port (an otel-demo frontend, in the live run that surfaced
// this) every tool call came back as an opaque HTML/404. A single /health probe
// at boot now tells NEAT from a foreign service — accepting NEAT unchanged,
// failing fast with a clear message on a confirmed-foreign endpoint, and NOT
// misreading a slow-to-boot or auth-gated real daemon as foreign.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function htmlResponse(status: number): Response {
  return new Response('<!doctype html><title>otel-demo frontend</title>', {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

// The daemon-wide /health shape a real NEAT daemon returns at the REST root.
const NEAT_HEALTH = { ok: true, uptimeMs: 1234, projects: [] }

describe('checkEndpointIsNeat', () => {
  it('accepts a daemon whose /health returns NEAT health JSON', async () => {
    const check = await checkEndpointIsNeat('http://localhost:8080', {
      fetchImpl: async () => jsonResponse(NEAT_HEALTH),
    })
    expect(check).toEqual({ kind: 'neat' })
  })

  it('flags an HTML 404 (the :8080-foreign-service case) as foreign', async () => {
    const check = await checkEndpointIsNeat('http://localhost:8080', {
      fetchImpl: async () => htmlResponse(404),
    })
    expect(check.kind).toBe('foreign')
    if (check.kind === 'foreign') {
      expect(check.status).toBe(404)
      expect(check.contentType).toContain('text/html')
    }
  })

  it('flags a 200 that is some other service’s JSON as foreign', async () => {
    const check = await checkEndpointIsNeat('http://localhost:8080', {
      fetchImpl: async () => jsonResponse({ service: 'not-neat', status: 'up' }),
    })
    expect(check.kind).toBe('foreign')
  })

  it('treats a refused connection as unreachable, not foreign', async () => {
    const check = await checkEndpointIsNeat('http://127.0.0.1:1', {
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1')
      },
    })
    expect(check.kind).toBe('unreachable')
  })

  it('treats a 401 (auth-gated real daemon) as unreachable, not foreign', async () => {
    const check = await checkEndpointIsNeat('http://localhost:8080', {
      fetchImpl: async () => jsonResponse({ error: 'unauthorized' }, 401),
    })
    expect(check.kind).toBe('unreachable')
  })

  it('treats a 502 gateway response as unreachable, not foreign', async () => {
    const check = await checkEndpointIsNeat('http://localhost:8080', {
      fetchImpl: async () => htmlResponse(502),
    })
    expect(check.kind).toBe('unreachable')
  })

  it('probes /health at the base-URL root and carries the bearer token', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    await checkEndpointIsNeat('http://localhost:8080/', {
      bearerToken: 'secret-abc',
      fetchImpl: async (url, init) => {
        seen.url = String(url)
        seen.init = init
        return jsonResponse(NEAT_HEALTH)
      },
    })
    expect(seen.url).toBe('http://localhost:8080/health')
    expect((seen.init?.headers as Record<string, string>).authorization).toBe('Bearer secret-abc')
  })

  it('omits the auth header when no bearer token is given', async () => {
    const seen: { init?: RequestInit } = {}
    await checkEndpointIsNeat('http://localhost:8080', {
      fetchImpl: async (_url, init) => {
        seen.init = init
        return jsonResponse(NEAT_HEALTH)
      },
    })
    expect((seen.init?.headers as Record<string, string>).authorization).toBeUndefined()
  })
})

describe('describeForeignEndpoint', () => {
  it('names the :8080 fallback and gives the actionable fix', () => {
    const msg = describeForeignEndpoint('http://localhost:8080', 'default', {
      status: 404,
      contentType: 'text/html',
    })
    expect(msg).toContain('http://localhost:8080')
    expect(msg).toContain('does not look like NEAT')
    expect(msg).toContain('/health')
    expect(msg).toContain('404')
    expect(msg).toContain(':8080')
    expect(msg).toContain('inside a NEAT project')
    expect(msg).toContain('NEAT_CORE_URL')
    expect(msg).toContain('NEAT_SKIP_ENDPOINT_CHECK=1')
  })

  it('words the explicit-NEAT_CORE_URL case differently from the fallback', () => {
    const msg = describeForeignEndpoint('http://wrong.internal:9000', 'env', {
      status: 200,
      contentType: 'application/json',
    })
    expect(msg).toContain('NEAT_CORE_URL / NEAT_API_URL')
    expect(msg).toContain('http://wrong.internal:9000')
    expect(msg).not.toContain(':8080')
  })

  it('words the stale daemon.json case as a stale record', () => {
    const msg = describeForeignEndpoint('http://localhost:8123', 'daemon-record', {
      status: 404,
      contentType: 'text/html',
    })
    expect(msg).toContain('daemon.json')
    expect(msg).toContain('stale')
  })
})
