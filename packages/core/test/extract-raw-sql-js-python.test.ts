import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { parseOtlpRequest, type OtlpTracesRequest } from '../src/otel.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import { mysqlJsEndpointsFromFile } from '../src/extract/calls/mysql-js.js'
import { pythonDbapiEndpointsFromFile } from '../src/extract/calls/dbapi-python.js'
import type { ColumnAttr, GraphEdge, InfraNode } from '@neat.is/types'
import { EdgeType, NodeType, Provenance, observedEdgeId, infraId, serviceId } from '@neat.is/types'

// #1432 — raw-SQL table readers for the JS `mysql`/`mysql2` and Python DB-API
// (`pymysql` …) drivers, the JS/Python siblings of the Go `database/sql` reader
// (ADR-184). Each reads the table + touched columns off a literal (or literal-headed,
// variable-resolved) statement with the SAME `tableFromSqlStatement` /
// `columnsFromSqlStatement` the OBSERVED ingest runs on `db.statement`, so an
// extracted `conn.query("… FROM office")` and its runtime span fuse on
// `infra:sql-table:office` rather than twinning. Gated on the driver import.

// A backtick kept out of TS template-literal delimiters, for inline JS template-string SQL.
const BT = String.fromCharCode(96)

// ---------------------------------------------------------------------------
// JS: mysql / mysql2
// ---------------------------------------------------------------------------

const SVC = '/svc'
const MYSQL = "const mysql = require('mysql')\nconst conn = mysql.createConnection({})\n"
const jsEps = (body: string, file = '/svc/db.js') =>
  mysqlJsEndpointsFromFile({ path: file, content: MYSQL + body }, SVC)
const jsTable = (body: string, name: string) => jsEps(body).find((e) => e.name === name)
const jsColumns = (body: string, name: string) => jsTable(body, name)?.columns ?? []

describe('mysqlJsEndpointsFromFile — statement shapes (#1432 ruling a)', () => {
  it('reads an inline string-literal SELECT into its table', () => {
    const t = jsTable('conn.query("SELECT * FROM office", cb)', 'office')!
    expect(t.infraId).toBe('infra:sql-table:office')
    expect(t.kind).toBe('sql-table')
    expect(t.edgeType).toBe('CALLS')
    expect(t.confidenceKind).toBe('verified-call-site')
    expect(t.evidence.snippet).toContain('conn.query(')
  })

  it('claims the literal HEAD of a concatenation (runtime tail does not block it)', () => {
    const body = 'const sql = "SELECT * FROM office " + whereSql\nconn.query(sql, cb)'
    expect(jsTable(body, 'office')).toBeTruthy()
  })

  it('reads columns from a fully-literal INSERT resolved through a variable', () => {
    const body = 'const sql = "INSERT INTO office (name, city) VALUES (?, ?)"\nconn.query(sql, cb)'
    expect(jsColumns(body, 'office').sort()).toEqual(['city', 'name'])
  })

  it('extends the head across a leading run of literals, stopping at the runtime piece', () => {
    const body = 'const sql = "INSERT INTO office (name)" + " VALUES " + vals\nconn.query(sql)'
    expect(jsColumns(body, 'office')).toEqual(['name'])
  })

  it('reads the literal head of a template string', () => {
    // conn.query(`SELECT * FROM office WHERE id=${id}`)
    const tmpl = 'conn.query(' + BT + 'SELECT * FROM office WHERE id=${id}' + BT + ')'
    expect(jsTable(tmpl, 'office')).toBeTruthy()
  })

  it('reads a mysql2 .execute() UPDATE', () => {
    expect(jsTable('conn.execute("UPDATE office SET name=? WHERE id=?", [n, id])', 'office')).toBeTruthy()
  })

  it('leaves a CREATE TABLE unclaimed (no FROM/INTO/UPDATE keyword)', () => {
    const body = 'const sql = "CREATE TABLE IF NOT EXISTS office (name VARCHAR(255))"\nconn.query(sql, cb)'
    expect(jsEps(body)).toEqual([])
  })
})

describe('mysqlJsEndpointsFromFile — variable resolution bounds (#1432)', () => {
  it('resolves a same-function, nearest-preceding literal assignment', () => {
    const body = 'function run(where){\n  const sql = "SELECT * FROM office " + where\n  conn.query(sql, cb)\n}'
    expect(jsTable(body, 'office')).toBeTruthy()
  })

  it('leaves an identifier reassigned to a non-literal in between unclaimed', () => {
    const body = 'function run(dyn){\n  let sql = "SELECT * FROM office"\n  sql = dyn\n  conn.query(sql, cb)\n}'
    expect(jsEps(body)).toEqual([])
  })

  it('leaves a function parameter unclaimed (no literal assignment)', () => {
    expect(jsEps('function run(sql){ conn.query(sql, cb) }')).toEqual([])
  })

  it('does not cross a nested function scope to resolve the variable', () => {
    // `sql` is assigned in the outer function; the query runs in a nested callback
    // whose enclosing function is the callback, which holds no assignment → unclaimed.
    const body =
      'function outer(){\n  const sql = "SELECT * FROM office"\n  register(function(){ conn.query(sql, cb) })\n}'
    expect(jsEps(body)).toEqual([])
  })
})

describe('mysqlJsEndpointsFromFile — gates', () => {
  it('mints nothing without a mysql/mysql2 import', () => {
    expect(
      mysqlJsEndpointsFromFile({ path: '/svc/db.js', content: 'conn.query("SELECT * FROM office")' }, SVC),
    ).toEqual([])
  })

  it('does not mint a table from a non-SQL .query() string in a mysql file', () => {
    expect(jsEps('conn.query("ping")')).toEqual([])
  })

  it('is inert on a non-JS/TS file', () => {
    expect(mysqlJsEndpointsFromFile({ path: '/svc/q.py', content: MYSQL + 'conn.query("SELECT * FROM office")' }, SVC)).toEqual([])
  })

  it('reads mysql2/promise imports and .ts files', () => {
    const src = "import mysql from 'mysql2/promise'\nconst conn = await mysql.createConnection({})\nconn.query('SELECT * FROM office')"
    expect(mysqlJsEndpointsFromFile({ path: '/svc/db.ts', content: src }, SVC).find((e) => e.name === 'office')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Python: DB-API (pymysql / …)
// ---------------------------------------------------------------------------

const pyEps = (body: string, file = '/svc/app.py', importLine = 'import pymysql\n') =>
  pythonDbapiEndpointsFromFile({ path: file, content: importLine + body }, SVC)
const pyTable = (body: string, name: string) => pyEps(body).find((e) => e.name === name)
const pyColumns = (body: string, name: string) => pyTable(body, name)?.columns ?? []

describe('pythonDbapiEndpointsFromFile — statement shapes + variable resolution (#1432)', () => {
  it('reads an inline SELECT with projected + WHERE columns', () => {
    const sel = 'cur.execute("SELECT order_id, price FROM voucher where order_id = %s", (oid,))'
    const t = pyTable(sel, 'voucher')!
    expect(t.infraId).toBe('infra:sql-table:voucher')
    expect(t.confidenceKind).toBe('verified-call-site')
    expect(pyColumns(sel, 'voucher').sort()).toEqual(['order_id', 'price'])
  })

  it('resolves the table of a `SELECT *` but attributes no columns (matches the OBSERVED parse)', () => {
    const sel = 'cur.execute("SELECT * FROM voucher where order_id = %s", (oid,))'
    expect(pyTable(sel, 'voucher')).toBeTruthy()
    expect(pyColumns(sel, 'voucher')).toEqual([])
  })

  it('resolves a variable-held INSERT and reads its columns', () => {
    const body = "def run():\n    sql = 'INSERT INTO voucher (order_id, price) VALUES (%s, %s)'\n    cur.execute(sql, (a, b))"
    expect(pyColumns(body, 'voucher').sort()).toEqual(['order_id', 'price'])
  })

  it('reads a .executemany()', () => {
    expect(pyTable('cur.executemany("INSERT INTO voucher (price) VALUES (%s)", rows)', 'voucher')).toBeTruthy()
  })

  it('leaves a triple-quoted CREATE TABLE unclaimed', () => {
    const body = 'def init():\n    sql = """\n    CREATE TABLE if not exists voucher (voucher_id INT)"""\n    cur.execute(sql)'
    expect(pyEps(body)).toEqual([])
  })

  it('leaves a parameter / non-literal first arg unclaimed', () => {
    expect(pyEps('def run(sql):\n    cur.execute(sql, params)')).toEqual([])
  })

  it('gates on a DB-API driver import — psycopg2 counts, no import does not', () => {
    expect(pyEps('cur.execute("SELECT * FROM voucher")', '/svc/app.py', 'import psycopg2\n').find((e) => e.name === 'voucher')).toBeTruthy()
    expect(pyEps('cur.execute("SELECT * FROM voucher")', '/svc/app.py', 'import json\n')).toEqual([])
  })

  it('is inert on a non-Python file', () => {
    expect(pythonDbapiEndpointsFromFile({ path: '/svc/app.js', content: 'import pymysql\ncur.execute("SELECT * FROM voucher")' }, SVC)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// End-to-end over the real train-ticket services + OBSERVED fusion
// ---------------------------------------------------------------------------

describe('raw-SQL JS/Python data axis end-to-end + observed fusion (#1432)', () => {
  beforeEach(() => resetGraph())
  const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
  const FIXTURE_JS = path.join(FIXTURES, 'raw-sql-js')
  const FIXTURE_PY = path.join(FIXTURES, 'raw-sql-python')
  const tbl = (name: string) => infraId('sql-table', name)

  const columnNames = (name: string): string[] => {
    const node = getGraph().getNodeAttributes(tbl(name)) as InfraNode
    return (node.columns ?? []).map((c: ColumnAttr) => c.name).sort()
  }
  const extractedCallsInto = (target: string): GraphEdge[] => {
    const out: GraphEdge[] = []
    getGraph().forEachEdge((_id, a) => {
      const e = a as GraphEdge
      if (e.type === EdgeType.CALLS && e.target === target && e.provenance === Provenance.EXTRACTED) out.push(e)
    })
    return out
  }
  function ctxFor(): IngestContext {
    return { graph: getGraph(), errorsPath: path.join(os.tmpdir(), 'neat-1432-errors.ndjson') }
  }
  function otlp(service: string, attrs: Record<string, string>, kind: number): OtlpTracesRequest {
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
                  name: `${service} query`,
                  kind,
                  startTimeUnixNano: '1000000000000000000',
                  endTimeUnixNano: '1000000000050000000',
                  attributes: Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: value } })),
                  status: { code: 0 },
                },
              ],
            },
          ],
        },
      ],
    }
  }

  it('reads the office table from ts-ticket-office (mysql), columns from the INSERT, one deduped CALLS edge', async () => {
    const graph = getGraph()
    const result = await extractFromDirectory(graph, FIXTURE_JS)
    expect(result.extractionErrors).toBe(0)
    expect(graph.hasNode(tbl('office'))).toBe(true)
    expect((graph.getNodeAttributes(tbl('office')) as InfraNode).kind).toBe('sql-table')
    // The INSERT site carries office's column list; the SELECT/UPDATE/DELETE sites fold in no columns.
    expect(columnNames('office')).toEqual(
      ['address', 'city', 'name', 'province', 'region', 'windownum', 'worktime'].sort(),
    )
    // Five claimable sites collapse to one file→office CALLS edge, pinned to bin/db.js.
    const calls = extractedCallsInto(tbl('office'))
    expect(calls.length).toBe(1)
    expect(calls[0]!.evidence.file).toContain('db.js')
  })

  it('reads the voucher table from ts-voucher (pymysql) with its columns', async () => {
    const graph = getGraph()
    const result = await extractFromDirectory(graph, FIXTURE_PY)
    expect(result.extractionErrors).toBe(0)
    expect(graph.hasNode(tbl('voucher'))).toBe(true)
    // The INSERT site folds its ten columns; the SELECT site's WHERE column (order_id)
    // is already among them; the CREATE TABLE site is unclaimed (no table resolved).
    expect(columnNames('voucher')).toEqual(
      [
        'contactname',
        'deststation',
        'order_id',
        'price',
        'seatclass',
        'seatnumber',
        'startstation',
        'traveldate',
        'traveltime',
        'trainnumber',
      ].sort(),
    )
    const calls = extractedCallsInto(tbl('voucher'))
    expect(calls.length).toBe(1)
    expect(calls[0]!.evidence.file).toContain('server.py')
  })

  it('an observed db span recovers office from db.statement and fuses onto the extracted node', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURE_JS)
    const tableId = tbl('office')
    expect(extractedCallsInto(tableId).length).toBeGreaterThan(0)

    const svc = 'ts-ticket-office'
    const [span] = parseOtlpRequest(
      otlp(svc, { 'db.system': 'mysql', 'db.name': 'office', 'db.statement': 'SELECT * FROM office' }, 3),
    )
    expect(span!.dbTable).toBe('office')
    await handleSpan(ctxFor(), span!)

    const observedCall = observedEdgeId(serviceId(svc), tableId, EdgeType.CALLS)
    expect(graph.hasEdge(observedCall)).toBe(true)
    // One office node, both provenances reach it — declared and observed fused, not twinned.
    const sqlTableNodes: string[] = []
    graph.forEachNode((id, a) => {
      const n = a as InfraNode & { type?: string }
      if (n.type === NodeType.InfraNode && n.kind === 'sql-table' && n.name === 'office') sqlTableNodes.push(id)
    })
    expect(sqlTableNodes).toEqual([tableId])
  })

  it('is idempotent — a second extract pass adds no nodes or edges', async () => {
    const graph = getGraph()
    const first = await extractFromDirectory(graph, FIXTURE_JS)
    const second = await extractFromDirectory(graph, FIXTURE_JS)
    expect(first.nodesAdded).toBeGreaterThan(0)
    expect(second.nodesAdded).toBe(0)
    expect(second.edgesAdded).toBe(0)
  })
})
