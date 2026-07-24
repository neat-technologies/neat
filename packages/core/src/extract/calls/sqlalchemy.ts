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

// ── cross-file model→table query attribution (ADR-149 analog) ────────────────

// A model class name → its table, service-wide (SQLAlchemy + Flask-SQLAlchemy). A
// name defined in two files with different tables is dropped — ambiguous, never
// guessed (the ADR-147 discipline).
function buildSqlalchemyModelRegistry(files: SourceFile[]): Map<string, string> {
  const table = new Map<string, string>()
  const ambiguous = new Set<string>()
  const parser = makePyParser()
  for (const file of files) {
    if (!SQLALCHEMY_IMPORT_RE.test(file.content)) continue
    const tree = parseSource(parser, file.content)
    walk(tree.rootNode, (node) => {
      if (node.type !== 'class_definition') return
      const nameNode = node.childForFieldName('name')
      const body = node.childForFieldName('body')
      if (!nameNode || !body) return
      const explicit = explicitTablename(body)
      if (explicit === 'computed') return
      let t: string | null = null
      if (explicit) t = explicit.name
      else if (extendsFlaskModel(node)) t = flaskSqlalchemyTableName(nameNode.text)
      if (!t) return
      const cls = nameNode.text
      if (table.has(cls) && table.get(cls) !== t) ambiguous.add(cls)
      else table.set(cls, t)
    })
  }
  for (const a of ambiguous) table.delete(a)
  return table
}

// The model class names a file queries: `session.query(X)` / `db.session.query(X)`
// / `select(X)` / `session.get(X, …)` (the first argument), and `X.query`
// (Flask-SQLAlchemy, the object). A non-model receiver (`session.query`) is
// filtered downstream by the registry.
function queryClassSites(root: Parser.SyntaxNode): { cls: string; line: number }[] {
  const out: { cls: string; line: number }[] = []
  walk(root, (node) => {
    if (node.type === 'call') {
      const fn = node.childForFieldName('function')
      const isQueryCall =
        (fn?.type === 'attribute' &&
          (fn.childForFieldName('attribute')?.text === 'query' ||
            fn.childForFieldName('attribute')?.text === 'get')) ||
        (fn?.type === 'identifier' && fn.text === 'select')
      if (isQueryCall) {
        const arg = node.childForFieldName('arguments')?.namedChild(0)
        if (arg?.type === 'identifier') out.push({ cls: arg.text, line: node.startPosition.row + 1 })
      }
    }
    if (node.type === 'attribute') {
      const obj = node.childForFieldName('object')
      if (node.childForFieldName('attribute')?.text === 'query' && obj?.type === 'identifier') {
        out.push({ cls: obj.text, line: node.startPosition.row + 1 })
      }
    }
  })
  return out
}

// Does a file import this name — so a query on it references a model defined
// elsewhere? Bounds the attribution to a real cross-file reference (the in-file
// case is already the definition-site edge).
function importsModelName(content: string, name: string): boolean {
  return new RegExp(`\\bimport\\b[^\\n]*\\b${name}\\b`).test(content)
}

// Attribute a cross-file query to its table at the *query* site: a file that runs
// `session.query(Order)` on an `Order` model defined and imported from another
// file gets the `file → sql-table:<name>` edge, so the code that actually reads
// the table is named — not only the model-definition file. A computed model, or
// a query on a locally-defined model (already the definition-site edge), is not
// re-emitted here.
export function pythonOrmCrossFileEndpoints(
  files: SourceFile[],
  serviceDir: string,
): ExternalEndpoint[] {
  const registry = buildSqlalchemyModelRegistry(files)
  if (registry.size === 0) return []
  const parser = makePyParser()
  const out: ExternalEndpoint[] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (!SQLALCHEMY_IMPORT_RE.test(file.content)) continue
    const tree = parseSource(parser, file.content)
    for (const { cls, line } of queryClassSites(tree.rootNode)) {
      const t = registry.get(cls)
      if (!t) continue
      if (!importsModelName(file.content, cls)) continue // cross-file (imported) only
      const key = `${file.path}::${t}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        infraId: infraId('sql-table', t),
        name: t,
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
  }
  return out
}
