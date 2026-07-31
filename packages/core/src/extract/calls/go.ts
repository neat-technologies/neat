import path from 'node:path'
import Parser from 'tree-sitter'
import Go from 'tree-sitter-go'
import { infraId } from '@neat.is/types'
import { tableFromSqlStatement } from '../../otel.js'
import type { ExternalEndpoint, SourceFile } from './shared.js'
import { snippet, toPosix } from './shared.js'

const SQL_METHODS = new Set(['Exec', 'ExecContext', 'Query', 'QueryContext', 'QueryRow', 'QueryRowContext'])
const PARSE_CHUNK = 16384

function walk(node: Parser.SyntaxNode, visit: (node: Parser.SyntaxNode) => void): void {
  visit(node)
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (child) walk(child, visit)
  }
}

export function goSqlEndpointsFromFile(file: SourceFile, serviceDir: string): ExternalEndpoint[] {
  if (path.extname(file.path) !== '.go') return []
  const parser = new Parser()
  parser.setLanguage(Go)
  const tree = parser.parse((index: number) =>
    index >= file.content.length ? '' : file.content.slice(index, index + PARSE_CHUNK),
  )
  const out: ExternalEndpoint[] = []
  walk(tree.rootNode, (node) => {
    if (node.type !== 'call_expression') return
    const fn = node.childForFieldName('function')
    if (fn?.type !== 'selector_expression') return
    const method = fn.childForFieldName('field')?.text
    if (!method || !SQL_METHODS.has(method)) return
    const arg = node.childForFieldName('arguments')?.namedChild(0)
    if (!arg || (arg.type !== 'interpreted_string_literal' && arg.type !== 'raw_string_literal')) return
    const sql = arg.text.slice(1, -1)
    const table = tableFromSqlStatement(sql)
    if (!table) return
    const line = node.startPosition.row + 1
    out.push({
      infraId: infraId('sql-table', table),
      name: table,
      kind: 'sql-table',
      edgeType: 'CALLS',
      confidenceKind: 'verified-call-site',
      evidence: { file: toPosix(path.relative(serviceDir, file.path)), line, snippet: snippet(file.content, line) },
    })
  })
  return out
}
