import path from 'node:path'
import Parser from 'tree-sitter'
import Java from 'tree-sitter-java'
import { infraId } from '@neat.is/types'
import { snippet, toPosix, type ExternalEndpoint, type SourceFile } from './shared.js'

// JPA / Spring Data data axis — the Java rung of the `infra:sql-table:<name>` grain
// the EF Core, GORM, SQLAlchemy, ActiveRecord and Eloquent readers produce.
//
//   @Entity
//   @Table(name = "orders")                  // the table, verbatim
//   public class Order { ... }
//
//   public interface OrderRepository extends CrudRepository<Order, String> { }
//
// The entity's `@Table(name = "…")` names the database table verbatim — the
// string an OBSERVED db span reports — so the node fuses by name. The entity
// file gets `file ──CALLS──▶ sql-table`, and so does every Spring Data
// repository over that entity (`CrudRepository<Order, …>`, `JpaRepository`,
// `PagingAndSortingRepository`, the `List*` variants), resolved across the
// service's files by the entity's simple class name. That is the file the
// queries actually run from.
//
// An entity with no `@Table(name)` is left unclaimed. Its table name then comes
// from the configured physical naming strategy, which lives outside the entity,
// so reading the class name would be a guess. A name that isn't a plain literal,
// an entity class name declared twice in one service, and a repository over an
// unclaimed entity are all left unclaimed the same way.
//
// Table grain only: column names go through the same naming strategy.

const PARSE_CHUNK = 16384
const JPA_GATE = /\b(?:javax|jakarta)\.persistence\b|@Entity\b|Repository\s*</
const REPOSITORY_BASES = new Set([
  'CrudRepository',
  'ListCrudRepository',
  'JpaRepository',
  'PagingAndSortingRepository',
  'ListPagingAndSortingRepository',
  'Repository',
])

function parseSource(parser: Parser, source: string): Parser.Tree {
  return parser.parse((index: number) =>
    index >= source.length ? '' : source.slice(index, index + PARSE_CHUNK),
  )
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node)
  for (const c of node.namedChildren) walk(c, visit)
}

function annotations(decl: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const mods = decl.namedChildren.find((c) => c.type === 'modifiers')
  return mods ? mods.namedChildren.filter((c) => c.type === 'annotation' || c.type === 'marker_annotation') : []
}

function simpleName(annotation: Parser.SyntaxNode): string {
  const text = annotation.childForFieldName('name')?.text ?? ''
  return text.slice(text.lastIndexOf('.') + 1)
}

function stringLiteral(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node || node.type !== 'string_literal') return null
  let out = ''
  for (const c of node.namedChildren) {
    if (c.type === 'string_fragment') out += c.text
    else return null
  }
  return out
}

// `@Table(name = "orders")` → orders. A `@Table` without a literal `name` (only
// `schema`, or a constant) → null.
function tableName(annotation: Parser.SyntaxNode): string | null {
  const args = annotation.childForFieldName('arguments')
  if (!args) return null
  for (const c of args.namedChildren) {
    if (c.type === 'element_value_pair' && c.childForFieldName('key')?.text === 'name') {
      return stringLiteral(c.childForFieldName('value'))
    }
  }
  return null
}

interface Entity {
  table: string | null
  file: SourceFile
  line: number
}

// The entity type a Spring Data repository interface manages: the first type
// argument of a known repository base in its `extends` list.
function repositoryEntity(iface: Parser.SyntaxNode): string | null {
  const ext = iface.namedChildren.find((c) => c.type === 'extends_interfaces')
  if (!ext) return null
  let found: string | null = null
  walk(ext, (n) => {
    if (found || n.type !== 'generic_type') return
    const base = n.namedChildren.find((c) => c.type === 'type_identifier' || c.type === 'scoped_type_identifier')
    const baseName = base?.text.slice(base.text.lastIndexOf('.') + 1) ?? ''
    if (!REPOSITORY_BASES.has(baseName)) return
    const first = n.namedChildren.find((c) => c.type === 'type_arguments')?.namedChildren[0]
    if (first && (first.type === 'type_identifier' || first.type === 'scoped_type_identifier')) {
      found = first.text.slice(first.text.lastIndexOf('.') + 1)
    }
  })
  return found
}

function endpoint(table: string, file: SourceFile, serviceDir: string, line: number): ExternalEndpoint {
  return {
    infraId: infraId('sql-table', table),
    name: table,
    kind: 'sql-table',
    edgeType: 'CALLS',
    confidenceKind: 'structural',
    evidence: {
      file: toPosix(path.relative(serviceDir, file.path)),
      line,
      snippet: snippet(file.content, line),
    },
  }
}

/** JPA entities and Spring Data repositories across one service's files. */
export function jpaEndpoints(files: SourceFile[], serviceDir: string): ExternalEndpoint[] {
  const javaFiles = files.filter((f) => path.extname(f.path) === '.java' && JPA_GATE.test(f.content))
  if (javaFiles.length === 0) return []
  const parser = new Parser()
  parser.setLanguage(Java)

  const entities = new Map<string, Entity | null>() // null: declared twice
  const repositories: { entity: string; file: SourceFile; line: number }[] = []

  for (const file of javaFiles) {
    const root = parseSource(parser, file.content).rootNode
    walk(root, (n) => {
      if (n.type === 'class_declaration') {
        const anns = annotations(n)
        if (!anns.some((a) => simpleName(a) === 'Entity')) return
        const name = n.childForFieldName('name')?.text
        if (!name) return
        const tableAnn = anns.find((a) => simpleName(a) === 'Table')
        const entity: Entity = {
          table: tableAnn ? tableName(tableAnn) : null,
          file,
          line: (tableAnn ?? n).startPosition.row + 1,
        }
        entities.set(name, entities.has(name) ? null : entity)
      } else if (n.type === 'interface_declaration') {
        const entity = repositoryEntity(n)
        if (entity) repositories.push({ entity, file, line: n.startPosition.row + 1 })
      }
    })
  }

  const out: ExternalEndpoint[] = []
  for (const entity of entities.values()) {
    if (entity?.table) out.push(endpoint(entity.table, entity.file, serviceDir, entity.line))
  }
  for (const repo of repositories) {
    const table = entities.get(repo.entity)?.table
    if (table) out.push(endpoint(table, repo.file, serviceDir, repo.line))
  }
  return out
}
