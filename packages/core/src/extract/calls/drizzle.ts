import path from 'node:path'
import Parser from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import { infraId } from '@neat.is/types'
import { GRAMMAR_BY_EXT, parseSource } from '../symbols.js'
import { snippet, type ExternalEndpoint, type SourceFile } from './shared.js'

// Drizzle schema table + column recognizer (ADR-152 table, ADR-157 §3 columns).
// The declared side of column grain: it names the table a `pgTable('orders',
// { … })` (mysqlTable / sqliteTable) declares AND the columns inside it, so a
// production query — whose OBSERVED table + columns NEAT recovers by parsing
// `db.statement` (ADR-152 / ADR-157 §2) — has a static twin to fuse onto at
// `infra:sql-table:<name>`.
//
//   import { pgTable, integer, text } from 'drizzle-orm/pg-core'
//   export const orders = pgTable('orders', {
//     id: serial('id').primaryKey(),
//     userId: integer('user_id'),
//     total: integer(),
//     status: text('status'),
//   })
//
// The table name is the first string literal. Each COLUMN name is derived the way
// Drizzle names the DB column, because that string — not the JS field name — is
// the fusion key the running query carries (ADR-157 §3, the load-bearing rule):
//   - the explicit column-builder name wins:  integer('user_id')  → user_id
//   - the object key is Drizzle's own fallback when the builder is given no
//     name:                                    total: integer()   → total
// Reading the key alone would name `userId` where production writes `user_id` and
// fuse onto nothing — the same fidelity rule the Mongoose pluralizer (ADR-147) and
// the Flask table-name port (ADR-152) follow. A computed / interpolated name is
// left unclaimed rather than guessed.

const DRIZZLE_IMPORT_RE = /drizzle-orm/
const TABLE_BUILDERS = new Set(['pgTable', 'mysqlTable', 'sqliteTable'])

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

// The literal text inside a `string` node (quotes stripped). Null for a template
// / interpolated string — never guessed at.
function stringLiteralText(node: Parser.SyntaxNode | null): string | null {
  if (!node || node.type !== 'string') return null
  for (const child of namedChildren(node)) {
    if (child.type === 'string_fragment') return child.text
  }
  return '' // an empty '' literal has no string_fragment child
}

// The first positional string argument of a call, or null when the first
// argument is not a plain string literal (so the caller falls back to the key).
function firstStringArg(call: Parser.SyntaxNode): string | null {
  const args = call.childForFieldName('arguments')
  if (!args) return null
  for (const arg of namedChildren(args)) {
    if (arg.type === 'string') return stringLiteralText(arg)
    // Stop at the first positional arg — a non-string first arg means no name.
    return null
  }
  return null
}

// The DB column name a Drizzle column value declares. Walks to the head builder
// call at the base of a `.primaryKey().notNull()` chain and reads its first
// string argument (the explicit column name). Null when the builder is given no
// name, so the caller falls back to the object key — exactly as Drizzle does.
function builderColumnName(value: Parser.SyntaxNode): string | null {
  let node: Parser.SyntaxNode | null = value
  while (node) {
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function')
      if (fn?.type === 'identifier') return firstStringArg(node)
      if (fn?.type === 'member_expression') {
        node = fn.childForFieldName('object')
        continue
      }
      return null
    }
    if (node.type === 'member_expression') {
      node = node.childForFieldName('object')
      continue
    }
    return null
  }
  return null
}

// A pair key → its column-name string (a bare `total:` or a quoted `'total':`).
function keyName(key: Parser.SyntaxNode | null): string | null {
  if (!key) return null
  if (key.type === 'property_identifier') return key.text
  if (key.type === 'string') return stringLiteralText(key)
  return null
}

// The columns declared in a pgTable's second-argument object. Reads each `pair`,
// preferring the builder's explicit name over the object key, and skips spreads /
// computed keys rather than guessing.
function columnsFromObject(obj: Parser.SyntaxNode): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const child of namedChildren(obj)) {
    if (child.type !== 'pair') continue
    const value = child.childForFieldName('value')
    const key = keyName(child.childForFieldName('key'))
    const name = (value ? builderColumnName(value) : null) ?? key
    if (name && !seen.has(name)) {
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

export function drizzleEndpointsFromFile(
  file: SourceFile,
  serviceDir: string,
): ExternalEndpoint[] {
  if (!DRIZZLE_IMPORT_RE.test(file.content)) return []
  const tree = parseSource(parserForExt(path.extname(file.path)), file.content)
  const out: ExternalEndpoint[] = []
  const seen = new Set<string>()

  const walk = (node: Parser.SyntaxNode): void => {
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function')
      if (fn?.type === 'identifier' && TABLE_BUILDERS.has(fn.text)) {
        const args = node.childForFieldName('arguments')
        const argNodes = args ? namedChildren(args) : []
        const tableName = stringLiteralText(argNodes[0] ?? null)
        const obj = argNodes[1]
        if (tableName && obj?.type === 'object' && !seen.has(tableName)) {
          seen.add(tableName)
          const columns = columnsFromObject(obj)
          const line = node.startPosition.row + 1
          out.push({
            infraId: infraId('sql-table', tableName),
            name: tableName,
            kind: 'sql-table',
            edgeType: 'CALLS',
            confidenceKind: 'structural',
            columns,
            evidence: {
              file: path.relative(serviceDir, file.path),
              line,
              snippet: snippet(file.content, line),
            },
          })
        }
      }
    }
    for (const c of namedChildren(node)) walk(c)
  }

  walk(tree.rootNode)
  return out
}
