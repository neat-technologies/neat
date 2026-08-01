import path from 'node:path'
import Parser from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import TypeScript from 'tree-sitter-typescript'
import type { GraphEdge, SymbolKind, SymbolNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  extractedEdgeId,
  symbolId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import type { DiscoveredService } from './shared.js'
import { recordExtractionError } from './errors.js'
import { ensureFileNode, loadSourceFiles, snippet, toPosix } from './calls/shared.js'

// Static symbol-node extraction (ADR-158, JS/TS first). Parses each JS/TS source
// file with tree-sitter and mints a SymbolNode per function / method /
// constructor / class *definition*, owned by its file through a
// `file ──CONTAINS──▶ symbol` edge — the same containment spine files use under
// services (file-awareness.md §2), one level deeper. Static-first: a symbol
// exists in the inventory whether or not runtime ever exercised it, and it
// carries its `{ startLine, endLine }` definition span, which is the fusion key
// ingest joins a span's `code.line` against to land an OBSERVED edge on the
// calling symbol (observed-first edges, ingest.ts).
//
// Scope is definitions only — no CALLS/INHERITS symbol edges (Phase 2). Each file
// is parsed with the grammar that understands it: `.ts` / `.tsx` through
// tree-sitter-typescript, `.js` / `.jsx` / `.mjs` / `.cjs` through
// tree-sitter-javascript. The JS grammar cannot parse TypeScript type annotations
// — it produces ERROR nodes that swallow most definitions (an all-`.ts` core file
// yields 4 of 27 functions under the JS grammar, 27 of 27 under the TS one) — and
// symbol extraction, unlike the string / route matchers that survive a partial
// parse, needs a correct AST. Python and Go symbol grain are a follow-on rung.
// Evidence carries the real `file:line`, never fabricated (file-awareness.md §6).

const PARSE_CHUNK = 16384

// The grammar for each source extension NEAT symbol-extracts in this slice.
// `.py` / `.go` are absent — symbol grain for those is a follow-on. tree-sitter-
// typescript is a superset grammar sharing the same definition node types
// (function_declaration / class_declaration / method_definition /
// variable_declarator), so `collectSymbolDefs` walks TS and JS trees identically.
const GRAMMAR_BY_EXT: Record<string, typeof JavaScript> = {
  '.ts': TypeScript.typescript,
  '.tsx': TypeScript.tsx,
  '.js': JavaScript,
  '.jsx': JavaScript,
  '.mjs': JavaScript,
  '.cjs': JavaScript,
}

function parseSource(parser: Parser, source: string): Parser.Tree {
  return parser.parse((index: number) =>
    index >= source.length ? '' : source.slice(index, index + PARSE_CHUNK),
  )
}

// A parsed definition, pre-identity. `qualname` is the source-declared name
// (`OrderService.create`, `merge`); `node` carries the definition span.
interface SymbolDef {
  kind: SymbolKind
  qualname: string
  startLine: number
  endLine: number
}

function methodName(node: Parser.SyntaxNode): string | null {
  const name = node.childForFieldName('name')
  return name ? name.text : null
}

// Walk the AST once, emitting one SymbolDef per definition. A class carries its
// method context so a method's qualname is `Class.method`; a plain (including
// nested) function keeps its bare declared name. Anonymous definitions with no
// declared name are skipped rather than given a fabricated one (§6).
function collectSymbolDefs(root: Parser.SyntaxNode): SymbolDef[] {
  const out: SymbolDef[] = []

  const push = (kind: SymbolKind, qualname: string, node: Parser.SyntaxNode): void => {
    out.push({
      kind,
      qualname,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    })
  }

  const visit = (node: Parser.SyntaxNode, classCtx: string | undefined): void => {
    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = node.childForFieldName('name')?.text
        if (name) push('function', name, node)
        break
      }
      case 'class_declaration':
      case 'class': {
        const name = node.childForFieldName('name')?.text
        if (name) push('class', name, node)
        const body = node.childForFieldName('body')
        if (body) {
          for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i)
            if (child) visit(child, name ?? classCtx)
          }
        }
        // Class children were walked with the class context above; skip the
        // generic recurse so its body isn't visited twice.
        return
      }
      case 'method_definition': {
        const name = methodName(node)
        if (name) {
          const kind: SymbolKind = name === 'constructor' ? 'constructor' : 'method'
          push(kind, classCtx ? `${classCtx}.${name}` : name, node)
        }
        break
      }
      case 'variable_declarator': {
        // `const foo = () => {}` / `const foo = function () {}` — the common
        // arrow/function-expression definition form. Only a plain identifier
        // name yields a symbol; a destructuring pattern names no single symbol.
        const value = node.childForFieldName('value')
        if (
          value &&
          (value.type === 'arrow_function' ||
            value.type === 'function' ||
            value.type === 'function_expression' ||
            value.type === 'generator_function')
        ) {
          const nameNode = node.childForFieldName('name')
          if (nameNode && nameNode.type === 'identifier') {
            push('function', nameNode.text, node)
          }
        }
        break
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (child) visit(child, classCtx)
    }
  }

  visit(root, undefined)
  return out
}

// Same-named siblings in one file (overloads, repeated anonymous-arrow names)
// get an ordinal disambiguator in source order so the id stays collision-free
// without inventing a name (ADR-158). A qualname that appears once keeps the
// clean, disambiguator-free id.
function disambiguate(defs: SymbolDef[]): { def: SymbolDef; disambiguator?: number }[] {
  const counts = new Map<string, number>()
  for (const def of defs) counts.set(def.qualname, (counts.get(def.qualname) ?? 0) + 1)
  const seen = new Map<string, number>()
  return defs.map((def) => {
    if ((counts.get(def.qualname) ?? 0) <= 1) return { def }
    const ordinal = seen.get(def.qualname) ?? 0
    seen.set(def.qualname, ordinal + 1)
    return { def, disambiguator: ordinal }
  })
}

export async function addSymbols(
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
    const files = await loadSourceFiles(service.dir)
    for (const file of files) {
      const parser = parserForExt(path.extname(file.path))
      if (!parser) continue
      const relPath = toPosix(path.relative(service.dir, file.path))

      let defs: SymbolDef[]
      try {
        const tree = parseSource(parser, file.content)
        defs = collectSymbolDefs(tree.rootNode)
      } catch (err) {
        recordExtractionError('symbol extraction', file.path, err)
        continue
      }
      if (defs.length === 0) continue

      // The file owns its symbols; ensure the FileNode (and the owning
      // `service ──CONTAINS──▶ file` edge) exists before a symbol hangs off it.
      // Idempotent — addFiles already minted it on this pass.
      const { fileNodeId, nodesAdded: fn, edgesAdded: fe } = ensureFileNode(
        graph,
        service.pkg.name,
        service.node.id,
        relPath,
      )
      nodesAdded += fn
      edgesAdded += fe

      for (const { def, disambiguator } of disambiguate(defs)) {
        const sid = symbolId(service.pkg.name, relPath, def.qualname, disambiguator)
        if (!graph.hasNode(sid)) {
          const node: SymbolNode = {
            id: sid,
            type: NodeType.SymbolNode,
            kind: def.kind,
            qualname: def.qualname,
            span: { startLine: def.startLine, endLine: def.endLine },
            service: service.pkg.name,
            relPath,
            discoveredVia: 'static',
          }
          graph.addNode(sid, node)
          nodesAdded++
        }
        // `file ──CONTAINS──▶ symbol` — structural ownership, the same tier and
        // shape as `service ──CONTAINS──▶ file` (file-awareness.md §2), evidence
        // pinned to the definition's file:line.
        const containsId = extractedEdgeId(fileNodeId, sid, EdgeType.CONTAINS)
        if (!graph.hasEdge(containsId)) {
          const edge: GraphEdge = {
            id: containsId,
            source: fileNodeId,
            target: sid,
            type: EdgeType.CONTAINS,
            provenance: Provenance.EXTRACTED,
            confidence: confidenceForExtracted('structural'),
            evidence: {
              file: relPath,
              line: def.startLine,
              snippet: snippet(file.content, def.startLine),
            },
          }
          graph.addEdgeWithKey(containsId, fileNodeId, sid, edge)
          edgesAdded++
        }
      }
    }
  }

  return { nodesAdded, edgesAdded }
}
