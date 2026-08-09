import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { getBlastRadius } from '../src/traverse.js'
import type { ColumnAttr, GraphEdge, InfraNode } from '@neat.is/types'
import { EdgeType, Provenance, extractedEdgeId, fileId, infraId, serviceId } from '@neat.is/types'
import {
  railsSchemaEndpointsFromFile,
  railsSchemaForeignKeys,
  railsModelEndpointsFromFile,
  railsModelForeignKeys,
} from '../src/extract/calls/activerecord.js'

// ADR-174 — Ruby/Rails ActiveRecord data axis, the second rung of the Ruby pilot.
// `db/schema.rb` names tables, columns, and foreign keys LITERALLY, so a Rails
// table joins the graph at the same `infra:sql-table:<name>` grain (and columns/
// REFERENCES types) every other ORM NEAT reads. The models add the class↔table
// link and the association graph; schema.rb literals are the anchor.

const SVC = '/svc'
const schemaEps = (content: string) =>
  railsSchemaEndpointsFromFile({ path: '/svc/db/schema.rb', content }, SVC)
const schemaTable = (content: string, name: string) => schemaEps(content).find((e) => e.name === name)
const schemaFks = (content: string) =>
  railsSchemaForeignKeys({ path: '/svc/db/schema.rb', content }, SVC)
const modelEps = (content: string) =>
  railsModelEndpointsFromFile({ path: '/svc/app/models/m.rb', content }, SVC)
const modelFks = (content: string) =>
  railsModelForeignKeys({ path: '/svc/app/models/m.rb', content }, SVC)

const tbl = (name: string) => infraId('sql-table', name)
const refEdge = (child: string, parent: string) =>
  extractedEdgeId(tbl(child), tbl(parent), EdgeType.REFERENCES)

describe('railsSchemaEndpointsFromFile — create_table → sql-table + columns (literal)', () => {
  it('reads a create_table into a sql-table node with an implicit id and typed columns', () => {
    const t = schemaTable(
      `
      ActiveRecord::Schema[7.1].define do
        create_table "orders", force: :cascade do |t|
          t.string "code"
          t.decimal "total"
          t.jsonb "metadata"
          t.timestamps
        end
      end
    `,
      'orders',
    )
    expect(t!.infraId).toBe('infra:sql-table:orders')
    expect(t!.kind).toBe('sql-table')
    // Implicit primary key, the literal column names, and t.timestamps expansion.
    expect(t!.columns).toEqual(['id', 'code', 'total', 'metadata', 'created_at', 'updated_at'])
    expect(t!.evidence.file).toBe('db/schema.rb')
    expect(t!.evidence.line).toBeGreaterThan(0)
  })

  it('honors id: false — no implicit primary key', () => {
    const t = schemaTable(
      `
      ActiveRecord::Schema[7.1].define do
        create_table "audit_events", id: false, force: :cascade do |t|
          t.string "event"
        end
      end
    `,
      'audit_events',
    )
    expect(t!.columns).toEqual(['event'])
    expect(t!.columns).not.toContain('id')
  })

  it('t.references / t.belongs_to add a <name>_id column; t.column reads its first arg', () => {
    const t = schemaTable(
      `
      ActiveRecord::Schema[7.1].define do
        create_table "orders", force: :cascade do |t|
          t.references :user, foreign_key: true
          t.belongs_to :account
          t.references :subject, polymorphic: true
          t.column "kind", "string"
        end
      end
    `,
      'orders',
    )
    // user_id + account_id, the polymorphic pair subject_id + subject_type, and the
    // generic column's own name. t.index and friends contribute nothing.
    expect(t!.columns).toEqual(['id', 'user_id', 'account_id', 'subject_id', 'subject_type', 'kind'])
  })

  it('ignores non-column table statements (index, check_constraint)', () => {
    const t = schemaTable(
      `
      ActiveRecord::Schema[7.1].define do
        create_table "widgets", force: :cascade do |t|
          t.string "name"
          t.index ["name"], name: "idx_widgets_name"
          t.check_constraint "length(name) > 0"
        end
      end
    `,
      'widgets',
    )
    expect(t!.columns).toEqual(['id', 'name'])
  })

  it('returns nothing for a .rb file that is not an ActiveRecord schema', () => {
    expect(schemaEps('class Foo\n  def bar; end\nend\n')).toEqual([])
  })
})

describe('railsSchemaForeignKeys — literal REFERENCES from schema.rb', () => {
  it('t.references :user, foreign_key: true → child REFERENCES users (pluralized)', () => {
    const out = schemaFks(`
      ActiveRecord::Schema[7.1].define do
        create_table "orders", force: :cascade do |t|
          t.references :user, foreign_key: true
        end
      end
    `)
    expect(out).toHaveLength(1)
    expect(out[0]!.childTable).toBe('orders')
    expect(out[0]!.parentTable).toBe('users')
    expect(out[0]!.evidence.file).toBe('db/schema.rb')
  })

  it('honors foreign_key: { to_table: :accounts } over the pluralized default', () => {
    const out = schemaFks(`
      ActiveRecord::Schema[7.1].define do
        create_table "orders", force: :cascade do |t|
          t.references :buyer, foreign_key: { to_table: :accounts }
        end
      end
    `)
    expect(out[0]!.parentTable).toBe('accounts')
  })

  it('a bare t.references (no foreign_key:) and a polymorphic one mint no edge', () => {
    const out = schemaFks(`
      ActiveRecord::Schema[7.1].define do
        create_table "orders", force: :cascade do |t|
          t.references :user
          t.references :subject, polymorphic: true, foreign_key: true
        end
      end
    `)
    expect(out).toEqual([])
  })

  it('reads a top-level add_foreign_key with both names literal', () => {
    const out = schemaFks(`
      ActiveRecord::Schema[7.1].define do
        add_foreign_key "line_items", "orders"
        add_foreign_key "comments", "posts", column: "post_ref"
      end
    `)
    const pairs = out.map((r) => `${r.childTable}->${r.parentTable}`)
    // The column: option does not change the table-grain edge.
    expect(pairs).toEqual(['line_items->orders', 'comments->posts'])
  })
})

describe('railsModelEndpointsFromFile — class↔table link', () => {
  it('links a model to its pluralized table (Order → orders), no columns', () => {
    const out = modelEps('class Order < ApplicationRecord\nend\n')
    expect(out).toHaveLength(1)
    expect(out[0]!.infraId).toBe('infra:sql-table:orders')
    expect(out[0]!.columns).toBeUndefined()
  })

  it('underscores a multi-word class name (LineItem → line_items)', () => {
    expect(modelEps('class LineItem < ApplicationRecord\nend\n')[0]!.name).toBe('line_items')
  })

  it('honors self.table_name over the pluralization fallback', () => {
    const out = modelEps('class Account < ApplicationRecord\n  self.table_name = "legacy_accounts"\nend\n')
    expect(out[0]!.name).toBe('legacy_accounts')
  })

  it('accepts the legacy ActiveRecord::Base base class', () => {
    expect(modelEps('class Widget < ActiveRecord::Base\nend\n')[0]!.name).toBe('widgets')
  })

  it('ignores a plain-old-Ruby class that is not an ActiveRecord model', () => {
    expect(modelEps('class PriceCalculator\n  def call; end\nend\n')).toEqual([])
  })
})

describe('railsModelForeignKeys — associations → REFERENCES (direction by macro)', () => {
  it('belongs_to points from this table to the association table', () => {
    const out = modelFks('class Order < ApplicationRecord\n  belongs_to :user\nend\n')
    expect(out[0]!.childTable).toBe('orders')
    expect(out[0]!.parentTable).toBe('users')
  })

  it('has_many / has_one put the FK on the OTHER table (child is the association)', () => {
    const out = modelFks('class User < ApplicationRecord\n  has_many :orders\n  has_one :profile\nend\n')
    const pairs = out.map((r) => `${r.childTable}->${r.parentTable}`)
    expect(pairs).toEqual(['orders->users', 'profiles->users'])
  })

  it('honors class_name: to resolve the association table', () => {
    const out = modelFks(
      'class Account < ApplicationRecord\n  self.table_name = "legacy_accounts"\n  belongs_to :owner, class_name: "User", foreign_key: "owner_ref"\nend\n',
    )
    expect(out[0]!.childTable).toBe('legacy_accounts')
    expect(out[0]!.parentTable).toBe('users')
  })

  it('defers has_many :through rather than guessing a join', () => {
    const out = modelFks('class User < ApplicationRecord\n  has_many :tags, through: :taggings\nend\n')
    expect(out).toEqual([])
  })
})

// End-to-end: the Gemfile discovers a Rails service, schema.rb + models are read
// into sql-table nodes, ColumnAttr columns, and REFERENCES edges — the same shapes
// Prisma and Drizzle produce, so the data-axis queries walk a Rails app unchanged.
describe('Rails ActiveRecord data axis end-to-end (ADR-174)', () => {
  beforeEach(() => resetGraph())
  const FIXTURE = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'rails-activerecord',
  )
  const SVC_NAME = 'rails-activerecord'

  const columnNames = (name: string): string[] => {
    const node = getGraph().getNodeAttributes(tbl(name)) as InfraNode
    return (node.columns ?? []).map((c: ColumnAttr) => c.name)
  }

  it('materializes schema.rb tables with folded EXTRACTED columns', async () => {
    const graph = getGraph()
    const result = await extractFromDirectory(graph, FIXTURE)
    expect(result.extractionErrors).toBe(0)

    for (const t of ['users', 'orders', 'line_items', 'audit_events']) {
      expect(graph.hasNode(tbl(t))).toBe(true)
      expect((graph.getNodeAttributes(tbl(t)) as InfraNode).kind).toBe('sql-table')
    }

    // orders columns include the literal names, the t.references user_id, and the
    // t.timestamps pair — folded as EXTRACTED ColumnAttrs.
    expect(columnNames('orders').sort()).toEqual(
      ['code', 'created_at', 'id', 'metadata', 'total', 'updated_at', 'user_id'].sort(),
    )
    const ordersCols = (graph.getNodeAttributes(tbl('orders')) as InfraNode).columns ?? []
    expect(ordersCols.every((c) => c.provenances.includes(Provenance.EXTRACTED))).toBe(true)

    // id: false is honored — audit_events has no id column.
    expect(columnNames('audit_events').sort()).toEqual(['event', 'occurred_at'])
    expect(columnNames('audit_events')).not.toContain('id')
  })

  it('mints REFERENCES edges, deduped, with schema.rb literals winning evidence', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURE)

    // schema.rb: orders → users (t.references) and line_items → orders (add_foreign_key).
    expect(graph.hasEdge(refEdge('orders', 'users'))).toBe(true)
    expect(graph.hasEdge(refEdge('line_items', 'orders'))).toBe(true)
    // model-only edges: has_one :profile and the class_name-resolved belongs_to.
    expect(graph.hasEdge(refEdge('profiles', 'users'))).toBe(true)
    expect(graph.hasEdge(refEdge('legacy_accounts', 'users'))).toBe(true)

    // orders → users is declared three ways (t.references + Order belongs_to +
    // User has_many) but is ONE edge; the schema.rb literal wins the evidence.
    const ordersRefs: string[] = []
    graph.forEachOutboundEdge(tbl('orders'), (_id, attrs) => {
      if ((attrs as GraphEdge).type === EdgeType.REFERENCES) ordersRefs.push((attrs as GraphEdge).target)
    })
    expect(ordersRefs).toEqual([tbl('users')])
    const edge = graph.getEdgeAttributes(refEdge('orders', 'users')) as GraphEdge
    expect(edge.provenance).toBe(Provenance.EXTRACTED)
    expect(edge.evidence?.file).toBe('db/schema.rb')

    // Blast radius from a parent table reaches the child that FKs into it.
    const blast = getBlastRadius(graph, tbl('users'))
    expect(blast.affectedNodes.map((n) => n.nodeId)).toContain(tbl('orders'))
  })

  it('links each model file to its table via a file → sql-table CALLS edge', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURE)

    // Account's self.table_name override lands: account.rb → legacy_accounts.
    const accountFile = fileId(SVC_NAME, 'app/models/account.rb')
    const callId = extractedEdgeId(accountFile, tbl('legacy_accounts'), EdgeType.CALLS)
    expect(graph.hasEdge(callId)).toBe(true)

    // The service was discovered as a Ruby service off the Gemfile.
    const svc = serviceId(SVC_NAME)
    expect((graph.getNodeAttributes(svc) as { language?: string }).language).toBe('ruby')
    expect((graph.getNodeAttributes(svc) as { framework?: string }).framework).toBe('rails')
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
