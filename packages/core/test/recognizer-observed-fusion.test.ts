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
  infraId,
  routeId,
  serviceId,
} from '@neat.is/types'

// Issue #998 — the route + data recognizers shipped this cycle (Go Chi / net/http
// / Echo / Fiber routes, GORM + raw-SQL data, Rails routes + ActiveRecord, Laravel
// routes + Eloquent) were verified extraction-side only: each test asserted the
// EXTRACTED node/template and, at most, that `normalizePathTemplate` agrees with a
// hand-written `http.route` string. None drove a real OTLP span through
// parseOtlpRequest → handleSpan to prove the observed side lands on the SAME node
// the extractor minted. These tests close that, the way two-sided-observed.test.ts
// (#796) did for Kafka / Python: run the real extractor over the real fixture, push
// a real span through the receiver's parse + ingest, and assert the declared edge
// and its observed twin fuse onto one node id — both provenances, no twin.
//
// The fusion key is the node id both sides compute independently:
//   • a RouteNode (`route:<svc>:<method>:<path>`), matched by normalized template.
//   • a SQL table (`infra:sql-table:<name>`), matched by name after the extractor's
//     pluralizer and the observed table (from db.query.text / db.collection.name)
//     resolve the same string. A mismatch here twins the table instead of fusing —
//     exactly the failure these tests would catch.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string): string => path.resolve(__dirname, 'fixtures', name)

function ctxFor(): IngestContext {
  return { graph: getGraph(), errorsPath: path.join(os.tmpdir(), 'neat-998-errors.ndjson') }
}

// One OTLP resource span, the shape an OTel exporter POSTs to /v1/traces.
function otlp(
  service: string,
  attrs: Record<string, string | number>,
  kind: number,
): OtlpTracesRequest {
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

// Every edge of a type pointing at a target, regardless of provenance — the fused
// set the declared and observed edges must both land in.
function edgesInto(target: string, type: EdgeType): GraphEdge[] {
  const out: GraphEdge[] = []
  getGraph().forEachEdge((_id, a) => {
    const e = a as GraphEdge
    if (e.type === type && e.target === target) out.push(e)
  })
  return out
}

// The ids of every sql-table node with a given name — [tableId] when fused, two
// entries when the observed table twinned the declared one.
function sqlTableNodesNamed(name: string): string[] {
  const ids: string[] = []
  getGraph().forEachNode((id, a) => {
    const n = a as InfraNode & { type?: string }
    if (n.type === NodeType.InfraNode && n.kind === 'sql-table' && n.name === name) ids.push(id)
  })
  return ids
}

// Drive a SERVER span (wire kind 2) carrying a matched `http.route` + method, then
// assert it fused onto the declared RouteNode: the observed CONTAINS twin exists,
// both provenances reach the one route node, and no second route node appeared.
async function assertRouteFuses(
  service: string,
  method: string,
  declaredTemplate: string,
  observedHttpRoute: string,
): Promise<void> {
  const graph = getGraph()
  const rid = routeId(service, method, declaredTemplate)
  const svc = serviceId(service)
  expect(graph.hasNode(rid), `declared RouteNode ${rid} should exist`).toBe(true)
  expect(graph.hasEdge(extractedEdgeId(svc, rid, EdgeType.CONTAINS))).toBe(true)

  const [span] = parseOtlpRequest(
    otlp(service, { 'http.route': observedHttpRoute, 'http.request.method': method }, 2),
  )
  expect(span!.httpRoute).toBe(observedHttpRoute)
  await handleSpan(ctxFor(), span!)

  // The observed SERVER span fused onto the declared route rather than landing
  // nowhere (a normalization mismatch) or minting a twin.
  expect(
    graph.hasEdge(observedEdgeId(svc, rid, EdgeType.CONTAINS)),
    `observed http.route "${observedHttpRoute}" should fuse onto ${rid}`,
  ).toBe(true)
  const contains = edgesInto(rid, EdgeType.CONTAINS)
  expect(new Set(contains.map((e) => e.provenance))).toEqual(
    new Set([Provenance.EXTRACTED, Provenance.OBSERVED]),
  )
}

// Drive a CLIENT db span (wire kind 3) whose SQL / table attribute names `table`,
// then assert it fused onto the declared sql-table: one node, an observed CALLS
// twin, both provenances, no second sql-table node of that name.
async function assertTableFuses(
  service: string,
  table: string,
  attrs: Record<string, string>,
): Promise<void> {
  const graph = getGraph()
  const tableId = infraId('sql-table', table)
  expect(graph.hasNode(tableId), `declared sql-table ${tableId} should exist`).toBe(true)
  const extractedCalls = edgesInto(tableId, EdgeType.CALLS).filter(
    (e) => e.provenance === Provenance.EXTRACTED,
  )
  expect(extractedCalls.length, `declared CALLS into ${tableId}`).toBeGreaterThan(0)

  const [span] = parseOtlpRequest(otlp(service, attrs, 3))
  expect(span!.dbTable, `ingest should recover table "${table}" from the span`).toBe(table)
  await handleSpan(ctxFor(), span!)

  expect(
    graph.hasEdge(observedEdgeId(serviceId(service), tableId, EdgeType.CALLS)),
    `observed db span should fuse onto ${tableId}`,
  ).toBe(true)
  // One node for the table — the pluralizer output and the observed table string
  // resolved to the same id rather than twinning.
  expect(sqlTableNodesNamed(table)).toEqual([tableId])
  expect(new Set(edgesInto(tableId, EdgeType.CALLS).map((e) => e.provenance))).toEqual(
    new Set([Provenance.EXTRACTED, Provenance.OBSERVED]),
  )
}

describe('Go routes fuse declared with observed (#998)', () => {
  const CHI = fixture('go-chi-nethttp')
  const ECHO_FIBER = fixture('go-echo-fiber')
  beforeEach(() => resetGraph())

  it('Chi: an observed SERVER http.route fuses onto the extracted RouteNode', async () => {
    await extractFromDirectory(getGraph(), CHI)
    await assertRouteFuses('chi-svc', 'GET', '/orders/{id}', '/orders/{id}')
  })

  it('Chi: a Route-closure-composed template fuses (the otelchi RoutePattern shape)', async () => {
    await extractFromDirectory(getGraph(), CHI)
    await assertRouteFuses('chi-svc', 'GET', '/articles/{articleID}', '/articles/{articleID}')
  })

  it('Chi: an observed :id-form http.route still fuses onto the {id}-form template', async () => {
    // Param-syntax difference (a proxy / different instrumentation emits `:id`);
    // normalizePathTemplate collapses `{id}` and `:id` to the same key.
    await extractFromDirectory(getGraph(), CHI)
    await assertRouteFuses('chi-svc', 'GET', '/orders/{id}', '/orders/:id')
  })

  it('Chi: an observed regex-constrained http.route fuses onto the stripped template', async () => {
    // The extractor strips `{id:[0-9]+}` to `/users/{id}`; a live otelchi span can
    // still carry the regex form. Both collapse to `/users/:param`.
    await extractFromDirectory(getGraph(), CHI)
    await assertRouteFuses('chi-svc', 'GET', '/users/{id}', '/users/{id:[0-9]+}')
  })

  it('net/http: an observed Go 1.22 ServeMux route fuses onto the extracted RouteNode', async () => {
    await extractFromDirectory(getGraph(), CHI)
    await assertRouteFuses('nethttp-svc', 'GET', '/orders/{id}', '/orders/{id}')
  })

  it('Echo: an observed http.route fuses onto the extracted RouteNode', async () => {
    await extractFromDirectory(getGraph(), ECHO_FIBER)
    await assertRouteFuses('echo-svc', 'GET', '/orders/:id', '/orders/:id')
  })

  it('Echo: a nested-group-composed template fuses (otelecho c.Path())', async () => {
    await extractFromDirectory(getGraph(), ECHO_FIBER)
    await assertRouteFuses('echo-svc', 'DELETE', '/admin/v1/users/:id', '/admin/v1/users/:id')
  })

  it('Fiber: an observed http.route fuses onto the extracted RouteNode', async () => {
    await extractFromDirectory(getGraph(), ECHO_FIBER)
    await assertRouteFuses('fiber-svc', 'GET', '/orders/:id', '/orders/:id')
  })

  it('Fiber: a nested-group + wildcard template fuses (otelfiber c.Route().Path)', async () => {
    await extractFromDirectory(getGraph(), ECHO_FIBER)
    await assertRouteFuses('fiber-svc', 'GET', '/api/v2/files/*', '/api/v2/files/*')
  })
})

describe('Go data (GORM) fuses declared with observed (#998)', () => {
  const GORM = fixture('go-gorm')
  const SVC = 'shop'
  beforeEach(() => resetGraph())

  it('an observed db.query.text span fuses onto the GORM-derived sql-table (orders)', async () => {
    await extractFromDirectory(getGraph(), GORM)
    await assertTableFuses(SVC, 'orders', {
      'db.system': 'postgresql',
      'db.name': 'shopdb',
      'db.query.text': 'SELECT id, code FROM orders WHERE id = $1',
    })
  })

  it('the GORM initialism pluralizer (APIKey → api_keys) lands the real runtime table', async () => {
    // GORM names APIKey's table `api_keys` at runtime (inflection.Plural(toDBName)).
    // The recognizer must derive the identical string or the observed span twins.
    await extractFromDirectory(getGraph(), GORM)
    await assertTableFuses(SVC, 'api_keys', {
      'db.system': 'postgresql',
      'db.query.text': 'SELECT id, token FROM api_keys WHERE id = $1',
    })
  })

  it('an observed db.collection.name (the db.sql.table semconv rename) fuses onto users', async () => {
    // The new OTel db semconv carries the ORM's resolved table as db.collection.name
    // (relational systems), the rename of the old db.sql.table. Ingest reads it as
    // the table directly — no SQL parse — and it must fuse onto the same node.
    await extractFromDirectory(getGraph(), GORM)
    await assertTableFuses(SVC, 'users', {
      'db.system': 'postgresql',
      'db.collection.name': 'users',
    })
  })
})

describe('Ruby / Rails fuses declared with observed (#998)', () => {
  const ROUTES = fixture('ruby-rails-baseline')
  const DATA = fixture('rails-activerecord')
  beforeEach(() => resetGraph())

  it('routes: an observed action_pack http.route (:id form) fuses onto the RouteNode', async () => {
    // Rails action_pack sets http.route to the `:id`-form template with `(.:format)`
    // stripped — `/orders/:id`, exactly the extractor's stored template.
    await extractFromDirectory(getGraph(), ROUTES)
    await assertRouteFuses('ruby-rails-baseline', 'GET', '/orders/:id', '/orders/:id')
  })

  it('routes: a nested :magazine_id route fuses', async () => {
    await extractFromDirectory(getGraph(), ROUTES)
    await assertRouteFuses(
      'ruby-rails-baseline',
      'GET',
      '/magazines/:magazine_id/ads/:id',
      '/magazines/:magazine_id/ads/:id',
    )
  })

  it('data: an observed db.query.text span fuses onto the schema.rb sql-table (orders)', async () => {
    // schema.rb names `orders` literally; the ActiveRecord/pg span carries the same
    // table in its SQL. They fuse on infra:sql-table:orders.
    await extractFromDirectory(getGraph(), DATA)
    await assertTableFuses('rails-activerecord', 'orders', {
      'db.system': 'postgresql',
      'db.name': 'railsdb',
      'db.query.text': 'SELECT id, code, total FROM orders WHERE id = $1',
    })
  })

  it('data: an observed db.collection.name span fuses onto users', async () => {
    await extractFromDirectory(getGraph(), DATA)
    await assertTableFuses('rails-activerecord', 'users', {
      'db.system': 'postgresql',
      'db.collection.name': 'users',
    })
  })
})

describe('PHP / Laravel fuses declared with observed (#998)', () => {
  const ROUTES = fixture('php-laravel-baseline')
  const DATA = fixture('php-laravel-eloquent')
  beforeEach(() => resetGraph())

  it('routes: an observed http.route (Laravel no-leading-slash form) fuses onto the RouteNode', async () => {
    // Laravel's instrumentation sets http.route to the templated URI with no leading
    // slash (`orders/{id}`); normalizePathTemplate re-roots it before comparison.
    await extractFromDirectory(getGraph(), ROUTES)
    await assertRouteFuses('php-laravel-baseline', 'GET', '/orders/{id}', 'orders/{id}')
  })

  it('routes: an api-prefixed resource route fuses', async () => {
    await extractFromDirectory(getGraph(), ROUTES)
    await assertRouteFuses('php-laravel-baseline', 'GET', '/api/photos/{photo}', 'api/photos/{photo}')
  })

  it('data: an observed db.query.text span fuses onto the migration sql-table (orders)', async () => {
    // The Schema::create('orders', …) migration is the literal table anchor; the
    // Eloquent/pdo span carries the same table in its SQL. They fuse.
    await extractFromDirectory(getGraph(), DATA)
    await assertTableFuses('php-laravel-eloquent', 'orders', {
      'db.system': 'mysql',
      'db.name': 'shop',
      'db.query.text': 'SELECT id, code, total FROM orders WHERE id = ?',
    })
  })

  it('data: an observed db.collection.name span fuses onto users', async () => {
    await extractFromDirectory(getGraph(), DATA)
    await assertTableFuses('php-laravel-eloquent', 'users', {
      'db.system': 'mysql',
      'db.collection.name': 'users',
    })
  })
})
