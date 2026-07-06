import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  type EdgeTypeValue,
  type ErrorEvent,
  type DatabaseNode,
  fileId,
  graphqlOperationId,
  grpcMethodId,
  infraId,
  type InfraNode,
  localDatabaseId,
  type GraphEdge,
  type GraphNode,
  type GraphQLOperationNode,
  type GrpcMethodNode,
  websocketChannelId,
  type WebSocketChannelNode,
  NodeType,
  Provenance,
} from '@neat.is/types'
import { ensureFileNode } from '../src/extract/calls/shared.js'
import {
  buildErrorEventForReceiver,
  handleSpan,
  markStaleEdges,
  mergeSnapshot,
  promoteFrontierNodes,
  readErrorEvents,
  readStaleEvents,
  resetParentSpanCache,
  SnapshotValidationError,
  stitchTrace,
  thresholdForEdgeType,
  type IngestContext,
} from '../src/ingest.js'
import { getRootCause } from '../src/traverse.js'
import type { ParsedSpan } from '../src/otel.js'
import type { NeatGraph } from '../src/graph.js'
import { SCHEMA_VERSION, type PersistedGraph } from '../src/persist.js'

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

  it('dedupes a re-delivered span to one incident on (traceId, spanId)', async () => {
    // OTel BatchSpanProcessor retries deliver the same span more than once, and
    // a daemon's receiver + handler can each write one POST. The append-only
    // ndjson keeps both lines; the incident surface must still count one.
    const span = dbSpan({
      statusCode: 2,
      exception: { message: 'connection reset' },
    })
    await handleSpan(ctx, span)
    await handleSpan(ctx, span)

    // Two lines on disk — the sidecar is append-only.
    const raw = await fs.readFile(ctx.errorsPath, 'utf8')
    expect(raw.split('\n').filter((l) => l.length > 0)).toHaveLength(2)

    // One incident at the surface.
    const events = await readErrorEvents(ctx.errorsPath)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      traceId: 'trace-1',
      spanId: 'span-b',
    } as ErrorEvent)
  })

  it('collapses one failure recorded from two spans of a trace to one incident (#624)', async () => {
    // A failed request: the DB driver throws (recorded from the db child span)
    // and the HTTP server span echoes it as a synthesized "500 on ...". Both
    // land on the same service in the same trace — two lines on disk, but one
    // failed request, so the surface must count one and keep the real cause.
    const httpAttrs = {
      'http.response.status_code': 500,
      'http.route': '/users/:id',
      'http.request.method': 'GET',
    }
    const serverSpan: ParsedSpan = {
      ...clientHttpSpan({ service: 'checkout', spanId: 'srv', kind: 2, statusCode: 2 }),
      attributes: httpAttrs,
    }
    const dbChildSpan: ParsedSpan = dbSpan({
      service: 'checkout',
      spanId: 'db',
      parentSpanId: 'srv',
      statusCode: 2,
      exception: { type: 'Error', message: 'SASL: SCRAM-SERVER-FIRST-MESSAGE failed' },
      attributes: { 'db.system': 'postgresql', 'server.address': 'payments-db' },
    })

    const ev1 = buildErrorEventForReceiver(serverSpan)!
    const ev2 = buildErrorEventForReceiver(dbChildSpan)!
    expect(ev1.errorMessage).toBe('500 on GET /users/:id')
    expect(ev1.affectedNode).toBe(ev2.affectedNode) // both attribute to service:checkout
    await fs.writeFile(ctx.errorsPath, JSON.stringify(ev1) + '\n' + JSON.stringify(ev2) + '\n')

    const events = await readErrorEvents(ctx.errorsPath)
    expect(events).toHaveLength(1)
    // The synthesized HTTP echo is dropped; the real exception survives.
    expect(events[0]!.errorMessage).toContain('SCRAM')
  })

  it('keeps a lone synthesized 5xx incident when nothing deeper explains it (#624)', async () => {
    // A clean 500 with no exception anywhere in the trace is still a real
    // incident — the collapse only drops the echo when a real failure shares
    // its trace and node.
    const serverSpan: ParsedSpan = {
      ...clientHttpSpan({ service: 'checkout', spanId: 'srv', kind: 2, statusCode: 2 }),
      attributes: {
        'http.response.status_code': 500,
        'http.route': '/health',
        'http.request.method': 'GET',
      },
    }
    const ev = buildErrorEventForReceiver(serverSpan)!
    await fs.writeFile(ctx.errorsPath, JSON.stringify(ev) + '\n')
    const events = await readErrorEvents(ctx.errorsPath)
    expect(events).toHaveLength(1)
    expect(events[0]!.errorMessage).toBe('500 on GET /health')
  })

  it('reads the gRPC status for a non-HTTP failure instead of unknown error (#624)', () => {
    const grpcSpan: ParsedSpan = {
      ...clientHttpSpan({ service: 'checkout', spanId: 'rpc', kind: 3, statusCode: 2 }),
      name: 'pay.Payments/Charge',
      attributes: {
        'rpc.system': 'grpc',
        'rpc.grpc.status_code': 14,
        'rpc.grpc.status_message': 'upstream connect error',
        'server.address': 'payments',
      },
    }
    const ev = buildErrorEventForReceiver(grpcSpan)!
    expect(ev.errorMessage).toBe('gRPC UNAVAILABLE: upstream connect error')
  })

  it('reads a connection error for a non-HTTP failure instead of unknown error (#624)', () => {
    const connSpan: ParsedSpan = {
      ...clientHttpSpan({ service: 'checkout', spanId: 'conn', kind: 3, statusCode: 2 }),
      name: 'GET',
      attributes: { 'error.type': 'ECONNREFUSED', 'server.address': 'payments' },
    }
    const ev = buildErrorEventForReceiver(connSpan)!
    expect(ev.errorMessage).toBe('ECONNREFUSED connecting to payments')
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

// Async / queue / background-worker failures (ADR-117, #614). An OTel worker
// span (bullmq, Redis Streams) that throws carries an exception event and a
// code.* call site but no HTTP response context, so the response-code path
// never sees it. Incident recording keys on the failure signal instead: an
// exception event records an incident independent of HTTP, attributed to the
// handler file:line or the service.
describe('handleSpan — async/worker failure incidents (ADR-117, #614)', () => {
  let tmpDir: string
  let ctx: IngestContext

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-worker-incident-'))
    ctx = {
      graph: newGraph(),
      errorsPath: path.join(tmpDir, 'errors.ndjson'),
    }
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // A bullmq / Redis-Streams job span: CONSUMER kind (5), an exception event, a
  // code.* call site, and NO HTTP response context.
  function workerSpan(overrides: Partial<ParsedSpan> = {}): ParsedSpan {
    return {
      service: 'email-worker',
      traceId: 'trace-w',
      spanId: 'span-w',
      name: 'sendWelcome',
      kind: 5, // CONSUMER
      startTimeUnixNano: '0',
      endTimeUnixNano: '0',
      durationNanos: 0n,
      env: 'unknown',
      startTimeIso: '2026-06-30T12:00:00.000Z',
      attributes: {
        'messaging.system': 'redis',
        'messaging.operation': 'process',
        'code.filepath': 'src/jobs/email.ts',
        'code.lineno': 42,
        'code.function': 'sendWelcome',
      },
      exception: { message: 'Error: SMTP connection refused', type: 'Error' },
      statusCode: 0,
      ...overrides,
    }
  }

  it('records an incident for an exception-event worker span with UNSET status and no HTTP context', async () => {
    await handleSpan(ctx, workerSpan())
    const events = await readErrorEvents(ctx.errorsPath)
    expect(events).toHaveLength(1)
    expect(events[0]!.errorMessage).toBe('Error: SMTP connection refused')
    // Attributed to the handler file:line the job threw in (code.filepath),
    // the same file grain OBSERVED CALLS edges land on.
    expect(events[0]!.affectedNode).toBe('file:email-worker:src/jobs/email.ts')
    expect(events[0]!.attributes!['code.lineno']).toBe(42)
    expect(events[0]!.exceptionType).toBe('Error')
  })

  it('records an incident for a worker span that also carries ERROR status, no HTTP context', async () => {
    await handleSpan(ctx, workerSpan({ spanId: 'span-w2', statusCode: 2 }))
    const events = await readErrorEvents(ctx.errorsPath)
    expect(events).toHaveLength(1)
    expect(events[0]!.errorMessage).toBe('Error: SMTP connection refused')
    // The ERROR-status path attributes to the worker's service; the handler
    // file:line rides along in the passed-through code.* attributes.
    expect(events[0]!.affectedNode).toBe('service:email-worker')
    expect(events[0]!.attributes!['code.filepath']).toBe('src/jobs/email.ts')
  })

  it('records once — the (traceId, spanId) collapse holds on job redelivery', async () => {
    // Same trace + span redelivered (a retried job). Both writes share the id
    // `${traceId}:${spanId}`; readErrorEvents collapses them to one (ADR-113).
    await handleSpan(ctx, workerSpan())
    await handleSpan(ctx, workerSpan())
    const events = await readErrorEvents(ctx.errorsPath)
    expect(events).toHaveLength(1)
  })

  it('a clean worker span (no exception, no error status) records nothing', async () => {
    await handleSpan(ctx, workerSpan({ exception: undefined }))
    expect(await readErrorEvents(ctx.errorsPath)).toEqual([])
  })

  it('leaves the HTTP failing-response path intact alongside worker incidents', async () => {
    // A worker exception and an HTTP 5xx in the same store both record, on
    // their own nodes — the HTTP path is unchanged by the exception trigger.
    await handleSpan(ctx, workerSpan())
    await handleSpan(
      ctx,
      clientHttpSpan({
        service: 'service-a',
        spanId: 'http-5xx',
        attributes: { 'http.method': 'GET', 'http.response.status_code': 502 },
      }),
    )
    const events = await readErrorEvents(ctx.errorsPath)
    expect(events).toHaveLength(2)
    expect(events.some((e) => e.affectedNode === 'file:email-worker:src/jobs/email.ts')).toBe(true)
    expect(events.some((e) => e.httpStatusCode === 502)).toBe(true)
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

  it('never mints INFERRED twins of structural edges, but still bridges an uninstrumented dependency', () => {
    const graph = newGraph()
    graph.addNode('service:api', {
      id: 'service:api',
      type: NodeType.ServiceNode,
      name: 'api',
      language: 'javascript',
    })
    graph.addNode('file:api/handler.ts', {
      id: 'file:api/handler.ts',
      type: NodeType.FileNode,
      name: 'handler.ts',
    })
    graph.addNode('file:api/util.ts', {
      id: 'file:api/util.ts',
      type: NodeType.FileNode,
      name: 'util.ts',
    })
    graph.addNode('config:api/.env', {
      id: 'config:api/.env',
      type: NodeType.ConfigNode,
      name: '.env',
    })
    graph.addNode('database:orders-db', {
      id: 'database:orders-db',
      type: NodeType.DatabaseNode,
      name: 'orders-db',
    })

    // Structural EXTRACTED edges out of the erroring service — must NOT be stitched.
    const structural: [EdgeTypeValue, string, string][] = [
      [EdgeType.CONTAINS, 'service:api', 'file:api/handler.ts'],
      [EdgeType.IMPORTS, 'service:api', 'file:api/util.ts'],
      [EdgeType.CONFIGURED_BY, 'service:api', 'config:api/.env'],
    ]
    for (const [type, source, target] of structural) {
      const id = `${type}:${source}->${target}`
      graph.addEdgeWithKey(id, source, target, {
        id,
        source,
        target,
        type,
        provenance: Provenance.EXTRACTED,
      })
    }

    // A genuine runtime dependency on an uninstrumented backend — SHOULD bridge.
    graph.addEdgeWithKey(
      'CONNECTS_TO:service:api->database:orders-db',
      'service:api',
      'database:orders-db',
      {
        id: 'CONNECTS_TO:service:api->database:orders-db',
        source: 'service:api',
        target: 'database:orders-db',
        type: EdgeType.CONNECTS_TO,
        provenance: Provenance.EXTRACTED,
      },
    )

    stitchTrace(graph, 'service:api', '2026-05-01T00:00:00.000Z')

    for (const [type, source, target] of structural) {
      expect(graph.hasEdge(`${type}:INFERRED:${source}->${target}`)).toBe(false)
    }
    expect(
      graph.hasEdge('CONNECTS_TO:INFERRED:service:api->database:orders-db'),
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

// A loopback peer address on a CLIENT span is this host talking to itself, not
// a distinct upstream. The real callee is recovered from the parent-span
// correlation on its SERVER span, so minting frontier:localhost /
// frontier:127.0.0.1 from the loopback address would double the edge with a
// phantom peer (issues #590, #577).
describe('handleSpan loopback guard (issues #590, #577)', () => {
  let tmpDir: string
  let ctx: IngestContext

  beforeEach(async () => {
    resetParentSpanCache()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-loopback-'))
    ctx = { graph: newGraph(), errorsPath: path.join(tmpDir, 'errors.ndjson') }
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    resetParentSpanCache()
  })

  for (const host of ['localhost', '127.0.0.1', '::1', '127.0.0.53']) {
    it(`does not mint a frontier for a loopback peer '${host}', leaving the parent-span fallback to record the resolved edge`, async () => {
      // CLIENT span on service-a whose peer address is loopback. It caches its
      // service for the child to resolve against but must not mint a frontier.
      await handleSpan(
        ctx,
        clientHttpSpan({
          service: 'service-a',
          spanId: 'client-lb',
          attributes: { 'http.method': 'GET', 'server.address': host },
        }),
      )

      // No phantom frontier node or edge for the loopback address.
      expect(ctx.graph.hasNode(`frontier:${host}`)).toBe(false)
      expect(
        ctx.graph.hasEdge(
          `${EdgeType.CALLS}:OBSERVED:service:service-a->frontier:${host}`,
        ),
      ).toBe(false)

      // The callee's SERVER span, parented to the cached CLIENT span, mints the
      // one resolved edge service-a -> service-b via the parent-span fallback.
      await handleSpan(
        ctx,
        clientHttpSpan({
          service: 'service-b',
          spanId: 'server-lb',
          parentSpanId: 'client-lb',
          kind: 2,
          attributes: {},
        }),
      )

      expect(ctx.graph.hasNode(`frontier:${host}`)).toBe(false)
      expect(
        ctx.graph.hasEdge(`${EdgeType.CALLS}:OBSERVED:service:service-a->service:service-b`),
      ).toBe(true)

      // Exactly one OBSERVED CALLS edge out of service-a — no duplicate twin.
      let observedCalls = 0
      ctx.graph.forEachEdge((_id, attrs) => {
        const e = attrs as GraphEdge
        if (
          e.type === EdgeType.CALLS &&
          e.provenance === Provenance.OBSERVED &&
          e.source === 'service:service-a'
        ) {
          observedCalls++
        }
      })
      expect(observedCalls).toBe(1)
    })
  }

  it('still mints a frontier for a non-loopback unresolved peer', async () => {
    await handleSpan(
      ctx,
      clientHttpSpan({ attributes: { 'server.address': 'payments-api.cluster.local' } }),
    )
    expect(ctx.graph.hasNode('frontier:payments-api.cluster.local')).toBe(true)
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

  // #619 — the fusion fix reconciled OBSERVED edge NODE ids onto the EXTRACTED
  // path, but the incident `affectedNode` and the OBSERVED edge's own
  // `evidence.file` still carried the raw deployed absolute path. On a
  // serverless deploy (runtime rooted at /var/task, daemon rooted elsewhere)
  // that split the incident off from the fused node and left the edge naming a
  // path its node id didn't match. Both must reconcile onto the fused FileNode.
  it('reconciles the incident affectedNode onto the fused FileNode so root-cause lands on it', async () => {
    const staticFileId = fileId('service-a', 'src/client.ts')
    ensureFileNode(ctx.graph, 'service-a', 'service:service-a', 'src/client.ts')

    // A failing span for that file, carrying the deployed absolute path the
    // SpanProcessor stamped. No scanPath is wired (the ad-hoc surface), and
    // `/var/task` is the Lambda task root, not the daemon's checkout.
    const span = clientHttpSpan({
      statusCode: 2,
      exception: { message: 'boom' },
      attributes: {
        'server.address': 'service-b',
        'code.filepath': '/var/task/src/client.ts',
        'code.lineno': 42,
      },
    })

    // The receiver-path incident (production daemon path) attributes to the ONE
    // fused node, not the phantom `file:service-a:var/task/src/client.ts`.
    const ev = buildErrorEventForReceiver(span, ctx.graph)
    expect(ev).not.toBeNull()
    expect(ev!.affectedNode).toBe(staticFileId)
    expect(ctx.graph.hasNode(ev!.affectedNode)).toBe(true)

    // And root-cause on that fused node returns it — the query that came back
    // empty before, because the incident pointed at a node absent from the graph.
    const rc = getRootCause(ctx.graph, staticFileId, ev!, [ev!])
    expect(rc).not.toBeNull()
    expect(rc!.rootCauseNode).toBe(staticFileId)
  })

  it("reconciles the OBSERVED edge's evidence.file onto the fused path (node id and evidence agree)", async () => {
    const staticFileId = fileId('service-a', 'src/client.ts')
    ensureFileNode(ctx.graph, 'service-a', 'service:service-a', 'src/client.ts')

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

    const observedCallsId = `${EdgeType.CALLS}:OBSERVED:${staticFileId}->service:service-b`
    const edge = ctx.graph.getEdgeAttributes(observedCallsId) as GraphEdge
    // The edge's node id already reconciled onto src/client.ts; its evidence must
    // name the same fused path, not the raw /var/task deployed path.
    expect(edge.evidence?.file).toBe('src/client.ts')
    expect(edge.source).toBe(staticFileId)
  })
})

// Issue #576 / #546 — an in-process / embedded database (SQLite, better-sqlite3,
// an in-memory store) serves a leaf service's reads without crossing a network
// boundary, so its span carries no peer address. It mints the same file-grained
// service→database CONNECTS_TO OBSERVED edge a networked DB does, keyed on a
// service-scoped local identity (ADR-118). Fixtures use REAL SDK span shape: a
// wire CLIENT span (kind 3), an ABSOLUTE `code.filepath` (the deployed root the
// SpanProcessor stamps), and `db.system` / `db.name` as an embedded-DB driver
// emits them — never `server.address`, which an in-process DB has no value for.
describe('handleSpan in-process database spans (#576 / #546)', () => {
  let tmpDir: string
  let ctx: IngestContext

  beforeEach(async () => {
    resetParentSpanCache()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-inproc-db-'))
    ctx = { graph: newGraph(), errorsPath: path.join(tmpDir, 'errors.ndjson') }
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    resetParentSpanCache()
  })

  // A better-sqlite3 query span: synchronous, so the SpanProcessor's stack walk
  // stamps the user call site; embedded, so there is no peer address at all.
  function inProcessDbSpan(overrides: Partial<ParsedSpan> = {}): ParsedSpan {
    return {
      service: 'service-a',
      traceId: 'trace-inproc',
      spanId: 'span-db',
      name: 'SELECT users',
      kind: 3,
      startTimeUnixNano: '0',
      endTimeUnixNano: '0',
      durationNanos: 0n,
      env: 'unknown',
      attributes: {
        'db.system': 'sqlite',
        'db.name': '/var/task/data/app.db',
        'code.filepath': '/var/task/src/db/user-repo.ts',
        'code.lineno': 24,
        'code.function': 'findUser',
      },
      dbSystem: 'sqlite',
      dbName: '/var/task/data/app.db',
      statusCode: 0,
      ...overrides,
    }
  }

  it('mints a file-grained CONNECTS_TO edge to a service-scoped local DatabaseNode', async () => {
    // The extractor already parsed the repo file the query runs in.
    ensureFileNode(ctx.graph, 'service-a', 'service:service-a', 'src/db/user-repo.ts')

    await handleSpan(ctx, inProcessDbSpan())

    // The DatabaseNode is keyed on the service-scoped local identity, not on a
    // fabricated host. It carries the engine and NO host.
    const dbNodeId = localDatabaseId('service-a', '/var/task/data/app.db')
    expect(dbNodeId).toBe('database:service-a//var/task/data/app.db')
    expect(ctx.graph.hasNode(dbNodeId)).toBe(true)
    const dbNode = ctx.graph.getNodeAttributes(dbNodeId) as DatabaseNode
    expect(dbNode.type).toBe(NodeType.DatabaseNode)
    expect(dbNode.engine).toBe('sqlite')
    expect(dbNode.host).toBeUndefined()
    expect(dbNode.discoveredVia).toBe('otel')

    // The edge originates from the FileNode at the exact call site — file-grained,
    // fused onto the EXTRACTED path (not the raw /var/task deployed path).
    const fileNodeId = fileId('service-a', 'src/db/user-repo.ts')
    const edgeId = `${EdgeType.CONNECTS_TO}:OBSERVED:${fileNodeId}->${dbNodeId}`
    expect(ctx.graph.hasEdge(edgeId)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    expect(edge.source).toBe(fileNodeId)
    expect(edge.evidence?.file).toBe('src/db/user-repo.ts')
    expect(edge.evidence?.line).toBe(24)
  })

  it('fuses the OBSERVED FileNode onto the EXTRACTED one — one node, both provenances, no twin', async () => {
    const staticFileId = fileId('service-a', 'src/db/user-repo.ts')
    ensureFileNode(ctx.graph, 'service-a', 'service:service-a', 'src/db/user-repo.ts')
    expect(ctx.graph.getNodeAttributes(staticFileId)).toMatchObject({
      discoveredVia: 'static',
      path: 'src/db/user-repo.ts',
    })

    await handleSpan(ctx, inProcessDbSpan())

    // Exactly ONE FileNode exists and it is the EXTRACTED one — the absolute
    // `code.filepath` reconciled onto it rather than forking a /var/task twin.
    const fileNodeIds: string[] = []
    ctx.graph.forEachNode((id, attrs) => {
      if ((attrs as { type: string }).type === NodeType.FileNode) fileNodeIds.push(id)
    })
    expect(fileNodeIds).toEqual([staticFileId])
    expect(ctx.graph.hasNode('file:service-a:var/task/src/db/user-repo.ts')).toBe(false)

    // Both layers hang off the one node id: the EXTRACTED CONTAINS from static
    // analysis and the OBSERVED CONNECTS_TO from runtime.
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

  it('names the local DatabaseNode by the engine when the span carries no db.name', async () => {
    await handleSpan(
      ctx,
      inProcessDbSpan({
        attributes: {
          'db.system': 'sqlite',
          'code.filepath': '/var/task/src/db/user-repo.ts',
          'code.lineno': 24,
        },
        dbName: undefined,
      }),
    )

    const dbNodeId = localDatabaseId('service-a', 'sqlite')
    expect(ctx.graph.hasNode(dbNodeId)).toBe(true)
    const dbNode = ctx.graph.getNodeAttributes(dbNodeId) as DatabaseNode
    expect(dbNode.name).toBe('sqlite')
    expect(dbNode.engine).toBe('sqlite')
    expect(dbNode.host).toBeUndefined()
  })

  it('keeps two services with their own app.db on distinct local DatabaseNodes', async () => {
    // service-a and service-b each read an embedded app.db of their own. The
    // service-scoped id keeps them separate rather than collapsing onto one node.
    await handleSpan(ctx, inProcessDbSpan({ service: 'service-a', dbName: 'app.db', attributes: {
      'db.system': 'sqlite',
      'db.name': 'app.db',
      'code.filepath': '/srv/a/src/repo.ts',
      'code.lineno': 5,
    } }))
    await handleSpan(ctx, inProcessDbSpan({ service: 'service-b', spanId: 'span-db-b', traceId: 'trace-b', dbName: 'app.db', attributes: {
      'db.system': 'sqlite',
      'db.name': 'app.db',
      'code.filepath': '/srv/b/src/repo.ts',
      'code.lineno': 9,
    } }))

    expect(ctx.graph.hasNode(localDatabaseId('service-a', 'app.db'))).toBe(true)
    expect(ctx.graph.hasNode(localDatabaseId('service-b', 'app.db'))).toBe(true)
    expect(localDatabaseId('service-a', 'app.db')).not.toBe(localDatabaseId('service-b', 'app.db'))
  })

  it('leaves a networked database span keyed on its host, unchanged', async () => {
    // Regression guard — a DB span that DOES carry a peer address still keys on
    // databaseId(host), never the local identity.
    await handleSpan(ctx, dbSpan())
    const id = `${EdgeType.CONNECTS_TO}:OBSERVED:service:service-b->database:payments-db`
    expect(ctx.graph.hasEdge(id)).toBe(true)
    // No local-identity node was minted for the networked DB.
    expect(ctx.graph.hasNode(localDatabaseId('service-b', 'neatdemo'))).toBe(false)
  })
})

// Issue #614 — the queue side of the OBSERVED layer. A PRODUCER span publishes
// to a topic; a CONSUMER span reads from one. Both mint an OBSERVED edge to the
// SAME destination node the static extractor names (extract/calls/kafka.ts:
// `infra:kafka-topic:<topic>`), so declared and observed queue topology fuse
// into one edge (→ divergence) instead of twinning. The consumer side is what
// the OBSERVED layer used to leave dark (only CLIENT/PRODUCER minted). Fixtures
// use REAL SDK messaging span shape: PRODUCER/CONSUMER wire kind, `messaging.
// system`, `messaging.destination.name`, and an ABSOLUTE `code.filepath` the
// SpanProcessor stamps — reconciled onto the EXTRACTED path (ADR-118).
describe('handleSpan queue producer/consumer spans (#614)', () => {
  let tmpDir: string
  let ctx: IngestContext

  beforeEach(async () => {
    resetParentSpanCache()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-queue-'))
    ctx = { graph: newGraph(), errorsPath: path.join(tmpDir, 'errors.ndjson') }
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    resetParentSpanCache()
  })

  // A kafkajs consumer "process" span: CONSUMER kind (5), the messaging semconv,
  // and a code.* call site for the handler the job runs in.
  function consumerSpan(overrides: Partial<ParsedSpan> = {}): ParsedSpan {
    return {
      service: 'service-a',
      traceId: 'trace-consume',
      spanId: 'span-consume',
      name: 'orders process',
      kind: 5, // CONSUMER
      startTimeUnixNano: '0',
      endTimeUnixNano: '0',
      durationNanos: 0n,
      env: 'unknown',
      attributes: {
        'messaging.system': 'kafka',
        'messaging.operation': 'process',
        'messaging.destination.name': 'orders',
        'code.filepath': '/var/task/src/consumers/orders.ts',
        'code.lineno': 31,
        'code.function': 'handleOrder',
      },
      messagingSystem: 'kafka',
      messagingDestination: 'orders',
      statusCode: 0,
      ...overrides,
    }
  }

  it('mints a file-grained CONSUMES_FROM edge from a CONSUMER span to the topic node', async () => {
    // The extractor already parsed the consumer file the handler lives in.
    ensureFileNode(ctx.graph, 'service-a', 'service:service-a', 'src/consumers/orders.ts')

    await handleSpan(ctx, consumerSpan())

    // The destination node is keyed exactly the way the static extractor keys a
    // kafka topic, so the two sides fuse rather than twin.
    const topicId = infraId('kafka-topic', 'orders')
    expect(topicId).toBe('infra:kafka-topic:orders')
    expect(ctx.graph.hasNode(topicId)).toBe(true)
    const topic = ctx.graph.getNodeAttributes(topicId) as InfraNode
    expect(topic.type).toBe(NodeType.InfraNode)
    expect(topic.name).toBe('orders')
    expect(topic.kind).toBe('kafka-topic')
    expect(topic.provider).toBe('self')

    // The edge originates from the consumer's FileNode at the exact call site —
    // file-grained, fused onto the EXTRACTED path (not the /var/task deployed one).
    const fileNodeId = fileId('service-a', 'src/consumers/orders.ts')
    const edgeId = `${EdgeType.CONSUMES_FROM}:OBSERVED:${fileNodeId}->${topicId}`
    expect(ctx.graph.hasEdge(edgeId)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    expect(edge.type).toBe(EdgeType.CONSUMES_FROM)
    expect(edge.source).toBe(fileNodeId)
    expect(edge.target).toBe(topicId)
    expect(edge.evidence?.file).toBe('src/consumers/orders.ts')
    expect(edge.evidence?.line).toBe(31)
  })

  it('mints a file-grained PUBLISHES_TO edge from a PRODUCER span to the same topic node', async () => {
    ensureFileNode(ctx.graph, 'service-a', 'service:service-a', 'src/producers/orders.ts')

    await handleSpan(
      ctx,
      consumerSpan({
        kind: 4, // PRODUCER
        spanId: 'span-produce',
        name: 'orders send',
        attributes: {
          'messaging.system': 'kafka',
          'messaging.operation': 'publish',
          'messaging.destination.name': 'orders',
          'code.filepath': '/var/task/src/producers/orders.ts',
          'code.lineno': 12,
        },
      }),
    )

    const topicId = infraId('kafka-topic', 'orders')
    const fileNodeId = fileId('service-a', 'src/producers/orders.ts')
    const edgeId = `${EdgeType.PUBLISHES_TO}:OBSERVED:${fileNodeId}->${topicId}`
    expect(ctx.graph.hasEdge(edgeId)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.type).toBe(EdgeType.PUBLISHES_TO)
    expect(edge.target).toBe(topicId)

    // The topic is the destination — not the broker host. A messaging span mints
    // no CALLS edge to a broker transport.
    let callsEdges = 0
    ctx.graph.forEachEdge((_id, a) => {
      if ((a as GraphEdge).type === EdgeType.CALLS) callsEdges++
    })
    expect(callsEdges).toBe(0)
  })

  it('fuses the OBSERVED CONSUMES_FROM onto the static one — one grain, both provenances, no twin', async () => {
    const fileNodeId = fileId('service-a', 'src/consumers/orders.ts')
    const topicId = infraId('kafka-topic', 'orders')

    // Static extraction already found the consumer call site and its topic: a
    // file → topic EXTRACTED CONSUMES_FROM edge to infra:kafka-topic:orders.
    ensureFileNode(ctx.graph, 'service-a', 'service:service-a', 'src/consumers/orders.ts')
    ctx.graph.addNode(topicId, {
      id: topicId,
      type: NodeType.InfraNode,
      name: 'orders',
      provider: 'self',
      kind: 'kafka-topic',
    })
    const staticEdgeId = `${EdgeType.CONSUMES_FROM}:${fileNodeId}->${topicId}`
    ctx.graph.addEdgeWithKey(staticEdgeId, fileNodeId, topicId, {
      id: staticEdgeId,
      source: fileNodeId,
      target: topicId,
      type: EdgeType.CONSUMES_FROM,
      provenance: Provenance.EXTRACTED,
    })

    await handleSpan(ctx, consumerSpan())

    // Exactly one topic InfraNode and one consumer FileNode — the absolute
    // `code.filepath` reconciled onto the EXTRACTED node rather than forking a
    // /var/task twin, and the observed edge reused the static topic node.
    const infraNodes: string[] = []
    ctx.graph.forEachNode((id, a) => {
      if ((a as { type: string }).type === NodeType.InfraNode) infraNodes.push(id)
    })
    expect(infraNodes).toEqual([topicId])
    expect(ctx.graph.hasNode('file:service-a:var/task/src/consumers/orders.ts')).toBe(false)

    // Both provenances ride the same (file → topic) CONSUMES_FROM grain: the
    // EXTRACTED declaration and the OBSERVED runtime edge, no twin node.
    expect(ctx.graph.hasEdge(staticEdgeId)).toBe(true)
    expect((ctx.graph.getEdgeAttributes(staticEdgeId) as GraphEdge).provenance).toBe(
      Provenance.EXTRACTED,
    )
    const observedId = `${EdgeType.CONSUMES_FROM}:OBSERVED:${fileNodeId}->${topicId}`
    expect(ctx.graph.hasEdge(observedId)).toBe(true)

    const consumesEdges: GraphEdge[] = []
    ctx.graph.forEachEdge((_id, a) => {
      const e = a as GraphEdge
      if (e.type === EdgeType.CONSUMES_FROM) consumesEdges.push(e)
    })
    expect(consumesEdges).toHaveLength(2)
    expect(new Set(consumesEdges.map((e) => e.source))).toEqual(new Set([fileNodeId]))
    expect(new Set(consumesEdges.map((e) => e.target))).toEqual(new Set([topicId]))
    expect(new Set(consumesEdges.map((e) => e.provenance))).toEqual(
      new Set([Provenance.EXTRACTED, Provenance.OBSERVED]),
    )
  })

  it('keys the destination node off messaging.system for a non-Kafka broker (Redis Streams)', async () => {
    // A Redis-Streams consumer with no code.* call site — the edge stays
    // service-level, honestly, and the node id generalises to `<system>-topic`.
    await handleSpan(
      ctx,
      consumerSpan({
        messagingSystem: 'redis',
        messagingDestination: 'events',
        attributes: {
          'messaging.system': 'redis',
          'messaging.destination.name': 'events',
        },
      }),
    )

    const topicId = infraId('redis-topic', 'events')
    expect(ctx.graph.hasNode(topicId)).toBe(true)
    const edgeId = `${EdgeType.CONSUMES_FROM}:OBSERVED:service:service-a->${topicId}`
    expect(ctx.graph.hasEdge(edgeId)).toBe(true)
    expect((ctx.graph.getEdgeAttributes(edgeId) as GraphEdge).target).toBe(topicId)
  })

  it('mints no messaging edge for a CONSUMER span that carries no destination', async () => {
    // The ADR-117 worker-incident path fires on a destination-less consumer
    // span; the queue edge must not. No destination, no topic node, no edge.
    await handleSpan(
      ctx,
      consumerSpan({
        messagingDestination: undefined,
        attributes: { 'messaging.system': 'kafka', 'messaging.operation': 'process' },
      }),
    )
    let infraNodes = 0
    ctx.graph.forEachNode((_id, a) => {
      if ((a as { type: string }).type === NodeType.InfraNode) infraNodes++
    })
    expect(infraNodes).toBe(0)
    let messagingEdges = 0
    ctx.graph.forEachEdge((_id, a) => {
      const e = a as GraphEdge
      if (e.type === EdgeType.CONSUMES_FROM || e.type === EdgeType.PUBLISHES_TO) messagingEdges++
    })
    expect(messagingEdges).toBe(0)
  })
})

// ── GraphQL operation spans (#615, ADR-122) ────────────────────────────────
// Every GraphQL request rides one HTTP endpoint (POST /graphql), so at HTTP
// grain the whole API collapses to a single edge and operation-level topology is
// invisible. The execution span carries the operation the client actually named
// (`graphql.operation.name` + `graphql.operation.type`), so handleSpan mints an
// OBSERVED `service ──CONTAINS──▶ operation` edge to a per-operation node —
// OBSERVED-only, keyed so a future static GraphQL extractor fuses onto the same
// id. Fixtures use REAL SDK GraphQL execution shape: INTERNAL wire kind, the
// `graphql.operation.*` semconv, and an ABSOLUTE `code.filepath` the
// SpanProcessor stamps — reconciled onto the EXTRACTED path.
describe('handleSpan GraphQL execution spans (#615)', () => {
  let tmpDir: string
  let ctx: IngestContext

  beforeEach(async () => {
    resetParentSpanCache()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-graphql-'))
    ctx = { graph: newGraph(), errorsPath: path.join(tmpDir, 'errors.ndjson') }
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    resetParentSpanCache()
  })

  // An @opentelemetry/instrumentation-graphql execute span: INTERNAL kind (1),
  // the graphql semconv, and a code.* call site for the resolver file.
  function graphqlSpan(overrides: Partial<ParsedSpan> = {}): ParsedSpan {
    return {
      service: 'service-a',
      traceId: 'trace-gql',
      spanId: 'span-gql',
      name: 'query GetUser',
      kind: 1, // INTERNAL
      startTimeUnixNano: '0',
      endTimeUnixNano: '0',
      durationNanos: 0n,
      env: 'unknown',
      attributes: {
        'graphql.operation.name': 'GetUser',
        'graphql.operation.type': 'query',
        'code.filepath': '/var/task/src/resolvers/user.ts',
        'code.lineno': 42,
        'code.function': 'getUser',
      },
      graphqlOperationName: 'GetUser',
      graphqlOperationType: 'query',
      statusCode: 0,
      ...overrides,
    }
  }

  it('mints a file-grained OBSERVED CONTAINS edge from the serving service to the operation node', async () => {
    // The extractor already parsed the resolver file the operation runs in.
    ensureFileNode(ctx.graph, 'service-a', 'service:service-a', 'src/resolvers/user.ts')

    await handleSpan(ctx, graphqlSpan())

    // The operation node is keyed on (service, type, name) so a future static
    // GraphQL extractor fuses onto the same id.
    const opId = graphqlOperationId('service-a', 'query', 'GetUser')
    expect(opId).toBe('graphql:service-a:query GetUser')
    expect(ctx.graph.hasNode(opId)).toBe(true)
    const op = ctx.graph.getNodeAttributes(opId) as GraphQLOperationNode
    expect(op.type).toBe(NodeType.GraphQLOperationNode)
    expect(op.name).toBe('GetUser')
    expect(op.service).toBe('service-a')
    expect(op.operationType).toBe('query')
    expect(op.operationName).toBe('GetUser')
    expect(op.discoveredVia).toBe('otel')

    // The edge originates from the resolver's FileNode at the exact call site —
    // file-grained, fused onto the EXTRACTED path (not the /var/task deployed one).
    const fileNodeId = fileId('service-a', 'src/resolvers/user.ts')
    const edgeId = `${EdgeType.CONTAINS}:OBSERVED:${fileNodeId}->${opId}`
    expect(ctx.graph.hasEdge(edgeId)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    expect(edge.type).toBe(EdgeType.CONTAINS)
    expect(edge.source).toBe(fileNodeId)
    expect(edge.target).toBe(opId)
    expect(edge.evidence?.file).toBe('src/resolvers/user.ts')
    expect(edge.evidence?.line).toBe(42)
  })

  it('keys a distinct node per (operationType, operationName) — a mutation is not a query', async () => {
    await handleSpan(ctx, graphqlSpan())
    await handleSpan(
      ctx,
      graphqlSpan({
        spanId: 'span-gql-2',
        name: 'mutation CreateUser',
        attributes: {
          'graphql.operation.name': 'CreateUser',
          'graphql.operation.type': 'mutation',
        },
        graphqlOperationName: 'CreateUser',
        graphqlOperationType: 'mutation',
      }),
    )

    const queryId = graphqlOperationId('service-a', 'query', 'GetUser')
    const mutationId = graphqlOperationId('service-a', 'mutation', 'CreateUser')
    expect(ctx.graph.hasNode(queryId)).toBe(true)
    expect(ctx.graph.hasNode(mutationId)).toBe(true)

    // No node collapse onto POST /graphql: two named operations, two nodes.
    const opNodes: string[] = []
    ctx.graph.forEachNode((id, a) => {
      if ((a as { type: string }).type === NodeType.GraphQLOperationNode) opNodes.push(id)
    })
    expect(new Set(opNodes)).toEqual(new Set([queryId, mutationId]))
  })

  it('stays service-level when the execution span carries no call site', async () => {
    await handleSpan(
      ctx,
      graphqlSpan({
        attributes: {
          'graphql.operation.name': 'GetUser',
          'graphql.operation.type': 'query',
        },
      }),
    )
    const opId = graphqlOperationId('service-a', 'query', 'GetUser')
    const edgeId = `${EdgeType.CONTAINS}:OBSERVED:service:service-a->${opId}`
    expect(ctx.graph.hasEdge(edgeId)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.source).toBe('service:service-a')
    expect(edge.evidence).toBeUndefined()
  })

  it('mints no operation node from the CLIENT side — client-side attribution is deferred', async () => {
    await handleSpan(ctx, graphqlSpan({ kind: 3 })) // CLIENT
    let opNodes = 0
    ctx.graph.forEachNode((_id, a) => {
      if ((a as { type: string }).type === NodeType.GraphQLOperationNode) opNodes++
    })
    expect(opNodes).toBe(0)
  })

  it('mints no operation node when the span names no operation type', async () => {
    await handleSpan(
      ctx,
      graphqlSpan({
        graphqlOperationType: undefined,
        attributes: { 'graphql.operation.name': 'GetUser' },
      }),
    )
    let opNodes = 0
    ctx.graph.forEachNode((_id, a) => {
      if ((a as { type: string }).type === NodeType.GraphQLOperationNode) opNodes++
    })
    expect(opNodes).toBe(0)
  })
})

// ── gRPC method spans (#616, ADR-123) ──────────────────────────────────────
// gRPC used to engage only at service grain: every method collapsed onto one
// service→service edge, so the per-method topology was invisible and one-sided.
// The serving span carries the method the caller invoked (`rpc.service` +
// `rpc.method` under `rpc.system=grpc`), so handleSpan mints an OBSERVED
// `service ──CONTAINS──▶ method` edge to a per-method node — keyed on the
// fully-qualified `rpc.service` so the static `.proto` extractor fuses onto the
// same id. Fixtures use REAL gRPC execution shape: SERVER wire kind (2), the
// `rpc.*` semconv, and an ABSOLUTE `code.filepath` the SpanProcessor stamps —
// reconciled onto the EXTRACTED path.
describe('handleSpan gRPC method spans (#616)', () => {
  let tmpDir: string
  let ctx: IngestContext

  beforeEach(async () => {
    resetParentSpanCache()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-grpc-'))
    ctx = { graph: newGraph(), errorsPath: path.join(tmpDir, 'errors.ndjson') }
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    resetParentSpanCache()
  })

  // An @opentelemetry SERVER span for a resolved gRPC unary call: SERVER kind (2),
  // the rpc semconv with a fully-qualified `rpc.service`, and a code.* call site
  // for the handler file.
  function grpcSpan(overrides: Partial<ParsedSpan> = {}): ParsedSpan {
    return {
      // The NEAT service (`service-a`) is deliberately not the gRPC service FQN
      // (`orders.OrderService`) — the method node keys on the wire FQN, not the
      // NEAT manifest name, so ownership and identity stay decoupled.
      service: 'service-a',
      traceId: 'trace-grpc',
      spanId: 'span-grpc',
      name: 'orders.OrderService/GetOrder',
      kind: 2, // SERVER
      startTimeUnixNano: '0',
      endTimeUnixNano: '0',
      durationNanos: 0n,
      env: 'unknown',
      attributes: {
        'rpc.system': 'grpc',
        'rpc.service': 'orders.OrderService',
        'rpc.method': 'GetOrder',
        'code.filepath': '/var/task/src/handlers/order.ts',
        'code.lineno': 17,
        'code.function': 'getOrder',
      },
      rpcSystem: 'grpc',
      rpcService: 'orders.OrderService',
      rpcMethod: 'GetOrder',
      statusCode: 0,
      ...overrides,
    }
  }

  it('mints a file-grained OBSERVED CONTAINS edge from the serving service to the method node', async () => {
    // The extractor already parsed the handler file the method runs in.
    ensureFileNode(ctx.graph, 'service-a', 'service:service-a', 'src/handlers/order.ts')

    await handleSpan(ctx, grpcSpan())

    // Keyed on the fully-qualified rpc.service so the static `.proto` definition
    // fuses onto the same id.
    const methodId = grpcMethodId('orders.OrderService', 'GetOrder')
    expect(methodId).toBe('grpc:orders.OrderService/GetOrder')
    expect(ctx.graph.hasNode(methodId)).toBe(true)
    const m = ctx.graph.getNodeAttributes(methodId) as GrpcMethodNode
    expect(m.type).toBe(NodeType.GrpcMethodNode)
    expect(m.name).toBe('orders.OrderService/GetOrder')
    expect(m.rpcService).toBe('orders.OrderService')
    expect(m.rpcMethod).toBe('GetOrder')
    expect(m.discoveredVia).toBe('otel')

    // The edge originates from the handler's FileNode at the exact call site —
    // file-grained, fused onto the EXTRACTED path (not the /var/task deployed one).
    const fileNodeId = fileId('service-a', 'src/handlers/order.ts')
    const edgeId = `${EdgeType.CONTAINS}:OBSERVED:${fileNodeId}->${methodId}`
    expect(ctx.graph.hasEdge(edgeId)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    expect(edge.type).toBe(EdgeType.CONTAINS)
    expect(edge.source).toBe(fileNodeId)
    expect(edge.target).toBe(methodId)
    expect(edge.evidence?.file).toBe('src/handlers/order.ts')
    expect(edge.evidence?.line).toBe(17)
  })

  it('keys a distinct node per (rpcService, rpcMethod) — no collapse onto a service edge', async () => {
    await handleSpan(ctx, grpcSpan())
    await handleSpan(
      ctx,
      grpcSpan({
        spanId: 'span-grpc-2',
        name: 'orders.OrderService/ListOrders',
        attributes: {
          'rpc.system': 'grpc',
          'rpc.service': 'orders.OrderService',
          'rpc.method': 'ListOrders',
        },
        rpcMethod: 'ListOrders',
      }),
    )

    const getId = grpcMethodId('orders.OrderService', 'GetOrder')
    const listId = grpcMethodId('orders.OrderService', 'ListOrders')
    const methodNodes: string[] = []
    ctx.graph.forEachNode((id, a) => {
      if ((a as { type: string }).type === NodeType.GrpcMethodNode) methodNodes.push(id)
    })
    expect(new Set(methodNodes)).toEqual(new Set([getId, listId]))
  })

  it('stays service-level when the serving span carries no call site', async () => {
    await handleSpan(
      ctx,
      grpcSpan({
        attributes: {
          'rpc.system': 'grpc',
          'rpc.service': 'orders.OrderService',
          'rpc.method': 'GetOrder',
        },
      }),
    )
    const methodId = grpcMethodId('orders.OrderService', 'GetOrder')
    const edgeId = `${EdgeType.CONTAINS}:OBSERVED:service:service-a->${methodId}`
    expect(ctx.graph.hasEdge(edgeId)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.source).toBe('service:service-a')
    expect(edge.evidence).toBeUndefined()
  })

  it('mints no method node from the CLIENT side — client-side attribution is deferred', async () => {
    await handleSpan(ctx, grpcSpan({ kind: 3 })) // CLIENT
    let methodNodes = 0
    ctx.graph.forEachNode((_id, a) => {
      if ((a as { type: string }).type === NodeType.GrpcMethodNode) methodNodes++
    })
    expect(methodNodes).toBe(0)
  })

  it('mints no method node when the span is not a gRPC RPC', async () => {
    // A non-grpc rpc.system (e.g. Connect / Thrift) is out of scope for this cut.
    await handleSpan(
      ctx,
      grpcSpan({
        rpcSystem: 'apache_thrift',
        attributes: {
          'rpc.system': 'apache_thrift',
          'rpc.service': 'orders.OrderService',
          'rpc.method': 'GetOrder',
        },
      }),
    )
    let methodNodes = 0
    ctx.graph.forEachNode((_id, a) => {
      if ((a as { type: string }).type === NodeType.GrpcMethodNode) methodNodes++
    })
    expect(methodNodes).toBe(0)
  })
})

// ── WebSocket channel spans (#617, ADR-125) ────────────────────────────────
// A WebSocket app used to produce no OBSERVED topology at all: only
// message-handler errors surfaced, as incidents, and the channels themselves
// stayed invisible. The one span that reliably marks a channel is the HTTP
// upgrade handshake that opens it: a SERVER `GET` carrying `Upgrade: websocket`
// and the connection path. handleSpan mints a per-channel WebSocketChannelNode
// and an OBSERVED `service ──CONNECTS_TO──▶ ws-channel` edge — reusing the
// connection edge, not a new edge type. The node is OBSERVED-only; the edge
// carries `lastObserved` and decays OBSERVED → STALE on CONNECTS_TO's threshold.
describe('handleSpan WebSocket channel spans (#617)', () => {
  let tmpDir: string
  let ctx: IngestContext

  beforeEach(async () => {
    resetParentSpanCache()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-ws-'))
    ctx = { graph: newGraph(), errorsPath: path.join(tmpDir, 'errors.ndjson') }
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    resetParentSpanCache()
  })

  // A real HTTP upgrade span: SERVER kind (2), a `GET` carrying
  // `Upgrade: websocket`, the templated channel path, and a code.* call site for
  // the handler file. otel.ts derives `websocketChannel` from these attrs; the
  // fixture sets it directly the way parseOtlpRequest would.
  function wsSpan(overrides: Partial<ParsedSpan> = {}): ParsedSpan {
    return {
      service: 'service-a',
      traceId: 'trace-ws',
      spanId: 'span-ws',
      name: 'GET /chat',
      kind: 2, // SERVER
      startTimeUnixNano: '0',
      endTimeUnixNano: '0',
      durationNanos: 0n,
      env: 'unknown',
      attributes: {
        'http.request.method': 'GET',
        'http.request.header.upgrade': ['websocket'],
        'http.route': '/chat',
        'code.filepath': '/var/task/src/ws/chat.ts',
        'code.lineno': 12,
        'code.function': 'onConnect',
      },
      websocketChannel: '/chat',
      statusCode: 0,
      ...overrides,
    }
  }

  it('mints a file-grained OBSERVED CONNECTS_TO edge from the serving service to the channel node', async () => {
    // The extractor already parsed the handler file the channel runs in.
    ensureFileNode(ctx.graph, 'service-a', 'service:service-a', 'src/ws/chat.ts')

    await handleSpan(ctx, wsSpan())

    const channelId = websocketChannelId('service-a', '/chat')
    expect(channelId).toBe('ws:service-a:/chat')
    expect(ctx.graph.hasNode(channelId)).toBe(true)
    const ch = ctx.graph.getNodeAttributes(channelId) as WebSocketChannelNode
    expect(ch.type).toBe(NodeType.WebSocketChannelNode)
    expect(ch.name).toBe('/chat')
    expect(ch.service).toBe('service-a')
    expect(ch.channel).toBe('/chat')
    expect(ch.discoveredVia).toBe('otel')
    // OBSERVED-only — no static twin, so path/line stay absent, never fabricated.
    expect(ch.path).toBeUndefined()
    expect(ch.line).toBeUndefined()

    // The edge reuses CONNECTS_TO (no new edge type) and originates from the
    // handler's FileNode at the exact call site, fused onto the EXTRACTED path.
    const fileNodeId = fileId('service-a', 'src/ws/chat.ts')
    const edgeId = `${EdgeType.CONNECTS_TO}:OBSERVED:${fileNodeId}->${channelId}`
    expect(ctx.graph.hasEdge(edgeId)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    expect(edge.type).toBe(EdgeType.CONNECTS_TO)
    expect(edge.source).toBe(fileNodeId)
    expect(edge.target).toBe(channelId)
    expect(edge.evidence?.file).toBe('src/ws/chat.ts')
    expect(edge.evidence?.line).toBe(12)
  })

  it('keys a distinct node per channel path, scoped to the serving service', async () => {
    await handleSpan(ctx, wsSpan())
    await handleSpan(
      ctx,
      wsSpan({
        spanId: 'span-ws-2',
        name: 'GET /notifications',
        attributes: {
          'http.request.method': 'GET',
          'http.request.header.upgrade': ['websocket'],
          'http.route': '/notifications',
        },
        websocketChannel: '/notifications',
      }),
    )

    const chatId = websocketChannelId('service-a', '/chat')
    const notifId = websocketChannelId('service-a', '/notifications')
    const channelNodes: string[] = []
    ctx.graph.forEachNode((id, a) => {
      if ((a as { type: string }).type === NodeType.WebSocketChannelNode) channelNodes.push(id)
    })
    expect(new Set(channelNodes)).toEqual(new Set([chatId, notifId]))
  })

  it('stays service-level when the upgrade span carries no call site', async () => {
    await handleSpan(
      ctx,
      wsSpan({
        attributes: {
          'http.request.method': 'GET',
          'http.request.header.upgrade': ['websocket'],
          'http.route': '/chat',
        },
      }),
    )
    const channelId = websocketChannelId('service-a', '/chat')
    const edgeId = `${EdgeType.CONNECTS_TO}:OBSERVED:service:service-a->${channelId}`
    expect(ctx.graph.hasEdge(edgeId)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.source).toBe('service:service-a')
    expect(edge.evidence).toBeUndefined()
  })

  it('mints no channel node from the CLIENT side — client-side attribution is deferred', async () => {
    await handleSpan(ctx, wsSpan({ kind: 3 })) // CLIENT
    let channelNodes = 0
    ctx.graph.forEachNode((_id, a) => {
      if ((a as { type: string }).type === NodeType.WebSocketChannelNode) channelNodes++
    })
    expect(channelNodes).toBe(0)
  })

  it('mints no channel node when the span carries no WebSocket channel', async () => {
    // A plain GET route span (no Upgrade header) never derives a channel.
    await handleSpan(
      ctx,
      wsSpan({
        websocketChannel: undefined,
        attributes: { 'http.request.method': 'GET', 'http.route': '/chat' },
      }),
    )
    let channelNodes = 0
    ctx.graph.forEachNode((_id, a) => {
      if ((a as { type: string }).type === NodeType.WebSocketChannelNode) channelNodes++
    })
    expect(channelNodes).toBe(0)
  })

  it('decays the channel CONNECTS_TO edge OBSERVED → STALE past the CONNECTS_TO threshold', async () => {
    // No call site here so the edge stays service-level with a deterministic id.
    await handleSpan(
      ctx,
      wsSpan({
        attributes: {
          'http.request.method': 'GET',
          'http.request.header.upgrade': ['websocket'],
          'http.route': '/chat',
        },
      }),
    )
    const channelId = websocketChannelId('service-a', '/chat')
    const edgeId = `${EdgeType.CONNECTS_TO}:OBSERVED:service:service-a->${channelId}`
    expect(ctx.graph.hasEdge(edgeId)).toBe(true)
    // Freshly observed — still OBSERVED right after the upgrade span.
    expect((ctx.graph.getEdgeAttributes(edgeId) as GraphEdge).provenance).toBe(Provenance.OBSERVED)

    // The channel goes quiet: five hours later, past CONNECTS_TO's 4h default.
    const now = Date.now() + 5 * 60 * 60 * 1000
    const result = await markStaleEdges(ctx.graph, { now })
    expect(result.count).toBe(1)
    const decayed = ctx.graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(decayed.provenance).toBe(Provenance.STALE)
  })
})

// #693 — a snapshot pushed to /snapshot used to have its node/edge entries
// cast straight to GraphNode/GraphEdge with no shape check ahead of
// graph.addNode()/addEdgeWithKey(). These tests drive mergeSnapshot directly
// with a payload shaped like what `JSON.parse` would hand back from a hostile
// or corrupted POST body — no schemaVersion problem, just an attributes
// object that doesn't match GraphNodeSchema / GraphEdgeSchema.
describe('mergeSnapshot (#693 — schema validation)', () => {
  function snapshotOf(
    nodes: Array<{ key: string; attributes?: unknown }>,
    edges: Array<{ key?: string; source: string; target: string; attributes?: unknown }> = [],
  ): PersistedGraph {
    return {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      graph: { nodes, edges } as unknown as PersistedGraph['graph'],
    }
  }

  it('merges a well-formed snapshot as before', () => {
    const graph = newGraph()
    const snapshot = snapshotOf([
      {
        key: 'service:service-c',
        attributes: {
          id: 'service:service-c',
          type: NodeType.ServiceNode,
          name: 'service-c',
          language: 'javascript',
        },
      },
    ])
    const result = mergeSnapshot(graph, snapshot)
    expect(result).toEqual({ nodesAdded: 1, edgesAdded: 0 })
    expect(graph.hasNode('service:service-c')).toBe(true)
  })

  it('rejects a snapshot carrying a node with an unrecognised `type` — and merges nothing at all', () => {
    const graph = newGraph()
    const snapshot = snapshotOf([
      {
        key: 'service:service-c',
        attributes: {
          id: 'service:service-c',
          type: NodeType.ServiceNode,
          name: 'service-c',
          language: 'javascript',
        },
      },
      {
        // Not a real NodeType literal — GraphNodeSchema's discriminated union
        // rejects it. Before #693 this landed on the graph unchanged.
        key: 'service:evil',
        attributes: { id: 'service:evil', type: 'DefinitelyNotARealNodeType', name: 'evil' },
      },
    ])

    expect(() => mergeSnapshot(graph, snapshot)).toThrow(SnapshotValidationError)
    // Whole-snapshot rejection: even the well-formed sibling node in the same
    // payload must not have been merged.
    expect(graph.hasNode('service:service-c')).toBe(false)
    expect(graph.hasNode('service:evil')).toBe(false)
  })

  it('rejects a snapshot carrying an edge with an invalid provenance, and reports it in `issues`', () => {
    const graph = newGraph()
    const snapshot = snapshotOf(
      [],
      [
        {
          key: 'CALLS:service:service-a->service:service-b',
          source: 'service:service-a',
          target: 'service:service-b',
          attributes: {
            id: 'CALLS:service:service-a->service:service-b',
            source: 'service:service-a',
            target: 'service:service-b',
            type: EdgeType.CALLS,
            // Not one of the four Provenance enum values.
            provenance: 'HALLUCINATED',
          },
        },
      ],
    )

    let caught: unknown
    try {
      mergeSnapshot(graph, snapshot)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SnapshotValidationError)
    expect((caught as SnapshotValidationError).issues.length).toBe(1)
    expect((caught as SnapshotValidationError).issues[0]).toContain(
      'CALLS:service:service-a->service:service-b',
    )
    expect(graph.hasEdge('CALLS:service:service-a->service:service-b')).toBe(false)
  })
})
