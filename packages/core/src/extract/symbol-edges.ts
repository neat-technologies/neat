import path from 'node:path'
import Parser from 'tree-sitter'
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
import { loadSourceFiles, snippet, toPosix } from './calls/shared.js'
import {
  GRAMMAR_BY_EXT,
  collectSymbolDefs,
  disambiguate,
  parseSource,
} from './symbols.js'
import { loadTsPathConfig, resolveJsImport, type TsPathConfig } from './imports.js'

// Static symbol *edges* (ADR-158 §3, Phase 2). Builds on the Phase-1 SymbolNode
// inventory: for every class it mints `INHERITS` / `IMPLEMENTS` from the parsed
// heritage clause, and for every call expression a symbol→symbol `CALLS` from the
// enclosing caller symbol to the callee — but only the confident ones. The
// load-bearing discipline (ADR-158 §3, file-awareness.md §6): an edge is emitted
// only when its target resolves to exactly one known SymbolNode without guessing —
// a same-file definition, or an imported binding resolved through the import graph
// to the exact exported symbol. A callee that needs a type or a runtime value to
// resolve (method dispatch on a receiver, a dynamic/computed call, an unresolvable
// or re-exported import, a default/namespace import) is left unclaimed rather than
// fuzzy-matched. A guessed symbol edge poisons the determinism the graph sells.
//
// Runs after `addSymbols` (the inventory it resolves against) and `addImports`
// (so the import graph is in place), reusing the same tree-sitter grammars and
// the `resolveJsImport` specifier→file resolver rather than reimplementing them.
// JS/TS only, matching Phase-1 node grain; Python/Go heritage and calls are a
// follow-on rung. Every edge grades EXTRACTED with `evidence.file`/`line` pinned
// to the real heritage clause / call site (never fabricated, §6).

// A Phase-1 symbol as this producer needs it: the id plus the definition span it
// was minted with, so a call line can be attributed to its enclosing symbol.
interface LocalSymbol {
  sid: string
  qualname: string
  kind: SymbolKind
  startLine: number
  endLine: number
}

// A named import binding resolved to the intra-service file that defines it and
// the exported name to match there. `import { Base } from './base'` →
// `Base → { targetRelPath: 'base.ts', importedName: 'Base' }`; an alias keeps the
// source-declared export name (`import { Shape as S }` → `S → …importedName:'Shape'`).
interface ResolvedImport {
  targetRelPath: string
  importedName: string
}

// The bare superclass name of a class's heritage, when it is a plain identifier
// this producer can resolve — handling both grammar shapes: the TS grammar wraps
// the superclass in an `extends_clause` (its `value` field), the JS grammar puts
// the identifier directly under `class_heritage`. A qualified superclass
// (`mod.Base`, a mixin call `mixin(Base)`) is not a bare identifier, so it returns
// null and no INHERITS edge is guessed.
function extendsInfo(
  classHeritage: Parser.SyntaxNode,
): { name: string; line: number } | null {
  for (let i = 0; i < classHeritage.namedChildCount; i++) {
    const child = classHeritage.namedChild(i)
    if (!child) continue
    if (child.type === 'extends_clause') {
      const value = child.childForFieldName('value')
      if (value && value.type === 'identifier') {
        return { name: value.text, line: value.startPosition.row + 1 }
      }
      return null
    }
    // JS grammar: the superclass identifier hangs directly off class_heritage.
    if (child.type === 'identifier') {
      return { name: child.text, line: child.startPosition.row + 1 }
    }
  }
  return null
}

// The bare implemented-type names of a class's `implements` clause (TS only).
// Each entry is a `type_identifier` (`implements Shape`) or a `generic_type`
// (`implements Comparable<number>`); a qualified `nested_type_identifier`
// (`ns.Shape`) is skipped rather than guessed. Note: an interface is not a
// SymbolNode (ADR-158 §2 fixes the kind set to function/method/constructor/class),
// so an IMPLEMENTS edge lands only when the implemented name resolves to a known
// *class* symbol (TS permits `implements <class>`); an `implements <interface>`
// resolves to nothing and emits no edge, honestly, until interface symbols exist.
function implementsInfo(
  classHeritage: Parser.SyntaxNode,
): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = []
  for (let i = 0; i < classHeritage.namedChildCount; i++) {
    const clause = classHeritage.namedChild(i)
    if (!clause || clause.type !== 'implements_clause') continue
    for (let j = 0; j < clause.namedChildCount; j++) {
      const t = clause.namedChild(j)
      if (!t) continue
      if (t.type === 'type_identifier') {
        out.push({ name: t.text, line: t.startPosition.row + 1 })
      } else if (t.type === 'generic_type') {
        const nameNode = t.childForFieldName('name')
        if (nameNode && nameNode.type === 'type_identifier') {
          out.push({ name: nameNode.text, line: nameNode.startPosition.row + 1 })
        }
      }
    }
  }
  return out
}

// Collect the ES-import bindings of a file: local name → { specifier, importedName }.
// Only named imports (including `as`-aliased) are collected — the binding names the
// exported symbol exactly. Default imports (`import X from`) and namespace imports
// (`import * as ns`) are skipped: resolving the former needs the target's
// export-default declaration and the latter is member access, both deferred rather
// than guessed. CommonJS `require` destructuring is likewise out of this slice.
function collectImportBindings(
  root: Parser.SyntaxNode,
): Map<string, { specifier: string; importedName: string }> {
  const out = new Map<string, { specifier: string; importedName: string }>()
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === 'import_statement') {
      const source = node.childForFieldName('source')
      const specifier = source ? stringInner(source) : null
      if (specifier) {
        for (let i = 0; i < node.namedChildCount; i++) {
          const clause = node.namedChild(i)
          if (clause?.type === 'import_clause') collectClause(clause, specifier, out)
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

function collectClause(
  clause: Parser.SyntaxNode,
  specifier: string,
  out: Map<string, { specifier: string; importedName: string }>,
): void {
  for (let i = 0; i < clause.namedChildCount; i++) {
    const child = clause.namedChild(i)
    if (!child) continue
    if (child.type === 'named_imports') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const spec = child.namedChild(j)
        if (spec?.type !== 'import_specifier') continue
        const nameNode = spec.childForFieldName('name')
        const aliasNode = spec.childForFieldName('alias')
        if (!nameNode) continue
        const importedName = nameNode.text
        const localName = aliasNode ? aliasNode.text : importedName
        out.set(localName, { specifier, importedName })
      }
    }
    // `identifier` (default import) and `namespace_import` are intentionally
    // skipped — see collectImportBindings.
  }
}

// The interior text of a string literal node (its `string_fragment` child), or a
// quote-stripped fallback. Mirrors imports.ts's `stringLiteralText`.
function stringInner(node: Parser.SyntaxNode): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child?.type === 'string_fragment') return child.text
  }
  const raw = node.text
  return raw.length >= 2 ? raw.slice(1, -1) : null
}

// A heritage or call edge to emit once its target resolves.
interface EdgeRequest {
  sourceSid: string
  targetName: string
  wantKind: SymbolKind
  edgeType: typeof EdgeType.INHERITS | typeof EdgeType.IMPLEMENTS | typeof EdgeType.CALLS
  line: number
}

export async function addSymbolEdges(
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

  let edgesAdded = 0

  for (const service of services) {
    const serviceName = service.pkg.name
    const tsPaths: TsPathConfig | null = await loadTsPathConfig(service.dir)
    const files = await loadSourceFiles(service.dir, service.excludeDirs)

    for (const file of files) {
      const parser = parserForExt(path.extname(file.path))
      if (!parser) continue
      const relPath = toPosix(path.relative(service.dir, file.path))
      const fileDir = path.dirname(file.path)

      let root: Parser.SyntaxNode
      try {
        root = parseSource(parser, file.content).rootNode
      } catch (err) {
        recordExtractionError('symbol edge extraction', file.path, err)
        continue
      }

      // Rebuild this file's symbol table (spans + ids) from the same collector
      // the node producer used, so ids and spans line up exactly.
      const disambiguated = disambiguate(collectSymbolDefs(root))
      const locals: LocalSymbol[] = disambiguated.map(({ def, disambiguator }) => ({
        sid: symbolId(serviceName, relPath, def.qualname, disambiguator),
        qualname: def.qualname,
        kind: def.kind,
        startLine: def.startLine,
        endLine: def.endLine,
      }))
      if (locals.length === 0) continue

      // A bare (dot-free) qualname that appears exactly once in the file — the
      // clean, disambiguator-free id. Same-name siblings (overloads, a module and
      // a nested definition sharing a name) are all disambiguated, so none lands
      // here: existence in this map *is* the "resolves to exactly one" test.
      const uniqueByBareName = new Map<string, LocalSymbol>()
      for (const { def, disambiguator } of disambiguated) {
        if (disambiguator !== undefined) continue
        if (def.qualname.includes('.')) continue // a method, not a callable bare name
        const local = locals.find((l) => l.qualname === def.qualname && l.startLine === def.startLine)
        if (local) uniqueByBareName.set(def.qualname, local)
      }

      // The symbol a definition span identifies exactly (used to find a class's own
      // node from its class_declaration span).
      const localBySpan = new Map<string, LocalSymbol>()
      for (const l of locals) localBySpan.set(`${l.startLine}:${l.endLine}`, l)

      // Resolve every named-import binding's specifier to its intra-service file
      // once, so target resolution during the walk stays a pure map lookup.
      const bindings = collectImportBindings(root)
      const resolvedImports = new Map<string, ResolvedImport>()
      for (const [localName, binding] of bindings) {
        const targetRelPath = await resolveJsImport(binding.specifier, fileDir, service.dir, tsPaths)
        if (targetRelPath) {
          resolvedImports.set(localName, { targetRelPath, importedName: binding.importedName })
        }
      }

      // Resolve a used name to exactly one SymbolNode of the wanted kind, or null.
      // Same-file first (a unique bare definition), then a resolved named import
      // whose exported symbol exists in the target file at the wanted kind.
      const resolveTarget = (name: string, wantKind: SymbolKind): string | null => {
        const local = uniqueByBareName.get(name)
        if (local) return local.kind === wantKind ? local.sid : null

        const imp = resolvedImports.get(name)
        if (imp) {
          const candidate = symbolId(serviceName, imp.targetRelPath, imp.importedName)
          if (graph.hasNode(candidate)) {
            const node = graph.getNodeAttributes(candidate) as SymbolNode
            if (node.type === NodeType.SymbolNode && node.kind === wantKind) return candidate
          }
        }
        return null
      }

      // Innermost symbol whose span contains `line` — the enclosing caller of a
      // call site. Smallest containing span wins (a call inside a method belongs to
      // the method, not the class), matching ingest's observed-landing choice.
      const enclosingSymbol = (line: number): LocalSymbol | null => {
        let best: LocalSymbol | null = null
        for (const l of locals) {
          if (line < l.startLine || line > l.endLine) continue
          if (!best || l.endLine - l.startLine < best.endLine - best.startLine) best = l
        }
        return best
      }

      // Walk once, collecting the confident edge requests.
      const requests: EdgeRequest[] = []
      const walk = (node: Parser.SyntaxNode): void => {
        if (
          node.type === 'class_declaration' ||
          node.type === 'abstract_class_declaration' ||
          node.type === 'class'
        ) {
          const self = localBySpan.get(`${node.startPosition.row + 1}:${node.endPosition.row + 1}`)
          if (self && self.kind === 'class') {
            for (let i = 0; i < node.namedChildCount; i++) {
              const child = node.namedChild(i)
              if (!child || child.type !== 'class_heritage') continue
              const ext = extendsInfo(child)
              if (ext) {
                requests.push({
                  sourceSid: self.sid,
                  targetName: ext.name,
                  wantKind: 'class',
                  edgeType: EdgeType.INHERITS,
                  line: ext.line,
                })
              }
              for (const impl of implementsInfo(child)) {
                requests.push({
                  sourceSid: self.sid,
                  targetName: impl.name,
                  wantKind: 'class',
                  edgeType: EdgeType.IMPLEMENTS,
                  line: impl.line,
                })
              }
            }
          }
        } else if (node.type === 'call_expression') {
          const fn = node.childForFieldName('function')
          // Only a bare identifier callee is resolvable without a receiver type —
          // `obj.foo()` (member_expression), `arr[k]()` (subscript), and dynamic
          // callees are left to observed / SCIP (ADR-158 §3).
          if (fn && fn.type === 'identifier') {
            const line = node.startPosition.row + 1
            const caller = enclosingSymbol(line)
            if (caller) {
              requests.push({
                sourceSid: caller.sid,
                targetName: fn.text,
                wantKind: 'function',
                edgeType: EdgeType.CALLS,
                line,
              })
            }
          }
        }
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i)
          if (child) walk(child)
        }
      }
      walk(root)

      for (const req of requests) {
        const targetSid = resolveTarget(req.targetName, req.wantKind)
        if (!targetSid) continue
        if (targetSid === req.sourceSid) continue // no self-loop (recursion / self-reference)

        const edgeId = extractedEdgeId(req.sourceSid, targetSid, req.edgeType)
        if (graph.hasEdge(edgeId)) continue
        const edge: GraphEdge = {
          id: edgeId,
          source: req.sourceSid,
          target: targetSid,
          type: req.edgeType,
          provenance: Provenance.EXTRACTED,
          confidence: confidenceForExtracted('structural'),
          evidence: {
            file: relPath,
            line: req.line,
            snippet: snippet(file.content, req.line),
          },
        }
        graph.addEdgeWithKey(edgeId, req.sourceSid, targetSid, edge)
        edgesAdded++
      }
    }
  }

  return { nodesAdded: 0, edgesAdded }
}
