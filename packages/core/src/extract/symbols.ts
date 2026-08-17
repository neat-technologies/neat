import path from 'node:path'
import Parser from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import TypeScript from 'tree-sitter-typescript'
import Python from 'tree-sitter-python'
import Go from 'tree-sitter-go'
import Ruby from 'tree-sitter-ruby'
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

// Static symbol-node extraction (ADR-158 wired JS/TS; ADR-192 added Python and
// Go; ADR-193 added Ruby). Parses each source file with the grammar that understands it and mints a
// SymbolNode per function / method / constructor / class *definition*, owned by
// its file through a `file ──CONTAINS──▶ symbol` edge — the same containment
// spine files use under services (file-awareness.md §2), one level deeper.
// Static-first: a symbol exists in the inventory whether or not runtime ever
// exercised it, and it carries its `{ startLine, endLine }` definition span,
// which is the fusion key ingest joins a span's `code.line` against to land an
// OBSERVED edge on the calling symbol (observed-first edges, ingest.ts). The node
// is language-neutral — `symbolId` carries no language token — so the per-language
// walker below is the only adapter, and a Python or Go symbol fuses with an
// observed span exactly as a JS/TS one does: line-in-span primary, `code.function`
// (the qualname's terminal name) the tiebreaker. The span alone earns the node;
// fusion also needs the observed span to carry the `code.*` anchor, which is a
// property of the instrumentation, not of this extractor (ADR-192 consequences).
//
// Scope is definitions only — no CALLS/INHERITS symbol edges (that stays Phase 2 /
// symbol-edges.ts, JS/TS). Each file is parsed with the grammar that understands
// it: `.ts` / `.tsx` through tree-sitter-typescript, `.js` / `.jsx` / `.mjs` /
// `.cjs` through tree-sitter-javascript, `.py` through tree-sitter-python, `.go`
// through tree-sitter-go, `.rb` through tree-sitter-ruby — the same grammars
// extract/routes.ts and the call producers already load, so no new dependency. The JS grammar cannot parse
// TypeScript type annotations — it produces ERROR nodes that swallow most
// definitions (an all-`.ts` core file yields 4 of 27 functions under the JS
// grammar, 27 of 27 under the TS one) — and symbol extraction, unlike the string /
// route matchers that survive a partial parse, needs a correct AST, so the grammar
// is chosen per extension. `collectSymbolDefsForExt` dispatches to the JS/TS,
// Python, Go, or Ruby walker on the extension. Evidence carries the real `file:line`,
// never fabricated (file-awareness.md §6).

const PARSE_CHUNK = 16384

// The grammar for the JS/TS extensions NEAT symbol-extracts. tree-sitter-
// typescript is a superset grammar sharing the same definition node types
// (function_declaration / class_declaration / method_definition /
// variable_declarator), so `collectSymbolDefs` walks TS and JS trees identically.
// This map stays JS/TS-only because the other AST producers that import it
// (symbol-edges.ts, actions.ts, zod-shapes.ts, calls/drizzle.ts,
// calls/firestore.ts) are JS/TS-scoped; symbol extraction extends the set to
// Python and Go through `SYMBOL_GRAMMAR_BY_EXT` below without pulling those
// producers onto languages they don't parse.
export const GRAMMAR_BY_EXT: Record<string, typeof JavaScript> = {
  '.ts': TypeScript.typescript,
  '.tsx': TypeScript.tsx,
  '.js': JavaScript,
  '.jsx': JavaScript,
  '.mjs': JavaScript,
  '.cjs': JavaScript,
}

// Symbol extraction alone reaches Python, Go, and Ruby (ADR-192, ADR-193): `.py` →
// tree-sitter-python, `.go` → tree-sitter-go, `.rb` → tree-sitter-ruby, layered
// over the JS/TS set so the shared `GRAMMAR_BY_EXT` its sibling producers import
// stays untouched.
const SYMBOL_GRAMMAR_BY_EXT: Record<string, typeof JavaScript> = {
  ...GRAMMAR_BY_EXT,
  '.py': Python,
  '.go': Go,
  '.rb': Ruby,
}

export function parseSource(parser: Parser, source: string): Parser.Tree {
  return parser.parse((index: number) =>
    index >= source.length ? '' : source.slice(index, index + PARSE_CHUNK),
  )
}

// A parsed definition, pre-identity. `qualname` is the source-declared name
// (`OrderService.create`, `merge`); `node` carries the definition span.
export interface SymbolDef {
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
export function collectSymbolDefs(root: Parser.SyntaxNode): SymbolDef[] {
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
      case 'abstract_class_declaration':
      case 'class': {
        // `abstract class Foo` parses as its own node type in the TS grammar,
        // not `class_declaration` — miss it and every INHERITS/IMPLEMENTS to an
        // abstract base (the most common heritage target) has no symbol to land
        // on. It carries the same `name` / `body` fields, so it mints identically.
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

// Python: `def` is `function_definition`, `class` is `class_definition`, and a
// decorated form wraps either in `decorated_definition`. A `function_definition`
// whose direct owner is a class body is a method (its `__init__` the constructor,
// the qualname `Class.__init__` so the terminal name still matches the runtime
// `code.function`); a top-level or nested `def` is a plain function. Method-ness
// comes from direct class-body membership, not ambient scope — a `def` nested in a
// method is a function, mirroring the JS/TS walker where the node type decides.
// `async def` is the same node type, so it needs no separate case.
export function collectPythonSymbolDefs(root: Parser.SyntaxNode): SymbolDef[] {
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
      case 'function_definition': {
        const name = node.childForFieldName('name')?.text
        if (name) {
          if (classCtx) {
            const kind: SymbolKind = name === '__init__' ? 'constructor' : 'method'
            push(kind, `${classCtx}.${name}`, node)
          } else {
            push('function', name, node)
          }
        }
        // The body is walked with no class context: a `def` inside this function
        // is a plain function, never a method of the enclosing class.
        const body = node.childForFieldName('body')
        if (body) {
          for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i)
            if (child) visit(child, undefined)
          }
        }
        return
      }
      case 'class_definition': {
        const name = node.childForFieldName('name')?.text
        if (name) push('class', name, node)
        const body = node.childForFieldName('body')
        if (body) {
          for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i)
            if (child) visit(child, name ?? classCtx)
          }
        }
        return
      }
      case 'decorated_definition': {
        // `@app.get(...)` etc. wrap the def/class in a `decorated_definition`;
        // unwrap to the inner definition, keeping the class context so a decorated
        // method in a class body still mints as a method.
        const def = node.childForFieldName('definition')
        if (def) visit(def, classCtx)
        return
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

// Go: a `function_declaration` is a free function; a `method_declaration` carries
// a receiver, so its qualname is `Receiver.method` — the terminal name matches the
// runtime `code.function` whether the instrumentation stamps the bare method name
// or a package-qualified `main.(*Server).Handle` (both reduce to `Handle` under
// `terminalName`). The receiver type is read off the receiver parameter, unwrapping
// a `*T` pointer and a `T[U]` generic to the base `type_identifier`. Go has no
// classes; struct types are not symbols in this rung (mirrors the JS/TS scope of
// callable-and-class definitions, without a Go analog for the class).
function goReceiverType(node: Parser.SyntaxNode): string | undefined {
  const receiver = node.childForFieldName('receiver')
  if (!receiver) return undefined
  for (let i = 0; i < receiver.namedChildCount; i++) {
    const param = receiver.namedChild(i)
    if (param?.type !== 'parameter_declaration') continue
    let typeNode = param.childForFieldName('type')
    if (typeNode?.type === 'pointer_type') typeNode = typeNode.namedChild(0) ?? typeNode
    if (typeNode?.type === 'generic_type') {
      typeNode = typeNode.childForFieldName('type') ?? typeNode.namedChild(0) ?? typeNode
    }
    if (typeNode?.type === 'type_identifier') return typeNode.text
    return typeNode?.text
  }
  return undefined
}

export function collectGoSymbolDefs(root: Parser.SyntaxNode): SymbolDef[] {
  const out: SymbolDef[] = []

  const push = (kind: SymbolKind, qualname: string, node: Parser.SyntaxNode): void => {
    out.push({
      kind,
      qualname,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    })
  }

  const visit = (node: Parser.SyntaxNode): void => {
    switch (node.type) {
      case 'function_declaration': {
        const name = node.childForFieldName('name')?.text
        if (name) push('function', name, node)
        break
      }
      case 'method_declaration': {
        const name = node.childForFieldName('name')?.text
        if (name) {
          const recv = goReceiverType(node)
          push('method', recv ? `${recv}.${name}` : name, node)
        }
        break
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

// Ruby: `method` is an instance method, `singleton_method` a class method
// (`def self.x`), `class` a class, `module` a namespace. A `method` / `singleton_method`
// inside a class or module body is a method (an instance `initialize` the
// constructor, its qualname `Class.initialize` so the terminal name still matches
// the runtime `code.function`); a top-level `def` is a plain function. Method-ness
// comes from direct class/module-body membership, not ambient scope — a `def`
// nested in a method is a function, mirroring the Python and JS/TS walkers where
// the node type and its owner decide. Ruby writes a method as `Class#method` and a
// namespace with `::` (`Shop::OrderMailer`); the qualname joins the nesting with a
// plain `.` so it reduces under `terminalName` (last-`.` split) to the bare method
// name — a runtime `OrderMailer#deliver` or a bare `deliver` both land via the
// line-in-span primary, and the bare form also matches the `code.function`
// tiebreaker. A class/module declared with a `::` scope-resolution name
// (`class Shop::OrderMailer`) is normalized to the same dotted form.
export function collectRubySymbolDefs(root: Parser.SyntaxNode): SymbolDef[] {
  const out: SymbolDef[] = []

  const push = (kind: SymbolKind, qualname: string, node: Parser.SyntaxNode): void => {
    out.push({
      kind,
      qualname,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    })
  }

  // The declared name of a class/module, dot-joined so a `Shop::OrderMailer`
  // scope-resolution name reduces cleanly under `terminalName`.
  const nameText = (node: Parser.SyntaxNode): string | undefined =>
    node.childForFieldName('name')?.text.replace(/::/g, '.')

  const walkBody = (node: Parser.SyntaxNode, ctx: string | undefined): void => {
    const body = node.childForFieldName('body')
    if (!body) return
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i)
      if (child) visit(child, ctx)
    }
  }

  const visit = (node: Parser.SyntaxNode, classCtx: string | undefined): void => {
    switch (node.type) {
      case 'method':
      case 'singleton_method': {
        const name = node.childForFieldName('name')?.text
        if (name) {
          if (classCtx) {
            const kind: SymbolKind =
              node.type === 'method' && name === 'initialize' ? 'constructor' : 'method'
            push(kind, `${classCtx}.${name}`, node)
          } else {
            push('function', name, node)
          }
        }
        // The body is walked with no class context: a `def` inside this method is a
        // plain function, never a method of the enclosing class.
        walkBody(node, undefined)
        return
      }
      case 'class':
      case 'module': {
        const name = nameText(node)
        if (name) push('class', classCtx ? `${classCtx}.${name}` : name, node)
        walkBody(node, name ? (classCtx ? `${classCtx}.${name}` : name) : classCtx)
        return
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

// Dispatch to the walker that reads the file's language. `.py`, `.go`, and `.rb`
// map to their own definition node types; every other mapped extension is JS/TS
// and rides the shared walker.
export function collectSymbolDefsForExt(ext: string, root: Parser.SyntaxNode): SymbolDef[] {
  switch (ext) {
    case '.py':
      return collectPythonSymbolDefs(root)
    case '.go':
      return collectGoSymbolDefs(root)
    case '.rb':
      return collectRubySymbolDefs(root)
    default:
      return collectSymbolDefs(root)
  }
}

// Same-named siblings in one file (overloads, repeated anonymous-arrow names)
// get an ordinal disambiguator in source order so the id stays collision-free
// without inventing a name (ADR-158). A qualname that appears once keeps the
// clean, disambiguator-free id.
export function disambiguate(defs: SymbolDef[]): { def: SymbolDef; disambiguator?: number }[] {
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
    const grammar = SYMBOL_GRAMMAR_BY_EXT[ext]
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
      const ext = path.extname(file.path)
      const parser = parserForExt(ext)
      if (!parser) continue
      const relPath = toPosix(path.relative(service.dir, file.path))

      let defs: SymbolDef[]
      try {
        const tree = parseSource(parser, file.content)
        defs = collectSymbolDefsForExt(ext, tree.rootNode)
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
