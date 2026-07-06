import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { LogEntry } from '@neat.is/types'
import { LogsResponseSchema } from '@neat.is/types'
import { resetGraph, getGraph } from '../src/graph.js'
import { buildApi } from '../src/api.js'
import { appendLogEntry, resetLogsStore } from '../src/logs-store.js'

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

function entry(overrides: Partial<LogEntry> & { id: string }): LogEntry {
  return {
    projectName: 'default',
    source: 'native',
    timestamp: iso(0),
    message: 'hello',
    ...overrides,
  }
}

describe('GET /logs', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    resetLogsStore()
    resetGraph()
    app = await buildApi({ graph: getGraph() })
  })

  afterEach(async () => {
    await app.close()
    resetLogsStore()
  })

  it('returns a wrapped empty list when the store has nothing for the project', async () => {
    const res = await app.inject({ method: 'GET', url: '/logs' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ count: 0, total: 0, logs: [] })
  })

  it('returns entries newest-first with the ADR-061 envelope shape', async () => {
    appendLogEntry(entry({ id: '1', message: 'first', timestamp: iso(-2000) }))
    appendLogEntry(entry({ id: '2', message: 'second', timestamp: iso(-1000) }))

    const res = await app.inject({ method: 'GET', url: '/logs' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.count).toBe(2)
    expect(body.total).toBe(2)
    expect(body.logs.map((l: LogEntry) => l.id)).toEqual(['2', '1'])

    const parsed = LogsResponseSchema.safeParse(body)
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.format())).toBe(true)
  })

  it('is dual-mounted at /logs and /projects/:project/logs', async () => {
    appendLogEntry(entry({ id: '1' }))
    const root = await app.inject({ method: 'GET', url: '/logs' })
    const prefixed = await app.inject({ method: 'GET', url: '/projects/default/logs' })
    expect(root.statusCode).toBe(200)
    expect(prefixed.statusCode).toBe(200)
    expect(root.json()).toEqual(prefixed.json())
  })

  it('filters by source, repeatable via ?source=a&source=b', async () => {
    appendLogEntry(entry({ id: 'n1', source: 'native' }))
    appendLogEntry(entry({ id: 's1', source: 'supabase' }))
    appendLogEntry(entry({ id: 'r1', source: 'railway' }))

    const onlyNative = await app.inject({ method: 'GET', url: '/logs?source=native' })
    expect(onlyNative.json().logs.map((l: LogEntry) => l.id)).toEqual(['n1'])

    const two = await app.inject({ method: 'GET', url: '/logs?source=native&source=supabase' })
    expect(two.json().logs.map((l: LogEntry) => l.id).sort()).toEqual(['n1', 's1'])
    expect(two.json().total).toBe(2)

    const all = await app.inject({ method: 'GET', url: '/logs' })
    expect(all.json().total).toBe(3)
  })

  it('filters by service', async () => {
    appendLogEntry(entry({ id: 'a', serviceName: 'checkout' }))
    appendLogEntry(entry({ id: 'b', serviceName: 'billing' }))
    const res = await app.inject({ method: 'GET', url: '/logs?service=checkout' })
    const body = res.json()
    expect(body.logs.map((l: LogEntry) => l.id)).toEqual(['a'])
    expect(body.total).toBe(1)
  })

  it('filters by since', async () => {
    appendLogEntry(entry({ id: 'old', timestamp: iso(-3000) }))
    appendLogEntry(entry({ id: 'new', timestamp: iso(-1000) }))
    const res = await app.inject({
      method: 'GET',
      url: `/logs?since=${encodeURIComponent(iso(-2000))}`,
    })
    const body = res.json()
    expect(body.logs.map((l: LogEntry) => l.id)).toEqual(['new'])
    expect(body.total).toBe(1)
  })

  it('caps `logs` at `limit` while `total` reflects the unlimited filtered count', async () => {
    appendLogEntry(entry({ id: '1', timestamp: iso(-3000) }))
    appendLogEntry(entry({ id: '2', timestamp: iso(-2000) }))
    appendLogEntry(entry({ id: '3', timestamp: iso(-1000) }))

    const res = await app.inject({ method: 'GET', url: '/logs?limit=2' })
    const body = res.json()
    expect(body.count).toBe(2)
    expect(body.total).toBe(3)
    expect(body.logs.map((l: LogEntry) => l.id)).toEqual(['3', '2'])
  })

  it('caps an oversized limit at the sane max rather than returning everything', async () => {
    for (let i = 0; i < 20; i++) {
      appendLogEntry(entry({ id: `e${i}`, timestamp: iso(-1000 * (20 - i)) }))
    }
    const res = await app.inject({ method: 'GET', url: '/logs?limit=1000000' })
    const body = res.json()
    expect(body.total).toBe(20)
    expect(body.count).toBe(20)
    expect(body.logs.length).toBeLessThanOrEqual(1000)
  })

  it('keeps entries from other projects out of the default-project read', async () => {
    appendLogEntry(entry({ id: 'other', projectName: 'other-project' }))
    const res = await app.inject({ method: 'GET', url: '/logs' })
    expect(res.json()).toEqual({ count: 0, total: 0, logs: [] })
  })
})
