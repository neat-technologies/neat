import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { getBlastRadius } from '../src/traverse.js'
import type { ColumnAttr, GraphEdge, InfraNode } from '@neat.is/types'
import { EdgeType, extractedEdgeId, fileId, infraId, serviceId } from '@neat.is/types'
import { gormEndpointsFromFile, gormForeignKeys } from '../src/extract/calls/gorm.js'

// ADR-180 — Go/GORM data axis. Unlike Rails' schema.rb or Laravel's migrations,
// GORM has no literal schema file: the table name is DERIVED from the struct name
// by GORM's own `inflection.Plural(toDBName(name))`, so the pluralizer must be
// correct or the extracted node fuses onto nothing (a false node, not a missed
// edge). The struct doubles as schema and model — one reader gives tables, columns,
// and the association graph, at the same `infra:sql-table:<name>` grain every other
// ORM NEAT reads produces.

// A backtick, kept out of TS template-literal delimiters so Go struct tags can be
// written inline (`Email string ${tag('gorm:"column:x"')}`).
const BT = String.fromCharCode(96)
const tag = (s: string): string => `${BT}${s}${BT}`

const SVC = '/svc'
const eps = (content: string) => gormEndpointsFromFile({ path: '/svc/models.go', content }, SVC)
const table = (content: string, name: string) => eps(content).find((e) => e.name === name)
const columnsOf = (content: string, name: string) => table(content, name)?.columns ?? []
const fks = (content: string) => gormForeignKeys({ path: '/svc/models.go', content }, SVC)
const pairs = (content: string) => fks(content).map((r) => `${r.childTable}->${r.parentTable}`)

const GORM = 'import "gorm.io/gorm"\n'
const tbl = (name: string) => infraId('sql-table', name)
const refEdge = (child: string, parent: string) =>
  extractedEdgeId(tbl(child), tbl(parent), EdgeType.REFERENCES)

describe('gormEndpointsFromFile — struct → sql-table (derived name)', () => {
  it('derives the table via initialism-aware snake_case + irregular plural', () => {
    const src = `package models
${GORM}
type User struct { gorm.Model }
type APIKey struct { gorm.Model }
type Person struct { gorm.Model }
type LineItem struct { gorm.Model }
`
    const names = eps(src).map((e) => e.name).sort()
    // APIKey → api_keys (not a_p_i_keys), Person → people (irregular), LineItem →
    // line_items, User → users.
    expect(names).toEqual(['api_keys', 'line_items', 'people', 'users'])
    expect(table(src, 'api_keys')!.infraId).toBe('infra:sql-table:api_keys')
    expect(table(src, 'api_keys')!.kind).toBe('sql-table')
  })

  it('honors a TableName() literal override', () => {
    const src = `package models
${GORM}
type User struct { gorm.Model }
func (User) TableName() string { return "legacy_users" }
`
    expect(eps(src).map((e) => e.name)).toEqual(['legacy_users'])
  })

  it('is inert on a .go file that does not import gorm', () => {
    expect(eps('package models\ntype User struct { Name string }\n')).toEqual([])
  })

  it('does not mint a table for a plain non-model struct', () => {
    // CreateUserRequest is never a gorm.Model, never in a db call, never a relation.
    const src = `package models
${GORM}
type User struct { gorm.Model }
type CreateUserRequest struct { Name string }
`
    expect(eps(src).map((e) => e.name)).toEqual(['users'])
  })
})

describe('gormEndpointsFromFile — fields → columns', () => {
  const src = `package models
${GORM}
type Order struct {
	gorm.Model
	Code       string
	TotalCents int    ${tag('gorm:"column:total"')}
	Secret     string ${tag('gorm:"-"')}
	CustomerID uint
	Customer   Customer
}
type Customer struct { gorm.Model }
`
  it('expands gorm.Model to id/created_at/updated_at/deleted_at', () => {
    const cols = columnsOf(src, 'orders')
    expect(cols.slice(0, 4)).toEqual(['id', 'created_at', 'updated_at', 'deleted_at'])
  })

  it('snake_cases scalar fields and honors gorm:"column:" verbatim', () => {
    const cols = columnsOf(src, 'orders')
    expect(cols).toContain('code')
    expect(cols).toContain('total') // column override wins over total_cents
    expect(cols).not.toContain('total_cents')
  })

  it('skips gorm:"-" and excludes the association field, keeps the FK scalar', () => {
    const cols = columnsOf(src, 'orders')
    expect(cols).toContain('customer_id') // the belongs-to FK scalar IS a column
    expect(cols).not.toContain('secret') // gorm:"-"
    expect(cols).not.toContain('customer') // the struct-typed relation is not a column
  })

  it('inlines an anonymous embedded local struct (a shared Base)', () => {
    const s = `package models
${GORM}
type Base struct {
	ID        uint
	CreatedAt string
}
type Widget struct {
	Base
	Name string
}
func seed(db *gorm.DB) { db.Create(&Widget{}) }
`
    expect(columnsOf(s, 'widgets')).toEqual(['id', 'created_at', 'name'])
  })
})

describe('gormForeignKeys — associations → REFERENCES (direction by shape)', () => {
  it('belongs-to: this table references the association (FK <Field>ID on this side)', () => {
    const src = `package models
${GORM}
type User struct { gorm.Model }
type Order struct { gorm.Model; UserID uint; User User }
`
    expect(pairs(src)).toEqual(['orders->users'])
  })

  it('has-many: the FK lives on the other table', () => {
    const src = `package models
${GORM}
type User struct { gorm.Model; Orders []Order }
type Order struct { gorm.Model; UserID uint }
`
    expect(pairs(src)).toEqual(['orders->users'])
  })

  it('has-one: a singular struct with no FK on this side points inward', () => {
    const src = `package models
${GORM}
type User struct { gorm.Model; Card CreditCard }
type CreditCard struct { gorm.Model; UserID uint }
`
    expect(pairs(src)).toEqual(['credit_cards->users'])
  })

  it('honors a foreignKey: override to read a non-conventional FK column', () => {
    // The field name is Owner (conventional FK OwnerID), but the tag names UserRef.
    const src = `package models
${GORM}
type User struct { gorm.Model }
type Project struct { gorm.Model; UserRef uint; Owner User ${tag('gorm:"foreignKey:UserRef"')} }
`
    expect(pairs(src)).toEqual(['projects->users'])
  })

  it('synthesizes the join table for many2many and references both sides', () => {
    const src = `package models
${GORM}
type User struct { gorm.Model; Languages []Language ${tag('gorm:"many2many:user_languages"')} }
type Language struct { gorm.Model }
`
    expect(pairs(src).sort()).toEqual(['user_languages->languages', 'user_languages->users'])
  })

  it('resolves the association table through a TableName() override', () => {
    const src = `package models
${GORM}
type User struct { gorm.Model; Orders []Order }
func (User) TableName() string { return "app_users" }
type Order struct { gorm.Model; UserID uint }
`
    expect(pairs(src)).toEqual(['orders->app_users'])
  })
})

// End-to-end: go.mod discovers the Go service, the model structs become sql-table
// nodes with folded EXTRACTED columns and REFERENCES edges — the same shapes Prisma
// and Rails produce, so the data-axis queries walk a GORM app unchanged.
describe('Go/GORM data axis end-to-end (ADR-180)', () => {
  beforeEach(() => resetGraph())
  const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'go-gorm')
  const SVC_NAME = 'shop'

  const columnNames = (name: string): string[] => {
    const node = getGraph().getNodeAttributes(tbl(name)) as InfraNode
    return (node.columns ?? []).map((c: ColumnAttr) => c.name)
  }

  it('materializes model tables with folded EXTRACTED columns', async () => {
    const graph = getGraph()
    const result = await extractFromDirectory(graph, FIXTURE)
    expect(result.extractionErrors).toBe(0)

    for (const t of ['users', 'orders', 'line_items', 'languages', 'api_keys', 'user_languages']) {
      expect(graph.hasNode(tbl(t))).toBe(true)
      expect((graph.getNodeAttributes(tbl(t)) as InfraNode).kind).toBe('sql-table')
    }

    // users: gorm.Model audit columns + name + the column override; password (-)
    // and the Orders/Languages relations are not columns.
    expect(columnNames('users').sort()).toEqual(
      ['created_at', 'deleted_at', 'email_address', 'id', 'name', 'updated_at'].sort(),
    )
    expect(columnNames('users')).not.toContain('password')
    expect(columnNames('users')).not.toContain('orders')

    // orders keeps the belongs-to FK scalar user_id, drops the User relation.
    expect(columnNames('orders')).toContain('user_id')
    expect(columnNames('orders')).toContain('code')
    expect(columnNames('orders')).not.toContain('user')
  })

  it('mints the REFERENCES edges, including the many2many join', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURE)

    expect(graph.hasEdge(refEdge('orders', 'users'))).toBe(true)
    expect(graph.hasEdge(refEdge('line_items', 'orders'))).toBe(true)
    expect(graph.hasEdge(refEdge('user_languages', 'users'))).toBe(true)
    expect(graph.hasEdge(refEdge('user_languages', 'languages'))).toBe(true)

    // orders → users is declared on both sides (User has_many Orders + Order
    // belongs_to User) but collapses to one edge.
    const ordersRefs: string[] = []
    graph.forEachOutboundEdge(tbl('orders'), (_id, attrs) => {
      if ((attrs as GraphEdge).type === EdgeType.REFERENCES) ordersRefs.push((attrs as GraphEdge).target)
    })
    expect(ordersRefs).toEqual([tbl('users')])

    // Blast radius from a parent table reaches the child that FKs into it.
    const blast = getBlastRadius(graph, tbl('users'))
    expect(blast.affectedNodes.map((n) => n.nodeId)).toContain(tbl('orders'))
  })

  it('links each model file to its table and discovers a Go service', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURE)

    const modelsFile = fileId(SVC_NAME, 'models.go')
    const callId = extractedEdgeId(modelsFile, tbl('users'), EdgeType.CALLS)
    expect(graph.hasEdge(callId)).toBe(true)

    expect((graph.getNodeAttributes(serviceId(SVC_NAME)) as { language?: string }).language).toBe('go')
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
