import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { MultiDirectedGraph } from 'graphology'
import { type GraphEdge, type GraphNode, type ErrorEvent, NodeType } from '@neat.is/types'
import { buildApi } from '../src/api.js'
import { readErrorEvents, INCIDENT_READ_MAX_EVENTS } from '../src/ingest.js'
import type { NeatGraph } from '../src/graph.js'

// Regression for #1083. On a long-running daemon a busy service accumulates an
// unbounded incident history in errors.ndjson. The old read pulled the whole
// file into one utf8 string and the incident-history handler serialized every
// matching record, so once the store crossed V8's ~2^29-char ceiling the read
// (or the response) threw `RangeError: Invalid string length` and the three
// incident-backed queries — get_incident_history, get_root_cause, ask — all
// 500'd on exactly the services that produce the most incidents. semantic_search
// / blast_radius / divergences never touch the store, which is why they survived.
//
// These tests seed a store far larger than every bound and assert the read and
// all three endpoints stay bounded and return 200, never a 500.

const NODE_ID = 'service:recommendation'
// Comfortably past both the read cap (5000) and the per-response cap (200).
const SEEDED = 12_000

function newGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  g.addNode(NODE_ID, {
    id: NODE_ID,
    type: NodeType.ServiceNode,
    name: 'recommendation',
    language: 'javascript',
  })
  return g
}

async function seedIncidents(errorsPath: string, count: number): Promise<void> {
  // A chunky stacktrace per record so the serialized store is genuinely large,
  // not a toy — the shape a real erroring service leaves behind.
  const stack = ('at handler (recommendation.js:42:13)\n'.repeat(12)).trim()
  const lines: string[] = []
  for (let i = 0; i < count; i++) {
    const ev: ErrorEvent = {
      id: `trace-${i}:span-${i}`,
      // Increasing timestamps so "most recent" is deterministic (i = newest last).
      timestamp: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      service: 'recommendation',
      traceId: `trace-${i}`,
      spanId: `span-${i}`,
      errorType: 'exception',
      errorMessage: `recommendation request ${i} failed: downstream timeout`,
      exceptionType: 'TimeoutError',
      exceptionStacktrace: stack,
      affectedNode: NODE_ID,
    }
    lines.push(JSON.stringify(ev))
  }
  await fs.writeFile(errorsPath, lines.join('\n') + '\n', 'utf8')
}

describe('incident serialization is bounded on a large store (#1083)', () => {
  let tmpDir: string
  let errorsPath: string
  let graph: NeatGraph
  let app: Awaited<ReturnType<typeof buildApi>>

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-incident-cap-'))
    errorsPath = path.join(tmpDir, 'errors.ndjson')
    graph = newGraph()
    await seedIncidents(errorsPath, SEEDED)
    app = await buildApi({ graph, errorsPath })
  })

  afterEach(async () => {
    await app.close()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('readErrorEvents caps the read and returns the most-recent window', async () => {
    const events = await readErrorEvents(errorsPath)
    expect(events.length).toBe(INCIDENT_READ_MAX_EVENTS)
    // The tail of the append-only file is newest, so the last seeded record is kept.
    expect(events[events.length - 1]!.id).toBe(`trace-${SEEDED - 1}:span-${SEEDED - 1}`)
    // An explicit `limit` narrows it further.
    const ten = await readErrorEvents(errorsPath, { limit: 10 })
    expect(ten.length).toBe(10)
    expect(ten[ten.length - 1]!.id).toBe(`trace-${SEEDED - 1}:span-${SEEDED - 1}`)
  })

  it('GET /incidents/:nodeId returns a bounded 200 with a truncation marker', async () => {
    const res = await app.inject({ method: 'GET', url: `/incidents/${NODE_ID}` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      count: number
      total: number
      events: ErrorEvent[]
      omitted?: number
    }
    // Default page (no ?limit) is bounded and small.
    expect(body.count).toBe(50)
    expect(body.events).toHaveLength(50)
    expect(body.total).toBeGreaterThan(body.count)
    expect(body.omitted).toBe(body.total - body.count)
    // Newest first.
    expect(body.events[0]!.id).toBe(`trace-${SEEDED - 1}:span-${SEEDED - 1}`)
  })

  it('GET /graph/incident-history/:nodeId honours ?limit and its cap', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/graph/incident-history/${NODE_ID}?limit=25`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().events).toHaveLength(25)

    const capped = await app.inject({
      method: 'GET',
      url: `/graph/incident-history/${NODE_ID}?limit=100000`,
    })
    expect(capped.statusCode).toBe(200)
    // Never more than the hard per-response cap, whatever the caller asks for.
    expect(capped.json().events.length).toBeLessThanOrEqual(200)
  })

  it('GET /incidents (list) returns a bounded 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/incidents' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { count: number; total: number; events: ErrorEvent[] }
    expect(body.count).toBe(50)
    expect(body.events).toHaveLength(50)
  })

  it('GET /graph/root-cause/:nodeId returns 200, not a 500', async () => {
    const res = await app.inject({ method: 'GET', url: `/graph/root-cause/${NODE_ID}` })
    expect(res.statusCode).not.toBe(500)
    expect(res.statusCode).toBe(200)
  })

  it('GET /graph/ask returns 200, not a 500', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/graph/ask?q=${encodeURIComponent('why is recommendation failing')}`,
    })
    expect(res.statusCode).not.toBe(500)
    expect(res.statusCode).toBe(200)
  })
})
