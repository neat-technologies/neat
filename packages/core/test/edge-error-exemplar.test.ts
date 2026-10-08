import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { MultiDirectedGraph } from 'graphology'
import { EdgeType, NodeType, type GraphEdge, type GraphNode } from '@neat.is/types'
import { EDGE_ERROR_MESSAGE_MAX, handleSpan, type IngestContext } from '../src/ingest.js'
import type { ParsedSpan } from '../src/otel.js'
import type { NeatGraph } from '../src/graph.js'

// ADR-236 — the OBSERVED error edge carries a bounded last-error exemplar. Before
// this, an edge recorded an error COUNT but dropped the span's real exception, so
// a timeout, a deadlock, and a connection-refused were indistinguishable at the
// edge surface. The exemplar carries WHAT failed (exception type + message, and
// the HTTP status when the failure is an HTTP one), last-write-wins, no history.
// The incident ledger still records the full exception independently — this is
// the edge-level complement, not a replacement.

const EDGE_ID = `${EdgeType.CALLS}:OBSERVED:service:service-a->service:service-b`

function newGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  for (const name of ['service-a', 'service-b']) {
    g.addNode(`service:${name}`, {
      id: `service:${name}`,
      type: NodeType.ServiceNode,
      name,
      language: 'javascript',
    } as GraphNode)
  }
  return g
}

// A CLIENT HTTP span from service-a to service-b. Overrides carry the failure
// shape under test (status, exception event, HTTP response code).
function clientSpan(overrides: Partial<ParsedSpan> = {}): ParsedSpan {
  return {
    service: 'service-a',
    traceId: 'trace-1',
    spanId: 'span-a',
    name: 'GET /query',
    kind: 3, // CLIENT — mints the OBSERVED CALLS edge from the caller side
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

function signalOf(g: NeatGraph): NonNullable<GraphEdge['signal']> {
  const edge = g.getEdgeAttributes(EDGE_ID) as GraphEdge
  return edge.signal!
}

describe('edge last-error exemplar (ADR-236)', () => {
  let tmpDir: string
  let ctx: IngestContext

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-edge-exemplar-'))
    ctx = {
      graph: newGraph(),
      errorsPath: path.join(tmpDir, 'errors.ndjson'),
    }
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('mints an OBSERVED error edge whose signal.lastError carries the exception type + message', async () => {
    await handleSpan(
      ctx,
      clientSpan({
        statusCode: 2,
        exception: { type: 'DeadlineExceeded', message: 'context deadline exceeded' },
      }),
    )
    expect(ctx.graph.hasEdge(EDGE_ID)).toBe(true)
    const signal = signalOf(ctx.graph)
    expect(signal.errorCount).toBe(1)
    expect(signal.lastError).toBeDefined()
    expect(signal.lastError!.exceptionType).toBe('DeadlineExceeded')
    expect(signal.lastError!.message).toBe('context deadline exceeded')
    // `at` mirrors `lastObserved` — the span's own observation time.
    expect(signal.lastError!.at).toBeTruthy()
  })

  it('distinguishes two failures that read identically on errorCount alone', async () => {
    // A deadline and a connection-refused both land as `errors=1` without the
    // exemplar — the exact gap ADR-236 closes.
    const gDeadline = { graph: newGraph(), errorsPath: path.join(tmpDir, 'a.ndjson') }
    const gRefused = { graph: newGraph(), errorsPath: path.join(tmpDir, 'b.ndjson') }
    await handleSpan(gDeadline, clientSpan({ statusCode: 2, exception: { type: 'DeadlineExceeded' } }))
    await handleSpan(
      gRefused,
      clientSpan({ statusCode: 2, exception: { type: 'ConnectionError', message: 'ECONNREFUSED' } }),
    )
    const a = gDeadline.graph.getEdgeAttributes(EDGE_ID) as GraphEdge
    const b = gRefused.graph.getEdgeAttributes(EDGE_ID) as GraphEdge
    expect(a.signal!.errorCount).toBe(b.signal!.errorCount) // same count…
    expect(a.signal!.lastError!.exceptionType).not.toBe(b.signal!.lastError!.exceptionType) // …different nature
  })

  it('captures the HTTP response status when the failure is an HTTP 5xx', async () => {
    await handleSpan(
      ctx,
      clientSpan({ attributes: { 'http.method': 'GET', 'server.address': 'service-b', 'http.response.status_code': 503 } }),
    )
    const signal = signalOf(ctx.graph)
    // A 5xx is an edge error (otel-ingest.md §errorCount) and carries the status.
    expect(signal.errorCount).toBe(1)
    expect(signal.lastError!.httpStatusCode).toBe(503)
  })

  it('leaves a prior exemplar untouched on a later clean call (last-write-wins, no clobber)', async () => {
    await handleSpan(
      ctx,
      clientSpan({ statusCode: 2, exception: { type: 'DeadlineExceeded', message: 'deadline' } }),
    )
    // A clean follow-up on the same edge: spanCount advances, errorCount holds,
    // and the exemplar is NOT cleared — it names the last thing that DID fail.
    await handleSpan(ctx, clientSpan({ spanId: 'span-a2', statusCode: 0 }))
    const signal = signalOf(ctx.graph)
    expect(signal.spanCount).toBe(2)
    expect(signal.errorCount).toBe(1)
    expect(signal.lastError).toBeDefined()
    expect(signal.lastError!.exceptionType).toBe('DeadlineExceeded')
  })

  it('overwrites the exemplar with the most recent failing observation (last-write-wins)', async () => {
    await handleSpan(
      ctx,
      clientSpan({ statusCode: 2, exception: { type: 'DeadlineExceeded', message: 'first' } }),
    )
    await handleSpan(
      ctx,
      clientSpan({
        spanId: 'span-a2',
        statusCode: 2,
        exception: { type: 'ConnectionError', message: 'second' },
      }),
    )
    const signal = signalOf(ctx.graph)
    expect(signal.errorCount).toBe(2)
    expect(signal.lastError!.exceptionType).toBe('ConnectionError')
    expect(signal.lastError!.message).toBe('second')
  })

  it('leaves lastError absent on an edge that never carried a failure', async () => {
    await handleSpan(ctx, clientSpan({ statusCode: 0 }))
    const signal = signalOf(ctx.graph)
    expect(signal.errorCount).toBe(0)
    expect(signal.lastError).toBeUndefined()
  })

  it('bounds the exemplar message to EDGE_ERROR_MESSAGE_MAX characters', async () => {
    const huge = 'x'.repeat(EDGE_ERROR_MESSAGE_MAX + 500)
    await handleSpan(
      ctx,
      clientSpan({ statusCode: 2, exception: { type: 'E', message: huge } }),
    )
    const signal = signalOf(ctx.graph)
    expect(signal.lastError!.message!.length).toBe(EDGE_ERROR_MESSAGE_MAX)
  })
})
