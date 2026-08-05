import path from 'node:path'
import Parser from 'tree-sitter'
import type { GraphEdge, ServerActionNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  extractedEdgeId,
  serverActionId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import { isTestPath, type DiscoveredService } from './shared.js'
import { recordExtractionError } from './errors.js'
import { ensureFileNode, loadSourceFiles, snippet, toPosix } from './calls/shared.js'
import { GRAMMAR_BY_EXT, parseSource } from './symbols.js'
import { loadTsPathConfig, resolveJsImport, type TsPathConfig } from './imports.js'

// Next.js Server Action extraction (ADR-168). A Server Action is the mutation
// boundary of a modern App Router app: an exported async function marked
// `"use server"`, either by a module-level directive (every exported async
// function in the file is an action) or an in-body directive (that one
// function). The client references the imported action binding — a call, an
// `action={fn}` JSX attribute, a `useActionState(fn)` / `fn.bind(...)` argument —
// and Next posts to it, serialising the call to an opaque `Next-Action` hash. At
// HTTP grain the whole surface collapses onto one POST edge, so this producer
// mints a ServerActionNode per exported action to recover the per-action
// topology, owned by its file through `file ──CONTAINS──▶ action`, and stitches
// `file ──CALLS──▶ action` on any client reference resolved through the import
// graph.
//
// EXTRACTED-first: OBSERVED fusion is deferred (the `Next-Action` hash carries no
// action name), the same posture GraphQLOperationNode took before its static
// extractor. Scope is gated by the `next` manifest dependency, JS/TS only,
// matching the SymbolNode grain the client-stitch resolves against. The
// load-bearing discipline (file-awareness.md §6): the client-stitch fires only
// when the imported binding resolves through `resolveJsImport` to exactly one
// known ServerActionNode — never fuzzy-matched — so the edge is deterministic.

// The interior text of a JS/TS string literal node (its `string_fragment`
// child), quote-stripped. Mirrors imports.ts's `stringLiteralText`.
function stringLiteralText(node: Parser.SyntaxNode): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child?.type === 'string_fragment') return child.text
  }
  const raw = node.text
  return raw.length >= 2 ? raw.slice(1, -1) : null
}

// A `"use server"` directive is a leading string-literal expression statement in
// a module body or a function's statement block. Scan only the leading run of
// string-literal statements (the directive prologue): a `"use strict"` /
// `"use client"` before it is skipped, and the first non-directive statement ends
// the prologue. Returns true when one of the leading directives is `use server`.
function hasUseServerDirective(container: Parser.SyntaxNode): boolean {
  for (let i = 0; i < container.namedChildCount; i++) {
    const stmt = container.namedChild(i)
    if (!stmt || stmt.type !== 'expression_statement') break
    const expr = stmt.namedChild(0)
    if (!expr || expr.type !== 'string') break
    if (stringLiteralText(expr) === 'use server') return true
    // Another leading directive (`use strict` / `use client`) — keep scanning.
  }
  return false
}

// A function node is async when it carries the `async` keyword token. tree-sitter
// exposes it as an anonymous child of the function / arrow node.
function isAsyncFunction(node: Parser.SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === 'async') return true
  }
  return false
}

// One exported async function the file declares — the unit a `"use server"`
// directive promotes to an action. `bodyNode` is the function's statement block
// (for the in-body directive test) or null for a concise-body arrow.
interface ExportedAsyncFn {
  exportName: string
  fnNode: Parser.SyntaxNode
  bodyNode: Parser.SyntaxNode | null
  line: number
}

// Collect the file's directly-exported async functions: `export async function
// f(){}` and `export const f = async () => {}` / `= async function(){}`. A
// destructuring export, a re-export clause (`export { f }`), and a default export
// are out of this slice — the direct-declaration forms are the idiomatic action
// shape. Sync exports are skipped (a Server Action must be async).
function collectExportedAsyncFns(root: Parser.SyntaxNode): ExportedAsyncFn[] {
  const out: ExportedAsyncFn[] = []
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === 'export_statement') {
      const decl = node.childForFieldName('declaration')
      const line = node.startPosition.row + 1
      if (decl?.type === 'function_declaration') {
        const name = decl.childForFieldName('name')?.text
        if (name && isAsyncFunction(decl)) {
          out.push({ exportName: name, fnNode: decl, bodyNode: decl.childForFieldName('body'), line })
        }
      } else if (decl?.type === 'lexical_declaration' || decl?.type === 'variable_declaration') {
        for (let i = 0; i < decl.namedChildCount; i++) {
          const d = decl.namedChild(i)
          if (d?.type !== 'variable_declarator') continue
          const nameNode = d.childForFieldName('name')
          const value = d.childForFieldName('value')
          if (nameNode?.type !== 'identifier' || !value) continue
          if (
            (value.type === 'arrow_function' ||
              value.type === 'function' ||
              value.type === 'function_expression' ||
              value.type === 'generator_function') &&
            isAsyncFunction(value)
          ) {
            out.push({
              exportName: nameNode.text,
              fnNode: value,
              bodyNode: value.childForFieldName('body'),
              line,
            })
          }
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (child) visit(child)
    }
  }
  visit(root)
  return out
}

// The named-import bindings of a file: local name → the exported name it names in
// its source module. Only named imports (including `as`-aliased) are collected —
// a Server Action is a named export, so a default / namespace import can't name
// one. `import type` is skipped (a type reference is not a value call path).
function collectNamedImports(
  root: Parser.SyntaxNode,
): Map<string, { specifier: string; importedName: string }> {
  const out = new Map<string, { specifier: string; importedName: string }>()
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === 'import_statement') {
      // `import type { … }` — skip the whole statement.
      for (let i = 0; i < node.childCount; i++) {
        if (node.child(i)?.type === 'type') return
      }
      const source = node.childForFieldName('source')
      const specifier = source ? stringLiteralText(source) : null
      if (specifier) {
        for (let i = 0; i < node.namedChildCount; i++) {
          const clause = node.namedChild(i)
          if (clause?.type !== 'import_clause') continue
          for (let j = 0; j < clause.namedChildCount; j++) {
            const named = clause.namedChild(j)
            if (named?.type !== 'named_imports') continue
            for (let k = 0; k < named.namedChildCount; k++) {
              const spec = named.namedChild(k)
              if (spec?.type !== 'import_specifier') continue
              // A per-specifier `import { type Foo }` marks a type-only binding.
              let isType = false
              for (let t = 0; t < spec.childCount; t++) {
                if (spec.child(t)?.type === 'type') isType = true
              }
              if (isType) continue
              const nameNode = spec.childForFieldName('name')
              if (!nameNode) continue
              const importedName = nameNode.text
              const localName = spec.childForFieldName('alias')?.text ?? importedName
              out.set(localName, { specifier, importedName })
            }
          }
        }
      }
      return
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (child) visit(child)
    }
  }
  visit(root)
  return out
}

// First reference line for each name in `wanted`, walking value-position
// `identifier` uses and skipping the import declarations themselves. A call
// (`fn()`), a JSX attribute (`action={fn}`), a `useActionState(fn)` argument, and
// a `fn.bind(...)` receiver are all plain `identifier` nodes — property keys and
// shorthand are their own node types, so they never match — which is what closes
// the form-action gap: referenced, not only called.
function firstReferenceLines(
  root: Parser.SyntaxNode,
  wanted: Set<string>,
): Map<string, number> {
  const lines = new Map<string, number>()
  const visit = (node: Parser.SyntaxNode): void => {
    // Don't descend into the import that declares the binding — the import
    // specifier is not a usage reference.
    if (node.type === 'import_statement') return
    if (node.type === 'identifier' && wanted.has(node.text) && !lines.has(node.text)) {
      lines.set(node.text, node.startPosition.row + 1)
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (child) visit(child)
    }
  }
  visit(root)
  return lines
}

export async function addServerActions(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  const parsers = new Map<string, Parser>()
  const parserForExt = (ext: string): Parser | null => {
    const grammar = GRAMMAR_BY_EXT[ext]
    if (!grammar) return null
    let parser = parsers.get(ext)
    if (!parser) {
      parser = new Parser()
      parser.setLanguage(grammar)
      parsers.set(ext, parser)
    }
    return parser
  }
  let nodesAdded = 0
  let edgesAdded = 0

  for (const service of services) {
    const deps = {
      ...(service.pkg.dependencies ?? {}),
      ...(service.pkg.devDependencies ?? {}),
    }
    // Gated on the `next` dependency, the same registry discipline addRoutes
    // uses — a service that isn't a Next.js app declares no Server Actions.
    if (deps['next'] === undefined) continue

    const tsPaths: TsPathConfig | null = await loadTsPathConfig(service.dir)
    const files = await loadSourceFiles(service.dir)

    // ── Pass 1: mint an action node per exported `"use server"` function. ──
    for (const file of files) {
      if (isTestPath(file.path)) continue
      const parser = parserForExt(path.extname(file.path))
      if (!parser) continue
      const relPath = toPosix(path.relative(service.dir, file.path))

      let root: Parser.SyntaxNode
      try {
        root = parseSource(parser, file.content).rootNode
      } catch (err) {
        recordExtractionError('server action extraction', file.path, err)
        continue
      }

      const moduleDirective = hasUseServerDirective(root)
      const exported = collectExportedAsyncFns(root)
      const actions = exported.filter(
        (fn) => moduleDirective || (fn.bodyNode ? hasUseServerDirective(fn.bodyNode) : false),
      )
      if (actions.length === 0) continue

      // The file owns its actions; ensure its FileNode (and the owning
      // `service ──CONTAINS──▶ file` edge) exists before an action hangs off it.
      const { fileNodeId, nodesAdded: fn, edgesAdded: fe } = ensureFileNode(
        graph,
        service.pkg.name,
        service.node.id,
        relPath,
      )
      nodesAdded += fn
      edgesAdded += fe

      for (const action of actions) {
        const aid = serverActionId(service.pkg.name, relPath, action.exportName)
        if (!graph.hasNode(aid)) {
          const node: ServerActionNode = {
            id: aid,
            type: NodeType.ServerActionNode,
            name: action.exportName,
            service: service.pkg.name,
            module: relPath,
            exportName: action.exportName,
            path: relPath,
            line: action.line,
            discoveredVia: 'static',
          }
          graph.addNode(aid, node)
          nodesAdded++
        }
        // `file ──CONTAINS──▶ action` — structural ownership, the same tier and
        // shape as `file ──CONTAINS──▶ symbol` (file-awareness.md §2), evidence
        // pinned to the action's declaration file:line.
        const containsId = extractedEdgeId(fileNodeId, aid, EdgeType.CONTAINS)
        if (!graph.hasEdge(containsId)) {
          const edge: GraphEdge = {
            id: containsId,
            source: fileNodeId,
            target: aid,
            type: EdgeType.CONTAINS,
            provenance: Provenance.EXTRACTED,
            confidence: confidenceForExtracted('structural'),
            evidence: {
              file: relPath,
              line: action.line,
              snippet: snippet(file.content, action.line),
            },
          }
          graph.addEdgeWithKey(containsId, fileNodeId, aid, edge)
          edgesAdded++
        }
      }
    }

    // ── Pass 2: client-stitch `file ──CALLS──▶ action` on any reference to an ──
    //    imported action binding, resolved through the import graph.
    for (const file of files) {
      if (isTestPath(file.path)) continue
      const parser = parserForExt(path.extname(file.path))
      if (!parser) continue
      const relPath = toPosix(path.relative(service.dir, file.path))
      const fileDir = path.dirname(file.path)

      let root: Parser.SyntaxNode
      try {
        root = parseSource(parser, file.content).rootNode
      } catch (err) {
        recordExtractionError('server action stitch', file.path, err)
        continue
      }

      // Resolve each named import to a known ServerActionNode; a local binding
      // that resolves to one is an action reference in this file.
      const bindings = collectNamedImports(root)
      const actionBindings = new Map<string, string>() // local name → action id
      for (const [local, binding] of bindings) {
        const target = await resolveJsImport(binding.specifier, fileDir, service.dir, tsPaths)
        if (!target) continue
        const aid = serverActionId(service.pkg.name, target, binding.importedName)
        if (graph.hasNode(aid)) actionBindings.set(local, aid)
      }
      if (actionBindings.size === 0) continue

      const refLines = firstReferenceLines(root, new Set(actionBindings.keys()))

      let clientFileId: string | null = null
      for (const [local, aid] of actionBindings) {
        const line = refLines.get(local)
        if (line === undefined) continue // imported but never referenced — no edge, honestly.
        if (clientFileId === null) {
          const ensured = ensureFileNode(graph, service.pkg.name, service.node.id, relPath)
          clientFileId = ensured.fileNodeId
          nodesAdded += ensured.nodesAdded
          edgesAdded += ensured.edgesAdded
        }
        // `file ──CALLS──▶ action` — a client reference to the action, resolved
        // through the import graph to exactly one known node. Reuses CALLS; no new
        // edge type (ADR-168). Deduped by the deterministic edge id, so multiple
        // references (a call and a JSX `action={fn}`) land one edge.
        const callsId = extractedEdgeId(clientFileId, aid, EdgeType.CALLS)
        if (graph.hasEdge(callsId)) continue
        const edge: GraphEdge = {
          id: callsId,
          source: clientFileId,
          target: aid,
          type: EdgeType.CALLS,
          provenance: Provenance.EXTRACTED,
          confidence: confidenceForExtracted('structural'),
          evidence: {
            file: relPath,
            line,
            snippet: snippet(file.content, line),
          },
        }
        graph.addEdgeWithKey(callsId, clientFileId, aid, edge)
        edgesAdded++
      }
    }
  }

  return { nodesAdded, edgesAdded }
}
