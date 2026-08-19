import path from 'node:path'
import Parser from 'tree-sitter'
import CSharp from 'tree-sitter-c-sharp'
import { infraId } from '@neat.is/types'
import { snippet, toPosix, type ExternalEndpoint, type SourceFile } from './shared.js'

// EF Core / .NET data-axis recognizer (ADR-203) — the C# rung of the same
// `infra:sql-table:<name>` grain the SQLAlchemy, GORM, ActiveRecord, and Eloquent
// readers already produce. The SQL analog of calls/gorm.ts, but with the opposite
// fidelity problem solved for free: where GORM *derives* the table name from the
// struct (so the pluralizer has to match byte-for-byte), EF Core's fusion-anchored
// shape is an EXPLICIT table name, so the recognizer reads a literal and never
// guesses:
//
//   [Table("orderitem", Schema = "accounting")]          // data annotation
//   public class OrderItemEntity { ... }
//
//   modelBuilder.Entity<OrderEntity>().ToTable("order"); // fluent API
//
// Both name the database table VERBATIM — the same string the running query hits,
// which is the string an OBSERVED db span reports (recovered from `db.statement`
// the way ADR-152 recovers SQLAlchemy's), so the extracted node fuses onto
// `infra:sql-table:<name>` by table name. The otel-demo `accounting` service names
// `orderitem` / `order` / `shipping` this way, so its OBSERVED `CALLS
// infra:sql-table:orderitem` edge gets a static twin instead of orphaning.
//
// Table grain only. EF Core's COLUMN names are convention-transformed
// (`UseSnakeCaseNamingConvention()` and friends, configured in a different file
// than the entity), so reproducing them faithfully is not a per-file fact the way
// GORM's tags are — and a PARTIAL column set would manufacture false column-drift.
// The OBSERVED side anchors columns regardless, so column grain is left as a named
// follow-on rather than guessed at.

// Cheap per-file gate — inert on any `.cs` file that isn't an EF Core entity /
// model-configuration file, the import-gate discipline the data-axis readers share.
// The `[Table]` / `[Column]` annotations live in
// `System.ComponentModel.DataAnnotations.Schema`; `DbContext` / `DbSet<>` and the
// fluent API live in `Microsoft.EntityFrameworkCore`.
const EFCORE_GATE =
  /Microsoft\.EntityFrameworkCore|DataAnnotations\.Schema|\bDbContext\b|\bDbSet\s*</

const PARSE_CHUNK = 16384

function makeCsParser(): Parser {
  const p = new Parser()
  p.setLanguage(CSharp)
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

function firstChildOfType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)
    if (c?.type === type) return c
  }
  return null
}

// A C# string literal node's value, or null when it is not a plain string (an
// interpolated `$"..."` carries a runtime hole — never a static table name).
// A regular `"orders"` exposes its text through a `string_literal_content` child;
// a verbatim `@"orders"` is a leaf whose `@"` / `"` delimiters (and doubled `""`
// escapes) are stripped here.
function csStringLiteral(node: Parser.SyntaxNode): string | null {
  if (node.type === 'string_literal') {
    let out = ''
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i)
      if (c?.type === 'string_literal_content') out += c.text
    }
    return out
  }
  if (node.type === 'verbatim_string_literal') {
    const t = node.text
    return t.length >= 3 ? t.slice(2, -1).replace(/""/g, '"') : ''
  }
  return null
}

// The trailing identifier of an attribute name (`Table`, or the last segment of a
// qualified `…Schema.Table`), so `[Table(...)]` and a fully-qualified spelling
// both resolve to `Table`. Tolerates the `Attribute` suffix C# allows to be
// dropped (`[TableAttribute(...)]`).
function attributeName(attr: Parser.SyntaxNode): string | null {
  const nameNode = attr.childForFieldName('name') ?? attr.namedChild(0)
  if (!nameNode) return null
  const text = nameNode.text
  const base = text.includes('.') ? text.slice(text.lastIndexOf('.') + 1) : text
  return base.endsWith('Attribute') ? base.slice(0, -'Attribute'.length) : base
}

// The literal table name a `[Table("orders", …)]` attribute declares: the value of
// its first POSITIONAL string argument. A `[Table(nameof(X))]` or a keyword-only
// form (`[Table(Schema = "s")]`) yields no positional string and is left unclaimed
// rather than guessed.
function tableFromAttribute(attr: Parser.SyntaxNode): string | null {
  if (attributeName(attr) !== 'Table') return null
  const args = attr.childForFieldName('arguments') ?? firstChildOfType(attr, 'attribute_argument_list')
  if (!args) return null
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i)
    if (arg?.type !== 'attribute_argument') continue
    // A named argument (`Schema = "accounting"`) is an assignment_expression — not
    // the positional table name. The positional table name is a bare string child.
    const first = arg.namedChild(0)
    if (!first) continue
    const value = csStringLiteral(first)
    if (value !== null) return value
    return null // first positional arg is not a plain string — don't guess
  }
  return null
}

// The literal table name a `.ToTable("orders")` fluent call declares: the value of
// its first string argument. `.ToTable(t => …)` (a table-builder overload) and any
// non-string first argument yield nothing.
function tableFromToTable(call: Parser.SyntaxNode): string | null {
  const fn = call.childForFieldName('function')
  if (fn?.type !== 'member_access_expression') return null
  const method = fn.childForFieldName('name') ?? fn.namedChild(fn.namedChildCount - 1)
  if (method?.text !== 'ToTable') return null
  const args = call.childForFieldName('arguments')
  const firstArg = args?.namedChild(0)
  if (firstArg?.type !== 'argument') return null
  const value = firstArg.namedChild(0)
  return value ? csStringLiteral(value) : null
}

// EF Core entity / model-configuration files → `infra:sql-table:<name>` endpoints
// (ADR-203). Gated on an EF Core signal; parsed with tree-sitter-c-sharp from the
// RAW file (comments are structural `comment` nodes, so a `[Table("x")]` in a `//`
// or `/* */` comment never mints a node). One endpoint per distinct table name;
// the orchestrator (calls/index.ts) mints the node and the `file ──CALLS──▶
// sql-table` edge. Table grain — no columns (see the file header).
export function efcoreEndpointsFromFile(
  file: SourceFile,
  serviceDir: string,
): ExternalEndpoint[] {
  if (path.extname(file.path) !== '.cs') return []
  if (!EFCORE_GATE.test(file.content)) return []
  const tree = parseSource(makeCsParser(), file.content)

  const out: ExternalEndpoint[] = []
  const seen = new Set<string>()
  const push = (name: string, line: number): void => {
    if (!name || seen.has(name)) return
    seen.add(name)
    out.push({
      infraId: infraId('sql-table', name),
      name,
      kind: 'sql-table',
      edgeType: 'CALLS',
      confidenceKind: 'structural',
      evidence: {
        file: toPosix(path.relative(serviceDir, file.path)),
        line,
        snippet: snippet(file.content, line),
      },
    })
  }

  walk(tree.rootNode, (node) => {
    if (node.type === 'attribute') {
      const table = tableFromAttribute(node)
      if (table) push(table, node.startPosition.row + 1)
      return
    }
    if (node.type === 'invocation_expression') {
      const table = tableFromToTable(node)
      if (table) push(table, node.startPosition.row + 1)
    }
  })

  return out
}
