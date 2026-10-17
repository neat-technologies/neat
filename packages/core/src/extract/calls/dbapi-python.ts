import path from 'node:path'
import Parser from 'tree-sitter'
import Python from 'tree-sitter-python'
import { infraId } from '@neat.is/types'
import { tableFromSqlStatement, columnsFromSqlStatement } from '../../otel.js'
import { snippet, toPosix, type ExternalEndpoint, type SourceFile } from './shared.js'

// Python raw-SQL data-axis recognizer for the DB-API drivers (#1432) — the Python
// sibling of the Go `database/sql` reader (calls/go.ts, ADR-184) and the JS
// `mysql`/`mysql2` reader (calls/mysql-js.ts). A service that talks to its database
// through a plain DB-API cursor with SQL in strings gets no table grain today: the
// Python ORM readers cover SQLAlchemy and the Django ORM, but a bare
// `cursor.execute(sql, params)` lands nothing. This reads the table (and the touched
// columns) off that statement and mints the same `infra:sql-table:<name>` node every
// ORM reader and the OBSERVED ingest produce.
//
//   import pymysql
//   cur.execute("SELECT * FROM voucher where order_id = %s", (oid,))   // inline
//   sql = 'INSERT INTO voucher (order_id) VALUES (%s)'; cur.execute(sql, (oid,))  // var
//
// THE POINT is fusion, not a static table list. The OBSERVED dbapi instrumentation
// emits no dedicated table attribute (ADR-152), so the table is recovered from a
// span's `db.statement` by `tableFromSqlStatement`; this recognizer runs the EXACT
// SAME shared helper on the SAME SQL text, so the extracted table is byte-identical
// to the observed one and the two fuse on `infraId('sql-table', <name>)` rather than
// twinning. `columnsFromSqlStatement` does the same for the touched columns (ADR-157
// §3). Both live in otel.ts, their one home — never a second SQL parser here.
//
// Statement shape (#1432 ruling a): a statement whose literal HEAD parses to
// `SELECT … FROM <t>` / `INSERT INTO <t>` / `UPDATE <t>` / `DELETE FROM <t>` is
// claimed with the table from the head; a runtime tail does not block it. A
// `CREATE TABLE` has no FROM/INTO/UPDATE keyword, so `tableFromSqlStatement` returns
// null and it is left unclaimed — never guessed.
//
// Variable resolution (#1432): the statement is usually built into a local variable
// first (`sql = …; cur.execute(sql, params)`), so a `.execute`/`.executemany` whose
// first positional argument is an identifier is resolved to its SAME-FILE,
// ENCLOSING-FUNCTION, NEAREST-PRECEDING assignment, and only when that value is a
// string literal or a literal-headed concatenation. An identifier reassigned in
// between, a function parameter, or an argument with no literal head stays unclaimed.
// Same literal inlining the URL-helper recognizer (#1426) does — precedent, not a new
// shape.
//
// Import gate (mirrors calls/socket.ts' import gate): recognized only in a file that
// imports a DB-API driver — `pymysql`, `MySQLdb`, `psycopg2`, `psycopg`, or
// `sqlite3`. Without it a `.execute(...)` on any object could mint a phantom table
// from any string that happens to parse as SQL. The SQL-parse gate
// (`tableFromSqlStatement` returning a table) is the second filter.

// `import pymysql` / `from pymysql import …` for the common DB-API drivers. `psycopg`
// is psycopg3; `psycopg2` its predecessor; `MySQLdb` is mysqlclient; `sqlite3` is the
// stdlib driver.
const DBAPI_IMPORT_RE =
  /(?:^|\n)\s*(?:import|from)\s+(?:pymysql|MySQLdb|psycopg2|psycopg|sqlite3)\b/

// DB-API cursor statement methods. `executescript` (sqlite-only, multi-statement) is
// intentionally excluded — it is not a single-statement, single-table shape.
const EXEC_METHODS = new Set(['execute', 'executemany'])

const PARSE_CHUNK = 16384

function makePyParser(): Parser {
  const p = new Parser()
  p.setLanguage(Python)
  return p
}

function parseSource(parser: Parser, source: string): Parser.Tree {
  return parser.parse((index: number) =>
    index >= source.length ? '' : source.slice(index, index + PARSE_CHUNK),
  )
}

function namedChildren(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = []
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)
    if (c) out.push(c)
  }
  return out
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node)
  for (const c of namedChildren(node)) walk(c, visit)
}

// The full literal value of a `string` node (`string_content` + any escapes), or
// null if it carries an `interpolation` (an f-string — not a pure literal).
function pyStringFull(node: Parser.SyntaxNode): string | null {
  let v = ''
  for (const c of namedChildren(node)) {
    if (c.type === 'interpolation') return null
    if (c.type === 'string_content' || c.type === 'escape_sequence') v += c.text
  }
  return v
}

// The leading literal text of a `string` node, up to the first `interpolation` —
// the head of an f-string. null if it opens with an interpolation.
function pyStringHead(node: Parser.SyntaxNode): string | null {
  let head = ''
  let saw = false
  for (const c of namedChildren(node)) {
    if (c.type === 'interpolation') break
    if (c.type === 'string_content' || c.type === 'escape_sequence') {
      head += c.text
      saw = true
    }
  }
  return saw ? head : null
}

// The value of an expression that is ENTIRELY string-literal — a `string`, an
// adjacency `concatenated_string`, or a `+` `binary_operator` of such — else null.
function pyPureLiteral(node: Parser.SyntaxNode | null): string | null {
  if (!node) return null
  if (node.type === 'string') return pyStringFull(node)
  if (node.type === 'concatenated_string') {
    let v = ''
    for (const c of namedChildren(node)) {
      const s = pyPureLiteral(c)
      if (s === null) return null
      v += s
    }
    return v
  }
  if (node.type === 'binary_operator' && node.childForFieldName('operator')?.text === '+') {
    const l = pyPureLiteral(node.childForFieldName('left'))
    const r = pyPureLiteral(node.childForFieldName('right'))
    return l !== null && r !== null ? l + r : null
  }
  return null
}

// The leading literal portion of an expression (#1432 ruling a): the statement head
// even when a runtime tail follows. null when there is no literal head.
function pyLiteralHead(node: Parser.SyntaxNode | null): string | null {
  if (!node) return null
  const whole = pyPureLiteral(node)
  if (whole !== null) return whole
  if (node.type === 'string') return pyStringHead(node)
  if (node.type === 'concatenated_string') {
    let v = ''
    let saw = false
    for (const c of namedChildren(node)) {
      const pure = pyPureLiteral(c)
      if (pure !== null) {
        v += pure
        saw = true
        continue
      }
      const h = pyLiteralHead(c)
      if (h !== null) {
        v += h
        saw = true
      }
      break
    }
    return saw ? v : null
  }
  if (node.type === 'binary_operator' && node.childForFieldName('operator')?.text === '+') {
    const left = node.childForFieldName('left')
    const leftFull = pyPureLiteral(left)
    if (leftFull !== null) {
      const rightHead = pyLiteralHead(node.childForFieldName('right'))
      return rightHead !== null ? leftFull + rightHead : leftFull
    }
    return pyLiteralHead(left)
  }
  return null
}

function enclosingFunction(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur = node.parent
  while (cur) {
    if (cur.type === 'function_definition') return cur
    cur = cur.parent
  }
  return null
}

// The value node of the nearest preceding `name = …` assignment within `scope`, not
// descending into nested function scopes.
function nearestAssignmentValue(
  scope: Parser.SyntaxNode,
  name: string,
  beforeIndex: number,
): Parser.SyntaxNode | null {
  let best: { pos: number; value: Parser.SyntaxNode } | null = null
  const visit = (node: Parser.SyntaxNode): void => {
    for (const c of namedChildren(node)) {
      if (c.type === 'assignment') {
        const lhs = c.childForFieldName('left')
        const val = c.childForFieldName('right')
        if (lhs?.type === 'identifier' && lhs.text === name && val && c.startIndex < beforeIndex) {
          if (!best || c.startIndex > best.pos) best = { pos: c.startIndex, value: val }
        }
      }
      if (c.type !== 'function_definition' && c.type !== 'lambda') visit(c)
    }
  }
  visit(scope)
  return best ? best.value : null
}

export function pythonDbapiEndpointsFromFile(
  file: SourceFile,
  serviceDir: string,
): ExternalEndpoint[] {
  if (path.extname(file.path) !== '.py') return []
  if (!DBAPI_IMPORT_RE.test(file.content)) return []

  const tree = parseSource(makePyParser(), file.content)
  const root = tree.rootNode
  const out: ExternalEndpoint[] = []

  walk(root, (node) => {
    if (node.type !== 'call') return
    const fn = node.childForFieldName('function')
    if (fn?.type !== 'attribute') return
    const method = fn.childForFieldName('attribute')?.text
    if (!method || !EXEC_METHODS.has(method)) return

    const argsNode = node.childForFieldName('arguments')
    const first = argsNode
      ? namedChildren(argsNode).find((a) => a.type !== 'keyword_argument')
      : undefined
    if (!first) return

    let head = pyLiteralHead(first)
    if (head === null && first.type === 'identifier') {
      const scope = enclosingFunction(node) ?? root
      const val = nearestAssignmentValue(scope, first.text, node.startIndex)
      if (val) head = pyLiteralHead(val)
    }
    if (head === null) return

    const table = tableFromSqlStatement(head)
    if (!table) return
    const columns = columnsFromSqlStatement(head)
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
