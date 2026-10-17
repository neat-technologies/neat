import path from 'node:path'
import Parser from 'tree-sitter'
import type { ExtractedConfidenceKind, GraphEdge } from '@neat.is/types'
import { EdgeType, Provenance, confidenceForExtracted, extractedEdgeId, symbolId } from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import type { DiscoveredService } from './shared.js'
import { recordExtractionError } from './errors.js'
import { loadSourceFiles, snippet, toPosix, type SourceFile } from './calls/shared.js'
import { SYMBOL_GRAMMAR_BY_EXT, collectCsharpSymbolDefs, disambiguate, parseSource } from './symbols.js'

// Static C# symbol edges — the C# rung of ADR-158 §3, beside go-symbol-edges.ts and
// java-symbol-edges.ts and holding their precision rule: a CALLS edge only where the
// callee resolves to exactly one method SymbolNode, never a guess. Three tiers, all
// inside one service directory, never across services:
//
//   1. Same file. An unqualified call or `this.M(…)` resolves to the one method the
//      enclosing class declares under that name; `Type.M(…)` (a static call on a
//      service type) to the one such method of that type.
//   2. Typed receiver. `x.M(…)` / `this.x.M(…)` where `x` is a local, a parameter or
//      a field resolves through `x`'s declared type to a type in the same service —
//      C# leans on `using` directives, so a type name is resolved by its **simple
//      name when that name is unique across the service** (the analog of Java's
//      import/package resolution), or by its fully-qualified `Namespace.Type`.
//   3. Interface → implementation. When that declared type is an interface, the call
//      lands on the implementing class's method, but only when the service's own
//      source has exactly one class implementing it — the single candidate DI wires
//      without an explicit registration pick.
//
// Left unclaimed: an overloaded name (the argument types would have to pick), an
// inherited or base-type method, a receiver typed `var` / generic / `predefined`, a
// type whose simple name is ambiguous or lives outside the service, an interface
// with zero or several implementors in the service, and any receiver that isn't a
// plain name or `this.field`. One case the rules can't see: a base class declaring
// an overload of the same name, which a call could bind to instead; the hierarchy is
// not read beyond the direct `base_list`. Runs after `addSymbols`, reusing its
// collector so ids and spans match the minted SymbolNodes exactly.

interface Def {
  sid: string
  qualname: string
  kind: string
  startIndex: number
  ambiguous: boolean
}

interface FileInfo {
  file: SourceFile
  relPath: string
  root: Parser.SyntaxNode
  defs: Def[]
  byStart: Map<number, Def>
}

interface TypeInfo {
  qualname: string
  isInterface: boolean
  baseNames: string[] // base-list entries as written
}

const TYPE_DECLS = new Set([
  'class_declaration',
  'interface_declaration',
  'struct_declaration',
  'record_declaration',
])
const METHOD_OWNERS = new Set(['class_declaration', 'struct_declaration', 'record_declaration'])
const CALLER_DECLS = new Set(['method_declaration', 'constructor_declaration'])

// A declared type as a name to resolve. A simple `identifier` or a dotted
// `qualified_name` is a name; `var` (implicit_type), a generic, an array, a nullable
// or a predefined type carries nothing we can resolve to a service method.
function declaredTypeName(typeNode: Parser.SyntaxNode | null | undefined): string | null {
  if (!typeNode) return null
  if (typeNode.type === 'identifier') return typeNode.text
  if (typeNode.type === 'qualified_name') return typeNode.text
  return null
}

// A field's declared type in a type body; undefined when the type has no such field.
function fieldType(name: string, typeNode: Parser.SyntaxNode): string | null | undefined {
  for (const m of typeNode.childForFieldName('body')?.namedChildren ?? []) {
    if (m.type !== 'field_declaration') continue
    const decl = m.namedChildren.find((c) => c.type === 'variable_declaration')
    if (!decl) continue
    for (const d of decl.namedChildren) {
      if (d.type === 'variable_declarator' && d.childForFieldName('name')?.text === name) {
        return declaredTypeName(decl.childForFieldName('type'))
      }
    }
  }
  return undefined
}

// The declared type of `name` at `call`: a local or parameter of an enclosing scope
// (innermost first), else a field of the innermost type. null when it is declared but
// untyped for our purposes (`var`, generic); undefined when not found.
function declaredType(
  name: string,
  call: Parser.SyntaxNode,
  typeNode: Parser.SyntaxNode,
): string | null | undefined {
  for (let n: Parser.SyntaxNode | null = call.parent; n && n !== typeNode; n = n.parent) {
    let found: string | null | undefined
    for (const c of n.namedChildren) {
      if (c.startIndex >= call.startIndex) break
      if (c.type !== 'local_declaration_statement') continue
      const decl = c.namedChildren.find((x) => x.type === 'variable_declaration')
      for (const d of decl?.namedChildren ?? []) {
        if (d.type === 'variable_declarator' && d.childForFieldName('name')?.text === name) {
          found = declaredTypeName(decl!.childForFieldName('type'))
        }
      }
    }
    if (found !== undefined) return found
    if (n.type === 'foreach_statement' && n.childForFieldName('left')?.text === name) {
      return declaredTypeName(n.childForFieldName('type'))
    }
    if (CALLER_DECLS.has(n.type)) {
      for (const p of n.childForFieldName('parameters')?.namedChildren ?? []) {
        if (p.type === 'parameter' && p.childForFieldName('name')?.text === name) {
          return declaredTypeName(p.childForFieldName('type'))
        }
      }
    }
  }
  return fieldType(name, typeNode)
}

export async function addCsharpSymbolEdges(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  const grammar = SYMBOL_GRAMMAR_BY_EXT['.cs']
  if (!grammar) return { nodesAdded: 0, edgesAdded: 0 }
  const parser = new Parser()
  parser.setLanguage(grammar)
  let edgesAdded = 0

  for (const service of services) {
    if (service.node.language !== 'csharp') continue
    const files = await loadSourceFiles(service.dir, service.excludeDirs)

    // Pass 1: every file's symbols and declared types.
    const infos: FileInfo[] = []
    const types = new Map<string, TypeInfo | null>() // null: qualname declared twice
    for (const file of files) {
      if (path.extname(file.path) !== '.cs') continue
      let root: Parser.SyntaxNode
      try {
        root = parseSource(parser, file.content).rootNode
      } catch (err) {
        recordExtractionError('csharp symbol edge extraction', file.path, err)
        continue
      }
      const relPath = toPosix(path.relative(service.dir, file.path))
      const defs: Def[] = disambiguate(collectCsharpSymbolDefs(root)).map(({ def, disambiguator }) => ({
        sid: symbolId(service.pkg.name, relPath, def.qualname, disambiguator),
        qualname: def.qualname,
        kind: def.kind,
        startIndex: def.startIndex,
        ambiguous: disambiguator !== undefined,
      }))
      const byStart = new Map<number, Def>()
      for (const d of defs) byStart.set(d.startIndex, d)
      infos.push({ file, relPath, root, defs, byStart })

      const visitTypes = (n: Parser.SyntaxNode): void => {
        if (TYPE_DECLS.has(n.type)) {
          const def = byStart.get(n.startIndex)
          if (def) {
            const baseNames: string[] = []
            for (const b of n.childForFieldName('bases')?.namedChildren ??
              n.namedChildren.find((c) => c.type === 'base_list')?.namedChildren ??
              []) {
              const name = declaredTypeName(b)
              if (name) baseNames.push(name)
            }
            types.set(
              def.qualname,
              types.has(def.qualname)
                ? null
                : { qualname: def.qualname, isInterface: n.type === 'interface_declaration', baseNames },
            )
          }
        }
        for (const c of n.namedChildren) visitTypes(c)
      }
      visitTypes(root)
    }
    if (infos.length === 0) continue

    // Simple type name → its qualname when unique across the service (null if two
    // types share the simple name). C# code names types by their simple name under a
    // `using`, so this is the service-wide resolution step.
    const simpleToType = new Map<string, string | null>()
    for (const [qualname, t] of types) {
      if (!t) continue
      const simple = qualname.slice(qualname.lastIndexOf('.') + 1)
      simpleToType.set(simple, simpleToType.has(simple) ? null : qualname)
    }
    const resolveType = (name: string): TypeInfo | null => {
      const qual = name.includes('.') ? name : simpleToType.get(name)
      return qual ? (types.get(qual) ?? null) : null
    }

    // Methods by owner + name across the service; more than one means overloads.
    const methods = new Map<string, Def[]>()
    for (const info of infos) {
      for (const d of info.defs) {
        if (d.kind === 'method') methods.set(d.qualname, [...(methods.get(d.qualname) ?? []), d])
      }
    }
    const uniqueMethod = (owner: string, name: string): Def | null => {
      const found = methods.get(`${owner}.${name}`)
      return found && found.length === 1 && !found[0]!.ambiguous ? found[0]! : null
    }

    // Interface qualname → service classes that implement it directly.
    const implementors = new Map<string, string[]>()
    for (const t of types.values()) {
      if (!t || t.isInterface) continue
      for (const base of t.baseNames) {
        const resolved = resolveType(base)
        if (resolved?.isInterface) {
          implementors.set(resolved.qualname, [...(implementors.get(resolved.qualname) ?? []), t.qualname])
        }
      }
    }

    const addEdge = (caller: Def, target: Def, kind: ExtractedConfidenceKind, info: FileInfo, line: number): void => {
      if (caller.sid === target.sid) return
      const edgeId = extractedEdgeId(caller.sid, target.sid, EdgeType.CALLS)
      if (graph.hasEdge(edgeId) || !graph.hasNode(caller.sid) || !graph.hasNode(target.sid)) return
      const edge: GraphEdge = {
        id: edgeId,
        source: caller.sid,
        target: target.sid,
        type: EdgeType.CALLS,
        provenance: Provenance.EXTRACTED,
        confidence: confidenceForExtracted(kind),
        evidence: { file: info.relPath, line, snippet: snippet(info.file.content, line) },
      }
      graph.addEdgeWithKey(edgeId, caller.sid, target.sid, edge)
      edgesAdded++
    }

    // A typed receiver's call: tier 2 on a class/struct/record, tier 3 through an interface.
    const viaType = (
      typeName: string,
      name: string,
    ): { target: Def; kind: ExtractedConfidenceKind } | null => {
      const type = resolveType(typeName)
      if (!type) return null
      if (!type.isInterface) {
        const t = uniqueMethod(type.qualname, name)
        return t ? { target: t, kind: 'structural' } : null
      }
      const impls = implementors.get(type.qualname) ?? []
      if (impls.length !== 1) return null
      const t = uniqueMethod(impls[0]!, name)
      return t ? { target: t, kind: 'verified-call-site' } : null
    }

    // Pass 2: resolve each call site.
    for (const info of infos) {
      // The caller and the innermost method-owning type, or null when none encloses.
      const context = (
        call: Parser.SyntaxNode,
      ): { caller: Def; typeNode: Parser.SyntaxNode; typeQual: string } | null => {
        let caller: Def | null = null
        for (let n = call.parent; n; n = n.parent) {
          if (!caller && CALLER_DECLS.has(n.type)) {
            caller = info.byStart.get(n.startIndex) ?? null
            if (!caller) return null
          }
          if (TYPE_DECLS.has(n.type)) {
            const cls = info.byStart.get(n.startIndex)
            if (!caller || !cls || !METHOD_OWNERS.has(n.type)) return null
            return { caller, typeNode: n, typeQual: cls.qualname }
          }
        }
        return null
      }

      const visit = (node: Parser.SyntaxNode): void => {
        if (node.type === 'invocation_expression') {
          const fn = node.childForFieldName('function')
          const ctx = fn ? context(node) : null
          if (ctx && fn) {
            const line = node.startPosition.row + 1
            let hit: { target: Def; kind: ExtractedConfidenceKind } | null = null
            if (fn.type === 'identifier') {
              // Tier 1: unqualified call → the enclosing type's own method.
              const t = uniqueMethod(ctx.typeQual, fn.text)
              if (t) hit = { target: t, kind: 'structural' }
            } else if (fn.type === 'member_access_expression') {
              const name = fn.childForFieldName('name')?.text
              const recv = fn.childForFieldName('expression')
              if (name && recv) {
                if (recv.type === 'this') {
                  const t = uniqueMethod(ctx.typeQual, name)
                  if (t) hit = { target: t, kind: 'structural' }
                } else if (recv.type === 'identifier') {
                  const typeName = declaredType(recv.text, node, ctx.typeNode)
                  if (typeName) hit = viaType(typeName, name)
                  else if (typeName === undefined) {
                    // Tier 1: `Type.M()` — a static call on a service type.
                    const type = resolveType(recv.text)
                    const t = type ? uniqueMethod(type.qualname, name) : null
                    if (t) hit = { target: t, kind: 'structural' }
                  }
                } else if (
                  recv.type === 'member_access_expression' &&
                  recv.childForFieldName('expression')?.type === 'this'
                ) {
                  const field = recv.childForFieldName('name')?.text
                  const typeName = field ? fieldType(field, ctx.typeNode) : null
                  if (typeName) hit = viaType(typeName, name)
                }
              }
            }
            if (hit) addEdge(ctx.caller, hit.target, hit.kind, info, line)
          }
        }
        for (const c of node.namedChildren) visit(c)
      }
      visit(info.root)
    }
  }
  return { nodesAdded: 0, edgesAdded }
}
