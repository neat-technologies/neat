import path from 'node:path'
import Parser from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import type { EdgeEvidence, GraphEdge, InfraNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  extractedEdgeId,
  infraId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import { isTestPath, type DiscoveredService } from './shared.js'
import { recordExtractionError } from './errors.js'
import { GRAMMAR_BY_EXT, parseSource } from './symbols.js'
import {
  ensureFileNode,
  loadSourceFiles,
  snippet,
  toPosix,
  type SourceFile,
} from './calls/shared.js'
import { foldColumns } from '../columns.js'

// Zod-as-contract declared-shape recognizer (ADR-170). For an app that treats
// Zod as the source of truth, the declared shape is invisible to the graph — a
// `const UserSchema` bound to a `z.object` shape is not even a SymbolNode
// (`collectSymbolDefs` mints `const` only for arrow / function values, not call
// expressions). This producer reads the top-level `z.object` / `z.enum` shape
// literals and mints each as an `InfraNode` of kind `zod-schema`, its fields
// folded on as `ColumnAttr` — the same column grain a `sql-table` node carries
// (ADR-157 §3), so a future declared-vs-observed field comparison has a static
// twin to land on.
//
//   A module-level  const UserSchema = z.object  whose body is
//   { id: z.string(), age: z.number() }  becomes an InfraNode
//   infra:zod-schema:UserSchema  with columns [id, age].
//
// A dedicated `zod-schema` kind — NOT a new NodeType and NOT a SymbolKind
// (minting Zod consts as symbols would ripple into symbol-edges.ts, symbol-grain
// OBSERVED fusion, and divergences.ts). `kind` is an open string, so this is a
// zero-schema-version change, and the read is EXTRACTED-only (no OBSERVED fusion:
// a runtime parse failure is not observed at field grain today).
//
// Scope is deliberately narrow — only a literal top-level `z.object` or `z.enum`
// shape bound directly to a module-level `const`. Composed / computed forms
// (`.extend`, `.merge`, `.pick`, unions, refinements, spreads, computed keys)
// name a partial or dynamic field set, so claiming them would misrepresent the
// contract — they are left unclaimed rather than guessed, a follow-on rung.
// Object-literal keys are read the way `calls/drizzle.ts` `columnsFromObject`
// reads a table's second-argument object.
//
// NOTE: comments here name the forms as `z.object` / `z.enum` without a trailing
// call paren on purpose — the Rule-5 audit (contracts.test.ts) forbids the literal
// `z.<object|enum>(` token in core/mcp src to stop schema *definitions* leaking in.
// This file recognizes those shapes, it does not define any.

const ZOD_IMPORT_RE = /\bzod\b/
// The conventional binding names for the Zod namespace: `import { z } from 'zod'`
// and `import * as z from 'zod'` (or `zod`). Any other alias is left unclaimed.
const ZOD_OBJECTS = new Set(['z', 'zod'])

// A schema recognized in one file: the InfraNode id it implies, its display
// name, and the declared top-level field set at code-name fidelity.
export interface ZodShape {
  infraId: string
  name: string
  fields: string[]
  evidence: EdgeEvidence
}

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
// / interpolated string — never guessed at. (Cloned from calls/drizzle.ts.)
function stringLiteralText(node: Parser.SyntaxNode | null): string | null {
  if (!node || node.type !== 'string') return null
  for (const child of namedChildren(node)) {
    if (child.type === 'string_fragment') return child.text
  }
  return '' // an empty '' literal has no string_fragment child
}

// A pair key → its field-name string (a bare `id:` or a quoted `'id':`).
function keyName(key: Parser.SyntaxNode | null): string | null {
  if (!key) return null
  if (key.type === 'property_identifier') return key.text
  if (key.type === 'string') return stringLiteralText(key)
  return null
}

// `z.object` / `z.enum` classification for a call, or null when the callee is
// not a `<z|zod>.object` / `<z|zod>.enum` member expression.
function zodCallKind(call: Parser.SyntaxNode): 'object' | 'enum' | null {
  const fn = call.childForFieldName('function')
  if (fn?.type !== 'member_expression') return null
  const obj = fn.childForFieldName('object')
  const prop = fn.childForFieldName('property')
  if (obj?.type !== 'identifier' || !ZOD_OBJECTS.has(obj.text)) return null
  if (prop?.type !== 'property_identifier') return null
  if (prop.text === 'object') return 'object'
  if (prop.text === 'enum') return 'enum'
  return null
}

// The first positional argument node of a call, or null.
function firstArg(call: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const args = call.childForFieldName('arguments')
  if (!args) return null
  return namedChildren(args)[0] ?? null
}

// The declared field names of a `z.object` shape literal, or null when the
// object is a composed / computed form (a spread or a computed key) — those name
// a partial or dynamic set, so the whole schema is left unclaimed.
function fieldsFromObject(obj: Parser.SyntaxNode): string[] | null {
  const out: string[] = []
  const seen = new Set<string>()
  for (const child of namedChildren(obj)) {
    if (child.type === 'spread_element') return null
    if (child.type !== 'pair') continue
    const key = child.childForFieldName('key')
    if (key?.type === 'computed_property_name') return null
    const name = keyName(key)
    if (name && !seen.has(name)) {
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

// The declared member set of a `z.enum` shape literal, or null when a member is
// not a plain string literal (a spread or a computed value) — left unclaimed.
function membersFromEnum(arr: Parser.SyntaxNode): string[] | null {
  const out: string[] = []
  const seen = new Set<string>()
  for (const child of namedChildren(arr)) {
    if (child.type !== 'string') return null
    const value = stringLiteralText(child)
    if (value !== null && value !== '' && !seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return out.length > 0 ? out : null
}

// Every top-level `const <Name>` bound directly to a `z.object` / `z.enum` shape
// literal in the program, as its schema name and the bound call node. Direct
// binding is the claim gate: a `.extend` / `.merge` wrapper makes the declarator's
// value the wrapping call, not the recognized shape call, so a composed form never
// matches.
function topLevelSchemas(root: Parser.SyntaxNode): { name: string; call: Parser.SyntaxNode }[] {
  const out: { name: string; call: Parser.SyntaxNode }[] = []
  for (const stmt of namedChildren(root)) {
    // Unwrap `export const …` to the declaration it fronts.
    const decl = stmt.type === 'export_statement' ? stmt.childForFieldName('declaration') : stmt
    if (decl?.type !== 'lexical_declaration' && decl?.type !== 'variable_declaration') continue
    for (const declarator of namedChildren(decl)) {
      if (declarator.type !== 'variable_declarator') continue
      const name = declarator.childForFieldName('name')
      const value = declarator.childForFieldName('value')
      if (name?.type !== 'identifier' || value?.type !== 'call_expression') continue
      if (zodCallKind(value) === null) continue
      out.push({ name: name.text, call: value })
    }
  }
  return out
}

export function zodShapesFromFile(file: SourceFile, serviceDir: string): ZodShape[] {
  if (!ZOD_IMPORT_RE.test(file.content)) return []
  const tree = parseSource(parserForExt(path.extname(file.path)), file.content)
  const out: ZodShape[] = []
  const seen = new Set<string>()

  for (const { name, call } of topLevelSchemas(tree.rootNode)) {
    const kind = zodCallKind(call)
    const arg = firstArg(call)
    let fields: string[] | null = null
    if (kind === 'object' && arg?.type === 'object') fields = fieldsFromObject(arg)
    else if (kind === 'enum' && arg?.type === 'array') fields = membersFromEnum(arg)
    // A composed / computed form (fields === null) or a non-literal argument is
    // left unclaimed — no node, rather than a partial contract.
    if (fields === null) continue
    if (seen.has(name)) continue
    seen.add(name)
    const line = call.startPosition.row + 1
    out.push({
      infraId: infraId('zod-schema', name),
      name,
      fields,
      evidence: {
        file: path.relative(serviceDir, file.path),
        line,
        snippet: snippet(file.content, line),
      },
    })
  }
  return out
}

export interface ZodExtractResult {
  nodesAdded: number
  edgesAdded: number
}

// Standalone extraction phase (registered in extract/index.ts). Gated per service
// on the `zod` dependency — a service that doesn't declare Zod is skipped. Each
// recognized schema mints an `infra:zod-schema:<name>` InfraNode with its fields
// folded on as EXTRACTED `ColumnAttr` (via the read-only `foldColumns`), owned by
// its file through a `file ──CONTAINS──▶ zod-schema` edge — the same containment
// spine symbols use under files (file-awareness.md §2). CONTAINS is structural,
// divergence-excluded, so the node carries no spurious `missing-observed` finding.
export async function addZodShapes(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<ZodExtractResult> {
  let nodesAdded = 0
  let edgesAdded = 0

  for (const service of services) {
    const deps = {
      ...(service.pkg.dependencies ?? {}),
      ...(service.pkg.devDependencies ?? {}),
    }
    if (deps['zod'] === undefined) continue

    const files = await loadSourceFiles(service.dir, service.excludeDirs)
    for (const file of files) {
      // Test scope is excluded from outbound inference the same way the CALLS
      // producers exclude it (ADR-065 #1) — a fixture schema is not app surface.
      if (isTestPath(file.path)) continue
      let shapes: ZodShape[]
      try {
        shapes = zodShapesFromFile(file, service.dir)
      } catch (err) {
        recordExtractionError('zod shape extraction', file.path, err)
        continue
      }
      for (const shape of shapes) {
        if (!graph.hasNode(shape.infraId)) {
          const node: InfraNode = {
            id: shape.infraId,
            type: NodeType.InfraNode,
            name: shape.name,
            provider: 'self',
            kind: 'zod-schema',
          }
          graph.addNode(node.id, node)
          nodesAdded++
        }

        // Fold the declared fields onto the node as EXTRACTED columns (ADR-157 §3
        // grain), read-only through `foldColumns`. Mutation is allowed here —
        // extract/* is a lifecycle authority (lifecycle.md §3).
        if (shape.fields.length > 0) {
          const node = graph.getNodeAttributes(shape.infraId) as InfraNode
          if (node.type === NodeType.InfraNode) {
            graph.replaceNodeAttributes(shape.infraId, {
              ...node,
              columns: foldColumns(
                node.columns,
                shape.fields,
                Provenance.EXTRACTED,
                confidenceForExtracted('structural'),
              ),
            })
          }
        }

        // File-first ownership (file-awareness.md §1–2): the schema is owned by
        // the file it is declared in, through a `file ──CONTAINS──▶ zod-schema`
        // edge alongside the `service ──CONTAINS──▶ file` edge ensureFileNode mints.
        const relFile = toPosix(shape.evidence.file)
        const { fileNodeId, nodesAdded: n, edgesAdded: e } = ensureFileNode(
          graph,
          service.pkg.name,
          service.node.id,
          relFile,
        )
        nodesAdded += n
        edgesAdded += e
        const edgeId = extractedEdgeId(fileNodeId, shape.infraId, EdgeType.CONTAINS)
        if (!graph.hasEdge(edgeId)) {
          const edge: GraphEdge = {
            id: edgeId,
            source: fileNodeId,
            target: shape.infraId,
            type: EdgeType.CONTAINS,
            provenance: Provenance.EXTRACTED,
            confidence: confidenceForExtracted('structural'),
            evidence: shape.evidence,
          }
          graph.addEdgeWithKey(edgeId, fileNodeId, shape.infraId, edge)
          edgesAdded++
        }
      }
    }
  }

  return { nodesAdded, edgesAdded }
}
