import path from 'node:path'
import Parser from 'tree-sitter'
import Go from 'tree-sitter-go'
import { infraId } from '@neat.is/types'
import { snippet, toPosix, type ExternalEndpoint, type SourceFile, type TableReference } from './shared.js'

// Go/GORM data-axis recognizer (ADR-180), the data rung for Go after ADR-154's
// route + `database/sql` call sites. GORM model structs feed the SAME `sql-table`
// nodes, `ColumnAttr` columns (ADR-157), and `REFERENCES` edges (ADR-161) Prisma,
// Drizzle, Rails, and Laravel already produce, so the reasoning core learns nothing
// GORM-specific (calls/activerecord.ts and calls/eloquent.ts are the closest
// analogs — a Rails model or an Eloquent model is a GORM struct).
//
//   type User struct {
//     gorm.Model                  // -> id, created_at, updated_at, deleted_at
//     Name      string            // -> name
//     CompanyID uint              // -> company_id (the belongs-to FK column)
//     Company   Company           // belongs-to: users -> companies
//     Orders    []Order           // has-many:   orders -> users
//   }
//   db.AutoMigrate(&User{}, &Company{}, &Order{})
//
// THE LOAD-BEARING DIFFERENCE from Rails/Laravel: GORM has no literal schema file.
// Rails' `db/schema.rb` and Laravel's migrations spell the table/column names out
// as the exact database strings; GORM DERIVES the table name from the struct name
// by `inflection.Plural(toDBName(StructName))` (schema.NamingStrategy.TableName,
// https://gorm.io/docs/conventions.html). So the pluralizer must reproduce GORM's
// own — an initialism-aware snake_case plus a jinzhu/inflection-style pluralizer
// with irregulars — because a wrong derivation mints a table node the runtime
// never creates (a FALSE node), not merely a missed edge. The OBSERVED table is
// the ground truth: the GORM OTel plugin reports `tx.Statement.Table` as
// `db.collection.name`, which ADR-179 taught ingest to read into the table key, so
// the extracted node fuses onto `infra:sql-table:<name>` by table NAME — the
// derivation is aimed at exactly that string. Where the derivation is wrong, the
// OBSERVED side is the anchor and the divergence surfaces the miss.

// Cheap per-file gate — inert on every `.go` file that isn't a GORM model file,
// the import-gate discipline the other data-axis readers follow.
const GORM_IMPORT_RE = /gorm\.io\/gorm/

const PARSE_CHUNK = 16384

function makeGoParser(): Parser {
  const p = new Parser()
  p.setLanguage(Go)
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

// ── inflection (GORM's schema.NamingStrategy, reproduced) ────────────────────
//
// Unlike the Rails/Laravel readers, where the schema literal is the anchor and the
// pluralizer is a fallback, here the derived name IS the table name for every
// struct without a `TableName()` override — so it must match GORM byte-for-byte or
// the node fuses onto nothing.

// The golint common-initialism list GORM's naming strategy links to. GORM replaces
// each with its Title-case form BEFORE snake-casing, so a run like `API` collapses
// to one word (`api`) instead of `a_p_i`. The exact set is GORM-version-sensitive
// (GORM trims a few from golint's list across releases); this is the documented
// best-effort surface where the OBSERVED table (ADR-179) is the ground-truth
// anchor. Sorted longest-first so `HTTPS` wins over its `HTTP` prefix, matching
// Go's `strings.Replacer` trie (longest match).
const COMMON_INITIALISMS = [
  'ASCII', 'HTTPS', 'UTF8', 'XSRF', 'HTML', 'HTTP', 'JSON', 'UUID', 'XMPP',
  'ACL', 'API', 'CPU', 'CSS', 'DNS', 'EOF', 'GUID', 'LHS', 'QPS', 'RAM', 'RHS',
  'RPC', 'SLA', 'SQL', 'SSH', 'TCP', 'TLS', 'TTL', 'UDP', 'UID', 'URI', 'URL',
  'UID', 'XSS', 'ID', 'IP', 'UI', 'VM', 'XML',
].sort((a, b) => b.length - a.length)

function titleCase(word: string): string {
  return word.charAt(0) + word.slice(1).toLowerCase()
}

// Reproduce GORM's `commonInitialismsReplacer` — replace each initialism with its
// Title-case form, scanning left-to-right, longest match first (Go's Replacer).
function replaceInitialisms(name: string): string {
  let out = ''
  let i = 0
  while (i < name.length) {
    let matched = false
    for (const init of COMMON_INITIALISMS) {
      if (name.startsWith(init, i)) {
        out += titleCase(init)
        i += init.length
        matched = true
        break
      }
    }
    if (!matched) {
      out += name[i]
      i++
    }
  }
  return out
}

const isUpper = (c: string): boolean => c >= 'A' && c <= 'Z'
const isDigit = (c: string): boolean => c >= '0' && c <= '9'

// A faithful port of GORM's `NamingStrategy.toDBName` (schema/naming.go): run the
// initialism replacer, then a CamelCase→snake pass that keeps capital runs
// together (`APIKey` → `api_key`, `LineItem` → `line_item`, `GormUserName` →
// `gorm_user_name`). Ported char-by-char since Go identifiers are ASCII.
function toDBName(name: string): string {
  if (name === '') return ''
  const value = replaceInitialisms(name)
  if (value.length === 1) return value.toLowerCase()

  let buf = ''
  let lastCase = false
  let curCase = isUpper(value[0]!)
  for (let i = 0; i < value.length - 1; i++) {
    const v = value[i]!
    const nextCase = isUpper(value[i + 1]!)
    const nextNumber = isDigit(value[i + 1]!)
    if (curCase) {
      if (lastCase && (nextCase || nextNumber)) {
        buf += v.toLowerCase()
      } else {
        if (i > 0 && value[i - 1] !== '_' && lastCase !== curCase) buf += '_'
        buf += v.toLowerCase()
      }
    } else {
      buf += v
    }
    lastCase = curCase
    curCase = nextCase
  }
  const last = value[value.length - 1]!
  if (curCase) {
    if (!lastCase && value.length > 1) buf += '_'
    buf += last.toLowerCase()
  } else {
    buf += last
  }
  return buf
}

// github.com/jinzhu/inflection (a Rails-ActiveSupport port) is what GORM pluralizes
// with. Uncountables pass through, irregulars map directly, then the ordered rules
// fire first-match-wins (specific before the generic `+s`). The irregular set is
// finite/best-effort — documented in ADR-180, with the OBSERVED table as the
// anchor where a rule is wrong. Operates on the snake_cased struct name, so the
// rules anchor on the trailing word of a multi-word name (`line_item` → `line_items`).
const UNCOUNTABLE = new Set([
  'equipment', 'information', 'rice', 'money', 'species', 'series', 'fish',
  'sheep', 'jeans', 'police',
])

const IRREGULAR: Array<[string, string]> = [
  ['person', 'people'],
  ['man', 'men'],
  ['child', 'children'],
  ['sex', 'sexes'],
  ['move', 'moves'],
]

const PLURAL_RULES: Array<[RegExp, string]> = [
  [/(quiz)$/i, '$1zes'],
  [/^(ox)$/i, '$1en'],
  [/([ml])ouse$/i, '$1ice'],
  [/(matr|vert|ind)(?:ix|ex)$/i, '$1ices'],
  [/(x|ch|ss|sh)$/i, '$1es'],
  [/([^aeiouy]|qu)y$/i, '$1ies'],
  [/(hive)$/i, '$1s'],
  [/(?:([^f])fe|([lr])f)$/i, '$1$2ves'],
  [/sis$/i, 'ses'],
  [/([ti])um$/i, '$1a'],
  [/([ti])a$/i, '$1a'],
  [/(buffal|tomat)o$/i, '$1oes'],
  [/(bu)s$/i, '$1ses'],
  [/(alias|status)$/i, '$1es'],
  [/(octop|vir)i$/i, '$1i'],
  [/(octop|vir)us$/i, '$1i'],
  [/(ax|test)is$/i, '$1es'],
  [/s$/i, 's'],
]

function pluralize(word: string): string {
  if (word === '') return word
  const lower = word.toLowerCase()
  for (const u of UNCOUNTABLE) {
    if (lower === u || lower.endsWith('_' + u)) return word
  }
  for (const [sing, plur] of IRREGULAR) {
    const re = new RegExp(sing + '$', 'i')
    if (re.test(word)) return word.replace(re, plur)
  }
  for (const [re, rep] of PLURAL_RULES) {
    if (re.test(word)) return word.replace(re, rep)
  }
  return word + 's'
}

// struct name → GORM's default table name: `inflection.Plural(toDBName(name))`.
// `User` → users, `LineItem` → line_items, `APIKey` → api_keys, `Person` → people.
function deriveTableName(structName: string): string {
  return pluralize(toDBName(structName))
}

// ── struct / field model ─────────────────────────────────────────────────────

interface GormTag {
  column?: string
  skip?: boolean // gorm:"-"
  primaryKey?: boolean
  foreignKey?: string
  many2many?: string
  embedded?: boolean
  embeddedPrefix?: string
}

interface GoField {
  names: string[] // empty for an embedded (anonymous) field
  typeName: string | null // base type name, slice/pointer/array unwrapped
  qualifier: string | null // package part of a qualified type (`gorm` in gorm.Model)
  isSlice: boolean
  isPointer: boolean
  isQualified: boolean
  tag: GormTag
  line: number
}

interface StructInfo {
  name: string
  fields: GoField[]
  line: number
}

function stringLiteralValue(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null
  if (node.type === 'interpreted_string_literal' || node.type === 'raw_string_literal') {
    const t = node.text
    return t.length >= 2 ? t.slice(1, -1) : ''
  }
  return null
}

// Parse a struct field's `gorm:"..."` tag. The tag node text carries its delimiters
// (backticks for a raw string, quotes for an interpreted one); an interpreted tag
// escapes its inner quotes, so unescape first.
function parseGormTag(tagNode: Parser.SyntaxNode | null | undefined): GormTag {
  const tag: GormTag = {}
  if (!tagNode) return tag
  let inner = tagNode.text
  if (inner.length >= 2) inner = inner.slice(1, -1)
  if (tagNode.type === 'interpreted_string_literal') inner = inner.replace(/\\"/g, '"')
  const m = inner.match(/gorm:"([^"]*)"/)
  if (!m) return tag
  for (const part of m[1]!.split(';')) {
    if (part === '') continue
    const idx = part.indexOf(':')
    const key = (idx >= 0 ? part.slice(0, idx) : part).trim().toLowerCase()
    const value = idx >= 0 ? part.slice(idx + 1).trim() : ''
    if (key === '-') tag.skip = true
    else if (key === 'column') tag.column = value
    else if (key === 'primarykey' || key === 'primary_key') tag.primaryKey = true
    else if (key === 'foreignkey') tag.foreignKey = value
    else if (key === 'many2many') tag.many2many = value
    else if (key === 'embedded') tag.embedded = true
    else if (key === 'embeddedprefix') tag.embeddedPrefix = value
  }
  return tag
}

// Unwrap a field's type through any slice / array / pointer layers to the base
// named type. `[]Order` → { name: 'Order', isSlice }, `*Company` → { name:
// 'Company', isPointer }, `time.Time` → { name: 'Time', qualifier: 'time' }.
function unwrapType(typeNode: Parser.SyntaxNode | null): {
  name: string | null
  qualifier: string | null
  isSlice: boolean
  isPointer: boolean
  isQualified: boolean
} {
  let isSlice = false
  let isPointer = false
  let n: Parser.SyntaxNode | null = typeNode
  while (n && (n.type === 'slice_type' || n.type === 'array_type' || n.type === 'pointer_type')) {
    if (n.type === 'slice_type' || n.type === 'array_type') isSlice = true
    if (n.type === 'pointer_type') isPointer = true
    n = n.childForFieldName('element') ?? n.namedChild(n.namedChildCount - 1)
  }
  if (!n) return { name: null, qualifier: null, isSlice, isPointer, isQualified: false }
  if (n.type === 'type_identifier') {
    return { name: n.text, qualifier: null, isSlice, isPointer, isQualified: false }
  }
  if (n.type === 'qualified_type') {
    const pkg = n.childForFieldName('package')?.text ?? n.namedChild(0)?.text ?? null
    const nm = n.childForFieldName('name')?.text ?? n.namedChild(1)?.text ?? null
    return { name: nm, qualifier: pkg, isSlice, isPointer, isQualified: true }
  }
  // map / func / interface / channel types are never a column or a relation.
  return { name: null, qualifier: null, isSlice, isPointer, isQualified: false }
}

function readField(fieldDecl: Parser.SyntaxNode): GoField {
  const names: string[] = []
  let tagNode: Parser.SyntaxNode | null = null
  for (let i = 0; i < fieldDecl.namedChildCount; i++) {
    const c = fieldDecl.namedChild(i)
    if (!c) continue
    if (c.type === 'field_identifier') names.push(c.text)
    else if (c.type === 'raw_string_literal' || c.type === 'interpreted_string_literal') tagNode = c
  }
  const typeNode = fieldDecl.childForFieldName('type')
  const t = unwrapType(typeNode)
  return {
    names,
    typeName: t.name,
    qualifier: t.qualifier,
    isSlice: t.isSlice,
    isPointer: t.isPointer,
    isQualified: t.isQualified,
    tag: parseGormTag(tagNode),
    line: fieldDecl.startPosition.row + 1,
  }
}

// Every `type X struct { … }` in the file, keyed by name.
function collectStructs(tree: Parser.Tree): Map<string, StructInfo> {
  const structs = new Map<string, StructInfo>()
  walk(tree.rootNode, (node) => {
    if (node.type !== 'type_spec') return
    const nameNode = node.childForFieldName('name')
    const typeNode = node.childForFieldName('type')
    if (!nameNode || typeNode?.type !== 'struct_type') return
    const list = typeNode.childForFieldName('body') ?? typeNode.namedChild(0)
    const fields: GoField[] = []
    if (list && list.type === 'field_declaration_list') {
      for (let i = 0; i < list.namedChildCount; i++) {
        const fd = list.namedChild(i)
        if (fd?.type === 'field_declaration') fields.push(readField(fd))
      }
    }
    structs.set(nameNode.text, {
      name: nameNode.text,
      fields,
      line: node.startPosition.row + 1,
    })
  })
  return structs
}

// GORM entry points that take a model pointer/value and so name a model struct.
// `AutoMigrate(&A{}, &B{})` is the richest — it enumerates the whole model set in
// one call.
const GORM_MODEL_METHODS = new Set([
  'AutoMigrate', 'Model', 'Create', 'Find', 'First', 'Take', 'Last', 'Save',
  'Delete', 'Where', 'FirstOrCreate', 'FirstOrInit',
])

// The struct name a `&X{}` / `X{}` argument composite-literal names, or null.
function compositeStructName(arg: Parser.SyntaxNode): string | null {
  let n: Parser.SyntaxNode | null = arg
  if (n.type === 'unary_expression') n = n.childForFieldName('operand') ?? n.namedChild(0)
  if (!n || n.type !== 'composite_literal') return null
  const typeNode = n.childForFieldName('type')
  if (!typeNode) return null
  if (typeNode.type === 'type_identifier') return typeNode.text
  if (typeNode.type === 'qualified_type') {
    return typeNode.childForFieldName('name')?.text ?? typeNode.namedChild(1)?.text ?? null
  }
  return null
}

// Model structs referenced through a GORM db-method call anywhere in the file.
function collectCallModels(tree: Parser.Tree): Set<string> {
  const models = new Set<string>()
  walk(tree.rootNode, (node) => {
    if (node.type !== 'call_expression') return
    const fn = node.childForFieldName('function')
    if (fn?.type !== 'selector_expression') return
    const method = fn.childForFieldName('field')?.text
    if (!method || !GORM_MODEL_METHODS.has(method)) return
    const args = node.childForFieldName('arguments')
    if (!args) return
    for (let i = 0; i < args.namedChildCount; i++) {
      const arg = args.namedChild(i)
      if (!arg) continue
      const name = compositeStructName(arg)
      if (name) models.add(name)
    }
  })
  return models
}

// A `func (X) TableName() string { return "literal" }` override map. A computed
// return (a variable, a concatenation) yields no entry — the struct falls back to
// the derived name — but still counts as a model signal.
function collectTableNameOverrides(
  tree: Parser.Tree,
): { overrides: Map<string, string>; declarers: Set<string> } {
  const overrides = new Map<string, string>()
  const declarers = new Set<string>()
  walk(tree.rootNode, (node) => {
    if (node.type !== 'method_declaration') return
    if (node.childForFieldName('name')?.text !== 'TableName') return
    const receiver = node.childForFieldName('receiver')
    if (!receiver) return
    let recvType: string | null = null
    for (let i = 0; i < receiver.namedChildCount; i++) {
      const pd = receiver.namedChild(i)
      if (pd?.type !== 'parameter_declaration') continue
      const t = unwrapType(pd.childForFieldName('type'))
      recvType = t.name
    }
    if (!recvType) return
    declarers.add(recvType)
    const body = node.childForFieldName('body')
    if (!body) return
    let literal: string | null = null
    walk(body, (n) => {
      if (literal !== null) return
      if (n.type !== 'return_statement') return
      const exprList = n.namedChild(0)
      const first = exprList?.namedChild(0) ?? exprList
      const v = stringLiteralValue(first)
      if (v) literal = v
    })
    if (literal !== null) overrides.set(recvType, literal)
  })
  return { overrides, declarers }
}

// A field is a RELATION (association), not a column, when its base type — slice or
// pointer unwrapped — is another struct declared in this file, and it is not a
// qualified type (`time.Time`, `sql.NullString`) or the embedded `gorm.Model`.
function isRelationField(field: GoField, structs: Map<string, StructInfo>): boolean {
  if (field.names.length === 0) return false // embedded, handled separately
  if (field.isQualified) return false
  if (!field.typeName) return false
  return structs.has(field.typeName)
}

// Is `gorm.Model`?
function isGormModelEmbed(field: GoField): boolean {
  return field.names.length === 0 && field.qualifier === 'gorm' && field.typeName === 'Model'
}

// ── analysis (shared by the endpoint and FK readers) ─────────────────────────

interface Analysis {
  structs: Map<string, StructInfo>
  models: Set<string>
  tableFor: (structName: string) => string
}

function analyze(tree: Parser.Tree): Analysis {
  const structs = collectStructs(tree)
  const { overrides, declarers } = collectTableNameOverrides(tree)
  const callModels = collectCallModels(tree)

  // Seed the model set from the three direct signals: a gorm.Model embed, a GORM
  // db-method call arg, or a TableName() declaration.
  const models = new Set<string>()
  for (const [name, info] of structs) {
    if (info.fields.some(isGormModelEmbed)) models.add(name)
  }
  for (const name of callModels) if (structs.has(name)) models.add(name)
  for (const name of declarers) if (structs.has(name)) models.add(name)

  // Expand: a struct referenced as a relation field by a model is itself a model
  // (GORM requires the related type to be a registered model). Fixpoint over the
  // relation graph so a related model's own relations pull their targets in too.
  let grew = true
  while (grew) {
    grew = false
    for (const name of Array.from(models)) {
      const info = structs.get(name)
      if (!info) continue
      for (const field of info.fields) {
        if (!isRelationField(field, structs)) continue
        const target = field.typeName!
        if (!models.has(target) && structs.has(target)) {
          models.add(target)
          grew = true
        }
      }
    }
  }

  const tableFor = (structName: string): string =>
    overrides.get(structName) ?? deriveTableName(structName)

  return { structs, models, tableFor }
}

// Expand a model struct's fields into its database column names. Anonymous
// embedded fields inline: `gorm.Model` → the four audit columns, and an embedded
// LOCAL struct (`type Base struct{…}; type User struct{ Base; … }`) inlines its own
// columns (one level, cycle-guarded). A named field with `gorm:"embedded"` inlines
// with an optional prefix. `gorm:"-"` skips; a relation field is not a column.
function collectColumns(
  struct: StructInfo,
  structs: Map<string, StructInfo>,
  seen: Set<string>,
  prefix: string,
  out: string[],
  emitted: Set<string>,
): void {
  if (seen.has(struct.name)) return
  seen.add(struct.name)

  const add = (col: string): void => {
    const full = prefix + col
    if (!emitted.has(full)) {
      emitted.add(full)
      out.push(full)
    }
  }

  for (const field of struct.fields) {
    if (field.tag.skip) continue

    // Anonymous embedded field.
    if (field.names.length === 0) {
      if (isGormModelEmbed(field)) {
        add('id')
        add('created_at')
        add('updated_at')
        add('deleted_at')
      } else if (!field.isQualified && field.typeName && structs.has(field.typeName)) {
        collectColumns(structs.get(field.typeName)!, structs, seen, prefix, out, emitted)
      }
      // An unresolved external embed (some other package's base) can't be inlined.
      continue
    }

    // A named field tagged embedded inlines the target struct's columns.
    if (field.tag.embedded && !field.isQualified && field.typeName && structs.has(field.typeName)) {
      collectColumns(
        structs.get(field.typeName)!,
        structs,
        seen,
        prefix + (field.tag.embeddedPrefix ?? ''),
        out,
        emitted,
      )
      continue
    }

    // A relation to another model is not a column (its FK companion scalar is).
    if (isRelationField(field, structs)) continue

    // A scalar / time.Time / sql.Null* / []byte / named-scalar field is a column.
    // The `gorm:"column:x"` override wins (verbatim); otherwise snake_case each
    // name. The override only makes sense for a single-name declaration.
    if (field.names.length === 1 && field.tag.column) {
      add(field.tag.column)
    } else {
      for (const n of field.names) add(toDBName(n))
    }
  }

  seen.delete(struct.name)
}

// GORM model structs → `infra:sql-table:<name>` endpoints carrying EXTRACTED
// columns (ADR-157 §3). Gated on the `gorm.io/gorm` import. One endpoint per
// distinct table; the orchestrator (calls/index.ts) mints the node, folds the
// columns, and originates the `file ──CALLS──▶ sql-table` edge.
export function gormEndpointsFromFile(
  file: SourceFile,
  serviceDir: string,
): ExternalEndpoint[] {
  if (path.extname(file.path) !== '.go') return []
  if (!GORM_IMPORT_RE.test(file.content)) return []
  const tree = parseSource(makeGoParser(), file.content)
  const { structs, models, tableFor } = analyze(tree)

  const out: ExternalEndpoint[] = []
  const seenTables = new Set<string>()
  for (const name of models) {
    const struct = structs.get(name)
    if (!struct) continue
    const table = tableFor(name)
    if (seenTables.has(table)) continue
    seenTables.add(table)

    const columns: string[] = []
    collectColumns(struct, structs, new Set(), '', columns, new Set())

    out.push({
      infraId: infraId('sql-table', table),
      name: table,
      kind: 'sql-table',
      edgeType: 'CALLS',
      confidenceKind: 'structural',
      ...(columns.length > 0 ? { columns } : {}),
      evidence: {
        file: toPosix(path.relative(serviceDir, file.path)),
        line: struct.line,
        snippet: snippet(file.content, struct.line),
      },
    })
  }
  return out
}

// GORM associations → `REFERENCES` table→table edges (ADR-161). The FK lives on the
// table holding the `<Field>ID` column, so direction depends on the association:
//   belongs to (User has CompanyID + Company Company) -> users REFERENCES companies
//   has one    (User has CreditCard CreditCard)       -> credit_cards REFERENCES users
//   has many   (User has Orders []Order)              -> orders REFERENCES users
//   many2many  (User has Languages []Language `many2many:user_languages`)
//                                    -> user_languages REFERENCES users + languages
// A singular struct field is belongs-to when THIS struct also holds the
// conventional `<Field>ID` (or `foreignKey:`-named) scalar; otherwise has-one.
// `table-edges.ts` dedupes at the graph level and drops self-loops.
export function gormForeignKeys(file: SourceFile, serviceDir: string): TableReference[] {
  if (path.extname(file.path) !== '.go') return []
  if (!GORM_IMPORT_RE.test(file.content)) return []
  const tree = parseSource(makeGoParser(), file.content)
  const { structs, models, tableFor } = analyze(tree)

  const out: TableReference[] = []
  const seen = new Set<string>()
  const emit = (childTable: string, parentTable: string, line: number): void => {
    if (!childTable || !parentTable || childTable === parentTable) return
    const key = `${childTable}->${parentTable}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      childTable,
      parentTable,
      evidence: {
        file: toPosix(path.relative(serviceDir, file.path)),
        line,
        snippet: snippet(file.content, line),
      },
    })
  }

  for (const name of models) {
    const struct = structs.get(name)
    if (!struct) continue
    const thisTable = tableFor(name)
    const scalarNames = new Set(
      struct.fields
        .filter((f) => f.names.length > 0 && !isRelationField(f, structs))
        .flatMap((f) => f.names),
    )

    for (const field of struct.fields) {
      if (field.tag.skip) continue
      if (!isRelationField(field, structs)) continue
      const relTable = tableFor(field.typeName!)

      // many2many: synthesize the join table and reference both sides.
      if (field.tag.many2many) {
        emit(field.tag.many2many, thisTable, field.line)
        emit(field.tag.many2many, relTable, field.line)
        continue
      }

      if (field.isSlice) {
        // has many — FK on the other table.
        emit(relTable, thisTable, field.line)
        continue
      }

      // Singular struct field: belongs-to when this struct carries the FK column.
      const convFk = field.names[0]! + 'ID'
      const belongsTo =
        scalarNames.has(convFk) ||
        (field.tag.foreignKey ? scalarNames.has(field.tag.foreignKey) : false)
      if (belongsTo) emit(thisTable, relTable, field.line)
      else emit(relTable, thisTable, field.line)
    }
  }

  return out
}
