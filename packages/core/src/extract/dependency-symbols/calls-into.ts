import path from 'node:path'
import type Parser from 'tree-sitter'
import type { DependencyNode, GraphEdge, GraphNode, SymbolKind } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  dependencySymbolId,
  extractedEdgeId,
  fileId,
  isDependencySymbolId,
  symbolId,
} from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { isTestPath, type DiscoveredService } from '../shared.js'
import { recordExtractionError } from '../errors.js'
import { loadSourceFiles, snippet, toPosix } from '../calls/shared.js'
import { collectSymbolDefs, disambiguate, parseSource } from '../symbols.js'
import { symbolEdgeParserFor } from '../symbol-edges.js'
import { DEFAULT_EXPORT, isEsmExports, type ExportTarget, type PackageExports } from './exports.js'

// First-party calls into a package's exported symbols (dependency-inventory.md
// §5): the edge that joins a first-party call graph to the package's own. A call
// resolves when its callee is a binding the file imported from the package and
// the package's export table names the symbol: `tpl()` after
// `const tpl = require('lodash/template')`, `qs.parse()` after `import qs from
// 'qs'`, `new Range()` after `import { Range } from 'semver'`. Everything else,
// including a method on a value a call returned, stays unresolved. JS/TS only.

// What a local name was bound to by an import of a package.
interface PackageBinding {
  pkg: string
  subpath: string
  style: 'require' | 'import'
  // `whole`: the module value (`const x = require()`, `import x from`, `import * as`).
  // Otherwise the named export it took.
  name: string | 'whole'
}

// `lodash/template` → { pkg: 'lodash', subpath: 'template' }; scoped names keep
// their scope. Null for relative, absolute and `node:` specifiers.
function splitSpecifier(specifier: string): { pkg: string; subpath: string } | null {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return null
  const parts = specifier.split('/')
  const n = specifier.startsWith('@') ? 2 : 1
  if (parts.length < n || !parts[n - 1]) return null
  return { pkg: parts.slice(0, n).join('/'), subpath: parts.slice(n).join('/') }
}

function stringText(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node || node.type !== 'string') return null
  return node.text.slice(1, -1)
}

// `require('x')` / `require('x').y`: the specifier and the export taken.
function requireOf(node: Parser.SyntaxNode | null): { specifier: string; name: string | 'whole' } | null {
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
  const specifier = stringText(call.childForFieldName('arguments')?.namedChild(0))
  return specifier ? { specifier, name } : null
}

export function collectPackageBindings(root: Parser.SyntaxNode): Map<string, PackageBinding> {
  const out = new Map<string, PackageBinding>()
  const bind = (local: string, specifier: string, name: string | 'whole', style: 'require' | 'import') => {
    const split = splitSpecifier(specifier)
    if (split) out.set(local, { ...split, name, style })
  }
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === 'import_statement') {
      if (/^import\s+type[\s{]/.test(node.text)) return
      const specifier = stringText(node.childForFieldName('source'))
      if (!specifier) return
      for (const clause of node.namedChildren) {
        if (clause.type !== 'import_clause') continue
        for (const part of clause.namedChildren) {
          if (part.type === 'identifier') bind(part.text, specifier, DEFAULT_EXPORT, 'import')
          else if (part.type === 'namespace_import') {
            const id = part.namedChildren.find((c) => c.type === 'identifier')
            if (id) bind(id.text, specifier, 'whole', 'import')
          } else if (part.type === 'named_imports') {
            for (const spec of part.namedChildren) {
              if (spec.type !== 'import_specifier') continue
              const name = spec.childForFieldName('name')
              const alias = spec.childForFieldName('alias')
              if (name) bind((alias ?? name).text, specifier, name.text, 'import')
            }
          }
        }
      }
      return
    }
    if (node.type === 'variable_declarator') {
      const req = requireOf(node.childForFieldName('value'))
      const target = node.childForFieldName('name')
      if (req && target?.type === 'identifier') bind(target.text, req.specifier, req.name, 'require')
      else if (req && req.name === 'whole' && target?.type === 'object_pattern') {
        for (const p of target.namedChildren) {
          if (p.type === 'shorthand_property_identifier_pattern') bind(p.text, req.specifier, p.text, 'require')
          else if (p.type === 'pair_pattern') {
            const key = p.childForFieldName('key')
            const value = p.childForFieldName('value')
            if (key && value?.type === 'identifier') bind(value.text, req.specifier, key.text, 'require')
          }
        }
      }
    }
    for (const c of node.namedChildren) visit(c)
  }
  visit(root)
  return out
}

export interface PackageScope {
  dep: DependencyNode
  exports: PackageExports
  kindOf: (sid: string) => SymbolKind | null
}

/**
 * The CALLS edges from one first-party file into the packages in `scopes`
 * (keyed by package name). Pure over its inputs. The caller is the innermost
 * first-party symbol around the call, or the file itself for a call at module
 * level, which runs on import.
 */
export function callsIntoPackages(
  root: Parser.SyntaxNode,
  service: string,
  relPath: string,
  content: string,
  scopes: Map<string, PackageScope>,
): GraphEdge[] {
  const bindings = collectPackageBindings(root)
  for (const [local, b] of [...bindings]) if (!scopes.has(b.pkg)) bindings.delete(local)
  if (bindings.size === 0) return []

  const defs = disambiguate(collectSymbolDefs(root))
  const callerAt = (line: number): string => {
    let best: (typeof defs)[number] | null = null
    for (const d of defs) {
      if (line < d.def.startLine || line > d.def.endLine) continue
      if (!best || d.def.endLine - d.def.startLine < best.def.endLine - best.def.startLine) best = d
    }
    return best ? symbolId(service, relPath, best.def.qualname, best.disambiguator) : fileId(service, relPath)
  }

  const exportsMemo = new Map<string, Map<string, ExportTarget> | null>()
  const tableFor = (b: PackageBinding) => {
    const key = `${b.pkg}\u0000${b.subpath}\u0000${b.style}`
    if (!exportsMemo.has(key)) exportsMemo.set(key, scopes.get(b.pkg)!.exports.forImport(b.subpath, b.style))
    return exportsMemo.get(key)!
  }
  const resolve = (b: PackageBinding, member: string | null, want: SymbolKind[]): string | null => {
    const table = tableFor(b)
    if (!table) return null
    let exportName: string
    if (member === null) exportName = b.name === 'whole' ? DEFAULT_EXPORT : b.name
    else if (b.name === 'whole') exportName = member
    // A default import of a CommonJS module is its `module.exports`, so a member
    // of it is a named export. On an ESM module it's a property of the default
    // export's value, which isn't resolvable here.
    else if (b.name === DEFAULT_EXPORT && !isEsmExports(table)) exportName = member
    else return null // a member of a named export: a method on a value
    const target = table.get(exportName)
    if (!target) return null
    const dep = scopes.get(b.pkg)!.dep
    const sid = dependencySymbolId(dep.ecosystem, dep.name, dep.version, target.file, target.qualname, target.disambiguator)
    const kind = scopes.get(b.pkg)!.kindOf(sid)
    return kind && want.includes(kind) ? sid : null
  }

  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  const emit = (source: string, target: string, line: number, specifier: string) => {
    const id = extractedEdgeId(source, target, EdgeType.CALLS)
    if (seen.has(id)) return
    seen.add(id)
    edges.push({
      id,
      source,
      target,
      type: EdgeType.CALLS,
      provenance: Provenance.EXTRACTED,
      confidence: confidenceForExtracted('structural'),
      evidence: { file: relPath, line, snippet: snippet(content, line), specifier },
    })
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
        const want: SymbolKind[] = isNew ? ['class', 'constructor'] : ['function', 'method', 'class', 'constructor']
        const target = resolve(b, member, want)
        if (target) {
          const line = node.startPosition.row + 1
          emit(callerAt(line), target, line, b.subpath ? `${b.pkg}/${b.subpath}` : b.pkg)
        }
      }
    }
    for (const c of node.namedChildren) walk(c)
  }
  walk(root)
  return edges
}

/**
 * Write first-party → package CALLS for the packages in `scopes`, replacing this
 * producer's edges from an earlier pass. Files that import none of them are
 * skipped; test files never count (ADR-065 §1).
 */
export async function writeCallsIntoPackages(
  graph: NeatGraph,
  services: DiscoveredService[],
  scopes: Map<string, PackageScope>,
): Promise<{ edgesAdded: number; edgesRemoved: number }> {
  let edgesAdded = 0
  const depIds = new Set([...scopes.values()].map((s) => s.dep.id))

  // This producer's edges: EXTRACTED CALLS from first-party code into these
  // packages' symbols. Kept when minted again, dropped otherwise.
  const stale = new Set<string>()
  graph.forEachEdge((id, attrs, source, target) => {
    const e = attrs as GraphEdge
    if (e.type !== EdgeType.CALLS || e.provenance !== Provenance.EXTRACTED) return
    if (!isDependencySymbolId(target) || isDependencySymbolId(source)) return
    const owner = graph.inNeighbors(target).find((n) => depIds.has(n))
    if (owner) stale.add(id)
  })

  for (const service of services) {
    const svcName = service.pkg.name
    if (!svcName) continue
    // Only files with an IMPORTS edge into one of these packages.
    const importing = new Set<string>()
    for (const depId of depIds) {
      graph.forEachInEdge(depId, (_e, attrs, source) => {
        if ((attrs as GraphEdge).type === EdgeType.IMPORTS && source.startsWith(fileId(svcName, ''))) importing.add(source)
      })
    }
    if (importing.size === 0) continue
    for (const file of await loadSourceFiles(service.dir, service.excludeDirs)) {
      if (isTestPath(file.path)) continue
      const relPath = toPosix(path.relative(service.dir, file.path))
      if (!importing.has(fileId(svcName, relPath))) continue
      const parser = symbolEdgeParserFor(path.extname(file.path))
      if (!parser) continue
      let edges: GraphEdge[]
      try {
        edges = callsIntoPackages(parseSource(parser, file.content).rootNode, svcName, relPath, file.content, scopes)
      } catch (err) {
        recordExtractionError('calls into dependencies', file.path, err)
        continue
      }
      for (const edge of edges) {
        if (!graph.hasNode(edge.source)) continue
        stale.delete(edge.id)
        if (graph.hasEdge(edge.id)) graph.replaceEdgeAttributes(edge.id, edge)
        else {
          graph.addEdgeWithKey(edge.id, edge.source, edge.target, edge)
          edgesAdded++
        }
      }
    }
  }
  for (const id of stale) graph.dropEdge(id)
  return { edgesAdded, edgesRemoved: stale.size }
}

export function dependencyNodeOf(graph: NeatGraph, depId: string): DependencyNode | null {
  if (!graph.hasNode(depId)) return null
  const n = graph.getNodeAttributes(depId) as GraphNode
  return n.type === NodeType.DependencyNode ? (n as DependencyNode) : null
}
