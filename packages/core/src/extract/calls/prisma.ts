import path from 'node:path'
import { infraId } from '@neat.is/types'
import { findFirst, readIfExists } from '../databases/shared.js'
import { snippet, type ExternalEndpoint, type SourceFile, type TableReference } from './shared.js'

// Prisma schema table + column recognizer (ADR-157 §3 columns, the named
// follow-on the ADR reserves after Drizzle). The declared side of column grain
// for Prisma: it reads each `model` block in `schema.prisma` and emits the table
// that model maps to AND the scalar columns it declares, so a production query —
// whose OBSERVED table + columns NEAT recovers by parsing `db.statement`
// (ADR-152 / ADR-157 §2) — has a static twin to fuse onto at
// `infra:sql-table:<name>`.
//
//   model Article {
//     id          Int       @id @default(autoincrement())
//     title       String
//     body        String    @map("article_body")
//     authorId    Int
//     author      User      @relation(fields: [authorId], references: [id])
//     comments    Comment[]
//     @@map("articles")
//   }
//
// The fidelity rules are the load-bearing part (ADR-157 §3 — the fusion key the
// running query carries is the DATABASE name, not the code name):
//   - TABLE name  = the model name verbatim (Prisma's default is PascalCase, NOT
//     snake-cased), or the `@@map("name")` value when the model declares one.
//   - COLUMN name = the field name verbatim, or the `@map("db_col")` value when
//     the field declares one. Prisma does NOT snake_case by default, so `authorId`
//     is the column, not `author_id`.
// A scalar field (`Int String Boolean DateTime Float Decimal BigInt Bytes Json`,
// or an enum-typed field) is a column — foreign-key scalars like `authorId Int`
// included. A relation field is NOT a column and is skipped: a field whose base
// type is another declared model (`author User`, `comments Comment[]`) or that
// carries `@relation(...)`. `schema.prisma` is not JS, so it is read as text with
// a small block scanner (the same read-polyglot-as-data discipline `proto.ts`
// follows). A field whose type is neither a scalar, a declared enum, nor a
// declared model is left unclaimed rather than guessed.

const SCALAR_TYPES = new Set([
  'Int',
  'String',
  'Boolean',
  'DateTime',
  'Float',
  'Decimal',
  'BigInt',
  'Bytes',
  'Json',
])

// Drop a trailing `//` line comment, respecting `"..."` strings so a `//` inside
// a URL default (`@default("https://…")`) is not mistaken for a comment.
function stripLineComment(line: string): string {
  let inStr = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"' && line[i - 1] !== '\\') inStr = !inStr
    else if (!inStr && ch === '/' && line[i + 1] === '/') return line.slice(0, i)
  }
  return line
}

// Net `{` minus `}` on a line, ignoring comments and string contents so a brace
// inside a default value can't unbalance the block scan. Prisma blocks don't
// nest, but counting keeps the scan robust to odd formatting.
function netBraces(line: string): number {
  const s = stripLineComment(line).replace(/"(\\.|[^"\\])*"/g, '')
  let n = 0
  for (const ch of s) {
    if (ch === '{') n++
    else if (ch === '}') n--
  }
  return n
}

interface ModelBlock {
  kind: string
  tableName: string
  startLine: number
  columns: string[]
  seenCol: Set<string>
}

// Parse a `schema.prisma`'s model blocks into `sql-table` endpoints carrying the
// declared columns at database-name fidelity. Pure over the file content so a
// test can drive it without touching the filesystem, mirroring
// `drizzleEndpointsFromFile`.
export function prismaColumnsFromSchema(
  file: SourceFile,
  serviceDir: string,
): ExternalEndpoint[] {
  const content = file.content
  if (!/\bmodel\s+[A-Za-z_]\w*\s*\{/.test(content)) return []

  const lines = content.split('\n')

  // First pass: the declared model + enum names. A field whose base type is a
  // model name is a relation (skipped); an enum-typed field is a column. Names
  // are collected up front so a relation to a model declared later in the file
  // still resolves.
  const modelNames = new Set<string>()
  const enumNames = new Set<string>()
  for (const line of lines) {
    const m = line.match(/^\s*model\s+([A-Za-z_]\w*)\s*\{/)
    if (m) modelNames.add(m[1]!)
    const e = line.match(/^\s*enum\s+([A-Za-z_]\w*)\s*\{/)
    if (e) enumNames.add(e[1]!)
  }

  const out: ExternalEndpoint[] = []
  const seenTable = new Set<string>()

  const finalize = (b: ModelBlock): void => {
    if (seenTable.has(b.tableName)) return
    seenTable.add(b.tableName)
    out.push({
      infraId: infraId('sql-table', b.tableName),
      name: b.tableName,
      kind: 'sql-table',
      edgeType: 'CALLS',
      confidenceKind: 'structural',
      columns: b.columns,
      evidence: {
        file: path.relative(serviceDir, file.path),
        line: b.startLine,
        snippet: snippet(content, b.startLine),
      },
    })
  }

  // Second pass: a line-based block scan. Only `model` blocks contribute
  // columns; `datasource` / `generator` / `enum` / `type` blocks are consumed so
  // their closing brace doesn't leak, but produce nothing here.
  let current: ModelBlock | null = null
  let depth = 0

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const lineNo = i + 1

    if (current === null) {
      const header = raw.match(/^\s*(model|enum|datasource|generator|type)\s+([A-Za-z_]\w*)\b/)
      if (header && raw.includes('{')) {
        current = {
          kind: header[1]!,
          tableName: header[2]!,
          startLine: lineNo,
          columns: [],
          seenCol: new Set(),
        }
        depth = netBraces(raw)
        if (depth <= 0) {
          if (current.kind === 'model') finalize(current)
          current = null
        }
      }
      continue
    }

    depth += netBraces(raw)
    if (depth <= 0) {
      if (current.kind === 'model') finalize(current)
      current = null
      continue
    }
    if (current.kind !== 'model') continue

    const trimmed = stripLineComment(raw).trim()
    if (!trimmed) continue
    if (trimmed.startsWith('@@')) {
      const map = trimmed.match(/@@map\(\s*"([^"]+)"\s*\)/)
      if (map) current.tableName = map[1]!
      continue
    }

    // `fieldName BaseType[...] attributes…` — the base type is the second token,
    // with a trailing `[]` array marker stripped by the alternation.
    const fm = trimmed.match(/^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)/)
    if (!fm) continue
    const fieldName = fm[1]!
    const baseType = fm[2]!

    // Relation fields are not columns: an `@relation(...)` field, or a field whose
    // base type is another declared model (covers `author User`, `Tag[]`, `Comment[]`).
    if (/@relation\b/.test(trimmed) || modelNames.has(baseType)) continue
    // A column is a scalar-typed or enum-typed field. Anything else (a composite
    // type, `Unsupported(...)`, a cross-file model) is left unclaimed.
    if (!enumNames.has(baseType) && !SCALAR_TYPES.has(baseType)) continue

    const mapM = trimmed.match(/(?<!@)@map\(\s*"([^"]+)"\s*\)/)
    const columnName = mapM ? mapM[1]! : fieldName
    if (!current.seenCol.has(columnName)) {
      current.seenCol.add(columnName)
      current.columns.push(columnName)
    }
  }

  // An unterminated final model (no trailing `}` at EOF) is still emitted.
  if (current && current.kind === 'model') finalize(current)

  return out
}

// Per-service pass: locate the service's `schema.prisma` and read its declared
// columns. `schema.prisma` is not a source file the walker loads (its extension
// is not in SERVICE_FILE_EXTENSIONS), so — unlike the JS producers that scan an
// already-loaded file — this reads the schema directly, the same standard
// location `databases/prisma.ts` reads for the datasource.
export async function prismaColumnEndpoints(serviceDir: string): Promise<ExternalEndpoint[]> {
  const schemaPath = await findFirst(serviceDir, [
    path.join('prisma', 'schema.prisma'),
    'schema.prisma',
  ])
  if (!schemaPath) return []
  const content = await readIfExists(schemaPath)
  if (!content) return []
  return prismaColumnsFromSchema({ path: schemaPath, content }, serviceDir)
}

// ── foreign-key table→table references (ADR-161) ─────────────────────────────
//
// Prisma declares a FK on the relation field that carries the scalar columns:
//   model Post {
//     authorId Int
//     author   User @relation(fields: [authorId], references: [id])
//   }
// The `fields:` side is the child (it holds the FK column); the field's base type
// is the parent model. The FK edge is `child-table ──REFERENCES──▶ parent-table`,
// both at DB-name fidelity — the model's `@@map` name where given, the model name
// verbatim otherwise (ADR-157 §3). The back-relation side (`posts Post[]`, no
// `fields:`) declares no FK and mints nothing, so the edge is minted once, in the
// correct direction. A relation whose base type is not a declared model, or a
// relation without `fields:`, resolves to no parent and is left unclaimed.

// Model name → the DB table it maps to (the `@@map` value, else the model name
// verbatim). Built up front so a relation to a model declared later still resolves.
function buildModelTableMap(lines: string[]): Map<string, string> {
  const map = new Map<string, string>()
  let current: { model: string; table: string } | null = null
  let depth = 0
  for (const raw of lines) {
    if (current === null) {
      const header = raw.match(/^\s*model\s+([A-Za-z_]\w*)\b/)
      if (header && raw.includes('{')) {
        current = { model: header[1]!, table: header[1]! }
        depth = netBraces(raw)
        if (depth <= 0) {
          map.set(current.model, current.table)
          current = null
        }
      }
      continue
    }
    depth += netBraces(raw)
    const trimmed = stripLineComment(raw).trim()
    if (trimmed.startsWith('@@')) {
      const m = trimmed.match(/@@map\(\s*"([^"]+)"\s*\)/)
      if (m) current.table = m[1]!
    }
    if (depth <= 0) {
      map.set(current.model, current.table)
      current = null
    }
  }
  if (current) map.set(current.model, current.table)
  return map
}

export function prismaForeignKeysFromSchema(
  file: SourceFile,
  serviceDir: string,
): TableReference[] {
  const content = file.content
  if (!/\bmodel\s+[A-Za-z_]\w*\s*\{/.test(content)) return []
  const lines = content.split('\n')
  const modelToTable = buildModelTableMap(lines)

  const out: TableReference[] = []
  const seen = new Set<string>()
  let current: { table: string } | null = null
  let depth = 0

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const lineNo = i + 1

    if (current === null) {
      const header = raw.match(/^\s*model\s+([A-Za-z_]\w*)\b/)
      if (header && raw.includes('{')) {
        current = { table: modelToTable.get(header[1]!) ?? header[1]! }
        depth = netBraces(raw)
        if (depth <= 0) current = null
      }
      continue
    }

    depth += netBraces(raw)
    const closing = depth <= 0
    const trimmed = stripLineComment(raw).trim()

    // A relation field holding the FK: `author User @relation(fields: [authorId],
    // references: [id])`. Only the `fields:` side mints an edge — the back-relation
    // (`posts Post[]`, no `fields:`) is skipped, so the direction is unambiguous.
    if (trimmed && !trimmed.startsWith('@@') && !trimmed.startsWith('}')) {
      const fm = trimmed.match(/^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)/)
      if (fm && /@relation\b[^)]*\bfields\s*:/.test(trimmed)) {
        const parentTable = modelToTable.get(fm[2]!)
        if (parentTable) {
          const key = `${current.table}->${parentTable}`
          if (!seen.has(key)) {
            seen.add(key)
            out.push({
              childTable: current.table,
              parentTable,
              evidence: {
                file: path.relative(serviceDir, file.path),
                line: lineNo,
                snippet: snippet(content, lineNo),
              },
            })
          }
        }
      }
    }

    if (closing) current = null
  }

  return out
}

// Per-service pass: locate `schema.prisma` and read its declared foreign keys.
// Mirrors `prismaColumnEndpoints` — the schema is not a walked source file, so it
// is read directly from the standard location.
export async function prismaForeignKeys(serviceDir: string): Promise<TableReference[]> {
  const schemaPath = await findFirst(serviceDir, [
    path.join('prisma', 'schema.prisma'),
    'schema.prisma',
  ])
  if (!schemaPath) return []
  const content = await readIfExists(schemaPath)
  if (!content) return []
  return prismaForeignKeysFromSchema({ path: schemaPath, content }, serviceDir)
}
