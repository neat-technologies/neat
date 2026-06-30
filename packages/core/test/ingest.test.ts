import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  type ErrorEvent,
  fileId,
  type GraphEdge,
  type GraphNode,
  NodeType,
  Provenance,
} from '@neat.is/types'
import { ensureFileNode } from '../src/extract/calls/shared.js'
import {
  buildErrorEventForReceiver,
  handleSpan,
  markStaleEdges,
  promoteFrontierNodes,
  readErrorEvents,
  readStaleEvents,
  resetParentSpanCache,
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

// The durable incident the daemon receiver writes (buildErrorEventForReceiver).
// An Express error handler that answers 500 cleanly leaves the span with no
// exception event but with the HTTP context and a `code.filepath` call site —
// the record must read those, not collapse to 'unknown error' on the bare
// service (#584).
describe('buildErrorEventForReceiver — file-grain + HTTP-context fallback (#584)', () => {
  function serverErrorSpan(overrides: Partial<ParsedSpan> = {}): ParsedSpan {
    return {
      service: 'harvest-api',
      traceId: 'trace-7',
      spanId: 'span-7',
      name: 'GET /users/:id',
      kind: 2, // SERVER
      startTimeUnixNano: '0',
      endTimeUnixNano: '0',
      durationNanos: 0n,
      env: 'unknown',
      startTimeIso: '2026-06-30T12:00:00.000Z',
      attributes: {
        'http.request.method': 'GET',
        'http.route': '/users/:id',
        'http.response.status_code': 500,
        'code.filepath': 'src/index.js',
        'code.lineno': 22,
      },
      statusCode: 2,
      ...overrides,
    }
  }

  it('attributes to the file node and builds a message from the route + status', () => {
    const ev = buildErrorEventForReceiver(serverErrorSpan())
    expect(ev).not.toBeNull()
    expect(ev!.errorMessage).toBe('500 on GET /users/:id')
    expect(ev!.affectedNode).toBe('file:harvest-api:src/index.js')
    expect(ev!.attributes!['code.filepath']).toBe('src/index.js')
    expect(ev!.attributes!['code.lineno']).toBe(22)
    expect(ev!.attributes!['http.route']).toBe('/users/:id')
  })

  it('prefers a real exception message when the span carries one', () => {
    const ev = buildErrorEventForReceiver(
      serverErrorSpan({ exception: { message: 'TypeError: cannot read id of undefined' } }),
    )
    expect(ev!.errorMessage).toBe('TypeError: cannot read id of undefined')
    // File grain still applies.
    expect(ev!.affectedNode).toBe('file:harvest-api:src/index.js')
  })

  it('falls back to the originating service and `unknown error` with no HTTP/code context', () => {
    const ev = buildErrorEventForReceiver(
      serverErrorSpan({ attributes: { 'db.system': 'postgresql' } }),
    )
    expect(ev!.errorMessage).toBe('unknown error')
    expect(ev!.affectedNode).toBe('service:harvest-api')
  })
})

// Failing-response incidents (issue #481). OTel leaves a CLIENT span's status
// UNSET on a 4xx/5xx response, so the statusCode === 2 path never sees a
// service whose outbound calls are failing en masse. These cover the new
// response-code path: 5xx records immediately, a 4xx burst coalesces into one
// incident, and a lone 4xx records nothing.
describe('handleSpan — failing-response incidents (#481)', () => {
  let tmpDir: string
  let ctx: IngestContext

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-incident-'))
    ctx = {
      graph: newGraph(),
      errorsPath: path.join(tmpDir, 'errors.ndjson'),
    }
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // A 404 CLIENT span against one peer, no ERROR status, no exception event.
  function clientFailSpan(status: number, overrides: Partial<ParsedSpan> = {}): ParsedSpan {
    return clientHttpSpan({
      attributes: {
        'http.method': 'GET',
        'server.address': 'service-b',
        'http.response.status_code': status,
      },
      ...overrides,
    })
  }

  it('coalesces a burst of 5+ consecutive 404s against one peer into one incident', async () => {
    for (let i = 0; i < 6; i++) {
      await handleSpan(
        ctx,
        clientFailSpan(404, { spanId: `burst-${i}`, startTimeIso: `2026-06-08T00:00:0${i}.000Z` }),
      )
    }
    const events = await readErrorEvents(ctx.errorsPath)
    // Threshold is 5: the 5th span flushes one incident; the 6th starts a new
    // (still-open) burst that hasn't reached threshold, so still exactly one.
    expect(events).toHaveLength(1)
    expect(events[0]!.incidentCount).toBe(5)
    expect(events[0]!.httpStatusCode).toBe(404)
    expect(events[0]!.errorType).toBe('http-failure')
    expect(events[0]!.firstTimestamp).toBe('2026-06-08T00:00:00.000Z')
    expect(events[0]!.lastTimestamp).toBe('2026-06-08T00:00:04.000Z')
  })

  it('reports the dominant status code across a mixed 4xx burst', async () => {
    // 404, 404, 404, 401, 404 → 404 dominates (4 of 5).
    const codes = [404, 404, 404, 401, 404]
    for (let i = 0; i < codes.length; i++) {
      await handleSpan(ctx, clientFailSpan(codes[i]!, { spanId: `mix-${i}` }))
    }
    const events = await readErrorEvents(ctx.errorsPath)
    expect(events).toHaveLength(1)
    expect(events[0]!.incidentCount).toBe(5)
    expect(events[0]!.httpStatusCode).toBe(404)
  })

  it('does not coalesce a lone 404 into an incident', async () => {
    await handleSpan(ctx, clientFailSpan(404))
    expect(await readErrorEvents(ctx.errorsPath)).toEqual([])
  })

  it('records an incident immediately for a single 5xx (no ERROR status, no exception)', async () => {
    await handleSpan(ctx, clientFailSpan(503, { spanId: 'five-oh-three' }))
    const events = await readErrorEvents(ctx.errorsPath)
    expect(events).toHaveLength(1)
    expect(events[0]!.httpStatusCode).toBe(503)
    expect(events[0]!.incidentCount).toBe(1)
    expect(events[0]!.errorType).toBe('http-failure')
  })

  it('still records an exception-event incident (pins existing behavior)', async () => {
    await handleSpan(
      ctx,
      clientHttpSpan({
        statusCode: 2,
        exception: { message: 'connect ECONNREFUSED' },
      }),
    )
    const events = await readErrorEvents(ctx.errorsPath)
    expect(events).toHaveLength(1)
    expect(events[0]!.errorMessage).toContain('ECONNREFUSED')
  })

  it('does not double-record a 5xx that also carries ERROR status', async () => {
    // statusCode === 2 path already records it; the 5xx path is skipped so the
    // incident isn't written twice.
    await handleSpan(
      ctx,
      clientFailSpan(500, { statusCode: 2, exception: { message: 'boom' } }),
    )
    const events = await readErrorEvents(ctx.errorsPath)
    expect(events).toHaveLength(1)
  })

  it('starts a fresh burst when a 4xx falls outside the window', async () => {
    let clock = 1_000_000
    ctx.now = () => clock
    // Four 404s inside the window, then a long pause resets the burst before it
    // reaches the threshold of 5 — nothing flushes.
    for (let i = 0; i < 4; i++) {
      clock += 1_000
      await handleSpan(ctx, clientFailSpan(404, { spanId: `pre-${i}` }))
    }
    clock += 120_000 // > 60s window
    await handleSpan(ctx, clientFailSpan(404, { spanId: 'after-gap' }))
    expect(await readErrorEvents(ctx.errorsPath)).toEqual([])
  })

  it('does not coalesce 4xx on a SERVER span (callee side, not the failing caller)', async () => {
    // kind 2 = SERVER. A 4xx the service *returned* isn't the same signal as a
    // 4xx its outbound CLIENT call *received*; only the caller side coalesces.
    for (let i = 0; i < 6; i++) {
      await handleSpan(ctx, clientFailSpan(404, { spanId: `srv-${i}`, kind: 2 }))
    }
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

// Issue #429 — only CLIENT / PRODUCER spans mint an OBSERVED edge from the peer
// address. INTERNAL spans (e.g. `tcp.connect` / `tls.connect` to a cloud
// endpoint) carry a `peer.address` but are not a cross-service call, so they
// must not mint a service-level edge. The kind here is the OTLP wire value
// (INTERNAL 1, SERVER 2, CLIENT 3, PRODUCER 4, CONSUMER 5) — the value the
// receiver puts on ParsedSpan.kind, offset by one from @opentelemetry/api.
describe('handleSpan kind-gate (issue #429)', () => {
  let tmpDir: string
  let ctx: IngestContext

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-kind-'))
    ctx = { graph: newGraph(), errorsPath: path.join(tmpDir, 'errors.ndjson') }
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function callsEdgeCount(): number {
    let n = 0
    ctx.graph.forEachEdge((_id, attrs) => {
      const e = attrs as GraphEdge
      if (e.type === EdgeType.CALLS && e.provenance === Provenance.OBSERVED) n++
    })
    return n
  }

  // The SQS leak the smoke caught: an INTERNAL connection span to a resolvable
  // cloud endpoint. No edge, no FrontierNode placeholder.
  it('mints nothing for an INTERNAL span with a resolvable peer address', async () => {
    await handleSpan(
      ctx,
      clientHttpSpan({
        kind: 1,
        attributes: { 'net.peer.name': 'sqs.us-east-1.amazonaws.com' },
      }),
    )
    expect(callsEdgeCount()).toBe(0)
    expect(ctx.graph.hasNode('frontier:sqs.us-east-1.amazonaws.com')).toBe(false)
  })

  it('mints one CALLS edge for the same shape as a CLIENT span', async () => {
    await handleSpan(
      ctx,
      clientHttpSpan({
        kind: 3,
        attributes: { 'net.peer.name': 'sqs.us-east-1.amazonaws.com' },
      }),
    )
    expect(callsEdgeCount()).toBe(1)
    expect(ctx.graph.hasNode('frontier:sqs.us-east-1.amazonaws.com')).toBe(true)
  })

  it('mints one CALLS edge for a PRODUCER span (queue send)', async () => {
    await handleSpan(
      ctx,
      clientHttpSpan({
        kind: 4,
        attributes: { 'net.peer.name': 'sqs.us-east-1.amazonaws.com' },
      }),
    )
    expect(callsEdgeCount()).toBe(1)
  })

  it('does not mint a CONNECTS_TO edge for an INTERNAL db span', async () => {
    await handleSpan(ctx, dbSpan({ kind: 1 }))
    let connects = 0
    ctx.graph.forEachEdge((_id, attrs) => {
      const e = attrs as GraphEdge
      if (e.type === EdgeType.CONNECTS_TO && e.provenance === Provenance.OBSERVED) connects++
    })
    expect(connects).toBe(0)
  })
})

// Issue #395 — OBSERVED edges carry evidence and originate from a FileNode when
// a span carries code.* semconv (file-awareness.md §4 + §6).
describe('handleSpan code.* evidence (issue #395)', () => {
  let tmpDir: string
  let ctx: IngestContext

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-code-star-'))
    ctx = { graph: newGraph(), errorsPath: path.join(tmpDir, 'errors.ndjson') }
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('sets evidence.file and evidence.line on the OBSERVED edge when code.* attrs are present', async () => {
    await handleSpan(
      ctx,
      clientHttpSpan({
        attributes: {
          'server.address': 'service-b',
          'code.filepath': 'src/client.ts',
          'code.lineno': 42,
          'code.function': 'callServiceB',
        },
      }),
    )
    // The edge source is now a FileNode id, not the service id.
    const fileNodeId = 'file:service-a:src/client.ts'
    expect(ctx.graph.hasNode(fileNodeId)).toBe(true)
    const fileNode = ctx.graph.getNodeAttributes(fileNodeId) as { type: string; path: string }
    expect(fileNode.type).toBe(NodeType.FileNode)
    expect(fileNode.path).toBe('src/client.ts')

    // The OBSERVED edge originates from the FileNode.
    const edgeId = `${EdgeType.CALLS}:OBSERVED:${fileNodeId}->service:service-b`
    expect(ctx.graph.hasEdge(edgeId)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    expect(edge.source).toBe(fileNodeId)
    expect(edge.evidence).toBeDefined()
    expect(edge.evidence!.file).toBe('src/client.ts')
    expect(edge.evidence!.line).toBe(42)
  })

  it('creates a CONTAINS edge from the service to the FileNode', async () => {
    await handleSpan(
      ctx,
      clientHttpSpan({
        attributes: {
          'server.address': 'service-b',
          'code.filepath': 'src/client.ts',
          'code.lineno': 42,
        },
      }),
    )
    const fileNodeId = 'file:service-a:src/client.ts'
    // A CONTAINS edge connects service:service-a → file:service-a:src/client.ts
    let containsFound = false
    ctx.graph.forEachEdge((_id, attrs) => {
      const e = attrs as GraphEdge
      if (
        e.type === EdgeType.CONTAINS &&
        e.source === 'service:service-a' &&
        e.target === fileNodeId
      ) {
        containsFound = true
      }
    })
    expect(containsFound).toBe(true)
  })

  it('sets no evidence and source stays as the service node when code.* is absent', async () => {
    await handleSpan(ctx, clientHttpSpan())
    const edgeId = `${EdgeType.CALLS}:OBSERVED:service:service-a->service:service-b`
    expect(ctx.graph.hasEdge(edgeId)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.source).toBe('service:service-a')
    expect(edge.evidence).toBeUndefined()
    // No FileNode was created.
    let fileNodeCount = 0
    ctx.graph.forEachNode((_id, attrs) => {
      if ((attrs as { type: string }).type === NodeType.FileNode) fileNodeCount++
    })
    expect(fileNodeCount).toBe(0)
  })

  it('sets evidence on CONNECTS_TO edges for db spans carrying code.*', async () => {
    await handleSpan(
      ctx,
      dbSpan({
        attributes: {
          'db.system': 'postgresql',
          'db.name': 'neatdemo',
          'server.address': 'payments-db',
          'code.filepath': 'src/repo.ts',
          'code.lineno': 88,
          'code.function': 'findUser',
        },
      }),
    )
    const fileNodeId = 'file:service-b:src/repo.ts'
    expect(ctx.graph.hasNode(fileNodeId)).toBe(true)

    const edgeId = `${EdgeType.CONNECTS_TO}:OBSERVED:${fileNodeId}->database:payments-db`
    expect(ctx.graph.hasEdge(edgeId)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.evidence).toBeDefined()
    expect(edge.evidence!.file).toBe('src/repo.ts')
    expect(edge.evidence!.line).toBe(88)
  })
})

describe('handleSpan parent-fallback call site (issue #536)', () => {
  let tmpDir: string
  let ctx: IngestContext

  beforeEach(async () => {
    resetParentSpanCache()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-parent-callsite-'))
    ctx = { graph: newGraph(), errorsPath: path.join(tmpDir, 'errors.ndjson') }
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    resetParentSpanCache()
  })

  it('anchors the fallback edge to the parent call site when the parent carried code.*', async () => {
    // Parent CLIENT span on service-a carrying a call site but NO peer address,
    // so it mints no edge of its own — only its spanId + call site land in the
    // parent-span cache for the child to resolve against.
    await handleSpan(
      ctx,
      clientHttpSpan({
        service: 'service-a',
        spanId: 'parent-1',
        attributes: {
          'code.filepath': 'src/caller.ts',
          'code.lineno': 17,
          'code.function': 'callDownstream',
        },
      }),
    )

    // Child SERVER span (kind 2) on service-b whose parent is the cached CLIENT
    // span. No peer address, so address-based resolution misses and the
    // parent-span fallback is the only path that produces the CALLS edge.
    await handleSpan(
      ctx,
      clientHttpSpan({
        service: 'service-b',
        spanId: 'child-1',
        parentSpanId: 'parent-1',
        kind: 2,
        attributes: {},
      }),
    )

    // The fallback edge now originates from the parent's FileNode — file:line —
    // instead of pinning to service:service-a.
    const fileNodeId = 'file:service-a:src/caller.ts'
    expect(ctx.graph.hasNode(fileNodeId)).toBe(true)

    const fileEdgeId = `${EdgeType.CALLS}:OBSERVED:${fileNodeId}->service:service-b`
    expect(ctx.graph.hasEdge(fileEdgeId)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(fileEdgeId) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    expect(edge.source).toBe(fileNodeId)
    expect(edge.evidence).toBeDefined()
    expect(edge.evidence!.file).toBe('src/caller.ts')
    expect(edge.evidence!.line).toBe(17)

    // The old service-coarse edge is not minted in parallel.
    const serviceEdgeId = `${EdgeType.CALLS}:OBSERVED:service:service-a->service:service-b`
    expect(ctx.graph.hasEdge(serviceEdgeId)).toBe(false)

    // The parent's CONTAINS edge to its FileNode lands too.
    let containsFound = false
    ctx.graph.forEachEdge((_id, attrs) => {
      const e = attrs as GraphEdge
      if (
        e.type === EdgeType.CONTAINS &&
        e.source === 'service:service-a' &&
        e.target === fileNodeId
      ) {
        containsFound = true
      }
    })
    expect(containsFound).toBe(true)
  })

  it('keeps the service-level fallback when the parent carried no call site (no fabrication)', async () => {
    // Parent CLIENT span on service-a with no code.* and no peer address.
    await handleSpan(
      ctx,
      clientHttpSpan({
        service: 'service-a',
        spanId: 'parent-2',
        attributes: {},
      }),
    )

    // Child SERVER span resolving only via the parent-span cache.
    await handleSpan(
      ctx,
      clientHttpSpan({
        service: 'service-b',
        spanId: 'child-2',
        parentSpanId: 'parent-2',
        kind: 2,
        attributes: {},
      }),
    )

    // No call site to anchor on → the edge stays service-coarse, evidence-free.
    const serviceEdgeId = `${EdgeType.CALLS}:OBSERVED:service:service-a->service:service-b`
    expect(ctx.graph.hasEdge(serviceEdgeId)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(serviceEdgeId) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    expect(edge.source).toBe('service:service-a')
    expect(edge.evidence).toBeUndefined()

    // No FileNode was fabricated for the parent.
    let fileNodeCount = 0
    ctx.graph.forEachNode((_id, attrs) => {
      if ((attrs as { type: string }).type === NodeType.FileNode) fileNodeCount++
    })
    expect(fileNodeCount).toBe(0)
  })
})

// The thesis: EXTRACTED (static) and OBSERVED (runtime) FileNodes for the SAME
// source file must fuse into ONE node, so the graph is a single fused model
// rather than two disjoint subgraphs. A real OTel SpanProcessor stamps an
// ABSOLUTE `code.filepath` (the Lambda task root, a container image rooted at
// /app, a relocated clone) — when that prefix can't be anchored against the
// daemon's scan root, the runtime path used to fork a parallel FileNode keyed
// off the absolute path, and the OBSERVED layer never landed on the EXTRACTED
// `src/...` node. handleSpan reconciles the runtime path onto the extractor's
// service-relative path so both layers key the same node (file-awareness.md §4).
describe('EXTRACTED and OBSERVED FileNodes fuse for the same source file', () => {
  let tmpDir: string
  let ctx: IngestContext

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-fuse-'))
    ctx = { graph: newGraph(), errorsPath: path.join(tmpDir, 'errors.ndjson') }
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('lands an OBSERVED span with an absolute code.filepath on the EXTRACTED FileNode (one fused node, not two)', async () => {
    // Static extraction minted the FileNode at the service-relative path.
    const staticFileId = fileId('service-a', 'src/client.ts')
    ensureFileNode(ctx.graph, 'service-a', 'service:service-a', 'src/client.ts')
    expect(ctx.graph.getNodeAttributes(staticFileId)).toMatchObject({
      discoveredVia: 'static',
      path: 'src/client.ts',
    })

    // A runtime span for the SAME file, carrying the absolute path the
    // SpanProcessor captured. No scanPath is wired (the multi-tenant / ad-hoc
    // surface), and the prefix `/var/task` is the deployed root, not the
    // daemon's checkout — so the path can't be anchored the cheap way.
    await handleSpan(
      ctx,
      clientHttpSpan({
        attributes: {
          'server.address': 'service-b',
          'code.filepath': '/var/task/src/client.ts',
          'code.lineno': 42,
        },
      }),
    )

    // Exactly ONE FileNode exists, and it is the EXTRACTED one — the OBSERVED
    // layer fused onto it rather than forking an absolute-path twin.
    const fileNodeIds: string[] = []
    ctx.graph.forEachNode((id, attrs) => {
      if ((attrs as { type: string }).type === NodeType.FileNode) fileNodeIds.push(id)
    })
    expect(fileNodeIds).toEqual([staticFileId])
    // The absolute-derived id the bug used to mint is absent.
    expect(ctx.graph.hasNode('file:service-a:var/task/src/client.ts')).toBe(false)

    // The fused node carries BOTH layers: the EXTRACTED CONTAINS edge from
    // static analysis and the OBSERVED CALLS edge from runtime both hang off
    // the one node id — a single fused model a divergence/traversal query reads.
    const observedCallsId = `${EdgeType.CALLS}:OBSERVED:${staticFileId}->service:service-b`
    expect(ctx.graph.hasEdge(observedCallsId)).toBe(true)
    expect((ctx.graph.getEdgeAttributes(observedCallsId) as GraphEdge).source).toBe(staticFileId)

    const provenancesTouchingFile = new Set<string>()
    ctx.graph.forEachEdge((_id, attrs) => {
      const e = attrs as GraphEdge
      if (e.source === staticFileId || e.target === staticFileId) {
        provenancesTouchingFile.add(e.provenance)
      }
    })
    expect(provenancesTouchingFile.has(Provenance.EXTRACTED)).toBe(true)
    expect(provenancesTouchingFile.has(Provenance.OBSERVED)).toBe(true)
  })

  it('keeps a genuinely OTel-only file honest — no false fusion onto an unrelated extracted file', async () => {
    ensureFileNode(ctx.graph, 'service-a', 'service:service-a', 'src/client.ts')

    // A file the extractor never parsed. It must NOT collapse onto src/client.ts.
    await handleSpan(
      ctx,
      clientHttpSpan({
        attributes: {
          'server.address': 'service-b',
          'code.filepath': '/var/task/src/uninstrumented.ts',
          'code.lineno': 7,
        },
      }),
    )

    const fileNodeIds: string[] = []
    ctx.graph.forEachNode((id, attrs) => {
      if ((attrs as { type: string }).type === NodeType.FileNode) fileNodeIds.push(id)
    })
    expect(fileNodeIds).toContain(fileId('service-a', 'src/client.ts'))
    expect(fileNodeIds.length).toBe(2)
    // The honest runtime path stands; evidence is never fabricated onto the
    // wrong static node.
    expect(fileNodeIds.some((id) => id.endsWith('src/uninstrumented.ts'))).toBe(true)
  })
})
