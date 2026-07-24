import path from 'node:path'
import Parser from 'tree-sitter'
import Python from 'tree-sitter-python'
import { infraId } from '@neat.is/types'
import { snippet, type ExternalEndpoint, type SourceFile } from './shared.js'

// Django ORM table call sites (ADR-151). A Django model maps to a table named
// `<app_label>_<lowercased-model>` unless `Meta.db_table` overrides it; the
// app_label defaults to the model file's app package (its parent directory),
// overridable by `Meta.app_label`. This is Django's naming reproduced verbatim —
// the fusion key, the same discipline the Mongoose pluralizer follows.
//
// It emits the same `infra:sql-table:<name>` node the SQLAlchemy extractor and
// the OBSERVED `db.statement` parse (ADR-152) use, so a declared Django model and
// the runtime query that hits its table fuse onto one node.

const DJANGO_IMPORT_RE = /(?:from|import)\s+django\b/
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

function pyStaticStringText(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'string') return null
  for (const c of namedChildren(node)) {
    if (c.type === 'interpolation') return null
    if (c.type === 'string_content') return c.text
  }
  return ''
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node)
  for (const c of namedChildren(node)) walk(c, visit)
}

function extendsDjangoModel(cls: Parser.SyntaxNode): boolean {
  const supers = cls.childForFieldName('superclasses')
  if (!supers) return false
  for (const a of namedChildren(supers)) {
    const t = a.text
    if (t === 'models.Model' || t === 'Model' || t.endsWith('.Model')) return true
  }
  return false
}

// Read `Meta.db_table` / `Meta.app_label` off a model class body (both literal).
function readMeta(body: Parser.SyntaxNode): { dbTable?: string; appLabel?: string } {
  const out: { dbTable?: string; appLabel?: string } = {}
  for (const stmt of namedChildren(body)) {
    if (stmt.type !== 'class_definition') continue
    if (stmt.childForFieldName('name')?.text !== 'Meta') continue
    const metaBody = stmt.childForFieldName('body')
    if (!metaBody) continue
    for (const ms of namedChildren(metaBody)) {
      if (ms.type !== 'expression_statement') continue
      const a = ms.namedChild(0)
      if (a?.type !== 'assignment') continue
      const l = a.childForFieldName('left')?.text
      const r = a.childForFieldName('right')
      if (r?.type !== 'string') continue
      if (l === 'db_table') out.dbTable = pyStaticStringText(r) ?? undefined
      if (l === 'app_label') out.appLabel = pyStaticStringText(r) ?? undefined
    }
  }
  return out
}

export function djangoOrmEndpointsFromFile(
  file: SourceFile,
  serviceDir: string,
): ExternalEndpoint[] {
  if (!DJANGO_IMPORT_RE.test(file.content)) return []
  const tree = parseSource(makePyParser(), file.content)
  const out: ExternalEndpoint[] = []
  const seen = new Set<string>()
  // The app_label defaults to the model file's app package — its parent directory.
  const defaultAppLabel = path.basename(path.dirname(file.path))

  walk(tree.rootNode, (node) => {
    if (node.type !== 'class_definition') return
    if (!extendsDjangoModel(node)) return
    const nameNode = node.childForFieldName('name')
    const body = node.childForFieldName('body')
    if (!nameNode || !body) return
    const meta = readMeta(body)
    const table = meta.dbTable ?? `${meta.appLabel ?? defaultAppLabel}_${nameNode.text.toLowerCase()}`
    if (seen.has(table)) return
    seen.add(table)
    const line = node.startPosition.row + 1
    out.push({
      infraId: infraId('sql-table', table),
      name: table,
      kind: 'sql-table',
      edgeType: 'CALLS',
      confidenceKind: 'verified-call-site',
      evidence: { file: path.relative(serviceDir, file.path), line, snippet: snippet(file.content, line) },
    })
  })

  return out
}
