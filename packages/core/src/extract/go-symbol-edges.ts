import path from 'node:path'
import Parser from 'tree-sitter'
import type { GraphEdge, SymbolKind } from '@neat.is/types'
import {
  EdgeType,
  Provenance,
  confidenceForExtracted,
  extractedEdgeId,
  symbolId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import type { DiscoveredService } from './shared.js'
import { recordExtractionError } from './errors.js'
import { loadSourceFiles, snippet, toPosix } from './calls/shared.js'
import { SYMBOL_GRAMMAR_BY_EXT, collectGoSymbolDefs, disambiguate, parseSource } from './symbols.js'

// Static Go symbol *edges* — the "Python/Go calls" follow-on rung `symbol-edges.ts`
// names (ADR-158 §3). symbol-edges.ts mints JS/TS symbol→symbol CALLS; Go can't ride
// it (its AST node types differ and it has no ES-import resolver), so Go gets its own
// producer here holding the SAME precision discipline: a CALLS edge is emitted only
// when the callee is a bare identifier resolving to exactly one known same-file
// top-level function SymbolNode. A method/selector call (`s.Render()`, `fmt.Println()`),
// a builtin (`len`, `make` — an identifier resolving to no in-file symbol), a
// package-qualified call, and a same-package call to a function defined in another
// file are all left unclaimed rather than guessed — a guessed symbol edge poisons the
// determinism the graph sells (file-awareness.md §6).
//
// Deferred to later rungs, deliberately: same-package cross-file resolution (Go has no
// per-file import map naming the exact callee the way `resolveJsImport` does, so it
// needs a package symbol index), cross-package resolution, and method-dispatch edges
// (which need receiver typing). Runs after `addSymbols`, reusing `collectGoSymbolDefs`
// so ids and spans line up exactly with the SymbolNodes that producer minted. Every
// edge grades EXTRACTED with evidence.file/line pinned to the real call site.

// A Phase-1 Go symbol as this producer needs it: the id plus the definition span it
// was minted with, so a call line can be attributed to its enclosing symbol.
interface LocalSymbol {
  sid: string
  qualname: string
  kind: SymbolKind
  startLine: number
  endLine: number
}

export async function addGoSymbolEdges(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  const grammar = SYMBOL_GRAMMAR_BY_EXT['.go']
  if (!grammar) return { nodesAdded: 0, edgesAdded: 0 }
  const parser = new Parser()
  parser.setLanguage(grammar)

  let edgesAdded = 0

  for (const service of services) {
    const serviceName = service.pkg.name
    const files = await loadSourceFiles(service.dir, service.excludeDirs)

    for (const file of files) {
      if (path.extname(file.path) !== '.go') continue
      const relPath = toPosix(path.relative(service.dir, file.path))

      let root: Parser.SyntaxNode
      try {
        root = parseSource(parser, file.content).rootNode
      } catch (err) {
        recordExtractionError('go symbol edge extraction', file.path, err)
        continue
      }

      // Rebuild this file's symbol inventory from the same collector the node
      // producer used, so ids and spans match the minted SymbolNodes exactly.
      const disambiguated = disambiguate(collectGoSymbolDefs(root))
      const locals: LocalSymbol[] = disambiguated.map(({ def, disambiguator }) => ({
        sid: symbolId(serviceName, relPath, def.qualname, disambiguator),
        qualname: def.qualname,
        kind: def.kind,
        startLine: def.startLine,
        endLine: def.endLine,
      }))
      if (locals.length === 0) continue

      // A bare (dot-free) function name that appears exactly once in the file — the
      // clean, disambiguator-free id. A method qualname (`Receiver.method`) carries a
      // dot and is excluded: a Go method is only ever reached through a selector
      // (`s.Render()`), never a bare-identifier callee. Existence in this map IS the
      // "resolves to exactly one same-file function" test (Go forbids two top-level
      // funcs sharing a name, so a bare function name is unique by the language rule).
      const uniqueFnByName = new Map<string, LocalSymbol>()
      for (const { def, disambiguator } of disambiguated) {
        if (disambiguator !== undefined) continue
        if (def.kind !== 'function') continue
        if (def.qualname.includes('.')) continue
        const local = locals.find(
          (l) => l.qualname === def.qualname && l.startLine === def.startLine,
        )
        if (local) uniqueFnByName.set(def.qualname, local)
      }

      // Innermost symbol whose span contains `line` — the enclosing caller of a call
      // site; smallest containing span wins (a call inside a method belongs to the
      // method), matching ingest's observed-landing choice.
      const enclosingSymbol = (line: number): LocalSymbol | null => {
        let best: LocalSymbol | null = null
        for (const l of locals) {
          if (line < l.startLine || line > l.endLine) continue
          if (!best || l.endLine - l.startLine < best.endLine - best.startLine) best = l
        }
        return best
      }

      // Walk once, minting a CALLS for each confident bare-function call site.
      const walk = (node: Parser.SyntaxNode): void => {
        if (node.type === 'call_expression') {
          const fn = node.childForFieldName('function')
          // Only a bare identifier callee is a same-file free-function call. A
          // `selector_expression` callee (`s.Render()`, `fmt.Println()`) needs a
          // receiver type or a package to resolve and is left to observed / a later rung.
          if (fn && fn.type === 'identifier') {
            const line = node.startPosition.row + 1
            const caller = enclosingSymbol(line)
            const target = uniqueFnByName.get(fn.text)
            if (caller && target && caller.sid !== target.sid) {
              const edgeId = extractedEdgeId(caller.sid, target.sid, EdgeType.CALLS)
              if (!graph.hasEdge(edgeId)) {
                const edge: GraphEdge = {
                  id: edgeId,
                  source: caller.sid,
                  target: target.sid,
                  type: EdgeType.CALLS,
                  provenance: Provenance.EXTRACTED,
                  confidence: confidenceForExtracted('structural'),
                  evidence: {
                    file: relPath,
                    line,
                    snippet: snippet(file.content, line),
                  },
                }
                graph.addEdgeWithKey(edgeId, caller.sid, target.sid, edge)
                edgesAdded++
              }
            }
          }
        }
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i)
          if (child) walk(child)
        }
      }
      walk(root)
    }
  }

  return { nodesAdded: 0, edgesAdded }
}
