import path from 'node:path'
import Parser from 'tree-sitter'
import Python from 'tree-sitter-python'
import { infraId } from '@neat.is/types'
import { snippet, type ExternalEndpoint, type SourceFile } from './shared.js'

// SQLAlchemy / Flask-SQLAlchemy table call sites (ADR-151, ADR-152). The SQL
// analog of calls/mongoose.ts: it names the table a model maps to, so a
// production SQLAlchemy query — whose OBSERVED table NEAT recovers by parsing the
// `db.statement` SQL (the instrumentation emits no table attribute, ADR-152) —
// has a file-grained static twin to fuse onto at `infra:sql-table:<name>`.
//
// The table name is the fusion key, derived VERBATIM the way the ORM derives it
// so the static string matches the table the running query hits:
//   - plain SQLAlchemy declarative:  __tablename__ = 'orders'   (explicit, required)
//   - Flask-SQLAlchemy (no __tablename__):  camel_to_snake_case(ClassName)
//       class UserProfile(db.Model): ...   → 'user_profile'
//   - native Core:  Table('orders', metadata, ...)   → the string literal

const SQLALCHEMY_IMPORT_RE = /(?:from|import)\s+(?:flask_sqlalchemy|sqlalchemy)\b/

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

// Verbatim port of flask_sqlalchemy's `camel_to_snake_case` (model.py, v3.x):
//   re.sub(r"((?<=[a-z0-9])[A-Z]|(?!^)[A-Z](?=[a-z]))", r"_\1", name).lower().lstrip("_")
// Reproduced byte-for-byte so a derived table matches the one Flask-SQLAlchemy
// actually creates — `UserProfile` → `user_profile`, `HTTPRequest` →
// `http_request`, `OAuth2Token` → `o_auth2_token`. Do not "improve" it: an
// English-nicer version would name a table the ORM never created and fuse onto
// nothing (the same fidelity rule the Mongoose pluralizer follows).
export function flaskSqlalchemyTableName(className: string): string {
  return className
    .replace(/((?<=[a-z0-9])[A-Z]|(?!^)[A-Z](?=[a-z]))/g, '_$1')
    .toLowerCase()
    .replace(/^_+/, '')
}

function namedChildren(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = []
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)
    if (c) out.push(c)
  }
  return out
}

function pyStaticStringText(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'string') return null
  for (const child of namedChildren(node)) {
    if (child.type === 'interpolation') return null // f-string — not a static literal
    if (child.type === 'string_content') return child.text
  }
  return ''
}

// The explicit `__tablename__ = 'x'` in a class body: its literal name, `'computed'`
// when it's assigned a non-literal (never guessed), or null when absent.
function explicitTablename(body: Parser.SyntaxNode): { name: string } | 'computed' | null {
  for (const stmt of namedChildren(body)) {
    if (stmt.type !== 'expression_statement') continue
    const assign = stmt.namedChild(0)
    if (assign?.type !== 'assignment') continue
    if (assign.childForFieldName('left')?.text !== '__tablename__') continue
    const right = assign.childForFieldName('right')
    if (right?.type === 'string') {
      const s = pyStaticStringText(right)
      return s ? { name: s } : 'computed'
    }
    return 'computed'
  }
  return null
}

// A Flask-SQLAlchemy model derives its table from the class name when it has no
// `__tablename__` — recognised by a `db.Model` / `Model` base class.
function extendsFlaskModel(cls: Parser.SyntaxNode): boolean {
  const supers = cls.childForFieldName('superclasses')
  if (!supers) return false
  for (const a of namedChildren(supers)) {
    const t = a.text
    if (t === 'db.Model' || t === 'Model' || t.endsWith('.Model')) return true
  }
  return false
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node)
  for (const c of namedChildren(node)) walk(c, visit)
}

export function sqlalchemyEndpointsFromFile(
  file: SourceFile,
  serviceDir: string,
): ExternalEndpoint[] {
  if (!SQLALCHEMY_IMPORT_RE.test(file.content)) return []
  const tree = parseSource(makePyParser(), file.content)
  const out: ExternalEndpoint[] = []
  const seen = new Set<string>()
  const push = (name: string, line: number): void => {
    if (seen.has(name)) return
    seen.add(name)
    out.push({
      infraId: infraId('sql-table', name),
      name,
      kind: 'sql-table',
      edgeType: 'CALLS',
      confidenceKind: 'verified-call-site',
      evidence: {
        file: path.relative(serviceDir, file.path),
        line,
        snippet: snippet(file.content, line),
      },
    })
  }

  walk(tree.rootNode, (node) => {
    if (node.type === 'class_definition') {
      const body = node.childForFieldName('body')
      const nameNode = node.childForFieldName('name')
      if (!body || !nameNode) return
      const line = node.startPosition.row + 1
      const explicit = explicitTablename(body)
      if (explicit === 'computed') return // named but not a literal — never guess
      if (explicit) {
        push(explicit.name, line)
        return
      }
      // No __tablename__: Flask-SQLAlchemy derives the table from the class name.
      if (extendsFlaskModel(node)) push(flaskSqlalchemyTableName(nameNode.text), line)
      return
    }
    // Native Core: `Table('orders', metadata, ...)` — the first positional string.
    if (node.type === 'call') {
      const fn = node.childForFieldName('function')
      const fnText = fn?.text
      if (fnText !== 'Table' && fnText !== 'sa.Table' && fnText !== 'sqlalchemy.Table') return
      const first = node.childForFieldName('arguments')?.namedChild(0)
      if (first?.type === 'string') {
        const s = pyStaticStringText(first)
        if (s) push(s, node.startPosition.row + 1)
      }
    }
  })

  return out
}
