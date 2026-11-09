import path from 'node:path'
import type Parser from 'tree-sitter'
import type { GraphEdge, SymbolKind } from '@neat.is/types'
import { EdgeType, Provenance, confidenceForExtracted, dependencySymbolId, extractedEdgeId } from '@neat.is/types'
import { snippet } from '../calls/shared.js'
import { collectSymbolDefs, disambiguate, parseSource } from '../symbols.js'
import { symbolEdgeParserFor } from '../symbol-edges.js'
import { DEFAULT_EXPORT, isEsmExports, PackageExports } from './exports.js'
import { resolveInPackage } from './resolve.js'
import type { DependencyRef } from './extract.js'

// Calls between a package's own modules through `require` and default or
// namespace imports (dependency-inventory.md §5): the CommonJS shape most npm
// packages use, which the named-import resolution in symbol-edges.ts doesn't
// cover. `const u = require('./utils'); u.merge()`, `const Range =
// require('../classes/range'); new Range()`, `import parse from './parse'`. The
// callee is resolved through the package's own export tables; a call with no
// enclosing symbol, or one on a value rather than a binding, stays unresolved.

interface ModuleBinding {
  file: string
  // `whole`: the module value. Otherwise the export taken.
  name: string | 'whole'
}

function relativeRequire(node: Parser.SyntaxNode | null): { specifier: string; name: string | 'whole' } | null {
  if (!node) return null
  let name: string | 'whole' = 'whole'
  let call = node
  if (node.type === 'member_expression') {
    const prop = node.childForFieldName('property')
    const obj = node.childForFieldName('object')
    if (!prop || !obj) return null
    name = prop.text
    call = obj
  }
  if (call.type !== 'call_expression' || call.childForFieldName('function')?.text !== 'require') return null
  const arg = call.childForFieldName('arguments')?.namedChild(0)
  if (arg?.type !== 'string') return null
  const specifier = arg.text.slice(1, -1)
  return specifier.startsWith('./') || specifier.startsWith('../') ? { specifier, name } : null
}

function moduleBindings(root: Parser.SyntaxNode, relPath: string, paths: ReadonlySet<string>): Map<string, ModuleBinding> {
  const out = new Map<string, ModuleBinding>()
  const bind = (local: string, specifier: string, name: string | 'whole') => {
    const file = resolveInPackage(paths, specifier, relPath)
    if (file) out.set(local, { file, name })
  }
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === 'import_statement') {
      const src = node.childForFieldName('source')
      const specifier = src?.type === 'string' ? src.text.slice(1, -1) : null
      if (!specifier || /^import\s+type[\s{]/.test(node.text)) return
      for (const clause of node.namedChildren) {
        if (clause.type !== 'import_clause') continue
        for (const part of clause.namedChildren) {
          // Named imports are symbol-edges.ts's; default and namespace are here.
          if (part.type === 'identifier') bind(part.text, specifier, DEFAULT_EXPORT)
          else if (part.type === 'namespace_import') {
            const id = part.namedChildren.find((c) => c.type === 'identifier')
            if (id) bind(id.text, specifier, 'whole')
          }
        }
      }
      return
    }
    if (node.type === 'variable_declarator') {
      const req = relativeRequire(node.childForFieldName('value'))
      const target = node.childForFieldName('name')
      if (req && target?.type === 'identifier') bind(target.text, req.specifier, req.name)
      else if (req && req.name === 'whole' && target?.type === 'object_pattern') {
        for (const p of target.namedChildren) {
          if (p.type === 'shorthand_property_identifier_pattern') bind(p.text, req.specifier, p.text)
          else if (p.type === 'pair_pattern') {
            const key = p.childForFieldName('key')
            const value = p.childForFieldName('value')
            if (key && value?.type === 'identifier') bind(value.text, req.specifier, key.text)
          }
        }
      }
    }
    for (const c of node.namedChildren) visit(c)
  }
  visit(root)
  return out
}

/** A package's calls between its own modules through require / default / namespace bindings. Pure. */
export function internalModuleCalls(
  dep: DependencyRef,
  files: Map<string, string>,
  kinds: ReadonlyMap<string, SymbolKind>,
  exportsOf: PackageExports = new PackageExports(null, files),
): GraphEdge[] {
  const paths = new Set(files.keys())
  const idOf = (file: string, qualname: string, d?: number) =>
    dependencySymbolId(dep.ecosystem, dep.name, dep.version, file, qualname, d)
  const out: GraphEdge[] = []
  const seen = new Set<string>()

  for (const relPath of [...paths].sort()) {
    const parser = symbolEdgeParserFor(path.posix.extname(relPath))
    if (!parser) continue
    const content = files.get(relPath)!
    const root = parseSource(parser, content).rootNode
    const bindings = moduleBindings(root, relPath, paths)
    if (bindings.size === 0) continue
    const defs = disambiguate(collectSymbolDefs(root))
    const callerAt = (line: number): string | null => {
      let best: (typeof defs)[number] | null = null
      for (const d of defs) {
        if (line < d.def.startLine || line > d.def.endLine) continue
        if (!best || d.def.endLine - d.def.startLine < best.def.endLine - best.def.startLine) best = d
      }
      return best ? idOf(relPath, best.def.qualname, best.disambiguator) : null
    }

    const walk = (node: Parser.SyntaxNode): void => {
      const isCall = node.type === 'call_expression'
      const isNew = node.type === 'new_expression'
      if (isCall || isNew) {
        const callee = node.childForFieldName(isCall ? 'function' : 'constructor')
        let local: string | null = null
        let member: string | null = null
        if (callee?.type === 'identifier') local = callee.text
        else if (callee?.type === 'member_expression') {
          const obj = callee.childForFieldName('object')
          const prop = callee.childForFieldName('property')
          if (obj?.type === 'identifier' && prop?.type === 'property_identifier') {
            local = obj.text
            member = prop.text
          }
        }
        const b = local ? bindings.get(local) : undefined
        if (b) {
          const table = exportsOf.ofFile(b.file, 0)
          let exportName: string | null = null
          if (member === null) exportName = b.name === 'whole' ? DEFAULT_EXPORT : b.name
          else if (b.name === 'whole') exportName = member
          else if (b.name === DEFAULT_EXPORT && !isEsmExports(table)) exportName = member
          const target = exportName ? table.get(exportName) : undefined
          const line = node.startPosition.row + 1
          const caller = target ? callerAt(line) : null
          if (target && caller) {
            const sid = idOf(target.file, target.qualname, target.disambiguator)
            const kind = kinds.get(sid)
            const want: SymbolKind[] = isNew ? ['class', 'constructor'] : ['function', 'method', 'class', 'constructor']
            const id = extractedEdgeId(caller, sid, EdgeType.CALLS)
            if (kind && want.includes(kind) && sid !== caller && !seen.has(id)) {
              seen.add(id)
              out.push({
                id,
                source: caller,
                target: sid,
                type: EdgeType.CALLS,
                provenance: Provenance.EXTRACTED,
                confidence: confidenceForExtracted('structural'),
                evidence: { file: relPath, line, snippet: snippet(content, line) },
              })
            }
          }
        }
      }
      for (const c of node.namedChildren) walk(c)
    }
    walk(root)
  }
  return out
}
