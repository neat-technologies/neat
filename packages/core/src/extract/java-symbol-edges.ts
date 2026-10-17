import path from 'node:path'
import Parser from 'tree-sitter'
import type { GraphEdge } from '@neat.is/types'
import { EdgeType, Provenance, confidenceForExtracted, extractedEdgeId, symbolId } from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import type { DiscoveredService } from './shared.js'
import { recordExtractionError } from './errors.js'
import { loadSourceFiles, snippet, toPosix } from './calls/shared.js'
import { SYMBOL_GRAMMAR_BY_EXT, collectJavaSymbolDefs, disambiguate, parseSource } from './symbols.js'

// Static Java symbol edges — the Java rung of ADR-158 §3, beside go-symbol-edges.ts
// and holding its precision rule: a CALLS edge only where the callee resolves to
// exactly one same-file method SymbolNode, never a guess.
//
// Two call shapes resolve:
//   - an unqualified call or `this.m(…)`: the callee is a method of the innermost
//     named class around the call site, so it resolves when that class declares
//     exactly one method of that name;
//   - `Type.m(…)` where `Type` is a class declared in the same file: one method of
//     that name in that class.
// Left unclaimed: an overloaded name (two declarations, which the call's argument
// types would have to pick between), a name the class doesn't declare (inherited,
// an outer class's, or a static import), a call inside an anonymous or local class
// (its own methods would shadow the enclosing class's), and every call on a field,
// local or parameter (`orderService.create(…)`), which needs the receiver's type
// and, through an interface, the implementation. One case the rule can't see: a
// superclass declaring an overload of the same name, which an unqualified call
// could bind to instead; the class hierarchy isn't read here. Runs after `addSymbols`, reusing
// its collector so ids and spans match the minted SymbolNodes exactly.

interface Def {
  sid: string
  qualname: string
  kind: string
  startIndex: number
  ambiguous: boolean
}

const TYPE_DECLS = new Set(['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'])

export async function addJavaSymbolEdges(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  const grammar = SYMBOL_GRAMMAR_BY_EXT['.java']
  if (!grammar) return { nodesAdded: 0, edgesAdded: 0 }
  const parser = new Parser()
  parser.setLanguage(grammar)
  let edgesAdded = 0

  for (const service of services) {
    if (service.node.language !== 'java') continue
    const files = await loadSourceFiles(service.dir, service.excludeDirs)
    for (const file of files) {
      if (path.extname(file.path) !== '.java') continue
      const relPath = toPosix(path.relative(service.dir, file.path))
      let root: Parser.SyntaxNode
      try {
        root = parseSource(parser, file.content).rootNode
      } catch (err) {
        recordExtractionError('java symbol edge extraction', file.path, err)
        continue
      }

      const defs: Def[] = disambiguate(collectJavaSymbolDefs(root)).map(({ def, disambiguator }) => ({
        sid: symbolId(service.pkg.name, relPath, def.qualname, disambiguator),
        qualname: def.qualname,
        kind: def.kind,
        startIndex: def.startIndex,
        ambiguous: disambiguator !== undefined,
      }))
      if (defs.length === 0) continue
      const byStart = new Map<number, Def>()
      for (const d of defs) byStart.set(d.startIndex, d)
      // qualname → its method defs; more than one means overloads.
      const methodsByQualname = new Map<string, Def[]>()
      for (const d of defs) {
        if (d.kind !== 'method') continue
        methodsByQualname.set(d.qualname, [...(methodsByQualname.get(d.qualname) ?? []), d])
      }
      // Simple class name → class qualname, for `Type.m()`; dropped when two
      // same-file classes share a simple name.
      const classBySimple = new Map<string, string | null>()
      for (const d of defs) {
        if (d.kind !== 'class') continue
        const simple = d.qualname.slice(d.qualname.lastIndexOf('.') + 1)
        classBySimple.set(simple, classBySimple.has(simple) ? null : d.qualname)
      }

      const uniqueMethod = (classQual: string, name: string): Def | null => {
        const found = methodsByQualname.get(`${classQual}.${name}`)
        return found && found.length === 1 && !found[0]!.ambiguous ? found[0]! : null
      }

      // The caller (innermost method/constructor) and the innermost named class,
      // or null when an anonymous or local class sits in between.
      const context = (call: Parser.SyntaxNode): { caller: Def; classQual: string } | null => {
        let caller: Def | null = null
        for (let n = call.parent; n; n = n.parent) {
          if (n.type === 'class_body' && n.parent?.type === 'object_creation_expression') return null
          if (!caller && (n.type === 'method_declaration' || n.type === 'constructor_declaration')) {
            caller = byStart.get(n.startIndex) ?? null
            if (!caller) return null
          }
          if (TYPE_DECLS.has(n.type)) {
            const cls = byStart.get(n.startIndex)
            if (!caller || !cls || cls.kind !== 'class') return null
            return { caller, classQual: cls.qualname }
          }
        }
        return null
      }

      const visit = (node: Parser.SyntaxNode): void => {
        if (node.type === 'method_invocation') {
          const name = node.childForFieldName('name')?.text
          const obj = node.childForFieldName('object')
          const ctx = name ? context(node) : null
          let target: Def | null = null
          if (ctx && name) {
            if (!obj || obj.type === 'this') target = uniqueMethod(ctx.classQual, name)
            else if (obj.type === 'identifier') {
              const cls = classBySimple.get(obj.text)
              if (cls) target = uniqueMethod(cls, name)
            }
          }
          if (ctx && target && ctx.caller.sid !== target.sid) {
            const line = node.startPosition.row + 1
            const edgeId = extractedEdgeId(ctx.caller.sid, target.sid, EdgeType.CALLS)
            if (!graph.hasEdge(edgeId) && graph.hasNode(ctx.caller.sid) && graph.hasNode(target.sid)) {
              const edge: GraphEdge = {
                id: edgeId,
                source: ctx.caller.sid,
                target: target.sid,
                type: EdgeType.CALLS,
                provenance: Provenance.EXTRACTED,
                confidence: confidenceForExtracted('structural'),
                evidence: { file: relPath, line, snippet: snippet(file.content, line) },
              }
              graph.addEdgeWithKey(edgeId, ctx.caller.sid, target.sid, edge)
              edgesAdded++
            }
          }
        }
        for (const c of node.namedChildren) visit(c)
      }
      visit(root)
    }
  }
  return { nodesAdded: 0, edgesAdded }
}
