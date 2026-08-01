import { describe, it, expect } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EdgeType, extractedEdgeId, fileId, infraId, type ColumnAttr, type GraphEdge, type InfraNode } from '@neat.is/types'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { flaskSqlalchemyTableName, sqlalchemyEndpointsFromFile } from '../src/extract/calls/sqlalchemy.js'
import { columnsFromSqlStatement, tableFromSqlStatement, type ParsedSpan } from '../src/otel.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'python-sqlalchemy')
const DJANGO_FIXTURES = path.resolve(__dirname, 'fixtures', 'python-django')

// ADR-152 — the SQLAlchemy analog of the Mongoose collection work. The static
// extractor derives the table a model maps to (verbatim, the fusion key); the
// OBSERVED side recovers the table by parsing db.statement (no table attribute
// is emitted). Both land on infra:sql-table:<name> so declared and observed
// table access fuse.

describe('Flask-SQLAlchemy camel_to_snake table naming (the fusion key)', () => {
  // Every expected value was produced by the real installed flask_sqlalchemy
  // camel_to_snake_case in a live capture — quirks preserved, not "corrected".
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['User', 'user'],
    ['UserProfile', 'user_profile'],
    ['HTTPRequest', 'http_request'],
    ['APIKey', 'api_key'],
    ['Order', 'order'],
    ['OAuth2Token', 'o_auth2_token'],
    ['URL', 'url'],
    ['Order2Line', 'order2_line'],
    ['MyURLShortener', 'my_url_shortener'],
    ['userProfile', 'user_profile'],
    ['A', 'a'],
    ['AB', 'ab'],
    ['ABC', 'abc'],
  ]
  for (const [cls, tbl] of cases) {
    it(`${cls} → ${tbl}`, () => expect(flaskSqlalchemyTableName(cls)).toBe(tbl))
  }
})

describe('sqlalchemyEndpointsFromFile', () => {
  const src = [
    'from sqlalchemy import Table, Column, Integer, MetaData',
    'from sqlalchemy.orm import declarative_base',
    'from flask_sqlalchemy import SQLAlchemy',
    'Base = declarative_base()',
    'db = SQLAlchemy()',
    'metadata = MetaData()',
    'class Order(Base):',
    '    __tablename__ = "orders"',
    'class UserProfile(db.Model):',
    '    id = Column(Integer, primary_key=True)',
    'audit_log = Table("audit_log", metadata, Column("id", Integer))',
    '',
  ].join('\n')

  it('names explicit __tablename__, Flask-derived, and native Table() tables', () => {
    const eps = sqlalchemyEndpointsFromFile({ path: '/svc/models.py', content: src }, '/svc')
    const names = eps.map((e) => e.name).sort()
    expect(names).toEqual(['audit_log', 'orders', 'user_profile'])

    const order = eps.find((e) => e.name === 'orders')!
    expect(order.infraId).toBe(infraId('sql-table', 'orders'))
    expect(order.kind).toBe('sql-table')
    expect(order.edgeType).toBe('CALLS')
    expect(order.confidenceKind).toBe('verified-call-site')
    expect(order.evidence.file).toBe('models.py')
    expect(order.evidence.line).toBeGreaterThan(0)
  })

  it('is inert without a sqlalchemy import (the dependency gate)', () => {
    expect(sqlalchemyEndpointsFromFile({ path: '/svc/x.py', content: 'x = 1\n' }, '/svc')).toHaveLength(0)
  })

  it('never guesses a computed __tablename__', () => {
    const computed = 'from sqlalchemy.orm import declarative_base\nclass X(Base):\n    __tablename__ = prefix + "t"\n'
    expect(sqlalchemyEndpointsFromFile({ path: '/svc/m.py', content: computed }, '/svc')).toHaveLength(0)
  })
})

describe('tableFromSqlStatement (OBSERVED table recovery from db.statement)', () => {
  it('parses the table from a real SQLAlchemy SELECT (columns are qualified)', () => {
    const sql = 'SELECT otel_probe_orders.id AS otel_probe_orders_id \nFROM otel_probe_orders'
    expect(tableFromSqlStatement(sql)).toBe('otel_probe_orders')
  })

  it('parses INSERT / UPDATE / DELETE targets', () => {
    expect(tableFromSqlStatement('INSERT INTO orders (id) VALUES (1)')).toBe('orders')
    expect(tableFromSqlStatement('UPDATE orders SET name = 1 WHERE id = 2')).toBe('orders')
    expect(tableFromSqlStatement('DELETE FROM orders WHERE id = 1')).toBe('orders')
  })

  it('strips schema qualifier and double quotes', () => {
    expect(tableFromSqlStatement('SELECT * FROM public.orders')).toBe('orders')
    expect(tableFromSqlStatement('SELECT * FROM "Orders"')).toBe('Orders')
  })

  it('degrades to null on joins and subqueries rather than guessing', () => {
    expect(tableFromSqlStatement('SELECT * FROM orders o JOIN lines l ON l.oid = o.id')).toBeNull()
    expect(tableFromSqlStatement('SELECT * FROM (SELECT id FROM inner_t) t')).toBeNull()
  })

  it('ignores DDL and empty statements', () => {
    expect(tableFromSqlStatement('CREATE TABLE orders (id integer)')).toBeNull()
    expect(tableFromSqlStatement('')).toBeNull()
  })
})

describe('columnsFromSqlStatement (OBSERVED column recovery from db.statement, ADR-157)', () => {
  const cols = (sql: string): string[] => columnsFromSqlStatement(sql).sort()

  it('recovers quoted, schema-qualified projection + WHERE columns', () => {
    // The exact shape a PostgREST / real Postgres statement carries.
    expect(cols('SELECT "id", "amount" FROM "public"."orders" WHERE "id" = $1')).toEqual([
      'amount',
      'id',
    ])
  })

  it('drops the SQLAlchemy `AS <table>_<col>` alias, recovering the REAL column', () => {
    // The crux: `orders.id AS orders_id` is one column (`id`), never `orders_id`.
    expect(columnsFromSqlStatement('SELECT orders.id AS orders_id \nFROM orders')).toEqual(['id'])
    expect(
      columnsFromSqlStatement(
        'SELECT otel_probe_orders.id AS otel_probe_orders_id FROM otel_probe_orders',
      ),
    ).toEqual(['id'])
    // The alias name must never leak through as a column.
    expect(columnsFromSqlStatement('SELECT orders.id AS orders_id FROM orders')).not.toContain(
      'orders_id',
    )
  })

  it('reads INSERT column lists', () => {
    expect(cols('INSERT INTO "public"."audit_log" ("event") VALUES ($1)')).toEqual(['event'])
    expect(cols('INSERT INTO orders (id, amount) VALUES (1, 2)')).toEqual(['amount', 'id'])
  })

  it('reads UPDATE SET targets plus WHERE predicates', () => {
    expect(cols('UPDATE orders SET name = $1 WHERE id = $2')).toEqual(['id', 'name'])
  })

  it('reads DELETE WHERE predicates', () => {
    expect(cols('DELETE FROM orders WHERE id = $1')).toEqual(['id'])
    expect(columnsFromSqlStatement('DELETE FROM orders')).toEqual([])
  })

  it('degrades to no columns on join / subquery / SELECT * / aggregate', () => {
    expect(columnsFromSqlStatement('SELECT * FROM public.orders')).toEqual([])
    expect(columnsFromSqlStatement('SELECT count(*) FROM pg_stat_activity')).toEqual([])
    expect(
      columnsFromSqlStatement('SELECT o.id FROM orders o JOIN lines l ON l.oid = o.id'),
    ).toEqual([])
    expect(columnsFromSqlStatement('SELECT id FROM (SELECT id FROM inner_t) t')).toEqual([])
    expect(columnsFromSqlStatement('CREATE TABLE orders (id integer)')).toEqual([])
    expect(columnsFromSqlStatement('')).toEqual([])
  })

  it('REAL fixture — parses the checked-in pg_stat_statements with ZERO alias leakage', () => {
    // The discipline that caught the symbol-grain bug: run the parser over the
    // real captured fixture, not a hand-written string, and assert the exact
    // column sets. `orders_id` (an alias) must never appear as a column.
    const fixturePath = path.resolve(__dirname, 'fixtures', 'supabase', 'pg-stat-statements.json')
    const rows = JSON.parse(readFileSync(fixturePath, 'utf8')) as Array<{ query: string }>
    const byQuery = Object.fromEntries(rows.map((r) => [r.query, cols(r.query)]))

    expect(byQuery['SELECT "id", "amount" FROM "public"."orders" WHERE "id" = $1']).toEqual([
      'amount',
      'id',
    ])
    expect(byQuery['SELECT "id" FROM "public"."profiles" WHERE "user_id" = $1']).toEqual([
      'id',
      'user_id',
    ])
    expect(byQuery['INSERT INTO "public"."audit_log" ("event") VALUES ($1)']).toEqual(['event'])
    expect(byQuery['SELECT count(*) FROM pg_stat_activity']).toEqual([])

    // No alias artifact anywhere across the whole fixture.
    const everyColumn = rows.flatMap((r) => cols(r.query))
    expect(everyColumn).not.toContain('orders_id')
    expect(everyColumn.every((c) => /^[a-z_][\w$]*$/.test(c))).toBe(true)
  })
})

describe('observed columns merge onto the sql-table node (ADR-157)', () => {
  it('a SQL span lands OBSERVED columns on the table node it CALLS', async () => {
    resetGraph()
    const graph = getGraph()
    const ctx: IngestContext = {
      graph,
      errorsPath: path.join(os.tmpdir(), 'neat-colgrain-errors.ndjson'),
    }
    const sql = 'SELECT "id", "amount" FROM "public"."orders" WHERE "id" = $1'
    const span: ParsedSpan = {
      service: 'orders-api',
      traceId: 'trace-col',
      spanId: 'span-col',
      name: 'SELECT orders-api',
      kind: 3,
      startTimeUnixNano: '0',
      endTimeUnixNano: '0',
      durationNanos: 0n,
      env: 'unknown',
      attributes: { 'db.system': 'postgresql', 'db.statement': sql, 'server.address': 'orders-db' },
      dbSystem: 'postgresql',
      dbTable: 'orders',
      dbColumns: columnsFromSqlStatement(sql),
      statusCode: 0,
    }
    await handleSpan(ctx, span)

    const tableId = infraId('sql-table', 'orders')
    const node = graph.getNodeAttributes(tableId) as InfraNode
    const columns = (node.columns ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))
    expect(columns.map((c) => c.name)).toEqual(['amount', 'id'])
    expect(columns.every((c: ColumnAttr) => c.provenance === 'OBSERVED')).toBe(true)
    expect(columns.every((c: ColumnAttr) => c.confidence > 0 && c.confidence <= 1)).toBe(true)

    // A second span touching a new column is additive and never duplicates a name.
    const sql2 = 'UPDATE orders SET status = $1 WHERE id = $2'
    await handleSpan(ctx, {
      ...span,
      spanId: 'span-col-2',
      attributes: { ...span.attributes, 'db.statement': sql2 },
      dbColumns: columnsFromSqlStatement(sql2),
    })
    const after = (graph.getNodeAttributes(tableId) as InfraNode).columns ?? []
    expect(after.map((c) => c.name).sort()).toEqual(['amount', 'id', 'status'])
  })
})

describe('Django ORM table extraction (app_label + Meta.db_table)', () => {
  it('names <app_label>_<model>, honoring Meta.db_table and Meta.app_label', async () => {
    resetGraph()
    const graph = getGraph()
    await extractFromDirectory(graph, DJANGO_FIXTURES)
    // Meta.db_table wins verbatim.
    expect(graph.hasNode(infraId('sql-table', 'custom_orders'))).toBe(true)
    // Default app_label = the model file's app package (dir `shop`).
    expect(graph.hasNode(infraId('sql-table', 'shop_customer'))).toBe(true)
    // Meta.app_label overrides the directory.
    expect(graph.hasNode(infraId('sql-table', 'billing_lineitem'))).toBe(true)
  })
})

describe('cross-file SQLAlchemy query attribution (ADR-149 analog)', () => {
  it('attributes a query file to the table of a model imported from another file', async () => {
    resetGraph()
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const tableId = infraId('sql-table', 'orders')
    // models.py defines Order (table "orders"); routes.py imports and queries it.
    const queryFile = fileId('orders-api', 'routes.py')
    expect(graph.hasEdge(extractedEdgeId(queryFile, tableId, EdgeType.CALLS))).toBe(true)
    // The model-definition file keeps its own edge — both files that touch the
    // table are named, which is the point.
    const modelsFile = fileId('orders-api', 'models.py')
    expect(graph.hasEdge(extractedEdgeId(modelsFile, tableId, EdgeType.CALLS))).toBe(true)
  })
})

describe('SQLAlchemy table fusion — EXTRACTED and OBSERVED land on one node', () => {
  it('the model→table extractor and a db.statement span fuse on infra:sql-table:orders', async () => {
    resetGraph()
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // EXTRACTED — models.py declares the `orders` table.
    const tableId = infraId('sql-table', 'orders')
    expect(graph.hasNode(tableId)).toBe(true)
    const modelsFile = fileId('orders-api', 'models.py')
    expect(graph.hasEdge(extractedEdgeId(modelsFile, tableId, EdgeType.CALLS))).toBe(true)
    // The Flask-derived table is present too.
    expect(graph.hasNode(infraId('sql-table', 'user_profile'))).toBe(true)

    // OBSERVED — a real SQLAlchemy SELECT span. The table is recovered from
    // db.statement and mints onto the SAME node, so it is not a disjoint graph.
    const ctx: IngestContext = {
      graph,
      errorsPath: path.join(os.tmpdir(), 'neat-sqlalch-errors.ndjson'),
    }
    const span: ParsedSpan = {
      service: 'orders-api',
      traceId: 'trace-1',
      spanId: 'span-db',
      name: 'SELECT orders-api',
      kind: 3,
      startTimeUnixNano: '0',
      endTimeUnixNano: '0',
      durationNanos: 0n,
      env: 'unknown',
      attributes: {
        'db.system': 'postgresql',
        'db.statement': 'SELECT orders.id AS orders_id \nFROM orders',
        'server.address': 'orders-db',
      },
      dbSystem: 'postgresql',
      dbTable: 'orders',
      statusCode: 0,
    }
    await handleSpan(ctx, span)

    const observed = graph
      .edges()
      .map((id) => graph.getEdgeAttributes(id) as GraphEdge)
      .find((e) => e.provenance === 'OBSERVED' && e.type === EdgeType.CALLS && e.target === tableId)
    expect(observed).toBeTruthy()
  })
})
