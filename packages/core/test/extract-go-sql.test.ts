import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { parseOtlpRequest, tableFromSqlStatement, type OtlpTracesRequest } from '../src/otel.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
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
import { goSqlEndpointsFromFile } from '../src/extract/calls/go.js'

// ADR-184 — Go raw-SQL data axis. GORM (ADR-180) covers the ORM; this reads the
// services that hand `database/sql` / `sqlx` a literal SQL string. The load-bearing
// property is fusion: the recognizer runs the SAME `tableFromSqlStatement` /
// `columnsFromSqlStatement` helpers the OBSERVED ingest runs on `db.statement` /
// `db.query.text`, so the extracted table name is byte-identical to the observed one
// and they land on one `infra:sql-table:<name>` node instead of twinning.

const BT = String.fromCharCode(96) // backtick, kept out of the TS template delimiters
const SVC = '/svc'
const eps = (content: string) => goSqlEndpointsFromFile({ path: '/svc/db.go', content }, SVC)
const table = (content: string, name: string) => eps(content).find((e) => e.name === name)
const columnsOf = (content: string, name: string) => table(content, name)?.columns ?? []
const names = (content: string) => eps(content).map((e) => e.name).sort()

describe('goSqlEndpointsFromFile — database/sql call sites → sql-table', () => {
  const src = `package repo

import (
	"context"
	"database/sql"
)

func run(ctx context.Context, db *sql.DB) {
	db.Query("SELECT id, email FROM users WHERE id = $1")
	db.ExecContext(ctx, "INSERT INTO orders (total) VALUES ($1)")
	db.Query(${BT}SELECT id, sku, price
		FROM products
		WHERE sku = $1${BT})
}
`

  it('reads the table from Query, and its columns from the projection + WHERE', () => {
    expect(names(src)).toEqual(['orders', 'products', 'users'])
    const users = table(src, 'users')!
    expect(users.infraId).toBe('infra:sql-table:users')
    expect(users.kind).toBe('sql-table')
    expect(users.edgeType).toBe('CALLS')
    expect(users.confidenceKind).toBe('verified-call-site')
    expect(columnsOf(src, 'users').sort()).toEqual(['email', 'id'])
  })

  it('skips the leading ctx on a *Context variant and takes the SQL argument', () => {
    // ExecContext(ctx, "INSERT INTO orders …") — arg 0 is ctx, the SQL is arg 1. The
    // table resolving at all proves the ctx was skipped.
    expect(columnsOf(src, 'orders')).toEqual(['total'])
  })

  it('reads a multi-line backtick statement', () => {
    expect(columnsOf(src, 'products').sort()).toEqual(['id', 'price', 'sku'])
  })

  it('pins evidence to the call site (file, line, snippet)', () => {
    const users = table(src, 'users')!
    expect(users.evidence.file).toBe('db.go')
    expect(users.evidence.line).toBeGreaterThan(0)
    expect(users.evidence.snippet).toContain('db.Query(')
  })

  it('covers the full database/sql statement surface (Prepare + QueryRow included)', () => {
    const s = `package repo
import "database/sql"
func run(db *sql.DB) {
	db.QueryRow("SELECT id FROM accounts")
	db.Prepare("INSERT INTO events (name) VALUES ($1)")
}
`
    expect(names(s)).toEqual(['accounts', 'events'])
  })

  it('emits one endpoint per call site so a SELECT and an INSERT both fold their columns', () => {
    // Two statements, same table — the orchestrator folds the union onto one node.
    const s = `package repo
import "database/sql"
func run(db *sql.DB) {
	db.Query("SELECT id, email FROM users WHERE id = $1")
	db.Exec("INSERT INTO users (name) VALUES ($1)")
}
`
    const forUsers = eps(s).filter((e) => e.name === 'users')
    expect(forUsers).toHaveLength(2)
    const cols = new Set(forUsers.flatMap((e) => e.columns ?? []))
    expect(cols).toEqual(new Set(['id', 'email', 'name']))
  })

  it('FUSION: the extracted table id is byte-identical to the OBSERVED SQL-parse', () => {
    // The recognizer and ingest run the SAME helper on the SAME SQL, so the ids match.
    const sql = 'SELECT id, email FROM users WHERE id = $1'
    expect(table(src, 'users')!.infraId).toBe(infraId('sql-table', tableFromSqlStatement(sql)!))
  })
})

describe('goSqlEndpointsFromFile — sqlx surface', () => {
  const src = `package repo

import (
	"github.com/jmoiron/sqlx"
)

func run(db *sqlx.DB) {
	var u User
	db.Get(&u, "SELECT id, email FROM accounts WHERE id = $1")
	var xs []Order
	db.Select(&xs, "SELECT id, total FROM invoices")
	db.NamedExec("INSERT INTO audits (action) VALUES (:action)", nil)
}
`

  it('reads Get/Select/NamedExec, skipping the destination pointer to find the SQL', () => {
    expect(names(src)).toEqual(['accounts', 'audits', 'invoices'])
    expect(columnsOf(src, 'accounts').sort()).toEqual(['email', 'id'])
    expect(columnsOf(src, 'invoices').sort()).toEqual(['id', 'total'])
  })

  it('does NOT recognize sqlx-only methods without a sqlx import', () => {
    // Get is a sqlx method; on a plain *sql.DB it does not exist, so a file that
    // imports only database/sql must not read it (a common method name otherwise).
    const s = `package repo
import "database/sql"
func run(db *sql.DB) {
	db.Get(&u, "SELECT id FROM accounts")
}
`
    expect(eps(s)).toEqual([])
  })
})

describe('goSqlEndpointsFromFile — the import gate and the never-guess bar', () => {
  it('mints nothing in a .go file that imports neither database/sql nor sqlx', () => {
    // The whole point of the structural gate: a .Query("… FROM foo") on some other
    // object (an HTTP client, a template engine) must not mint a phantom table.
    const s = `package repo

func run(client *Thing) {
	client.Query("SELECT id FROM foo WHERE id = $1")
}
`
    expect(eps(s)).toEqual([])
  })

  it('leaves a computed statement unclaimed (fmt.Sprintf / concatenation)', () => {
    const s = `package repo
import "database/sql"
func run(db *sql.DB, name string) {
	db.Query(fmt.Sprintf("SELECT id FROM %s", name))
	db.Query("SELECT id FROM " + name)
}
`
    expect(eps(s)).toEqual([])
  })

  it('skips a statement whose table does not resolve (a JOIN)', () => {
    const s = `package repo
import "database/sql"
func run(db *sql.DB) {
	db.Query("SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id")
}
`
    expect(eps(s)).toEqual([])
  })

  it('is inert on a non-.go file', () => {
    expect(goSqlEndpointsFromFile({ path: '/svc/db.py', content: 'db.Query("SELECT id FROM users")' }, SVC)).toEqual([])
  })
})

// End-to-end: go.mod discovers the Go service, the raw-SQL call sites become
// sql-table nodes with folded EXTRACTED columns and CALLS edges, and a real OBSERVED
// span recovered from db.query.text lands on the SAME node — the fusion the whole
// recognizer is built for. Mirrors two-sided-observed.test.ts (#796).
describe('Go raw-SQL data axis end-to-end + observed fusion (ADR-184)', () => {
  beforeEach(() => resetGraph())
  const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'go-sql')
  const SVC_NAME = 'inventory'

  const columnNames = (name: string): string[] => {
    const node = getGraph().getNodeAttributes(infraId('sql-table', name)) as InfraNode
    return (node.columns ?? []).map((c: ColumnAttr) => c.name)
  }

  function ctxFor(): IngestContext {
    return { graph: getGraph(), errorsPath: path.join(os.tmpdir(), 'neat-994-errors.ndjson') }
  }

  function otlp(service: string, attrs: Record<string, string>, kind: number): OtlpTracesRequest {
    const attributes = Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: value } }))
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

  it('materializes the raw-SQL tables with folded EXTRACTED columns and CALLS edges', async () => {
    const graph = getGraph()
    const result = await extractFromDirectory(graph, FIXTURE)
    expect(result.extractionErrors).toBe(0)

    for (const t of ['users', 'orders', 'accounts']) {
      expect(graph.hasNode(infraId('sql-table', t))).toBe(true)
      expect((graph.getNodeAttributes(infraId('sql-table', t)) as InfraNode).kind).toBe('sql-table')
    }

    expect(columnNames('users').sort()).toEqual(['email', 'id'])
    expect(columnNames('orders')).toEqual(['total'])
    expect(columnNames('accounts').sort()).toEqual(['email', 'id']) // multi-line sqlx backtick

    const dbFile = fileId(SVC_NAME, 'db.go')
    expect(graph.hasEdge(extractedEdgeId(dbFile, infraId('sql-table', 'users'), EdgeType.CALLS))).toBe(true)
    expect(graph.hasEdge(extractedEdgeId(dbFile, infraId('sql-table', 'accounts'), EdgeType.CALLS))).toBe(true)
    expect((graph.getNodeAttributes(serviceId(SVC_NAME)) as { language?: string }).language).toBe('go')
  })

  it('fuses an OBSERVED db span onto the SAME sql-table node the extractor minted', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURE)
    const tableId = infraId('sql-table', 'users')

    // EXTRACTED: db.go → users CALLS edge is in the graph.
    const extracted = extractedEdgeId(fileId(SVC_NAME, 'db.go'), tableId, EdgeType.CALLS)
    expect(graph.hasEdge(extracted)).toBe(true)

    // OBSERVED: a real database/sql CLIENT span (wire kind 3). The driver emits no
    // table attribute, so ingest recovers it by parsing db.query.text — the SAME
    // helper the extractor ran, landing on the SAME node id.
    const [span] = parseOtlpRequest(
      otlp(
        SVC_NAME,
        { 'db.system': 'postgresql', 'db.query.text': 'SELECT id, email FROM users WHERE id = $1' },
        3,
      ),
    )
    expect(span!.dbTable).toBe('users')
    await handleSpan(ctxFor(), span!)

    const observed = observedEdgeId(serviceId(SVC_NAME), tableId, EdgeType.CALLS)
    expect(graph.hasEdge(observed)).toBe(true)
    expect((graph.getEdgeAttributes(observed) as GraphEdge).provenance).toBe(Provenance.OBSERVED)

    // One users node, both provenances reach it on CALLS — no twin.
    const sqlTableNodes: string[] = []
    graph.forEachNode((id, a) => {
      const n = a as InfraNode & { type?: string }
      if (n.type === NodeType.InfraNode && n.kind === 'sql-table' && n.name === 'users') sqlTableNodes.push(id)
    })
    expect(sqlTableNodes).toEqual([tableId])

    const provenances = new Set<string>()
    graph.forEachEdge((_id, a) => {
      const e = a as GraphEdge
      if (e.type === EdgeType.CALLS && e.target === tableId) provenances.add(e.provenance)
    })
    expect(provenances).toEqual(new Set([Provenance.EXTRACTED, Provenance.OBSERVED]))
  })

  it('is idempotent — a second pass adds no nodes or edges', async () => {
    const graph = getGraph()
    const first = await extractFromDirectory(graph, FIXTURE)
    const second = await extractFromDirectory(graph, FIXTURE)
    expect(first.nodesAdded).toBeGreaterThan(0)
    expect(second.nodesAdded).toBe(0)
    expect(second.edgesAdded).toBe(0)
  })
})
