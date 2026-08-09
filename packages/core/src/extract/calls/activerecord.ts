import path from 'node:path'
import Parser from 'tree-sitter'
import Ruby from 'tree-sitter-ruby'
import { infraId } from '@neat.is/types'
import { snippet, type ExternalEndpoint, type SourceFile, type TableReference } from './shared.js'

// Ruby/Rails ActiveRecord data-axis recognizer (ADR-174), the second rung of the
// Ruby pilot after ADR-173's routes. Rails declares its schema twice — literally
// in `db/schema.rb` and behaviourally in the ActiveRecord models — and both feed
// the SAME `sql-table` nodes, `ColumnAttr` columns (ADR-157), and `REFERENCES`
// edges (ADR-161) Prisma and Drizzle already produce, so the reasoning core learns
// nothing Rails-specific (calls/prisma.ts is the closest analog).
//
//   ActiveRecord::Schema[7.1].define do
//     create_table "orders", force: :cascade do |t|
//       t.string   "name"
//       t.integer  "qty"
//       t.references :user, foreign_key: true      # -> user_id column + FK to users
//       t.timestamps                               # -> created_at, updated_at
//     end
//     add_foreign_key "line_items", "orders"       # -> line_items REFERENCES orders
//   end
//
// The fidelity rule (ADR-157 §3): the table/column/FK names in schema.rb are
// LITERAL — the exact strings the database uses and a query's `db.statement`
// carries at runtime — so schema.rb is the anchor and needs no pluralization. The
// models add what the schema can't name on its own: the class↔table link and the
// association graph. There the ActiveSupport pluralizer is a fallback only, since
// a wrong guess there is a missed edge, never a wrong table node.

const AR_SCHEMA_RE = /ActiveRecord::Schema/

const PARSE_CHUNK = 16384

function makeRubyParser(): Parser {
  const p = new Parser()
  p.setLanguage(Ruby)
  return p
}

function parseSource(parser: Parser, source: string): Parser.Tree {
  return parser.parse((index: number) =>
    index >= source.length ? '' : source.slice(index, index + PARSE_CHUNK),
  )
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node)
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)
    if (c) walk(c, visit)
  }
}

// The interior text of a Ruby string literal, or a symbol's name without its
// leading colon (`:orders` → 'orders'). Null for an interpolated string — a
// schema name is always a static literal. Mirrors routes.ts's `rubyLiteral`.
function rubyLiteral(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null
  if (node.type === 'simple_symbol') return node.text.replace(/^:/, '')
  if (node.type === 'string') {
    let text = ''
    let sawContent = false
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (!child) continue
      if (child.type === 'string_content' || child.type === 'escape_sequence') {
        text += child.text
        sawContent = true
      } else {
        return null // interpolation or anything non-literal
      }
    }
    return sawContent ? text : '' // an empty string literal has no content child
  }
  return null
}

function rubyArgs(call: Parser.SyntaxNode): Parser.SyntaxNode | null {
  return call.childForFieldName('arguments')
}

// The positional (non-`pair`) arguments of a call, in order.
function rubyPositional(args: Parser.SyntaxNode | null): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = []
  if (!args) return out
  for (let i = 0; i < args.namedChildCount; i++) {
    const c = args.namedChild(i)
    if (c && c.type !== 'pair') out.push(c)
  }
  return out
}

// The value node of a keyword argument `key: …` — a `pair` whose key is a
// `hash_key_symbol` with the given name. Handles both an inline argument-list
// pair (`create_table "x", id: false`) and a `hash` literal's own pairs
// (`foreign_key: { to_table: :y }`).
function rubyKwarg(container: Parser.SyntaxNode | null, key: string): Parser.SyntaxNode | null {
  if (!container) return null
  for (let i = 0; i < container.namedChildCount; i++) {
    const pair = container.namedChild(i)
    if (!pair || pair.type !== 'pair') continue
    const k = pair.childForFieldName('key')
    if (k?.type === 'hash_key_symbol' && k.text === key) return pair.childForFieldName('value')
  }
  return null
}

// The `call` statements at the top level of a `do … end` block or a class
// `body_statement`. tree-sitter-ruby wraps multiple statements in a
// `body_statement`; fall back to the container's own direct children for the
// single-statement shape. Mirrors routes.ts's `rubyBlockCalls`.
function rubyBodyCalls(container: Parser.SyntaxNode | null): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = []
  if (!container) return out
  const pushCalls = (n: Parser.SyntaxNode): void => {
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i)
      if (c?.type === 'call') out.push(c)
    }
  }
  let sawBody = false
  for (let i = 0; i < container.namedChildCount; i++) {
    const c = container.namedChild(i)
    if (c?.type === 'body_statement') {
      pushCalls(c)
      sawBody = true
    }
  }
  if (!sawBody) pushCalls(container)
  return out
}

// ── inflection (model / association fallback only) ───────────────────────────
//
// schema.rb names are literal and never routed through here. These reproduce the
// common-case ActiveSupport rules for the model→table fallback and the singular
// association→table derivation. Irregulars (person/people, child/children) and a
// project's custom inflections are a documented refinement (ADR-174) — since the
// schema.rb literal is the anchor, a wrong guess here is a missed corroborating
// edge, not a wrong node.

// `Admin::User` → `User`.
function demodulize(name: string): string {
  const i = name.lastIndexOf('::')
  return i >= 0 ? name.slice(i + 2) : name
}

// ActiveSupport underscore: CamelCase → snake_case, keeping acronym runs together
// (`APIKey` → `api_key`, `LineItem` → `line_item`).
function underscore(name: string): string {
  return name
    .replace(/([A-Z\d]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

// Common-case English pluralizer — the rules ActiveSupport's default inflections
// ship for the frequent endings.
function pluralize(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return word.replace(/y$/i, 'ies')
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + 'es'
  return word + 's'
}

// class name → table name (ActiveSupport `tableize`, default `table_name`):
// pluralize(underscore(demodulize(name))). `Order` → orders, `LineItem` →
// line_items, `Admin::User` → users.
function tableize(className: string): string {
  return pluralize(underscore(demodulize(className)))
}

// ── db/schema.rb: create_table → sql-table + columns ─────────────────────────

// The ActiveRecord migration column-type methods that declare a column named by
// their first string/symbol argument. `t.column "name", "type"` (the generic
// form) is here too — its first positional is still the name. Non-column table
// methods (`t.index`, `t.check_constraint`, `t.foreign_key`) are absent, so they
// contribute nothing — the bounded-set discipline Drizzle's TABLE_BUILDERS and
// SQLAlchemy's COLUMN_BUILDERS follow. `references`/`belongs_to`/`timestamps` are
// handled specially below (they expand to `<name>_id` / created_at+updated_at).
const AR_COLUMN_TYPES = new Set([
  'string', 'text', 'integer', 'bigint', 'float', 'decimal', 'numeric',
  'datetime', 'timestamp', 'timestamptz', 'time', 'date', 'binary', 'boolean',
  'json', 'jsonb', 'uuid', 'hstore', 'citext', 'inet', 'cidr', 'macaddr',
  'money', 'xml', 'tsvector', 'ltree', 'interval', 'oid', 'bit', 'blob',
  'int4range', 'int8range', 'numrange', 'tsrange', 'tstzrange', 'daterange',
  'point', 'line', 'lseg', 'box', 'path', 'polygon', 'circle', 'enum',
  'primary_key', 'virtual', 'column',
])

const AR_REFERENCE_METHODS = new Set(['references', 'belongs_to'])

// The receiver-and-method of a `t.<method> …` block call. Returns the method name
// (`string`, `references`, `timestamps`, …) regardless of the block variable name.
function blockCallMethod(call: Parser.SyntaxNode): string | null {
  return call.childForFieldName('method')?.text ?? null
}

interface SchemaTable {
  name: string
  line: number
  columns: string[]
}

// Read a single `create_table "orders", … do |t| … end` call into its table name,
// the implicit primary key, and the columns its block declares.
function readCreateTable(call: Parser.SyntaxNode): SchemaTable | null {
  const args = rubyArgs(call)
  const name = rubyLiteral(rubyPositional(args)[0])
  if (!name) return null // computed / interpolated table name — never guessed
  const line = call.startPosition.row + 1

  const columns: string[] = []
  const seen = new Set<string>()
  const add = (col: string | null): void => {
    if (col && !seen.has(col)) {
      seen.add(col)
      columns.push(col)
    }
  }

  // Implicit primary key, unless `id: false`. A `primary_key: "uuid"` renames it.
  const idOpt = rubyKwarg(args, 'id')
  if (!idOpt || idOpt.type !== 'false') {
    add(rubyLiteral(rubyKwarg(args, 'primary_key')) ?? 'id')
  }

  for (const bc of rubyBodyCalls(call.childForFieldName('block'))) {
    const method = blockCallMethod(bc)
    if (!method) continue
    const bArgs = rubyArgs(bc)
    if (method === 'timestamps') {
      add('created_at')
      add('updated_at')
    } else if (AR_REFERENCE_METHODS.has(method)) {
      const refName = rubyLiteral(rubyPositional(bArgs)[0])
      if (!refName) continue
      add(`${refName}_id`)
      // A polymorphic reference also declares a `<name>_type` discriminator.
      const poly = rubyKwarg(bArgs, 'polymorphic')
      if (poly && poly.type === 'true') add(`${refName}_type`)
    } else if (AR_COLUMN_TYPES.has(method)) {
      add(rubyLiteral(rubyPositional(bArgs)[0]))
    }
    // Anything else (index, check_constraint, …) declares no column.
  }

  return { name, line, columns }
}

// db/schema.rb tables + columns. Gated on the `ActiveRecord::Schema` marker so it
// is inert on every other `.rb` file (the import-gate discipline Drizzle and
// SQLAlchemy follow). Emits one `sql-table` endpoint per `create_table`, carrying
// the literal column names — the orchestrator (calls/index.ts) mints the node and
// folds the columns onto it as EXTRACTED `ColumnAttr`s (ADR-157 §3).
export function railsSchemaEndpointsFromFile(
  file: SourceFile,
  serviceDir: string,
): ExternalEndpoint[] {
  if (!AR_SCHEMA_RE.test(file.content)) return []
  const tree = parseSource(makeRubyParser(), file.content)
  const out: ExternalEndpoint[] = []
  const seen = new Set<string>()

  walk(tree.rootNode, (node) => {
    if (node.type !== 'call') return
    if (blockCallMethod(node) !== 'create_table') return
    const table = readCreateTable(node)
    if (!table || seen.has(table.name)) return
    seen.add(table.name)
    out.push({
      infraId: infraId('sql-table', table.name),
      name: table.name,
      kind: 'sql-table',
      edgeType: 'CALLS',
      confidenceKind: 'structural',
      ...(table.columns.length > 0 ? { columns: table.columns } : {}),
      evidence: {
        file: path.relative(serviceDir, file.path),
        line: table.line,
        snippet: snippet(file.content, table.line),
      },
    })
  })

  return out
}

// db/schema.rb foreign keys → REFERENCES table→table edges. Two literal sources,
// both preferred over any model inference: an inline `t.references :user,
// foreign_key: true` inside a create_table (parent pluralized, or `to_table:`
// verbatim when given) and a top-level `add_foreign_key "orders", "users"` (both
// names literal). A polymorphic reference names no single parent and is left
// unclaimed. `column:` / `primary_key:` on `add_foreign_key` don't change the
// table-grain edge and are ignored.
export function railsSchemaForeignKeys(
  file: SourceFile,
  serviceDir: string,
): TableReference[] {
  if (!AR_SCHEMA_RE.test(file.content)) return []
  const tree = parseSource(makeRubyParser(), file.content)
  const out: TableReference[] = []
  const seen = new Set<string>()

  const emit = (childTable: string, parentTable: string, line: number): void => {
    if (childTable === parentTable) return // self-loop, dropped by the graph anyway
    const key = `${childTable}->${parentTable}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      childTable,
      parentTable,
      evidence: {
        file: path.relative(serviceDir, file.path),
        line,
        snippet: snippet(file.content, line),
      },
    })
  }

  walk(tree.rootNode, (node) => {
    if (node.type !== 'call') return
    const method = blockCallMethod(node)

    // Top-level `add_foreign_key "child", "parent", …` — both names literal.
    if (method === 'add_foreign_key') {
      const args = rubyArgs(node)
      const pos = rubyPositional(args)
      const child = rubyLiteral(pos[0])
      const parent = rubyLiteral(pos[1])
      if (child && parent) emit(child, parent, node.startPosition.row + 1)
      return
    }

    // Inline `t.references :user, foreign_key: true` inside a create_table.
    if (method !== 'create_table') return
    const table = readCreateTable(node)
    if (!table) return
    for (const bc of rubyBodyCalls(node.childForFieldName('block'))) {
      if (!AR_REFERENCE_METHODS.has(blockCallMethod(bc) ?? '')) continue
      const bArgs = rubyArgs(bc)
      const refName = rubyLiteral(rubyPositional(bArgs)[0])
      if (!refName) continue
      const poly = rubyKwarg(bArgs, 'polymorphic')
      if (poly && poly.type === 'true') continue // no single parent to reference
      const fk = rubyKwarg(bArgs, 'foreign_key')
      if (!fk || fk.type === 'false') continue // no `foreign_key: true` → no DB FK
      // `foreign_key: { to_table: :accounts }` overrides the pluralized default.
      const toTable = fk.type === 'hash' ? rubyLiteral(rubyKwarg(fk, 'to_table')) : null
      const parent = toTable ?? pluralize(refName)
      emit(table.name, parent, bc.startPosition.row + 1)
    }
  })

  return out
}

// ── app/models/*.rb: class↔table link + associations ─────────────────────────

// The superclass constant of a `class X < Y` — `Y`'s text, or null when the class
// has no superclass. Reads the `superclass` node's constant / scope_resolution.
function superclassName(cls: Parser.SyntaxNode): string | null {
  const sup = cls.childForFieldName('superclass')
  if (!sup) return null
  for (let i = 0; i < sup.namedChildCount; i++) {
    const c = sup.namedChild(i)
    if (c && (c.type === 'constant' || c.type === 'scope_resolution')) return c.text
  }
  return null
}

// Is this class an ActiveRecord model? `< ApplicationRecord` (the Rails ≥ 5 base)
// or `< ActiveRecord::Base` (legacy), including a namespaced `Foo::ApplicationRecord`.
function isActiveRecordModel(cls: Parser.SyntaxNode): boolean {
  const sup = superclassName(cls)
  if (!sup) return false
  return sup === 'ApplicationRecord' || sup.endsWith('::ApplicationRecord') || sup === 'ActiveRecord::Base'
}

// The table a model class maps to: an explicit `self.table_name = "x"` when set,
// else the ActiveSupport pluralisation of the underscored class name (`Order` →
// orders). schema.rb literals are the anchor; this only names the link.
function modelTable(cls: Parser.SyntaxNode): string | null {
  const nameNode = cls.childForFieldName('name')
  if (!nameNode) return null
  const body = cls.childForFieldName('body')
  if (body) {
    for (let i = 0; i < body.namedChildCount; i++) {
      const stmt = body.namedChild(i)
      if (stmt?.type !== 'assignment') continue
      const left = stmt.childForFieldName('left')
      if (left?.text !== 'self.table_name') continue
      const explicit = rubyLiteral(stmt.childForFieldName('right'))
      if (explicit) return explicit
    }
  }
  return tableize(nameNode.text)
}

// app/models/*.rb: the model→table link. Emits a `sql-table` endpoint so the
// model file gets a `file ──CALLS──▶ sql-table` edge (the SQLAlchemy model-file
// pattern) — no columns, since ActiveRecord reads those from the DB, and schema.rb
// is the column authority.
export function railsModelEndpointsFromFile(
  file: SourceFile,
  serviceDir: string,
): ExternalEndpoint[] {
  const tree = parseSource(makeRubyParser(), file.content)
  const out: ExternalEndpoint[] = []
  const seen = new Set<string>()

  walk(tree.rootNode, (node) => {
    if (node.type !== 'class' || !isActiveRecordModel(node)) return
    const table = modelTable(node)
    if (!table || seen.has(table)) return
    seen.add(table)
    const line = node.startPosition.row + 1
    out.push({
      infraId: infraId('sql-table', table),
      name: table,
      kind: 'sql-table',
      edgeType: 'CALLS',
      confidenceKind: 'verified-call-site',
      evidence: {
        file: path.relative(serviceDir, file.path),
        line,
        snippet: snippet(file.content, line),
      },
    })
  })

  return out
}

const AR_ASSOCIATIONS = new Set(['belongs_to', 'has_many', 'has_one'])

// app/models/*.rb associations → REFERENCES edges, deduped against the schema.rb
// FKs at the graph level (table-edges.ts guards every write with `hasEdge`, and
// the schema.rb refs are added first). The FK lives on the table that holds the
// `<name>_id` column, so direction depends on the macro:
//   belongs_to :user     -> this table REFERENCES the association's table (users)
//   has_many :line_items -> line_items REFERENCES this table (FK on the other side)
//   has_one :profile     -> profiles REFERENCES this table
// `class_name:` retargets the association's class (hence table); `through:` (a
// join through a third model) and `has_and_belongs_to_many` are deferred.
export function railsModelForeignKeys(
  file: SourceFile,
  serviceDir: string,
): TableReference[] {
  const tree = parseSource(makeRubyParser(), file.content)
  const out: TableReference[] = []
  const seen = new Set<string>()

  walk(tree.rootNode, (node) => {
    if (node.type !== 'class' || !isActiveRecordModel(node)) return
    const thisTable = modelTable(node)
    if (!thisTable) return

    for (const call of rubyBodyCalls(node.childForFieldName('body'))) {
      const macro = blockCallMethod(call)
      if (!macro || !AR_ASSOCIATIONS.has(macro)) continue
      const args = rubyArgs(call)
      const assoc = rubyLiteral(rubyPositional(args)[0])
      if (!assoc) continue
      if (rubyKwarg(args, 'through')) continue // has_many/has_one :through — deferred

      // The association's own table: `class_name:` when given, else the
      // conventional derivation. A has_many name is already the plural table
      // name; belongs_to / has_one names are singular and pluralize.
      const className = rubyLiteral(rubyKwarg(args, 'class_name'))
      const assocTable = className
        ? tableize(className)
        : macro === 'has_many'
          ? assoc
          : pluralize(assoc)

      const childTable = macro === 'belongs_to' ? thisTable : assocTable
      const parentTable = macro === 'belongs_to' ? assocTable : thisTable
      if (childTable === parentTable) continue
      const key = `${childTable}->${parentTable}`
      if (seen.has(key)) continue
      seen.add(key)
      const line = call.startPosition.row + 1
      out.push({
        childTable,
        parentTable,
        evidence: {
          file: path.relative(serviceDir, file.path),
          line,
          snippet: snippet(file.content, line),
        },
      })
    }
  })

  return out
}
