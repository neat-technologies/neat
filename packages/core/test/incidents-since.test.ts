import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { MultiDirectedGraph } from 'graphology'
import type { ErrorEvent, GraphEdge, GraphNode } from '@neat.is/types'
import { buildApi } from '../src/api.js'
import type { NeatGraph } from '../src/graph.js'

// ADR-261 — GET /incidents?since= keeps the incidents stamped at or after `since`
// before the limit applies. The search hook asks it "anything live?" once per
// session; the list is oldest-first, so on a long ledger the limit alone would
// hand back the oldest incidents and never the live ones.

describe('GET /incidents?since=', () => {
  let tmp: string
  let app: Awaited<ReturnType<typeof buildApi>>

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-incidents-since-'))
    const errorsPath = path.join(tmp, 'errors.ndjson')
    const lines: string[] = []
    for (let i = 0; i < 300; i++) {
      const ev: ErrorEvent = {
        id: `t${i}:s${i}`,
        timestamp: new Date(Date.UTC(2026, 9, 17, 0, 0, 0) + i * 60_000).toISOString(),
        service: 'geo',
        errorType: 'exception',
        errorMessage: `failure ${i}`,
        affectedNode: 'service:geo',
      } as ErrorEvent
      lines.push(JSON.stringify(ev))
    }
    await fs.writeFile(errorsPath, lines.join('\n') + '\n')
    const graph: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    app = await buildApi({ graph, errorsPath })
  })
  afterEach(async () => {
    await app.close()
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('without since, the limit returns the oldest slice', async () => {
    const res = await app.inject({ method: 'GET', url: '/incidents?limit=200' })
    const body = res.json() as { count: number; total: number; events: ErrorEvent[] }
    expect(body.total).toBe(300)
    expect(body.events.at(-1)!.errorMessage).toBe('failure 199')
  })

  it('since keeps only the incidents at or after it, before the limit', async () => {
    const since = new Date(Date.UTC(2026, 9, 17, 0, 0, 0) + 290 * 60_000).toISOString()
    const res = await app.inject({ method: 'GET', url: `/incidents?limit=200&since=${encodeURIComponent(since)}` })
    const body = res.json() as { count: number; total: number; events: ErrorEvent[] }
    expect(body.total).toBe(10)
    expect(body.events.map((e) => e.errorMessage)).toEqual(Array.from({ length: 10 }, (_, k) => `failure ${290 + k}`))
  })

  it('an unparseable since is a 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/incidents?since=yesterday' })
    expect(res.statusCode).toBe(400)
  })
})
