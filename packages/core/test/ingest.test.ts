import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  type ErrorEvent,
  type GraphEdge,
  type GraphNode,
  NodeType,
  Provenance,
} from '@neat.is/types'
import {
  handleSpan,
  markStaleEdges,
  promoteFrontierNodes,
  readErrorEvents,
  readStaleEvents,
  stitchTrace,
  thresholdForEdgeType,
  type IngestContext,
} from '../src/ingest.js'
import type { ParsedSpan } from '../src/otel.js'
import type { NeatGraph } from '../src/graph.js'

function newGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  g.addNode('service:service-a', {
    id: 'service:service-a',
    type: NodeType.ServiceNode,
    name: 'service-a',
    language: 'javascript',
  })
  g.addNode('service:service-b', {
    id: 'service:service-b',
    type: NodeType.ServiceNode,
    name: 'service-b',
    language: 'javascript',
  })
  g.addNode('database:payments-db', {
    id: 'database:payments-db',
    type: NodeType.DatabaseNode,
    name: 'neatdemo',
    engine: 'postgresql',
    engineVersion: '15',
    compatibleDrivers: [],
  })
  return g
}

function addExtractedEdges(g: NeatGraph): void {
  g.addEdgeWithKey(
    'CALLS:service:service-a->service:service-b',
    'service:service-a',
    'service:service-b',
    {
      id: 'CALLS:service:service-a->service:service-b',
      source: 'service:service-a',
      target: 'service:service-b',
      type: EdgeType.CALLS,
      provenance: Provenance.EXTRACTED,
    },
  )
  g.addEdgeWithKey(
    'CONNECTS_TO:service:service-b->database:payments-db',
    'service:service-b',
    'database:payments-db',
    {
      id: 'CONNECTS_TO:service:service-b->database:payments-db',
      source: 'service:service-b',
      target: 'database:payments-db',
      type: EdgeType.CONNECTS_TO,
      provenance: Provenance.EXTRACTED,
    },
  )
}

function clientHttpSpan(overrides: Partial<ParsedSpan> = {}): ParsedSpan {
  return {
    service: 'service-a',
    traceId: 'trace-1',
    spanId: 'span-a',
    name: 'GET /query',
    kind: 3,
    startTimeUnixNano: '0',
    endTimeUnixNano: '0',
    durationNanos: 0n,
    env: 'unknown',
    attributes: {
      'http.method': 'GET',
      'server.address': 'service-b',
      'server.port': 3001,
    },
    statusCode: 0,
    ...overrides,
  }
}

function dbSpan(overrides: Partial<ParsedSpan> = {}): ParsedSpan {
  return {
    service: 'service-b',
    traceId: 'trace-1',
    spanId: 'span-b',
    parentSpanId: 'span-a',
    name: 'pg.query',
    kind: 3,
    startTimeUnixNano: '0',
    endTimeUnixNano: '0',
    durationNanos: 0n,
    env: 'unknown',
    attributes: {
      'db.system': 'postgresql',
      'db.name': 'neatdemo',
      'server.address': 'payments-db',
    },
    dbSystem: 'postgresql',
    dbName: 'neatdemo',
    statusCode: 0,
    ...overrides,
  }
}

describe('handleSpan', () => {
  let tmpDir: string
  let ctx: IngestContext

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-ingest-'))
    ctx = {
      graph: newGraph(),
      errorsPath: path.join(tmpDir, 'errors.ndjson'),
    }
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('upserts an OBSERVED CALLS edge for a cross-service HTTP client span', async () => {
    await handleSpan(ctx, clientHttpSpan())
    const id = `${EdgeType.CALLS}:OBSERVED:service:service-a->service:service-b`
    expect(ctx.graph.hasEdge(id)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(id) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    expect(edge.callCount).toBe(1)
    // ADR-066 — confidence grades from the signal block. A single span lands
    // in the weak tier (< 1.0); 1.0 is reserved for the strong tier
    // (spanCount >= 100 + recent).
    expect(edge.confidence).toBeGreaterThan(0)
    expect(edge.confidence).toBeLessThan(1)
    expect(edge.lastObserved).toBeTruthy()
  })

  it('populates edge.signal with span and error counts', async () => {
    await handleSpan(ctx, clientHttpSpan())
    await handleSpan(ctx, clientHttpSpan({ spanId: 'span-a2' }))
    await handleSpan(
      ctx,
      clientHttpSpan({ spanId: 'span-a3', statusCode: 2, errorMessage: 'boom' }),
    )
    const id = `${EdgeType.CALLS}:OBSERVED:service:service-a->service:service-b`
    const edge = ctx.graph.getEdgeAttributes(id) as GraphEdge
    expect(edge.signal?.spanCount).toBe(3)
    expect(edge.signal?.errorCount).toBe(1)
    expect(edge.signal?.lastObservedAgeMs).toBe(0)
  })

  it('OBSERVED confidence grades higher with more spans (ADR-066 #2)', async () => {
    // 100 spans lands in the strong tier (~0.95+); 3 spans lands in the
    // weak tier (~0.4-0.5). The grading helper in @neat.is/types/confidence
    // is the single source of truth — this fixture proves the wiring.
    const lowCtx = ctx
    for (let i = 0; i < 3; i++) {
      await handleSpan(lowCtx, clientHttpSpan({ spanId: `low-${i}` }))
    }
    const lowId = `${EdgeType.CALLS}:OBSERVED:service:service-a->service:service-b`
    const lowConfidence = (lowCtx.graph.getEdgeAttributes(lowId) as GraphEdge).confidence!

    // Reset the same graph state by clearing the edge and replaying.
    lowCtx.graph.dropEdge(lowId)
    for (let i = 0; i < 100; i++) {
      await handleSpan(lowCtx, clientHttpSpan({ spanId: `high-${i}` }))
    }
    const highConfidence = (lowCtx.graph.getEdgeAttributes(lowId) as GraphEdge).confidence!

    expect(highConfidence).toBeGreaterThan(lowConfidence)
    expect(highConfidence).toBeGreaterThanOrEqual(0.95)
  })

  it('OBSERVED confidence drops when error ratio climbs (ADR-066 #2)', async () => {
    // 5 clean spans vs 5 spans with 2 errors. Clean grades higher.
    for (let i = 0; i < 5; i++) {
      await handleSpan(ctx, clientHttpSpan({ spanId: `clean-${i}` }))
    }
    const id = `${EdgeType.CALLS}:OBSERVED:service:service-a->service:service-b`
    const cleanConfidence = (ctx.graph.getEdgeAttributes(id) as GraphEdge).confidence!

    ctx.graph.dropEdge(id)
    for (let i = 0; i < 5; i++) {
      const isError = i < 2
      await handleSpan(
        ctx,
        clientHttpSpan({
          spanId: `err-${i}`,
          ...(isError ? { statusCode: 2, exception: { message: 'boom' } } : {}),
        }),
      )
    }
    const erroringConfidence = (ctx.graph.getEdgeAttributes(id) as GraphEdge).confidence!
    expect(erroringConfidence).toBeLessThan(cleanConfidence)
  })

  it('increments callCount on repeat observations without duplicating the edge', async () => {
    await handleSpan(ctx, clientHttpSpan())
    await handleSpan(ctx, clientHttpSpan({ spanId: 'span-a2' }))
    await handleSpan(ctx, clientHttpSpan({ spanId: 'span-a3' }))
    const id = `${EdgeType.CALLS}:OBSERVED:service:service-a->service:service-b`
    expect(ctx.graph.hasEdge(id)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(id) as GraphEdge
    expect(edge.callCount).toBe(3)
    // No duplicate edges.
    const keys: string[] = []
    ctx.graph.forEachEdge((k) => keys.push(k))
    expect(keys.filter((k) => k.startsWith(`${EdgeType.CALLS}:OBSERVED:`))).toHaveLength(1)
  })

  it('upserts an OBSERVED CONNECTS_TO edge for a database span', async () => {
    await handleSpan(ctx, dbSpan())
    const id = `${EdgeType.CONNECTS_TO}:OBSERVED:service:service-b->database:payments-db`
    expect(ctx.graph.hasEdge(id)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(id) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    expect(edge.callCount).toBe(1)
  })

  it('falls back to net.peer.name when server.address is missing', async () => {
    const span = dbSpan({
      attributes: {
        'db.system': 'postgresql',
        'db.name': 'neatdemo',
        'net.peer.name': 'payments-db',
      },
    })
    await handleSpan(ctx, span)
    expect(
      ctx.graph.hasEdge(`${EdgeType.CONNECTS_TO}:OBSERVED:service:service-b->database:payments-db`),
    ).toBe(true)
  })

  it('parses host out of url.full when peer attrs are absent', async () => {
    const span = clientHttpSpan({
      attributes: {
        'http.method': 'GET',
        'url.full': 'http://service-b:3001/query',
      },
    })
    await handleSpan(ctx, span)
    expect(
      ctx.graph.hasEdge(`${EdgeType.CALLS}:OBSERVED:service:service-a->service:service-b`),
    ).toBe(true)
  })

  it('emits an OBSERVED edge to a FrontierNode placeholder when the span peer matches no service node (ADR-068)', async () => {
    await handleSpan(
      ctx,
      clientHttpSpan({ attributes: { 'server.address': 'payments-api.cluster.local' } }),
    )

    expect(ctx.graph.hasNode('frontier:payments-api.cluster.local')).toBe(true)
    const frontier = ctx.graph.getNodeAttributes(
      'frontier:payments-api.cluster.local',
    ) as { type: string; host: string; firstObserved?: string }
    expect(frontier.type).toBe(NodeType.FrontierNode)
    expect(frontier.host).toBe('payments-api.cluster.local')
    expect(frontier.firstObserved).toBeTruthy()

    const observedFrontierEdgeId = `${EdgeType.CALLS}:OBSERVED:service:service-a->frontier:payments-api.cluster.local`
    expect(ctx.graph.hasEdge(observedFrontierEdgeId)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(observedFrontierEdgeId) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    expect(edge.callCount).toBe(1)
    expect(edge.signal).toBeDefined()
    expect(edge.signal!.spanCount).toBe(1)
    expect(edge.signal!.errorCount).toBe(0)
    expect(typeof edge.confidence).toBe('number')
  })

  it('resolves a span peer through ServiceNode.aliases', async () => {
    ctx.graph.replaceNodeAttributes('service:service-b', {
      ...(ctx.graph.getNodeAttributes('service:service-b') as Record<string, unknown>),
      aliases: ['payments-api.cluster.local'],
    })
    await handleSpan(
      ctx,
      clientHttpSpan({ attributes: { 'server.address': 'payments-api.cluster.local' } }),
    )
    expect(
      ctx.graph.hasEdge(`${EdgeType.CALLS}:OBSERVED:service:service-a->service:service-b`),
    ).toBe(true)
    expect(ctx.graph.hasNode('frontier:payments-api.cluster.local')).toBe(false)
  })

  it('does not touch a pre-existing EXTRACTED edge between the same services', async () => {
    const staticId = `${EdgeType.CALLS}:service:service-a->service:service-b`
    ctx.graph.addEdgeWithKey(staticId, 'service:service-a', 'service:service-b', {
      id: staticId,
      source: 'service:service-a',
      target: 'service:service-b',
      type: EdgeType.CALLS,
      provenance: Provenance.EXTRACTED,
    })
    await handleSpan(ctx, clientHttpSpan())
    const staticEdge = ctx.graph.getEdgeAttributes(staticId) as GraphEdge
    expect(staticEdge.provenance).toBe(Provenance.EXTRACTED)
    expect(staticEdge.callCount).toBeUndefined()
    expect(
      ctx.graph.hasEdge(`${EdgeType.CALLS}:OBSERVED:service:service-a->service:service-b`),
    ).toBe(true)
  })

  it('writes an ErrorEvent line to the ndjson file when status.code === 2', async () => {
    await handleSpan(
      ctx,
      dbSpan({
        statusCode: 2,
        // ADR-068 follow-up — errorMessage reads exception.message per OTel
        // semconv; the polluted status.message fallback is gone, so the
        // exception event has to carry the actual error string.
        exception: { message: 'SASL: SCRAM-SERVER-FIRST-MESSAGE' },
      }),
    )
    const events = await readErrorEvents(ctx.errorsPath)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      service: 'service-b',
      traceId: 'trace-1',
      spanId: 'span-b',
      affectedNode: 'database:payments-db',
      errorMessage: expect.stringContaining('SCRAM'),
    } as ErrorEvent)
  })

  it('preserves span attributes on the ErrorEvent (ADR-068 follow-up)', async () => {
    await handleSpan(
      ctx,
      dbSpan({
        statusCode: 2,
        exception: { message: 'boom' },
        attributes: {
          'db.system': 'postgresql',
          'db.name': 'neatdemo',
          'server.address': 'payments-db',
          'code.filepath': 'src/payment.ts',
          'code.lineno': 84,
          'code.function': 'processPayment',
        },
      }),
    )
    const events = await readErrorEvents(ctx.errorsPath)
    expect(events).toHaveLength(1)
    const ev = events[0]!
    expect(ev.attributes).toBeDefined()
    expect(ev.attributes!['code.filepath']).toBe('src/payment.ts')
    expect(ev.attributes!['code.lineno']).toBe(84)
    expect(ev.attributes!['code.function']).toBe('processPayment')
  })

  it('errorMessage prefers exception.message over span.name; ignores status.message (ADR-068 follow-up)', async () => {
    // Mirror the NEAT-BUG-11 reproduction: OTel auto-instrumentation can
    // surface the HTTP method in status.message for HTTP server errors.
    // The receiver must read exception.message, not span.errorMessage.
    await handleSpan(
      ctx,
      dbSpan({
        statusCode: 2,
        errorMessage: 'GET', // polluted status.message
        name: 'POST /payments',
        exception: { message: 'synthetic failure (counter=3)' },
      }),
    )
    const events = await readErrorEvents(ctx.errorsPath)
    expect(events).toHaveLength(1)
    expect(events[0]!.errorMessage).toBe('synthetic failure (counter=3)')
  })

  it('errorMessage falls back to literal `unknown error`, never span.name (issue #285)', async () => {
    // No exception event — the field reads the literal 'unknown error' so
    // the schema's required-string contract holds. span.name is reserved for
    // OTel HTTP server instrumentation's request-method payload and stays
    // out of the chain. status.message (the auto-instrumentation pollution
    // from NEAT-BUG-11) is also out.
    await handleSpan(
      ctx,
      dbSpan({
        statusCode: 2,
        errorMessage: 'GET', // polluted status.message
        name: 'pg.query',
      }),
    )
    const events = await readErrorEvents(ctx.errorsPath)
    expect(events).toHaveLength(1)
    expect(events[0]!.errorMessage).toBe('unknown error')
    expect(events[0]!.errorMessage).not.toBe('pg.query')
  })

  it('does not log an ErrorEvent for a successful span', async () => {
    await handleSpan(ctx, clientHttpSpan())
    expect(await readErrorEvents(ctx.errorsPath)).toEqual([])
  })
})

describe('markStaleEdges', () => {
  it('demotes OBSERVED edges whose lastObserved is older than the threshold to STALE', async () => {
    const graph = newGraph()
    const fresh = new Date()
    const old = new Date(fresh.getTime() - 25 * 60 * 60 * 1000)
    graph.addEdgeWithKey(
      'CALLS:OBSERVED:service:service-a->service:service-b',
      'service:service-a',
      'service:service-b',
      {
        id: 'CALLS:OBSERVED:service:service-a->service:service-b',
        source: 'service:service-a',
        target: 'service:service-b',
        type: EdgeType.CALLS,
        provenance: Provenance.OBSERVED,
        lastObserved: old.toISOString(),
        callCount: 7,
        confidence: 1,
      },
    )
    graph.addEdgeWithKey(
      'CONNECTS_TO:OBSERVED:service:service-b->database:payments-db',
      'service:service-b',
      'database:payments-db',
      {
        id: 'CONNECTS_TO:OBSERVED:service:service-b->database:payments-db',
        source: 'service:service-b',
        target: 'database:payments-db',
        type: EdgeType.CONNECTS_TO,
        provenance: Provenance.OBSERVED,
        lastObserved: fresh.toISOString(),
        callCount: 3,
        confidence: 1,
      },
    )
    const result = await markStaleEdges(graph, {
      thresholds: {
        CALLS: 24 * 60 * 60 * 1000,
        CONNECTS_TO: 24 * 60 * 60 * 1000,
      },
      now: fresh.getTime(),
    })
    expect(result.count).toBe(1)
    const stale = graph.getEdgeAttributes('CALLS:OBSERVED:service:service-a->service:service-b') as GraphEdge
    expect(stale.provenance).toBe(Provenance.STALE)
    expect(stale.confidence).toBe(0.3)
    const still = graph.getEdgeAttributes(
      'CONNECTS_TO:OBSERVED:service:service-b->database:payments-db',
    ) as GraphEdge
    expect(still.provenance).toBe(Provenance.OBSERVED)
  })

  it('leaves EXTRACTED edges alone', async () => {
    const graph = newGraph()
    graph.addEdgeWithKey(
      'CALLS:service:service-a->service:service-b',
      'service:service-a',
      'service:service-b',
      {
        id: 'CALLS:service:service-a->service:service-b',
        source: 'service:service-a',
        target: 'service:service-b',
        type: EdgeType.CALLS,
        provenance: Provenance.EXTRACTED,
      },
    )
    const result = await markStaleEdges(graph, { thresholds: { CALLS: 0 } })
    expect(result.count).toBe(0)
  })

  it('uses per-edge-type defaults: CALLS goes stale faster than CONNECTS_TO', async () => {
    const graph = newGraph()
    const now = new Date('2026-05-02T12:00:00.000Z').getTime()
    const ninetyMinAgo = new Date(now - 90 * 60 * 1000).toISOString()

    graph.addEdgeWithKey(
      'CALLS:OBSERVED:service:service-a->service:service-b',
      'service:service-a',
      'service:service-b',
      {
        id: 'CALLS:OBSERVED:service:service-a->service:service-b',
        source: 'service:service-a',
        target: 'service:service-b',
        type: EdgeType.CALLS,
        provenance: Provenance.OBSERVED,
        lastObserved: ninetyMinAgo,
      },
    )
    graph.addEdgeWithKey(
      'CONNECTS_TO:OBSERVED:service:service-b->database:payments-db',
      'service:service-b',
      'database:payments-db',
      {
        id: 'CONNECTS_TO:OBSERVED:service:service-b->database:payments-db',
        source: 'service:service-b',
        target: 'database:payments-db',
        type: EdgeType.CONNECTS_TO,
        provenance: Provenance.OBSERVED,
        lastObserved: ninetyMinAgo,
      },
    )

    const result = await markStaleEdges(graph, { now })
    expect(result.count).toBe(1)
    expect(
      (graph.getEdgeAttributes(
        'CALLS:OBSERVED:service:service-a->service:service-b',
      ) as GraphEdge).provenance,
    ).toBe(Provenance.STALE)
    // CONNECTS_TO threshold is 4h by default — 90 min isn't long enough.
    expect(
      (graph.getEdgeAttributes(
        'CONNECTS_TO:OBSERVED:service:service-b->database:payments-db',
      ) as GraphEdge).provenance,
    ).toBe(Provenance.OBSERVED)
  })

  it('appends a StaleEvent to the log on transition', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-stale-'))
    const staleEventsPath = path.join(tmpDir, 'stale-events.ndjson')
    try {
      const graph = newGraph()
      const now = new Date('2026-05-02T12:00:00.000Z').getTime()
      graph.addEdgeWithKey(
        'CALLS:OBSERVED:service:service-a->service:service-b',
        'service:service-a',
        'service:service-b',
        {
          id: 'CALLS:OBSERVED:service:service-a->service:service-b',
          source: 'service:service-a',
          target: 'service:service-b',
          type: EdgeType.CALLS,
          provenance: Provenance.OBSERVED,
          lastObserved: new Date(now - 90 * 60 * 1000).toISOString(),
        },
      )
      const { events } = await markStaleEdges(graph, { now, staleEventsPath })
      expect(events).toHaveLength(1)
      const persisted = await readStaleEvents(staleEventsPath)
      expect(persisted).toHaveLength(1)
      expect(persisted[0].edgeType).toBe(EdgeType.CALLS)
      expect(persisted[0].thresholdMs).toBe(60 * 60 * 1000)
      expect(persisted[0].source).toBe('service:service-a')
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('thresholdForEdgeType', () => {
  const originalEnv = process.env.NEAT_STALE_THRESHOLDS
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.NEAT_STALE_THRESHOLDS
    else process.env.NEAT_STALE_THRESHOLDS = originalEnv
  })

  it('returns the per-edge-type default when no override is set', () => {
    expect(thresholdForEdgeType('CALLS')).toBe(60 * 60 * 1000)
    expect(thresholdForEdgeType('CONNECTS_TO')).toBe(4 * 60 * 60 * 1000)
    expect(thresholdForEdgeType('DEPENDS_ON')).toBe(24 * 60 * 60 * 1000)
  })

  it('applies NEAT_STALE_THRESHOLDS overrides', () => {
    process.env.NEAT_STALE_THRESHOLDS = JSON.stringify({ CALLS: 5 * 60 * 1000 })
    expect(thresholdForEdgeType('CALLS')).toBe(5 * 60 * 1000)
    // Unaffected types keep their defaults.
    expect(thresholdForEdgeType('CONNECTS_TO')).toBe(4 * 60 * 60 * 1000)
  })

  it('falls back to the default map when the env var is malformed JSON', () => {
    process.env.NEAT_STALE_THRESHOLDS = 'not-json'
    expect(thresholdForEdgeType('CALLS')).toBe(60 * 60 * 1000)
  })
})

describe('readErrorEvents', () => {
  it('returns [] when the file does not exist yet', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-ingest-read-'))
    expect(await readErrorEvents(path.join(tmpDir, 'absent.ndjson'))).toEqual([])
    await fs.rm(tmpDir, { recursive: true, force: true })
  })
})

describe('stitchTrace', () => {
  it('writes INFERRED twins of EXTRACTED outgoing edges within depth 2', () => {
    const graph = newGraph()
    addExtractedEdges(graph)
    stitchTrace(graph, 'service:service-a', '2026-05-01T00:00:00.000Z')

    const callsId = `${EdgeType.CALLS}:INFERRED:service:service-a->service:service-b`
    const connectsId = `${EdgeType.CONNECTS_TO}:INFERRED:service:service-b->database:payments-db`
    expect(graph.hasEdge(callsId)).toBe(true)
    expect(graph.hasEdge(connectsId)).toBe(true)

    const calls = graph.getEdgeAttributes(callsId) as GraphEdge
    expect(calls.provenance).toBe(Provenance.INFERRED)
    expect(calls.confidence).toBe(0.6)
    expect(calls.lastObserved).toBe('2026-05-01T00:00:00.000Z')
    const connects = graph.getEdgeAttributes(connectsId) as GraphEdge
    expect(connects.confidence).toBe(0.6)
  })

  it('refreshes lastObserved on re-stitch without duplicating the edge', () => {
    const graph = newGraph()
    addExtractedEdges(graph)
    stitchTrace(graph, 'service:service-b', '2026-05-01T00:00:00.000Z')
    stitchTrace(graph, 'service:service-b', '2026-05-01T01:00:00.000Z')

    const id = `${EdgeType.CONNECTS_TO}:INFERRED:service:service-b->database:payments-db`
    const edge = graph.getEdgeAttributes(id) as GraphEdge
    expect(edge.lastObserved).toBe('2026-05-01T01:00:00.000Z')

    let count = 0
    graph.forEachEdge((k) => {
      if (k === id) count++
    })
    expect(count).toBe(1)
  })

  it('does not promote OBSERVED edges to INFERRED twins', () => {
    const graph = newGraph()
    graph.addEdgeWithKey(
      'CALLS:OBSERVED:service:service-a->service:service-b',
      'service:service-a',
      'service:service-b',
      {
        id: 'CALLS:OBSERVED:service:service-a->service:service-b',
        source: 'service:service-a',
        target: 'service:service-b',
        type: EdgeType.CALLS,
        provenance: Provenance.OBSERVED,
        confidence: 1.0,
        lastObserved: '2026-05-01T00:00:00.000Z',
        callCount: 5,
      },
    )
    stitchTrace(graph, 'service:service-a', '2026-05-01T00:00:00.000Z')

    expect(
      graph.hasEdge(`${EdgeType.CALLS}:INFERRED:service:service-a->service:service-b`),
    ).toBe(false)
  })

  it('respects the depth-2 ceiling', () => {
    const graph = newGraph()
    graph.addNode('service:service-c', {
      id: 'service:service-c',
      type: NodeType.ServiceNode,
      name: 'service-c',
      language: 'javascript',
    })
    addExtractedEdges(graph)
    // service-b -> service-c extends the chain to depth 3 from service-a.
    graph.addEdgeWithKey(
      'CALLS:service:service-b->service:service-c',
      'service:service-b',
      'service:service-c',
      {
        id: 'CALLS:service:service-b->service:service-c',
        source: 'service:service-b',
        target: 'service:service-c',
        type: EdgeType.CALLS,
        provenance: Provenance.EXTRACTED,
      },
    )
    stitchTrace(graph, 'service:service-a', '2026-05-01T00:00:00.000Z')

    // Depth 1: service-a -> service-b. Depth 2: service-b -> service-c, service-b -> payments-db.
    // Anything past service-b's outbound is depth >= 3 and shouldn't be stitched.
    expect(
      graph.hasEdge(`${EdgeType.CALLS}:INFERRED:service:service-a->service:service-b`),
    ).toBe(true)
    expect(
      graph.hasEdge(`${EdgeType.CALLS}:INFERRED:service:service-b->service:service-c`),
    ).toBe(true)
    expect(
      graph.hasEdge(`${EdgeType.CONNECTS_TO}:INFERRED:service:service-b->database:payments-db`),
    ).toBe(true)
  })

  it('is a no-op for an unknown source service', () => {
    const graph = newGraph()
    addExtractedEdges(graph)
    stitchTrace(graph, 'service:does-not-exist', '2026-05-01T00:00:00.000Z')

    let inferred = 0
    graph.forEachEdge((k) => {
      if (k.includes(':INFERRED:')) inferred++
    })
    expect(inferred).toBe(0)
  })

  it('runs from handleSpan when a span has statusCode === 2 and honors the OBSERVED-twin-skip rule', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-stitch-'))
    const graph = newGraph()
    addExtractedEdges(graph)
    const ctx: IngestContext = {
      graph,
      errorsPath: path.join(tmpDir, 'errors.ndjson'),
    }
    await handleSpan(
      ctx,
      dbSpan({ statusCode: 2, errorMessage: 'SASL: SCRAM-SERVER-FIRST-MESSAGE' }),
    )

    // handleSpan wrote an OBSERVED CONNECTS_TO and then invoked stitchTrace
    // from service:service-b. The stitcher walked outbound EXTRACTED edges,
    // saw the OBSERVED twin for service-b → payments-db, and skipped the hop
    // per ADR-034. So the OBSERVED edge is present and no INFERRED twin was
    // created — that's the proof both halves of the integration ran correctly.
    expect(
      graph.hasEdge(`${EdgeType.CONNECTS_TO}:OBSERVED:service:service-b->database:payments-db`),
    ).toBe(true)
    expect(
      graph.hasEdge(`${EdgeType.CONNECTS_TO}:INFERRED:service:service-b->database:payments-db`),
    ).toBe(false)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })
})

describe('promoteFrontierNodes', () => {
  it('replaces a frontier node once a service records its host as an alias', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-frontier-'))
    const graph = newGraph()
    const ctx: IngestContext = { graph, errorsPath: path.join(tmpDir, 'errors.ndjson') }

    await handleSpan(
      ctx,
      clientHttpSpan({ attributes: { 'server.address': 'payments-api.cluster.local' } }),
    )
    expect(graph.hasNode('frontier:payments-api.cluster.local')).toBe(true)

    graph.replaceNodeAttributes('service:service-b', {
      ...(graph.getNodeAttributes('service:service-b') as Record<string, unknown>),
      aliases: ['payments-api.cluster.local'],
    })

    const promoted = promoteFrontierNodes(graph)
    expect(promoted).toBe(1)
    expect(graph.hasNode('frontier:payments-api.cluster.local')).toBe(false)

    const promotedEdgeId = `${EdgeType.CALLS}:OBSERVED:service:service-a->service:service-b`
    expect(graph.hasEdge(promotedEdgeId)).toBe(true)
    const edge = graph.getEdgeAttributes(promotedEdgeId) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    expect(edge.callCount).toBe(1)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('merges with an existing OBSERVED edge if one already targets the service', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-frontier-merge-'))
    const graph = newGraph()
    const ctx: IngestContext = { graph, errorsPath: path.join(tmpDir, 'errors.ndjson') }

    await handleSpan(ctx, clientHttpSpan())
    await handleSpan(
      ctx,
      clientHttpSpan({
        spanId: 'span-a2',
        attributes: { 'server.address': 'payments-api.cluster.local' },
      }),
    )

    graph.replaceNodeAttributes('service:service-b', {
      ...(graph.getNodeAttributes('service:service-b') as Record<string, unknown>),
      aliases: ['payments-api.cluster.local'],
    })
    promoteFrontierNodes(graph)

    const id = `${EdgeType.CALLS}:OBSERVED:service:service-a->service:service-b`
    const edge = graph.getEdgeAttributes(id) as GraphEdge
    expect(edge.callCount).toBe(2)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('leaves a frontier alone if no alias matches yet', () => {
    const graph = newGraph()
    graph.addNode('frontier:unknown', {
      id: 'frontier:unknown',
      type: NodeType.FrontierNode,
      name: 'unknown',
      host: 'unknown',
    })
    expect(promoteFrontierNodes(graph)).toBe(0)
    expect(graph.hasNode('frontier:unknown')).toBe(true)
  })
})
