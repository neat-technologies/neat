import path from 'node:path'
import Parser from 'tree-sitter'
import Go from 'tree-sitter-go'
import { infraId } from '@neat.is/types'
import { tableFromSqlStatement, columnsFromSqlStatement } from '../../otel.js'
import { snippet, toPosix, type ExternalEndpoint, type SourceFile } from './shared.js'

// Go raw-SQL data-axis recognizer (ADR-184). The GORM reader (ADR-180) covers the
// ORM case, but plenty of Go services skip the ORM and hand `database/sql` (or
// `github.com/jmoiron/sqlx`) a literal SQL string. Those table reads/writes were
// invisible — a Go service's data only showed up when it used GORM. This reads the
// call sites that carry a static SQL statement and lands them on the SAME
// `infra:sql-table:<name>` nodes GORM, Prisma, Drizzle, and the rest produce.
//
//   db.Query("SELECT id, email FROM users WHERE id = $1")
//   db.ExecContext(ctx, "INSERT INTO orders (total) VALUES ($1)")
//   db.Get(&u, `SELECT id, email FROM accounts WHERE id = $1`)   // sqlx
//
// THE POINT is fusion, not a static table list (that's what every other tool
// already does). The OBSERVED ingest recovers the table by running
// `tableFromSqlStatement` on the span's `db.statement` / `db.query.text` (there is
// no dedicated table attribute — ADR-152), so this recognizer runs the EXACT SAME
// helper on the SAME SQL text. The extracted table name is therefore byte-identical
// to the observed one and the two fuse on `infraId('sql-table', <name>)` rather than
// twinning. `columnsFromSqlStatement` does the same for the touched columns, folded
// as `ColumnAttr` (ADR-157). Don't write a second SQL parser here — divergence from
// the ingest parse is the one way this breaks.
//
// Import gate (mirrors net/http's structural gate in routes.ts): recognize only in a
// file that imports `database/sql` and/or `github.com/jmoiron/sqlx`. Both are the
// self-gating discipline every data reader follows — without it an arbitrary Go
// string literal that happens to look like SQL would mint a table.

const PARSE_CHUNK = 16384

// `database/sql`'s statement-taking methods. A `*sqlx.DB` embeds `*sql.DB`, so these
// are recognized whenever EITHER import is present.
const DATABASE_SQL_METHODS = new Set([
  'Query',
  'QueryContext',
  'QueryRow',
  'QueryRowContext',
  'Exec',
  'ExecContext',
  'Prepare',
  'PrepareContext',
])

// sqlx's own statement-taking surface — recognized only when `sqlx` is imported.
// `Get`/`Select`/`GetContext`/`SelectContext` take a destination pointer first, so
// the SQL isn't argument 0; the "first string-literal argument" rule below handles
// that the same way it skips a leading `ctx`.
const SQLX_METHODS = new Set([
  'Get',
  'Select',
  'Queryx',
  'QueryRowx',
  'NamedExec',
  'NamedQuery',
  'MustExec',
  'Preparex',
  'GetContext',
  'SelectContext',
])

const DATABASE_SQL_IMPORT = 'database/sql'
const SQLX_IMPORT = 'github.com/jmoiron/sqlx'

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

// The literal value of an interpreted (`"..."`) or raw/backtick (`` `...` ``) Go
// string literal, delimiters stripped; null for anything else. Multi-line backtick
// SQL is idiomatic in Go, so both node types are read verbatim — the backtick body
// needs no unescaping.
function goStringLiteralValue(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null
  if (node.type === 'interpreted_string_literal' || node.type === 'raw_string_literal') {
    const t = node.text
    return t.length >= 2 ? t.slice(1, -1) : ''
  }
  return null
}

// Whether the file imports any of `names` — the structural half of the gate, read
// off both the grouped `import ( … )` and the single `import "database/sql"` forms
// (each yields an `import_spec` whose path is a string literal). Mirrors
// `goImportsNetHttp` in routes.ts.
function goImportsAny(root: Parser.SyntaxNode, names: Set<string>): boolean {
  let found = false
  walk(root, (node) => {
    if (found || node.type !== 'import_spec') return
    for (let i = 0; i < node.namedChildCount; i++) {
      const value = goStringLiteralValue(node.namedChild(i))
      if (value !== null && names.has(value)) found = true
    }
  })
  return found
}

// The first DIRECT argument that is itself a string literal — the SQL statement.
// Scanning direct args (not recursing) both skips a leading `ctx` / destination
// pointer and refuses a computed statement: a `fmt.Sprintf(...)` or `base + " ..."`
// argument is a call/binary expression, not a string literal, so nothing matches and
// the call site is left unclaimed rather than guessed.
function firstStringLiteralArg(argsNode: Parser.SyntaxNode | null): string | null {
  if (!argsNode) return null
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const value = goStringLiteralValue(argsNode.namedChild(i))
    if (value !== null) return value
  }
  return null
}

// Raw-SQL call sites → `infra:sql-table:<name>` endpoints carrying the touched
// columns (ADR-157 §3). Gated on the `database/sql` / `sqlx` import. One endpoint per
// call site (not per table) so a SELECT and an INSERT to the same table each
// contribute their columns — the orchestrator (calls/index.ts) dedupes the CALLS
// edge and folds the union of columns onto the one node.
export function goSqlEndpointsFromFile(file: SourceFile, serviceDir: string): ExternalEndpoint[] {
  if (path.extname(file.path) !== '.go') return []
  // Cheap textual pre-check before parsing — inert on the vast majority of `.go`
  // files that touch no SQL driver at all.
  if (!file.content.includes(DATABASE_SQL_IMPORT) && !file.content.includes(SQLX_IMPORT)) return []

  const tree = parseSource(makeGoParser(), file.content)
  const importsDatabaseSql = goImportsAny(tree.rootNode, new Set([DATABASE_SQL_IMPORT]))
  const importsSqlx = goImportsAny(tree.rootNode, new Set([SQLX_IMPORT]))
  if (!importsDatabaseSql && !importsSqlx) return []

  const out: ExternalEndpoint[] = []
  walk(tree.rootNode, (node) => {
    if (node.type !== 'call_expression') return
    const fn = node.childForFieldName('function')
    if (fn?.type !== 'selector_expression') return
    const method = fn.childForFieldName('field')?.text
    if (!method) return
    const recognized = DATABASE_SQL_METHODS.has(method) || (importsSqlx && SQLX_METHODS.has(method))
    if (!recognized) return

    const sql = firstStringLiteralArg(node.childForFieldName('arguments'))
    if (sql === null) return
    const table = tableFromSqlStatement(sql)
    if (!table) return
    const columns = columnsFromSqlStatement(sql)
    const line = node.startPosition.row + 1

    out.push({
      infraId: infraId('sql-table', table),
      name: table,
      kind: 'sql-table',
      edgeType: 'CALLS',
      confidenceKind: 'verified-call-site',
      ...(columns.length > 0 ? { columns } : {}),
      evidence: {
        file: toPosix(path.relative(serviceDir, file.path)),
        line,
        snippet: snippet(file.content, line),
      },
    })
  })
  return out
}
