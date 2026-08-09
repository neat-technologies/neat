import path from 'node:path'
import Parser from 'tree-sitter'
import Php from 'tree-sitter-php'
import { infraId } from '@neat.is/types'
import { snippet, type ExternalEndpoint, type SourceFile, type TableReference } from './shared.js'

// PHP/Laravel data-axis recognizer (ADR-178), the second rung of the PHP pilot
// after ADR-177's routes. Laravel declares its schema in two places — literally
// in `database/migrations/*.php` and behaviourally in the Eloquent models — and
// both feed the SAME `sql-table` nodes, `ColumnAttr` columns (ADR-157), and
// `REFERENCES` edges (ADR-161) Prisma, Drizzle, and Rails' schema.rb already
// produce, so the reasoning core learns nothing Laravel-specific
// (calls/activerecord.ts is the closest analog — a migration is Rails' schema.rb,
// an Eloquent model is an ActiveRecord model).
//
//   Schema::create('orders', function (Blueprint $table) {
//     $table->id();                              // -> id
//     $table->string('code');                    // -> code
//     $table->foreignId('user_id')->constrained();  // -> user_id column + FK to users
//     $table->timestamps();                      // -> created_at, updated_at
//   });
//
//   class Order extends Model {                  // -> maps to the orders table
//     public function user() { return $this->belongsTo(User::class); }  // orders -> users
//   }
//
// The fidelity rule (ADR-157 §3): the table/column names inside `Schema::create`
// are LITERAL — the exact strings the database uses and a query's `db.statement`
// carries at runtime — so the migration is the anchor and needs no pluralization.
// The models add what the migration can't name on its own: the class↔table link
// and the relation graph. There the snake_case pluralizer is a fallback only,
// since a wrong guess there is a missed corroborating edge, never a wrong table
// node (the migration literal anchors the node either way).

// Cheap per-file gate — inert on every `.php` file that declares no schema, the
// import-gate discipline the other data-axis readers follow. A migration always
// names `Schema::create` / `Schema::table` (or the `createIfNotExists` variant),
// including the fully-qualified `\Illuminate\Support\Facades\Schema::create`.
const LARAVEL_SCHEMA_RE = /\bSchema::(create|createIfNotExists|table)\b/

const PARSE_CHUNK = 16384

function makePhpParser(): Parser {
  const p = new Parser()
  p.setLanguage(Php.php_only)
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

// ── PHP literal / argument helpers (mirrors routes.ts) ───────────────────────

// The interior text of a PHP single-quoted `string` or double-quoted
// `encapsed_string`, or null when it carries interpolation (a schema name is a
// static literal). An empty literal returns ''.
function phpStaticString(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null
  if (node.type !== 'string' && node.type !== 'encapsed_string') return null
  let text = ''
  let sawContent = false
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (!child) continue
    if (child.type === 'string_content') {
      text += child.text
      sawContent = true
    } else {
      return null // interpolation / escape / anything non-literal
    }
  }
  return sawContent ? text : ''
}

// The value nodes of a call's positional arguments. tree-sitter-php wraps each in
// an `argument`; the value is its last named child (a PHP-8 named argument
// `name: value` carries a `name` field that precedes the value).
function phpArgumentValues(argsNode: Parser.SyntaxNode | null | undefined): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = []
  if (!argsNode) return out
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const arg = argsNode.namedChild(i)
    if (!arg || arg.type !== 'argument') continue
    const val = arg.namedChild(arg.namedChildCount - 1)
    if (val) out.push(val)
  }
  return out
}

// The first positional argument as a static string, or null.
function phpFirstString(argsNode: Parser.SyntaxNode | null | undefined): string | null {
  const vals = phpArgumentValues(argsNode)
  return vals.length > 0 ? phpStaticString(vals[0]) : null
}

// The basename of a class reference — `User::class` (`class_constant_access_expression`),
// a namespaced `\App\Models\User::class`, or a `'App\Models\User'` string literal —
// stripped of its namespace: `User`. Null for anything else.
function classRefBasename(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null
  let raw: string | null = null
  if (node.type === 'class_constant_access_expression') {
    // First named child is the class name (`name` or `qualified_name`); the
    // second is the `class` keyword.
    raw = node.namedChild(0)?.text ?? null
  } else if (node.type === 'string' || node.type === 'encapsed_string') {
    // A `'App\Models\User'` string carries the namespace as literal backslashes
    // (an escape_sequence child), so read the raw interior rather than the
    // string_content pieces and split on the backslash separator below.
    const t = node.text
    raw = t.length >= 2 ? t.slice(1, -1) : null
  }
  if (raw === null) return null
  const seg = raw.replace(/^\\+/, '').split(/\\+/)
  return seg[seg.length - 1] || null
}

// ── inflection (convention / model fallback only) ────────────────────────────
//
// Migration `Schema::create` names are literal and never routed through here.
// These reproduce the common-case Laravel rules for the model→table fallback, the
// `foreignId('user_id')->constrained()` column→table convention, and the
// `foreignIdFor(Model::class)` model→table derivation. Irregulars (person/people)
// are a documented refinement (ADR-178) — since the migration literal is the
// anchor, a wrong guess here is a missed corroborating edge, not a wrong node.

// StudlyCase → snake_case: `LineItem` → line_item, `APIToken` → api_token.
function snakeCase(name: string): string {
  return name
    .replace(/([A-Z\d]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

// Common-case English pluralizer — the frequent endings Laravel's Str::plural
// covers. Irregulars are the documented refinement.
function pluralize(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return word.replace(/y$/i, 'ies')
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + 'es'
  return word + 's'
}

// class name → table name (Laravel's default `getTable()`): the snake_case plural
// of the class basename. `Order` → orders, `LineItem` → line_items.
function tableize(className: string): string {
  return pluralize(snakeCase(className))
}

// `foreignId('user_id')->constrained()` infers its parent table from the column
// name the way Laravel does: strip a trailing `_id`, then pluralize the singular.
// `user_id` → users, `author_id` → authors, `category_id` → categories.
function tableFromForeignKeyColumn(column: string): string | null {
  const singular = column.replace(/_id$/, '')
  if (singular.length === 0 || singular === column) return null
  return pluralize(singular)
}

// ── member-call chain flattening ─────────────────────────────────────────────

interface PhpSeg {
  method: string
  args: Parser.SyntaxNode | null
  node: Parser.SyntaxNode
}

// Flatten a `$table->foreignId('x')->constrained()` fluent chain into its ordered
// (method, args) segments, innermost first, plus the base receiver. A bare
// `$table->id()` → { base: $table, segs: [id] }; `$table->foreign('x')->on('y')` →
// [foreign, on]. Returns null when the chain doesn't root at a `variable_name`.
function unrollMemberChain(
  node: Parser.SyntaxNode,
): { base: Parser.SyntaxNode; segs: PhpSeg[] } | null {
  const segs: PhpSeg[] = []
  let cur: Parser.SyntaxNode | null = node
  while (cur && cur.type === 'member_call_expression') {
    const name = cur.childForFieldName('name')?.text
    if (!name) return null
    segs.unshift({ method: name, args: cur.childForFieldName('arguments'), node: cur })
    cur = cur.childForFieldName('object')
  }
  if (!cur || cur.type !== 'variable_name') return null
  return { base: cur, segs }
}

// The name of a `variable_name` (`$table` → 'table'), or null.
function variableName(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node || node.type !== 'variable_name') return null
  return node.namedChild(0)?.text ?? null
}

// ── Schema::create / Schema::table discovery ─────────────────────────────────

interface Blueprint {
  table: string
  line: number
  blueprintVar: string | null // the closure's Blueprint parameter name (`table`)
  closureBody: Parser.SyntaxNode | null // compound_statement or an arrow body
}

// The closure a `Schema::create('x', …)` carries — an anonymous `function () {}`
// (`anonymous_function_creation_expression`) or a `fn () => …` (`arrow_function`).
function schemaClosure(argsNode: Parser.SyntaxNode | null): Parser.SyntaxNode | null {
  for (const v of phpArgumentValues(argsNode)) {
    if (v.type === 'anonymous_function_creation_expression' || v.type === 'arrow_function') return v
  }
  return null
}

// The Blueprint parameter name of a schema closure (`function (Blueprint $table)`
// → 'table'), so column calls can be matched to that receiver and unrelated
// `$other->foo()` statements in the body are ignored.
function blueprintParamName(closure: Parser.SyntaxNode): string | null {
  const params = closure.childForFieldName('parameters')
  if (!params) return null
  for (let i = 0; i < params.namedChildCount; i++) {
    const p = params.namedChild(i)
    if (p?.type === 'simple_parameter') return variableName(p.childForFieldName('name'))
  }
  return null
}

// The `$table->…()` statement chains inside a schema closure — the outer
// `member_call_expression` of each, whether in a `{ … }` block or a single-
// expression arrow body.
function closureCalls(closure: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = []
  const body = closure.childForFieldName('body')
  if (!body) return out
  if (closure.type === 'arrow_function') {
    if (body.type === 'member_call_expression') out.push(body)
    return out
  }
  for (let i = 0; i < body.namedChildCount; i++) {
    const stmt = body.namedChild(i)
    if (stmt?.type !== 'expression_statement') continue
    const call = stmt.namedChild(0)
    if (call?.type === 'member_call_expression') out.push(call)
  }
  return out
}

// Is this scoped call a `Schema::create` / `Schema::table` (or the FQ facade)?
function isSchemaCall(node: Parser.SyntaxNode): boolean {
  if (node.type !== 'scoped_call_expression') return false
  const scope = node.childForFieldName('scope')?.text ?? ''
  const rooted = scope === 'Schema' || scope.endsWith('\\Schema')
  if (!rooted) return false
  const method = node.childForFieldName('name')?.text ?? ''
  return method === 'create' || method === 'createIfNotExists' || method === 'table'
}

// Read a `Schema::create('orders', function (Blueprint $table) { … })` into its
// literal table name and the closure to scan for columns / FKs. A computed table
// name (interpolated, a constant) is left unclaimed — never guessed.
function readBlueprint(node: Parser.SyntaxNode): Blueprint | null {
  const args = node.childForFieldName('arguments')
  const table = phpFirstString(args)
  if (table === null || table.length === 0) return null
  const closure = schemaClosure(args)
  return {
    table,
    line: node.startPosition.row + 1,
    blueprintVar: closure ? blueprintParamName(closure) : null,
    closureBody: closure,
  }
}

// ── columns ──────────────────────────────────────────────────────────────────

// The Blueprint methods whose FIRST string argument is the column name — the
// bounded set the fidelity discipline keeps (the analog of ActiveRecord's
// AR_COLUMN_TYPES and Drizzle's TABLE_BUILDERS). Non-column methods (index,
// unique, primary, dropColumn, foreign) are absent, so they contribute nothing.
// `id` / `timestamps` / `softDeletes` / `rememberToken` / `foreignId` /
// `foreignIdFor` expand specially below.
const NAMED_COLUMN_METHODS = new Set([
  'bigIncrements', 'bigInteger', 'binary', 'boolean', 'char', 'dateTime', 'dateTimeTz',
  'date', 'decimal', 'double', 'enum', 'float', 'foreignUlid', 'foreignUuid', 'fullText',
  'geography', 'geometry', 'increments', 'integer', 'ipAddress', 'json', 'jsonb', 'lineString',
  'longText', 'macAddress', 'mediumIncrements', 'mediumInteger', 'mediumText', 'multiLineString',
  'multiPoint', 'multiPolygon', 'point', 'polygon', 'set', 'smallIncrements', 'smallInteger',
  'string', 'text', 'time', 'timeTz', 'timestamp', 'timestampTz', 'tinyIncrements',
  'tinyInteger', 'tinyText', 'ulid', 'unsignedBigInteger', 'unsignedDecimal', 'unsignedInteger',
  'unsignedMediumInteger', 'unsignedSmallInteger', 'unsignedTinyInteger', 'uuid', 'year',
])

// The column(s) a single `$table->…()` statement declares, or [] for a
// non-column statement (an index, a bare `foreign()` constraint, a deferred
// `morphs()`). The base segment is the column-defining method; chained modifiers
// (`->nullable()`, `->constrained()`, …) don't rename the column.
function columnsFromCall(chain: Parser.SyntaxNode, blueprintVar: string | null): string[] {
  const un = unrollMemberChain(chain)
  if (!un) return []
  // Only columns on the Blueprint receiver, when the param name is known.
  if (blueprintVar !== null && variableName(un.base) !== blueprintVar) return []
  const base = un.segs[0]
  if (!base) return []
  const m = base.method
  const first = phpFirstString(base.args)

  if (m === 'id') return [first ?? 'id']
  if (m === 'timestamps' || m === 'timestampsTz' || m === 'nullableTimestamps') {
    return ['created_at', 'updated_at']
  }
  if (m === 'softDeletes' || m === 'softDeletesTz') return [first ?? 'deleted_at']
  if (m === 'rememberToken') return ['remember_token']
  if (m === 'foreignId') return first ? [first] : []
  if (m === 'foreignIdFor') {
    // The column Laravel derives from the model: snake_case(basename) + '_id'.
    const cls = classRefBasename(phpArgumentValues(base.args)[0])
    return cls ? [`${snakeCase(cls)}_id`] : []
  }
  if (NAMED_COLUMN_METHODS.has(m)) return first ? [first] : []
  // Everything else (index, unique, primary, foreign, morphs, dropColumn, …)
  // declares no column here.
  return []
}

// database/migrations/*.php tables + columns. Gated on the `Schema::` marker so it
// is inert on every other `.php` file. Emits one `sql-table` endpoint per
// `Schema::create` / `Schema::table`, carrying the literal column names — the
// orchestrator (calls/index.ts) mints the node and folds the columns onto it as
// EXTRACTED `ColumnAttr`s (ADR-157 §3). `Schema::table` (an alter) folds its added
// columns onto the same node the create minted.
export function laravelMigrationEndpointsFromFile(
  file: SourceFile,
  serviceDir: string,
): ExternalEndpoint[] {
  if (!LARAVEL_SCHEMA_RE.test(file.content)) return []
  const tree = parseSource(makePhpParser(), file.content)
  const out: ExternalEndpoint[] = []

  walk(tree.rootNode, (node) => {
    if (!isSchemaCall(node)) return
    const bp = readBlueprint(node)
    if (!bp) return

    const columns: string[] = []
    const seen = new Set<string>()
    if (bp.closureBody) {
      for (const call of closureCalls(bp.closureBody)) {
        for (const col of columnsFromCall(call, bp.blueprintVar)) {
          if (!seen.has(col)) {
            seen.add(col)
            columns.push(col)
          }
        }
      }
    }

    out.push({
      infraId: infraId('sql-table', bp.table),
      name: bp.table,
      kind: 'sql-table',
      edgeType: 'CALLS',
      confidenceKind: 'structural',
      ...(columns.length > 0 ? { columns } : {}),
      evidence: {
        file: path.relative(serviceDir, file.path),
        line: bp.line,
        snippet: snippet(file.content, bp.line),
      },
    })
  })

  return out
}

// ── migration foreign keys ───────────────────────────────────────────────────

// database/migrations/*.php foreign keys → REFERENCES table→table edges (ADR-161),
// from the three literal migration sources:
//   $table->foreignId('user_id')->constrained()          -> orders REFERENCES users
//   $table->foreignId('acct_id')->constrained('accounts') -> orders REFERENCES accounts
//   $table->foreignIdFor(User::class)                    -> orders REFERENCES users
//   $table->foreign('buyer_id')->references('id')->on('buyers') -> orders REFERENCES buyers
// A bare `foreignId('user_id')` with no `->constrained()` is a column only (no DB
// FK), so it mints no edge. A computed / unresolvable target is left unclaimed.
export function laravelMigrationForeignKeys(
  file: SourceFile,
  serviceDir: string,
): TableReference[] {
  if (!LARAVEL_SCHEMA_RE.test(file.content)) return []
  const tree = parseSource(makePhpParser(), file.content)
  const out: TableReference[] = []
  const seen = new Set<string>()

  const emit = (childTable: string, parentTable: string, line: number): void => {
    if (!parentTable || childTable === parentTable) return
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
    if (!isSchemaCall(node)) return
    const bp = readBlueprint(node)
    if (!bp || !bp.closureBody) return

    for (const chain of closureCalls(bp.closureBody)) {
      const un = unrollMemberChain(chain)
      if (!un) continue
      if (bp.blueprintVar !== null && variableName(un.base) !== bp.blueprintVar) continue
      const base = un.segs[0]
      if (!base) continue
      const line = chain.startPosition.row + 1

      // `foreignId('user_id')->constrained(['accounts'])` — FK only when a
      // `constrained` segment is present; the parent is its explicit table
      // argument, else the column-name convention.
      if (base.method === 'foreignId' || base.method === 'foreignUuid') {
        const constrained = un.segs.find((s) => s.method === 'constrained')
        if (!constrained) continue
        const column = phpFirstString(base.args)
        if (!column) continue
        const explicit = phpFirstString(constrained.args)
        const parent = explicit ?? tableFromForeignKeyColumn(column)
        if (parent) emit(bp.table, parent, line)
        continue
      }

      // `foreignIdFor(User::class)` — the model names its table directly.
      if (base.method === 'foreignIdFor') {
        const cls = classRefBasename(phpArgumentValues(base.args)[0])
        if (cls) emit(bp.table, tableize(cls), line)
        continue
      }

      // `foreign('buyer_id')->references('id')->on('buyers')` — the parent table
      // is the `on(...)` argument; `references(...)` is the parent column, ignored
      // at table grain.
      if (base.method === 'foreign') {
        const on = un.segs.find((s) => s.method === 'on')
        const parent = on ? phpFirstString(on.args) : null
        if (parent) emit(bp.table, parent, line)
        continue
      }
    }
  })

  return out
}

// ── app/Models/*.php: class↔table link + relations ───────────────────────────

// The base-class basename of a `class X extends Y` — `Y`'s trailing name, or null.
function baseClassName(cls: Parser.SyntaxNode): string | null {
  for (let i = 0; i < cls.namedChildCount; i++) {
    const c = cls.namedChild(i)
    if (c?.type !== 'base_clause') continue
    const ref = c.namedChild(0)
    if (!ref) return null
    const seg = ref.text.replace(/^\\+/, '').split('\\')
    return seg[seg.length - 1] || null
  }
  return null
}

// Is this class an Eloquent model? `extends Model` (the Eloquent base) or
// `extends Authenticatable` (the base Laravel's own `User` model uses), including
// a fully-qualified `\Illuminate\Database\Eloquent\Model`.
function isEloquentModel(cls: Parser.SyntaxNode): boolean {
  const base = baseClassName(cls)
  return base === 'Model' || base === 'Authenticatable'
}

// The `declaration_list` body of a class.
function classBody(cls: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (let i = 0; i < cls.namedChildCount; i++) {
    const c = cls.namedChild(i)
    if (c?.type === 'declaration_list') return c
  }
  return null
}

// The explicit `protected $table = 'x'` override on a model, or null.
function modelTableOverride(cls: Parser.SyntaxNode): string | null {
  const body = classBody(cls)
  if (!body) return null
  for (let i = 0; i < body.namedChildCount; i++) {
    const decl = body.namedChild(i)
    if (decl?.type !== 'property_declaration') continue
    for (let j = 0; j < decl.namedChildCount; j++) {
      const el = decl.namedChild(j)
      if (el?.type !== 'property_element') continue
      // property_element's first named child is the `variable_name`; a
      // `property_initializer` (when the property has a default) wraps its value.
      if (variableName(el.namedChild(0)) !== 'table') continue
      for (let k = 0; k < el.namedChildCount; k++) {
        const child = el.namedChild(k)
        if (child?.type !== 'property_initializer') continue
        const str = phpStaticString(child.namedChild(child.namedChildCount - 1))
        if (str) return str
      }
    }
  }
  return null
}

// The table a model maps to: `protected $table` when set, else the snake_case
// plural of the class name. The migration literal is the anchor; this only names
// the link.
function modelTable(cls: Parser.SyntaxNode): string | null {
  const nameNode = cls.childForFieldName('name')
  if (!nameNode) return null
  return modelTableOverride(cls) ?? tableize(nameNode.text)
}

// Walk a class subtree WITHOUT crossing into a nested class / anonymous class, so
// `$this->belongsTo(...)` calls inside the model's relation methods are found but
// a nested declaration's calls are not attributed here.
function walkWithinClass(cls: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  const body = classBody(cls)
  if (!body) return
  const recur = (n: Parser.SyntaxNode): void => {
    visit(n)
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i)
      if (!c) continue
      if (c.type === 'class_declaration' || c.type === 'object_creation_expression') continue
      recur(c)
    }
  }
  recur(body)
}

// app/Models/*.php: the model→table link. Emits a `sql-table` endpoint so the
// model file gets a `file ──CALLS──▶ sql-table` edge (the ActiveRecord/SQLAlchemy
// model-file pattern) — no columns, since Eloquent reads those from the DB and the
// migration is the column authority.
export function laravelModelEndpointsFromFile(
  file: SourceFile,
  serviceDir: string,
): ExternalEndpoint[] {
  const tree = parseSource(makePhpParser(), file.content)
  const out: ExternalEndpoint[] = []
  const seen = new Set<string>()

  walk(tree.rootNode, (node) => {
    if (node.type !== 'class_declaration' || !isEloquentModel(node)) return
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

const ELOQUENT_RELATIONS = new Set(['belongsTo', 'hasMany', 'hasOne'])

// app/Models/*.php relations → REFERENCES edges, deduped against the migration FKs
// at the graph level (table-edges.ts guards every write with `hasEdge`, and the
// migration refs are added first). The FK lives on the table that holds the
// `<name>_id` column, so direction depends on the relation macro:
//   belongsTo(User::class)     -> this table REFERENCES the relation's table (users)
//   hasMany(LineItem::class)   -> line_items REFERENCES this table (FK on the other side)
//   hasOne(Profile::class)     -> profiles REFERENCES this table
// The first argument is the related model class; `belongsToMany` (pivot) and
// `hasManyThrough` are deferred.
export function laravelModelForeignKeys(
  file: SourceFile,
  serviceDir: string,
): TableReference[] {
  const tree = parseSource(makePhpParser(), file.content)
  const out: TableReference[] = []
  const seen = new Set<string>()

  walk(tree.rootNode, (node) => {
    if (node.type !== 'class_declaration' || !isEloquentModel(node)) return
    const thisTable = modelTable(node)
    if (!thisTable) return

    walkWithinClass(node, (call) => {
      if (call.type !== 'member_call_expression') return
      if (variableName(call.childForFieldName('object')) !== 'this') return
      const macro = call.childForFieldName('name')?.text
      if (!macro || !ELOQUENT_RELATIONS.has(macro)) return
      const related = classRefBasename(phpArgumentValues(call.childForFieldName('arguments'))[0])
      if (!related) return
      const relatedTable = tableize(related)

      const childTable = macro === 'belongsTo' ? thisTable : relatedTable
      const parentTable = macro === 'belongsTo' ? relatedTable : thisTable
      if (childTable === parentTable) return
      const key = `${childTable}->${parentTable}`
      if (seen.has(key)) return
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
    })
  })

  return out
}
