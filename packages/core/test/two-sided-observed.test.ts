import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { parseOtlpRequest, type OtlpTracesRequest } from '../src/otel.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import type { GraphEdge, InfraNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  extractedEdgeId,
  observedEdgeId,
  fileId,
  infraId,
  routeId,
  serviceId,
} from '@neat.is/types'

// Issue #796 — the two coverage gaps the audit named were "integration-only":
// the Kafka producer/consumer path and the Python extraction path each had the
// EXTRACTED side and the OBSERVED side tested apart, but nothing drove a real
// runtime span end-to-end and proved it lands on the SAME node the static
// extractor minted. These tests close that: run the real extractor over a real
// fixture, then push a real OTLP span through parseOtlpRequest → handleSpan, and
// assert the declared edge and its observed twin fuse onto one node id.
//
// The fusion key is always the node id both sides compute independently: a Kafka
// topic (`infra:kafka-topic:<topic>`), a RouteNode (`route:<svc>:<method>:<path>`
// matched by normalized template), a SQL table (`infra:sql-table:<name>`). If the
// keys ever drift apart the graph twins instead of fusing — which is exactly what
// these tests would catch.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const KAFKA_FIXTURES = path.resolve(__dirname, 'fixtures', 'calls')
const ROUTE_FIXTURES = path.resolve(__dirname, 'fixtures', 'routes')
const SQLALCHEMY_FIXTURES = path.resolve(__dirname, 'fixtures', 'python-sqlalchemy')

function ctxFor(): IngestContext {
  return { graph: getGraph(), errorsPath: path.join(os.tmpdir(), 'neat-796-errors.ndjson') }
}

// One OTLP resource span, the shape an OTel exporter actually POSTs to /v1/traces.
function otlp(service: string, attrs: Record<string, string | number>, kind: number): OtlpTracesRequest {
  const attributes = Object.entries(attrs).map(([key, value]) =>
    typeof value === 'number'
      ? { key, value: { intValue: String(value) } }
      : { key, value: { stringValue: value } },
  )
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'aabbccddeeff00112233445566778899',
                spanId: '1111111111111111',
                name: `${service} span`,
                kind,
                startTimeUnixNano: '1000000000000000000',
                endTimeUnixNano: '1000000000050000000',
                attributes,
                status: { code: 0 },
              },
            ],
          },
        ],
      },
    ],
  }
}

// Collect every edge of a given type pointing at a target node, regardless of
// provenance — the fused set the declared and observed edges must land in.
function edgesInto(target: string, type: EdgeType): GraphEdge[] {
  const graph = getGraph()
  const out: GraphEdge[] = []
  graph.forEachEdge((_id, a) => {
    const e = a as GraphEdge
    if (e.type === type && e.target === target) out.push(e)
  })
  return out
}

describe('Kafka produce/consume fuses declared with observed (#796)', () => {
  beforeEach(() => resetGraph())

  it('an observed PRODUCER span lands on the same topic node the extractor declared (orders)', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, KAFKA_FIXTURES)

    // EXTRACTED: `producer.send({ topic: 'orders' })` → file → topic PUBLISHES_TO.
    const topicId = infraId('kafka-topic', 'orders')
    expect(topicId).toBe('infra:kafka-topic:orders')
    const fileNodeId = fileId('fixture-kafka-service', 'index.js')
    const extractedPublish = extractedEdgeId(fileNodeId, topicId, EdgeType.PUBLISHES_TO)
    expect(graph.hasEdge(extractedPublish)).toBe(true)
    expect((graph.getEdgeAttributes(extractedPublish) as GraphEdge).provenance).toBe(
      Provenance.EXTRACTED,
    )

    // OBSERVED: a real kafkajs PRODUCER span (wire kind 4) publishing to `orders`,
    // carrying the JS call site the SpanProcessor stamps so it fuses file-grained.
    const [span] = parseOtlpRequest(
      otlp(
        'fixture-kafka-service',
        {
          'messaging.system': 'kafka',
          'messaging.operation': 'publish',
          'messaging.destination.name': 'orders',
          'code.filepath': '/app/index.js',
          'code.lineno': 8,
          'code.function': 'publish',
        },
        4,
      ),
    )
    expect(span!.messagingSystem).toBe('kafka')
    expect(span!.messagingDestination).toBe('orders')
    await handleSpan(ctxFor(), span!)

    // Exactly one `orders` topic node — the observed edge reused the extractor's
    // node id rather than forking an OTel-only twin.
    const topicNodes: string[] = []
    graph.forEachNode((id, a) => {
      const n = a as InfraNode & { type?: string }
      if (n.type === NodeType.InfraNode && n.kind === 'kafka-topic' && n.name === 'orders') {
        topicNodes.push(id)
      }
    })
    expect(topicNodes).toEqual([topicId])

    // The observed twin reaches that same topic. Its source reconciled onto the
    // EXTRACTED index.js — a symbol child of it (`code.function` names `publish`,
    // so the edge lands at symbol grain, ADR-158, one rung finer than the file →
    // topic declaration), never a raw `/app` deployed twin.
    const publishes = edgesInto(topicId, EdgeType.PUBLISHES_TO)
    const observed = publishes.filter((e) => e.provenance === Provenance.OBSERVED)
    expect(observed).toHaveLength(1)
    expect(observed[0]!.source).toContain('fixture-kafka-service:index.js')
    expect(graph.hasNode('file:fixture-kafka-service:app/index.js')).toBe(false)

    // Both provenances land on the one topic node: the declared file → topic edge
    // and its observed twin fuse rather than splitting the queue topology in two.
    expect(new Set(publishes.map((e) => e.provenance))).toEqual(
      new Set([Provenance.EXTRACTED, Provenance.OBSERVED]),
    )
  })

  it('an observed CONSUMER span lands on the same topic node the extractor declared (shipments)', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, KAFKA_FIXTURES)

    // EXTRACTED: `consumer.subscribe({ topic: 'shipments' })` → CONSUMES_FROM.
    const topicId = infraId('kafka-topic', 'shipments')
    const fileNodeId = fileId('fixture-kafka-service', 'index.js')
    expect(graph.hasEdge(extractedEdgeId(fileNodeId, topicId, EdgeType.CONSUMES_FROM))).toBe(true)

    // OBSERVED: a real kafkajs CONSUMER span (wire kind 5) reading `shipments`.
    const [span] = parseOtlpRequest(
      otlp(
        'fixture-kafka-service',
        {
          'messaging.system': 'kafka',
          'messaging.operation': 'process',
          'messaging.destination.name': 'shipments',
          'code.filepath': '/app/index.js',
          'code.lineno': 16,
          'code.function': 'listen',
        },
        5,
      ),
    )
    await handleSpan(ctxFor(), span!)

    const consumes = edgesInto(topicId, EdgeType.CONSUMES_FROM)
    const observed = consumes.filter((e) => e.provenance === Provenance.OBSERVED)
    expect(observed).toHaveLength(1)
    expect(observed[0]!.source).toContain('fixture-kafka-service:index.js')
    // Declared (file → topic) and observed twin both reach the one shipments node.
    expect(new Set(consumes.map((e) => e.provenance))).toEqual(
      new Set([Provenance.EXTRACTED, Provenance.OBSERVED]),
    )
  })

  it('reads the legacy messaging.destination key so a pre-semconv-rename span still fuses', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, KAFKA_FIXTURES)
    const topicId = infraId('kafka-topic', 'orders')

    // Older instrumentations emit `messaging.destination`, not the SC v1.24+
    // `messaging.destination.name`. Ingest reads both, so the same #879/ADR-179
    // class of semconv-rename bug can't leave the observed twin dark here.
    const [span] = parseOtlpRequest(
      otlp(
        'fixture-kafka-service',
        {
          'messaging.system': 'kafka',
          'messaging.destination': 'orders',
          'code.filepath': '/app/index.js',
          'code.lineno': 8,
        },
        4,
      ),
    )
    expect(span!.messagingDestination).toBe('orders')
    await handleSpan(ctxFor(), span!)

    expect(new Set(edgesInto(topicId, EdgeType.PUBLISHES_TO).map((e) => e.provenance))).toEqual(
      new Set([Provenance.EXTRACTED, Provenance.OBSERVED]),
    )
  })
})

describe('Python service fuses declared with observed (#796)', () => {
  beforeEach(() => resetGraph())

  it('an observed FastAPI SERVER http.route span fuses onto the extracted RouteNode', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, ROUTE_FIXTURES)

    // EXTRACTED: `@items.get("/{item_id}")` under `APIRouter(prefix="/items")`.
    const rid = routeId('fastapi-server', 'GET', '/items/{item_id}')
    expect(graph.hasNode(rid)).toBe(true)
    const svc = serviceId('fastapi-server')
    const extractedContains = extractedEdgeId(svc, rid, EdgeType.CONTAINS)
    expect(graph.hasEdge(extractedContains)).toBe(true)
    expect((graph.getEdgeAttributes(extractedContains) as GraphEdge).provenance).toBe(
      Provenance.EXTRACTED,
    )

    // OBSERVED: a real FastAPI SERVER span (wire kind 2) carrying the matched
    // route template `http.route`. The declared `{item_id}` and the served
    // template collapse to the same normalized key, so the span fuses onto the
    // declared route instead of minting an OTel-only route.
    const [span] = parseOtlpRequest(
      otlp(
        'fastapi-server',
        { 'http.route': '/items/{item_id}', 'http.request.method': 'GET' },
        2,
      ),
    )
    expect(span!.httpRoute).toBe('/items/{item_id}')
    await handleSpan(ctxFor(), span!)

    const observedContains = observedEdgeId(svc, rid, EdgeType.CONTAINS)
    expect(graph.hasEdge(observedContains)).toBe(true)
    expect((graph.getEdgeAttributes(observedContains) as GraphEdge).provenance).toBe(
      Provenance.OBSERVED,
    )

    // One RouteNode, both provenances reach it on the same service → route grain.
    const contains = edgesInto(rid, EdgeType.CONTAINS)
    expect(new Set(contains.map((e) => e.provenance))).toEqual(
      new Set([Provenance.EXTRACTED, Provenance.OBSERVED]),
    )
    expect(new Set(contains.map((e) => e.source))).toEqual(new Set([svc]))
  })

  it("an observed FastAPI span whose http.route uses a different param syntax still fuses", async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, ROUTE_FIXTURES)
    const rid = routeId('fastapi-server', 'GET', '/items/{item_id}')

    // Same route served, but the span names the param `:item_id` (the reduced
    // form a proxy / different instrumentation can emit). normalizePathTemplate
    // collapses `{item_id}` and `:item_id` to the same key, so it still lands.
    const [span] = parseOtlpRequest(
      otlp('fastapi-server', { 'http.route': '/items/:item_id', 'http.request.method': 'GET' }, 2),
    )
    await handleSpan(ctxFor(), span!)

    expect(graph.hasEdge(observedEdgeId(serviceId('fastapi-server'), rid, EdgeType.CONTAINS))).toBe(
      true,
    )
  })

  it('an observed SQLAlchemy SQL span recovers its table from db.statement and fuses onto the extracted sql-table', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, SQLALCHEMY_FIXTURES)

    // EXTRACTED: `class Order(Base): __tablename__ = "orders"` → sql-table, with a
    // CALLS edge from every file that touches it (models.py defines, routes.py queries).
    const tableId = infraId('sql-table', 'orders')
    expect(graph.hasNode(tableId)).toBe(true)
    const extractedCalls = edgesInto(tableId, EdgeType.CALLS).filter(
      (e) => e.provenance === Provenance.EXTRACTED,
    )
    expect(extractedCalls.length).toBeGreaterThan(0)

    // OBSERVED: a real SQLAlchemy CLIENT span (wire kind 3). The dbapi / SQLAlchemy
    // instrumentation emits no table attribute, so the table is recovered by
    // parsing db.statement — landing on the same `infra:sql-table:orders` node id.
    const [span] = parseOtlpRequest(
      otlp(
        'orders-api',
        {
          'db.system': 'postgresql',
          'db.name': 'ordersdb',
          'db.statement': 'SELECT "id", "amount" FROM "public"."orders" WHERE "id" = $1',
        },
        3,
      ),
    )
    // The observed side computed the same node id independently — the fusion key.
    expect(span!.dbTable).toBe('orders')
    await handleSpan(ctxFor(), span!)

    // The observed CALLS lands service-level (Python carries no JS-style code.*
    // call-site stamper yet — the honest current grain), but on the SAME table
    // node the extractor declared, so declared and observed table access fuse.
    const observedCall = observedEdgeId(serviceId('orders-api'), tableId, EdgeType.CALLS)
    expect(graph.hasEdge(observedCall)).toBe(true)
    expect((graph.getEdgeAttributes(observedCall) as GraphEdge).provenance).toBe(Provenance.OBSERVED)

    // One sql-table node, both provenances reach it — no twin.
    const sqlTableNodes: string[] = []
    graph.forEachNode((id, a) => {
      const n = a as InfraNode & { type?: string }
      if (n.type === NodeType.InfraNode && n.kind === 'sql-table' && n.name === 'orders') {
        sqlTableNodes.push(id)
      }
    })
    expect(sqlTableNodes).toEqual([tableId])
    expect(new Set(edgesInto(tableId, EdgeType.CALLS).map((e) => e.provenance))).toEqual(
      new Set([Provenance.EXTRACTED, Provenance.OBSERVED]),
    )
  })
})

describe('Next.js API routes fuse declared with observed (#1043)', () => {
  beforeEach(() => resetGraph())

  // Next.js names the matched route template on the span (and mirrors it in the
  // `next.span_name` attribute), NOT in `http.route` — so a Next fusion test has
  // to control the span name / attributes directly, which the shared `otlp`
  // helper (fixed name, no next attr) can't. `http.target` carries only the
  // concrete path a real request took, exactly as it does in production.
  function nextServerSpan(
    service: string,
    spanName: string,
    attrs: Record<string, string>,
  ): OtlpTracesRequest {
    const attributes = Object.entries(attrs).map(([key, value]) => ({
      key,
      value: { stringValue: value },
    }))
    return {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'aabbccddeeff00112233445566778899',
                  spanId: '2222222222222222',
                  name: spanName,
                  kind: 2,
                  startTimeUnixNano: '1000000000000000000',
                  endTimeUnixNano: '1000000000050000000',
                  attributes,
                  status: { code: 0 },
                },
              ],
            },
          ],
        },
      ],
    }
  }

  it('fuses an App-Router `executing api route (app)` span onto the extracted RouteNode', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, ROUTE_FIXTURES)

    // EXTRACTED: app/orders/[orderId]/route.ts exports GET → route:next-app:GET /orders/:orderId.
    const rid = routeId('next-app', 'GET', '/orders/:orderId')
    expect(graph.hasNode(rid)).toBe(true)
    const svc = serviceId('next-app')
    expect(graph.hasEdge(extractedEdgeId(svc, rid, EdgeType.CONTAINS))).toBe(true)

    // OBSERVED: the App Router names the template on the span, not http.route;
    // http.target carries only the concrete path, which never matches :orderId.
    const [span] = parseOtlpRequest(
      nextServerSpan('next-app', 'executing api route (app) /orders/[orderId]', {
        'http.request.method': 'GET',
        'http.target': '/orders/ord_9f3c8a',
      }),
    )
    expect(span!.httpRoute).toBeUndefined() // the template is NOT in http.route
    await handleSpan(ctxFor(), span!)

    const observed = observedEdgeId(svc, rid, EdgeType.CONTAINS)
    expect(graph.hasEdge(observed)).toBe(true)
    expect((graph.getEdgeAttributes(observed) as GraphEdge).provenance).toBe(Provenance.OBSERVED)

    // One RouteNode, both provenances, one service — declared and observed fused.
    const contains = edgesInto(rid, EdgeType.CONTAINS)
    expect(new Set(contains.map((e) => e.provenance))).toEqual(
      new Set([Provenance.EXTRACTED, Provenance.OBSERVED]),
    )
    expect(new Set(contains.map((e) => e.source))).toEqual(new Set([svc]))
  })

  it('fuses a Pages-Router catch-all `[...slug]` span read from the next.span_name attribute', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, ROUTE_FIXTURES)

    // EXTRACTED: pages/api/files/[...slug].ts → route:next-app:ALL /api/files/:slug.
    const rid = routeId('next-app', 'ALL', '/api/files/:slug')
    expect(graph.hasNode(rid)).toBe(true)

    // The template rides the `next.span_name` attribute here (span name left
    // generic), and the catch-all `[...slug]` collapses to the same :param key as
    // the declared `:slug` — so it lands on the one extracted node.
    const [span] = parseOtlpRequest(
      nextServerSpan('next-app', 'GET /api/files/[...slug]', {
        'next.span_name': 'executing api route (pages) /api/files/[...slug]',
        'http.request.method': 'GET',
        'http.target': '/api/files/2024/q3/report.pdf',
      }),
    )
    await handleSpan(ctxFor(), span!)

    const svc = serviceId('next-app')
    expect(graph.hasEdge(observedEdgeId(svc, rid, EdgeType.CONTAINS))).toBe(true)
    // Exactly one RouteNode carries the fused pair — no observed-only twin minted.
    const contains = edgesInto(rid, EdgeType.CONTAINS)
    expect(new Set(contains.map((e) => e.provenance))).toEqual(
      new Set([Provenance.EXTRACTED, Provenance.OBSERVED]),
    )
    expect(new Set(contains.map((e) => e.source))).toEqual(new Set([svc]))
  })

  it('still fuses a plain http.route span — the next.span_name source is additive', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, ROUTE_FIXTURES)
    const rid = routeId('next-app', 'ALL', '/api/legacy/:id')
    expect(graph.hasNode(rid)).toBe(true)

    // No `executing api route` phrase anywhere — the fusion falls back to
    // http.route exactly as it did before this change (the regression guard).
    const [span] = parseOtlpRequest(
      otlp('next-app', { 'http.route': '/api/legacy/:id', 'http.request.method': 'GET' }, 2),
    )
    await handleSpan(ctxFor(), span!)

    expect(graph.hasEdge(observedEdgeId(serviceId('next-app'), rid, EdgeType.CONTAINS))).toBe(true)
  })
})
