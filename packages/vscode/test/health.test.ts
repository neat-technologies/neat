import { describe, it, expect } from 'vitest'
import {
  BASE_INTERVAL_MS,
  MAX_INTERVAL_MS,
  healthUrl,
  nextInterval,
  parseHealth,
  pollHealth,
  statusText,
  type StatusState,
} from '../src/health'

describe('parseHealth — liveness + node total', () => {
  it('sums nodeCount across a daemon-wide projects array', () => {
    const body = {
      ok: true,
      uptimeMs: 10,
      projects: [
        { name: 'a', nodeCount: 12, edgeCount: 3 },
        { name: 'b', nodeCount: 30, edgeCount: 9 },
      ],
    }
    expect(parseHealth(body)).toEqual({ ok: true, nodeCount: 42 })
  })

  it('reads a single per-project daemon (project + one-entry projects)', () => {
    const body = { ok: true, project: 'brief', projects: [{ name: 'brief', nodeCount: 7 }] }
    expect(parseHealth(body)).toEqual({ ok: true, nodeCount: 7 })
  })

  it('falls back to a top-level nodeCount', () => {
    expect(parseHealth({ ok: true, nodeCount: 5 })).toEqual({ ok: true, nodeCount: 5 })
  })

  it('treats anything not clearly ok as down', () => {
    expect(parseHealth({ ok: false })).toEqual({ ok: false, nodeCount: 0 })
    expect(parseHealth(null)).toEqual({ ok: false, nodeCount: 0 })
    expect(parseHealth('nope')).toEqual({ ok: false, nodeCount: 0 })
    expect(parseHealth({})).toEqual({ ok: false, nodeCount: 0 })
  })
})

describe('statusText — state → status-bar label', () => {
  it('up shows a thousands-separated node count', () => {
    const { text, tooltip } = statusText({ kind: 'up', nodeCount: 1234 })
    expect(text).toBe('$(circle-filled) NEAT 1,234')
    expect(tooltip).toContain('1,234 nodes')
  })

  it('singular node reads "node" not "nodes"', () => {
    expect(statusText({ kind: 'up', nodeCount: 1 }).tooltip).toContain('1 node in the graph')
  })

  it('down and checking have their own labels', () => {
    expect(statusText({ kind: 'down' }).text).toBe('$(circle-slash) NEAT offline')
    expect(statusText({ kind: 'checking' }).text).toBe('$(sync~spin) NEAT')
  })
})

describe('nextInterval — steady when up, backoff when down', () => {
  it('resets to the base interval on an up poll', () => {
    expect(nextInterval({ kind: 'up', nodeCount: 0 }, MAX_INTERVAL_MS)).toBe(BASE_INTERVAL_MS)
  })

  it('doubles on a miss and caps at the max', () => {
    const down: StatusState = { kind: 'down' }
    expect(nextInterval(down, BASE_INTERVAL_MS)).toBe(20_000)
    expect(nextInterval(down, 20_000)).toBe(40_000)
    expect(nextInterval(down, 40_000)).toBe(MAX_INTERVAL_MS)
    expect(nextInterval(down, MAX_INTERVAL_MS)).toBe(MAX_INTERVAL_MS)
  })
})

describe('healthUrl', () => {
  it('joins base + /health tolerating a trailing slash', () => {
    expect(healthUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/health')
    expect(healthUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/health')
  })
})

describe('pollHealth — with a mocked fetch, never a live daemon', () => {
  it('returns up + node count on a 200 health payload', async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => ({ ok: true, projects: [{ nodeCount: 9 }] }),
      }) as unknown as Response) as typeof fetch
    expect(await pollHealth('http://127.0.0.1:8080', undefined, fakeFetch)).toEqual({
      kind: 'up',
      nodeCount: 9,
    })
  })

  it('returns down on a non-2xx response', async () => {
    const fakeFetch = (async () => ({ ok: false }) as unknown as Response) as typeof fetch
    expect(await pollHealth('http://127.0.0.1:8080', undefined, fakeFetch)).toEqual({ kind: 'down' })
  })

  it('returns down (never throws) when fetch rejects', async () => {
    const fakeFetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    expect(await pollHealth('http://127.0.0.1:8080', undefined, fakeFetch)).toEqual({ kind: 'down' })
  })

  it('sends a bearer header when a token is configured', async () => {
    let seen: Record<string, string> | undefined
    const fakeFetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
      seen = init?.headers
      return { ok: true, json: async () => ({ ok: true, projects: [] }) } as unknown as Response
    }) as unknown as typeof fetch
    await pollHealth('http://127.0.0.1:8080', 'secret-token', fakeFetch)
    expect(seen?.Authorization).toBe('Bearer secret-token')
  })
})
