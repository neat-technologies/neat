import { describe, it, expect } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { EdgeType, extractedEdgeId, fileId, infraId, type GraphEdge } from '@neat.is/types'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { flaskSqlalchemyTableName, sqlalchemyEndpointsFromFile } from '../src/extract/calls/sqlalchemy.js'
import { tableFromSqlStatement, type ParsedSpan } from '../src/otel.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'python-sqlalchemy')

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
