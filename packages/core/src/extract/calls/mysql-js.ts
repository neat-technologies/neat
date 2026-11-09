import path from 'node:path'
import Parser from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import { infraId } from '@neat.is/types'
import { tableFromSqlStatement, columnsFromSqlStatement } from '../../otel.js'
import { GRAMMAR_BY_EXT, parseSource } from '../symbols.js'
import { snippet, toPosix, type ExternalEndpoint, type SourceFile } from './shared.js'

// JS/TS raw-SQL data-axis recognizer for the `mysql` / `mysql2` drivers (#1432) —
// the JavaScript sibling of the Go `database/sql` reader (calls/go.ts, ADR-184).
// A service that talks to MySQL through a plain driver with SQL in strings gets no
// table grain today: the JS ORM readers cover knex / sequelize / prisma / drizzle /
// typeorm, but a bare `mysql`/`mysql2` connection handed a literal statement lands
// nothing. This reads the table (and the touched columns) off that statement and
// mints the same `infra:sql-table:<name>` node every ORM reader and the OBSERVED
// ingest produce.
//
//   const mysql = require('mysql')
//   conn.query("SELECT * FROM office", cb)                         // inline literal
//   const sql = "SELECT * FROM office " + where_sql; conn.query(sql, cb)   // var + head
//   conn.execute("INSERT INTO office (name) VALUES (?)", [n])      // mysql2
//
// THE POINT is fusion, not a static table list. The OBSERVED ingest recovers the
// table by running `tableFromSqlStatement` on a span's `db.statement` (there is no
// dedicated table attribute — ADR-152), so this recognizer runs the EXACT SAME
// shared helper on the SAME SQL text and the extracted table is byte-identical to
// the observed one — the two fuse on `infraId('sql-table', <name>)` rather than
// twinning. `columnsFromSqlStatement` does the same for the touched columns (ADR-157
// §3). Both live in otel.ts, their one home — never a second SQL parser here, since
// divergence from the ingest parse is the one way this breaks.
//
// Statement shape (#1432 ruling a): a statement whose literal HEAD parses to
// `SELECT … FROM <t>` / `INSERT INTO <t>` / `UPDATE <t>` / `DELETE FROM <t>` is
// claimed with the table from the head; a runtime tail (`"… FROM office " + where`)
// does not block it. A `CREATE TABLE` has no FROM/INTO/UPDATE keyword, so
// `tableFromSqlStatement` returns null and it is left unclaimed — the honest,
// conservative default, never guessed.
//
// Variable resolution (#1432): the statement is usually built into a local variable
// first (`const sql = …; conn.query(sql, cb)`), so a `.query`/`.execute` whose first
// argument is an identifier is resolved to its SAME-FILE, ENCLOSING-FUNCTION,
// NEAREST-PRECEDING assignment, and only when that value is a string literal or a
// literal-headed concatenation. An identifier reassigned in between (the nearest
// assignment is then the non-literal one), a function parameter, or an argument with
// no literal head stays unclaimed. This is the same literal inlining the URL-helper
// recognizer (#1426) does for one-return helpers — precedent, not a new shape.
//
// Import gate (mirrors calls/go.ts' driver gate): recognized only in a file that
// imports `mysql` or `mysql2` (incl. `mysql2/promise`). Without it a `.query(...)` /
// `.execute(...)` on any object — an HTTP client, an ORM — could mint a phantom
// table from any string that happens to parse as SQL. The SQL-parse gate
// (`tableFromSqlStatement` returning a table) is the second filter, so a non-SQL
// `.execute("...")` in a mysql-importing file still claims nothing.

// `require('mysql')` / `require('mysql2')` / `require('mysql2/promise')` and the
// `import … from 'mysql2/promise'` forms.
const MYSQL_IMPORT_RE = /(?:from\s+['"`]|require\(\s*['"`])mysql2?(?:\/promise)?['"`]/

// Statement-taking methods on a `mysql`/`mysql2` connection, pool, or promise
// wrapper. `query` is `mysql` + `mysql2`; `execute` is `mysql2`'s prepared path.
const SQL_METHODS = new Set(['query', 'execute'])

const JS_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'])

// Nodes that open a new function scope — the boundary variable resolution does not
// cross (a `.query(sql)` resolves `sql` only within its own enclosing function).
const FUNCTION_NODE_TYPES = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'generator_function',
  'generator_function_declaration',
])

function parserForExt(ext: string): Parser {
  const p = new Parser()
  p.setLanguage(GRAMMAR_BY_EXT[ext] ?? JavaScript)
  return p
}

function namedChildren(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = []
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)
    if (c) out.push(c)
  }
  return out
}

// The full literal value of a plain `string` node (quotes stripped); null for a
// template / any non-string node. An empty `''` has no `string_fragment` child.
function stringLiteralValue(node: Parser.SyntaxNode | null): string | null {
  if (!node || node.type !== 'string') return null
  for (const c of namedChildren(node)) {
    if (c.type === 'string_fragment') return c.text
  }
  return ''
}

// The value of an expression that is ENTIRELY string-literal — a `string`, a
// template with no `${}`, or a `+` concatenation of such — else null.
function pureLiteral(node: Parser.SyntaxNode | null): string | null {
  if (!node) return null
  if (node.type === 'string') return stringLiteralValue(node)
  if (node.type === 'template_string') {
    let v = ''
    for (const c of namedChildren(node)) {
      if (c.type === 'template_substitution') return null
      if (c.type === 'string_fragment') v += c.text
      else if (c.type === 'escape_sequence') return null
    }
    return v
  }
  if (node.type === 'binary_expression' && node.childForFieldName('operator')?.text === '+') {
    const l = pureLiteral(node.childForFieldName('left'))
    const r = pureLiteral(node.childForFieldName('right'))
    return l !== null && r !== null ? l + r : null
  }
  return null
}

// The leading literal portion of an expression (#1432 ruling a): the statement head
// even when a runtime tail follows. null when there is no literal head.
function literalHead(node: Parser.SyntaxNode | null): string | null {
  if (!node) return null
  const whole = pureLiteral(node)
  if (whole !== null) return whole
  if (node.type === 'template_string') {
    let head = ''
    let saw = false
    for (const c of namedChildren(node)) {
      if (c.type === 'template_substitution') break
      if (c.type === 'string_fragment') {
        head += c.text
        saw = true
      } else if (c.type === 'escape_sequence') break
    }
    return saw ? head : null
  }
  if (node.type === 'binary_expression' && node.childForFieldName('operator')?.text === '+') {
    const left = node.childForFieldName('left')
    const leftFull = pureLiteral(left)
    if (leftFull !== null) {
      const rightHead = literalHead(node.childForFieldName('right'))
      return rightHead !== null ? leftFull + rightHead : leftFull
    }
    return literalHead(left)
  }
  return null
}

function enclosingFunction(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur = node.parent
  while (cur) {
    if (FUNCTION_NODE_TYPES.has(cur.type)) return cur
    cur = cur.parent
  }
  return null
}

// The value node of the nearest preceding assignment to `name` within `scope`, not
// descending into nested function scopes. Handles both `var/let/const name = …`
// (`variable_declarator`) and `name = …` (`assignment_expression`).
function nearestAssignmentValue(
  scope: Parser.SyntaxNode,
  name: string,
  beforeIndex: number,
): Parser.SyntaxNode | null {
  let best: { pos: number; value: Parser.SyntaxNode } | null = null
  const visit = (node: Parser.SyntaxNode): void => {
    for (const c of namedChildren(node)) {
      if (c.type === 'variable_declarator') {
        const nm = c.childForFieldName('name')
        const val = c.childForFieldName('value')
        if (nm?.type === 'identifier' && nm.text === name && val && c.startIndex < beforeIndex) {
          if (!best || c.startIndex > best.pos) best = { pos: c.startIndex, value: val }
        }
      } else if (c.type === 'assignment_expression') {
        const lhs = c.childForFieldName('left')
        const val = c.childForFieldName('right')
        if (lhs?.type === 'identifier' && lhs.text === name && val && c.startIndex < beforeIndex) {
          if (!best || c.startIndex > best.pos) best = { pos: c.startIndex, value: val }
        }
      }
      if (!FUNCTION_NODE_TYPES.has(c.type)) visit(c)
    }
  }
  visit(scope)
  return best ? best.value : null
}

export function mysqlJsEndpointsFromFile(file: SourceFile, serviceDir: string): ExternalEndpoint[] {
  const ext = path.extname(file.path)
  if (!JS_EXTS.has(ext)) return []
  // Cheap textual pre-check before parsing — inert on files that import no driver.
  if (!MYSQL_IMPORT_RE.test(file.content)) return []

  const tree = parseSource(parserForExt(ext), file.content)
  const root = tree.rootNode
  const out: ExternalEndpoint[] = []

  const walk = (node: Parser.SyntaxNode): void => {
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function')
      if (fn?.type === 'member_expression') {
        const method = fn.childForFieldName('property')?.text
        if (method && SQL_METHODS.has(method)) {
          const argsNode = node.childForFieldName('arguments')
          const first = argsNode ? namedChildren(argsNode)[0] : undefined
          if (first) {
            let head = literalHead(first)
            if (head === null && first.type === 'identifier') {
              const scope = enclosingFunction(node) ?? root
              const val = nearestAssignmentValue(scope, first.text, node.startIndex)
              if (val) head = literalHead(val)
            }
            if (head !== null) {
              const table = tableFromSqlStatement(head)
              if (table) {
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
              }
            }
          }
        }
      }
    }
    for (const c of namedChildren(node)) walk(c)
  }
  walk(root)
  return out
}
