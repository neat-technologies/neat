import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { parseOtlpRequest, tableFromSqlStatement, type OtlpTracesRequest } from '../src/otel.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import { goSqlEndpointsFromFile } from '../src/extract/calls/go.js'
import type { ColumnAttr, GraphEdge, InfraNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  extractedEdgeId,
  observedEdgeId,
  fileId,
  infraId,
  serviceId,
} from '@neat.is/types'

// ADR-184 — Go raw-SQL data axis. The reader for services that skip the ORM and
// hand `database/sql` / `github.com/jmoiron/sqlx` a literal statement. It reuses the
// exact `tableFromSqlStatement` / `columnsFromSqlStatement` the OBSERVED ingest runs
// on `db.query.text`, so an extracted `db.Query("… FROM users")` and its runtime span
// fuse on `infra:sql-table:users` rather than twinning. Gated on the driver import so
// a stray Go string never mints a table.

// A backtick kept out of TS template-literal delimiters, so multi-line Go raw-string
// SQL can be written inline.
const BT = String.fromCharCode(96)

const SVC = '/svc'
const eps = (content: string, file = '/svc/store.go') =>
  goSqlEndpointsFromFile({ path: file, content }, SVC)
const table = (content: string, name: string) => eps(content).find((e) => e.name === name)
const columnsOf = (content: string, name: string) => table(content, name)?.columns ?? []

const DATABASE_SQL = 'import "database/sql"\n'
const SQLX = 'import "github.com/jmoiron/sqlx"\n'

describe('goSqlEndpointsFromFile — database/sql call sites → sql-table', () => {
  it('reads a SELECT and an INSERT into their tables with columns and evidence', () => {
    const src = `package main
${DATABASE_SQL}
func run(db *sql.DB) {
	_, _ = db.Query("SELECT id, email FROM users WHERE id = $1")
	_, _ = db.Exec("INSERT INTO orders (total) VALUES ($1)")
}
`
    expect(eps(src).map((e) => e.name).sort()).toEqual(['orders', 'users'])

    const users = table(src, 'users')!
    expect(users.infraId).toBe('infra:sql-table:users')
    expect(users.kind).toBe('sql-table')
    expect(users.edgeType).toBe('CALLS')
    expect(users.confidenceKind).toBe('verified-call-site')
    expect(columnsOf(src, 'users').sort()).toEqual(['email', 'id'])
    // Evidence points at the real call-site line with a snippet.
    const queryLine = src.split('\n').findIndex((l) => l.includes('db.Query(')) + 1
    expect(users.evidence.file).toBe('store.go')
    expect(users.evidence.line).toBe(queryLine)
    expect(users.evidence.snippet).toContain('db.Query(')

    expect(columnsOf(src, 'orders')).toEqual(['total'])
  })

  it('skips a leading ctx on a *Context call (SQL is the first string literal, not arg 0)', () => {
    const src = `package main
import (
	"context"
	"database/sql"
)
func run(ctx context.Context, db *sql.DB) {
	_, _ = db.QueryContext(ctx, "SELECT id FROM widgets WHERE id = $1")
}
`
    expect(table(src, 'widgets')).toBeTruthy()
    expect(columnsOf(src, 'widgets')).toEqual(['id'])
  })

  it('reads a multi-line raw backtick statement', () => {
    const src = `package main
${DATABASE_SQL}
func run(db *sql.DB) {
	_, _ = db.Query(${BT}SELECT id, name
FROM products
WHERE id = $1${BT})
}
`
    expect(table(src, 'products')).toBeTruthy()
    expect(columnsOf(src, 'products').sort()).toEqual(['id', 'name'])
  })

  it('does not guess on a non-literal statement (fmt.Sprintf / concatenation)', () => {
    const src = `package main
import (
	"database/sql"
	"fmt"
)
func run(db *sql.DB, t string) {
	_, _ = db.Query(fmt.Sprintf("SELECT id FROM %s", t))
	_, _ = db.Query("SELECT id FROM " + t)
}
`
    expect(eps(src)).toEqual([])
  })
})

describe('goSqlEndpointsFromFile — sqlx surface', () => {
  it('reads sqlx Get, whose SQL follows a destination pointer, with its columns', () => {
    const src = `package main
${SQLX}
type account struct{}
func run(db *sqlx.DB) {
	var a account
	_ = db.Get(&a, "SELECT id, email FROM accounts WHERE id = $1")
}
`
    expect(table(src, 'accounts')).toBeTruthy()
    expect(columnsOf(src, 'accounts').sort()).toEqual(['email', 'id'])
  })

  it('reads sqlx Select and NamedExec too', () => {
    const src = `package main
${SQLX}
func run(db *sqlx.DB, arg any) {
	var xs []int
	_ = db.Select(&xs, "SELECT id FROM sessions")
	_, _ = db.NamedExec("INSERT INTO invoices (amount) VALUES (:amount)", arg)
}
`
    expect(eps(src).map((e) => e.name).sort()).toEqual(['invoices', 'sessions'])
    expect(columnsOf(src, 'invoices')).toEqual(['amount'])
  })

  it('does NOT read a sqlx-only method under a database/sql-only import (Get is a common name)', () => {
    // `Get` here is some HTTP/cache client, not sqlx — no sqlx import, so it must
    // not be mistaken for a query even though its argument parses as SQL.
    const src = `package main
${DATABASE_SQL}
func run(client Thing) {
	_ = client.Get("SELECT id FROM users")
}
`
    expect(eps(src)).toEqual([])
  })
})

describe('goSqlEndpointsFromFile — import gate (the precision fix)', () => {
  it('mints nothing from a .Query()/.Exec() call in a file that imports no SQL driver', () => {
    // Without the gate, this ungated .Query() on an arbitrary object would mint a
    // phantom `foo` table. The gate closes that false-positive hole.
    const src = `package main
import "net/http"
func run(client *http.Client) {
	_, _ = client.Query("SELECT id FROM foo")
	_, _ = renderer.Exec("SELECT * FROM bar")
}
`
    expect(eps(src)).toEqual([])
  })

  it('is inert on a non-.go file', () => {
    expect(eps('SELECT id FROM users', '/svc/query.sql')).toEqual([])
  })
})

describe('goSqlEndpointsFromFile — fusion with the OBSERVED SQL parse', () => {
  it('extracts the same infraId the OBSERVED db.query.text path produces for the same SQL', () => {
    // The whole point (ADR-184): the recognizer runs the exact same
    // tableFromSqlStatement the OBSERVED ingest runs on the span's db.query.text, so
    // the extracted node id is byte-identical to the observed one and they fuse.
    const sql = 'SELECT id, email FROM users WHERE id = $1'
    const src = `package main
${DATABASE_SQL}
func run(db *sql.DB) {
	_, _ = db.Query("${sql}")
}
`
    const observedTable = tableFromSqlStatement(sql)! // what ingest computes off db.query.text
    expect(table(src, 'users')!.infraId).toBe(infraId('sql-table', observedTable))
  })
})

// End-to-end: extract a real Go service, then push a real OTLP db span through
// parseOtlpRequest → handleSpan and prove the declared table access and its observed
// twin land on ONE `infra:sql-table:<name>` node — the same two-sided shape the
// SQLAlchemy / Kafka / route fusion tests prove (two-sided-observed.test.ts, #796).
describe('Go raw-SQL data axis end-to-end + observed fusion (ADR-184)', () => {
  beforeEach(() => resetGraph())
  const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'go-rawsql')
  const SVC_NAME = 'inventory'
  const tbl = (name: string) => infraId('sql-table', name)

  const columnNames = (name: string): string[] => {
    const node = getGraph().getNodeAttributes(tbl(name)) as InfraNode
    return (node.columns ?? []).map((c: ColumnAttr) => c.name)
  }

  function ctxFor(): IngestContext {
    return { graph: getGraph(), errorsPath: path.join(os.tmpdir(), 'neat-994-errors.ndjson') }
  }

  function otlp(service: string, attrs: Record<string, string>, kind: number): OtlpTracesRequest {
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
                  spanId: '1111111111111111',
                  name: `${service} query`,
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

  const edgesInto = (target: string, type: EdgeType): GraphEdge[] => {
    const out: GraphEdge[] = []
    getGraph().forEachEdge((_id, a) => {
      const e = a as GraphEdge
      if (e.type === type && e.target === target) out.push(e)
    })
    return out
  }

  it('materializes the tables the database/sql and sqlx call sites touch, with columns', async () => {
    const graph = getGraph()
    const result = await extractFromDirectory(graph, FIXTURE)
    expect(result.extractionErrors).toBe(0)
    expect((graph.getNodeAttributes(serviceId(SVC_NAME)) as { language?: string }).language).toBe('go')

    for (const t of ['users', 'orders', 'accounts']) {
      expect(graph.hasNode(tbl(t))).toBe(true)
      expect((graph.getNodeAttributes(tbl(t)) as InfraNode).kind).toBe('sql-table')
    }
    expect(columnNames('users').sort()).toEqual(['email', 'id'])
    expect(columnNames('orders')).toEqual(['total'])
    // accounts came through sqlx Get + a multi-line backtick statement, via the real
    // (comment-masked) extraction pipeline — proving both survive it.
    expect(columnNames('accounts').sort()).toEqual(['email', 'id'])

    // The file that holds each call site owns the CALLS edge, with evidence.
    const storeFile = fileId(SVC_NAME, 'store.go')
    const usersCall = extractedEdgeId(storeFile, tbl('users'), EdgeType.CALLS)
    expect(graph.hasEdge(usersCall)).toBe(true)
    expect((graph.getEdgeAttributes(usersCall) as GraphEdge).evidence.file).toBe('store.go')
  })

  it('an observed db span recovers its table from db.query.text and fuses onto the extracted node', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURE)

    const tableId = tbl('users')
    const extractedCalls = edgesInto(tableId, EdgeType.CALLS).filter(
      (e) => e.provenance === Provenance.EXTRACTED,
    )
    expect(extractedCalls.length).toBeGreaterThan(0)

    // A real database/sql CLIENT span (wire kind 3). The driver emits no table
    // attribute; ingest recovers it by parsing db.query.text (semconv ≥ 1.30) with
    // the same helper the extractor used — landing on the same node id.
    const [span] = parseOtlpRequest(
      otlp(
        SVC_NAME,
        {
          'db.system': 'postgresql',
          'db.name': 'inventorydb',
          'db.query.text': 'SELECT id, email FROM users WHERE id = $1',
        },
        3,
      ),
    )
    expect(span!.dbTable).toBe('users')
    await handleSpan(ctxFor(), span!)

    const observedCall = observedEdgeId(serviceId(SVC_NAME), tableId, EdgeType.CALLS)
    expect(graph.hasEdge(observedCall)).toBe(true)
    expect((graph.getEdgeAttributes(observedCall) as GraphEdge).provenance).toBe(Provenance.OBSERVED)

    // One sql-table:users node, both provenances reach it — declared and observed
    // table access fused rather than twinning.
    const sqlTableNodes: string[] = []
    graph.forEachNode((id, a) => {
      const n = a as InfraNode & { type?: string }
      if (n.type === NodeType.InfraNode && n.kind === 'sql-table' && n.name === 'users') {
        sqlTableNodes.push(id)
      }
    })
    expect(sqlTableNodes).toEqual([tableId])
    expect(new Set(edgesInto(tableId, EdgeType.CALLS).map((e) => e.provenance))).toEqual(
      new Set([Provenance.EXTRACTED, Provenance.OBSERVED]),
    )
  })

  it('is idempotent — a second extract pass adds no nodes or edges', async () => {
    const graph = getGraph()
    const first = await extractFromDirectory(graph, FIXTURE)
    const second = await extractFromDirectory(graph, FIXTURE)
    expect(first.nodesAdded).toBeGreaterThan(0)
    expect(second.nodesAdded).toBe(0)
    expect(second.edgesAdded).toBe(0)
  })
})
