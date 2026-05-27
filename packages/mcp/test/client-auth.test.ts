import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpClient } from '../src/client.js'

// ADR-073 §3 — the MCP server is a first-party read client, so createHttpClient
// must carry the operator's bearer on every request when one is configured,
// and omit it when none is (loopback dev core). We stub global fetch to capture
// the outgoing headers rather than stand up a daemon.

function stubFetch(): { headersFor: (i: number) => Headers } {
  const calls: RequestInit[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(init ?? {})
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
  return {
    headersFor: (i: number) => new Headers(calls[i]?.headers),
  }
}

describe('MCP createHttpClient bearer auth (ADR-073 §3)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('attaches Authorization on GET when a token is given', async () => {
    const cap = stubFetch()
    const client = createHttpClient('http://localhost:8080', 'tok-mcp')
    await client.get('/graph')
    expect(cap.headersFor(0).get('authorization')).toBe('Bearer tok-mcp')
  })

  it('attaches Authorization on POST when a token is given', async () => {
    const cap = stubFetch()
    const client = createHttpClient('http://localhost:8080', 'tok-mcp')
    await client.post!('/policies/check', { hypotheticalAction: null })
    const headers = cap.headersFor(0)
    expect(headers.get('authorization')).toBe('Bearer tok-mcp')
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('omits Authorization when no token is given', async () => {
    const cap = stubFetch()
    const client = createHttpClient('http://localhost:8080')
    await client.get('/graph')
    expect(cap.headersFor(0).get('authorization')).toBeNull()
  })

  it('omits Authorization when the token is an empty string', async () => {
    const cap = stubFetch()
    const client = createHttpClient('http://localhost:8080', '')
    await client.get('/graph')
    expect(cap.headersFor(0).get('authorization')).toBeNull()
  })
})
