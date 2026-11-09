import path from 'node:path'
import Parser from 'tree-sitter'
import type { ExtractedConfidenceKind, GraphEdge } from '@neat.is/types'
import { EdgeType, Provenance, confidenceForExtracted, extractedEdgeId, symbolId } from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import type { DiscoveredService } from './shared.js'
import { recordExtractionError } from './errors.js'
import { loadSourceFiles, snippet, toPosix, type SourceFile } from './calls/shared.js'
import { SYMBOL_GRAMMAR_BY_EXT, collectJavaSymbolDefs, disambiguate, parseSource } from './symbols.js'

// Static Java symbol edges — the Java rung of ADR-158 §3, beside go-symbol-edges.ts
// and holding its precision rule: a CALLS edge only where the callee resolves to
// exactly one method SymbolNode, never a guess. Three tiers, all inside one
// service directory, never across services:
//
//   1. Same file (#1442). An unqualified call or `this.m(…)` resolves to the one
//      method the innermost named class declares under that name; `Type.m(…)` to
//      the one such method of a same-file class.
//   2. Typed receiver (ADR-257). `x.m(…)` / `this.x.m(…)` where `x` is a local, a
//      parameter or a field (innermost scope first) resolves through `x`'s
//      declared type: the type name goes through the file's single-type imports,
//      then its own package, then its wildcard imports, to a class in the same
//      service, and the callee is the one method that class declares by that name.
//   3. Interface → implementation (ADR-257). When that declared type is an
//      interface, the call lands on the implementing class's method, but only when
//      the service's own source has exactly one class implementing it — the single
//      candidate that lets Spring wire the bean without a @Qualifier.
//
// Left unclaimed: an overloaded name (the argument types would have to pick), an
// inherited or outer-class method, a call inside an anonymous or local class
// (its own methods would shadow), a receiver typed `var`, generic-only or by a
// type outside the service, an interface with zero or several implementors in the
// service, and any receiver that isn't a plain name (`a.b().m()`). One case the
// rules can't see: a superclass declaring an overload of the same name, which a
// call could bind to instead; the class hierarchy isn't read beyond `implements`.
// Runs after `addSymbols`, reusing its collector so ids and spans match the minted
// SymbolNodes exactly.

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
  pkg: string | undefined
  singleImports: Map<string, string> // simple name → qualified
  wildcardImports: string[] // package prefixes
  defs: Def[]
  byStart: Map<number, Def>
}

interface TypeInfo {
  qualname: string
  isInterface: boolean
  implementsNames: string[] // as written, resolved against `file`
  file: FileInfo
}

const TYPE_DECLS = new Set(['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'])

function readImports(root: Parser.SyntaxNode): { single: Map<string, string>; wildcard: string[] } {
  const single = new Map<string, string>()
  const wildcard: string[] = []
  for (const c of root.namedChildren) {
    if (c.type !== 'import_declaration') continue
    const m = /^import\s+(static\s+)?([\w.]+?)(\.\*)?\s*;/.exec(c.text)
    if (!m || m[1]) continue
    if (m[3]) wildcard.push(m[2]!)
    else single.set(m[2]!.slice(m[2]!.lastIndexOf('.') + 1), m[2]!)
  }
  return { single, wildcard }
}

// A declared type as a name to resolve; generics, arrays and `var` → null.
function declaredTypeName(typeNode: Parser.SyntaxNode | null): string | null {
  if (!typeNode) return null
  if (typeNode.type === 'type_identifier') return typeNode.text === 'var' ? null : typeNode.text
  if (typeNode.type === 'scoped_type_identifier') return typeNode.text
  return null
}

// A field's declared type in a class body; undefined when the class has no such field.
function fieldType(name: string, classNode: Parser.SyntaxNode): string | null | undefined {
  for (const f of classNode.childForFieldName('body')?.namedChildren ?? []) {
    if (f.type !== 'field_declaration') continue
    for (const d of f.namedChildren) {
      if (d.type === 'variable_declarator' && d.childForFieldName('name')?.text === name) {
        return declaredTypeName(f.childForFieldName('type'))
      }
    }
  }
  return undefined
}

// The declared type of `name` at `call`: a local or parameter of an enclosing
// scope (innermost first), else a field of the innermost class. null when it's
// declared but untyped for our purposes (var, generic); undefined when not found.
function declaredType(name: string, call: Parser.SyntaxNode, classNode: Parser.SyntaxNode): string | null | undefined {
  for (let n: Parser.SyntaxNode | null = call.parent; n && n !== classNode; n = n.parent) {
    let found: string | null | undefined
    for (const c of n.namedChildren) {
      if (c.startIndex >= call.startIndex) break
      if (c.type !== 'local_variable_declaration') continue
      for (const d of c.namedChildren) {
        if (d.type === 'variable_declarator' && d.childForFieldName('name')?.text === name) {
          found = declaredTypeName(c.childForFieldName('type'))
        }
      }
    }
    if (found !== undefined) return found
    if (n.type === 'enhanced_for_statement' && n.childForFieldName('name')?.text === name) {
      return declaredTypeName(n.childForFieldName('type'))
    }
    if (n.type === 'method_declaration' || n.type === 'constructor_declaration' || n.type === 'lambda_expression') {
      const params = n.childForFieldName('parameters')
      if (params?.type === 'identifier' && params.text === name) return null // `x -> …`
      for (const p of params?.namedChildren ?? []) {
        if (p.type === 'formal_parameter' && p.childForFieldName('name')?.text === name) {
          return declaredTypeName(p.childForFieldName('type'))
        }
        if ((p.type === 'identifier' || p.type === 'spread_parameter') && p.text.endsWith(name)) return null
      }
    }
  }
  return fieldType(name, classNode)
}

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

    // Pass 1: every file's symbols, package, imports and declared types.
    const infos: FileInfo[] = []
    const types = new Map<string, TypeInfo | null>() // null: qualname declared twice
    for (const file of files) {
      if (path.extname(file.path) !== '.java') continue
      let root: Parser.SyntaxNode
      try {
        root = parseSource(parser, file.content).rootNode
      } catch (err) {
        recordExtractionError('java symbol edge extraction', file.path, err)
        continue
      }
      const relPath = toPosix(path.relative(service.dir, file.path))
      const defs: Def[] = disambiguate(collectJavaSymbolDefs(root)).map(({ def, disambiguator }) => ({
        sid: symbolId(service.pkg.name, relPath, def.qualname, disambiguator),
        qualname: def.qualname,
        kind: def.kind,
        startIndex: def.startIndex,
        ambiguous: disambiguator !== undefined,
      }))
      const byStart = new Map<number, Def>()
      for (const d of defs) byStart.set(d.startIndex, d)
      const { single, wildcard } = readImports(root)
      const info: FileInfo = {
        file,
        relPath,
        root,
        pkg: root.namedChildren.find((c) => c.type === 'package_declaration')?.namedChildren[0]?.text,
        singleImports: single,
        wildcardImports: wildcard,
        defs,
        byStart,
      }
      infos.push(info)
      const visitTypes = (n: Parser.SyntaxNode): void => {
        if (TYPE_DECLS.has(n.type)) {
          const def = byStart.get(n.startIndex)
          if (def) {
            const names: string[] = []
            const ifaces = n.type === 'class_declaration' ? n.childForFieldName('interfaces') : null
            for (const t of ifaces?.descendantsOfType(['type_identifier', 'scoped_type_identifier']) ?? []) {
              if (t.parent?.type === 'type_list') names.push(t.text)
            }
            types.set(
              def.qualname,
              types.has(def.qualname)
                ? null
                : { qualname: def.qualname, isInterface: n.type === 'interface_declaration', implementsNames: names, file: info },
            )
          }
        }
        for (const c of n.namedChildren) visitTypes(c)
      }
      visitTypes(root)
    }
    if (infos.length === 0) continue

    // A type name as written in `info` → a type declared in this service.
    const resolveType = (name: string, info: FileInfo): TypeInfo | null => {
      if (name.includes('.')) return types.get(name) ?? null
      const imported = info.singleImports.get(name)
      if (imported) return types.get(imported) ?? null
      const local = types.get(info.pkg ? `${info.pkg}.${name}` : name)
      if (local) return local
      const viaWildcard = info.wildcardImports
        .map((p) => types.get(`${p}.${name}`))
        .filter((t): t is TypeInfo => !!t)
      return viaWildcard.length === 1 ? viaWildcard[0]! : null
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

    // Interface → the classes in this service that implement it directly.
    const implementors = new Map<string, string[]>()
    for (const t of types.values()) {
      if (!t || t.isInterface) continue
      for (const n of t.implementsNames) {
        const iface = resolveType(n, t.file)
        if (iface?.isInterface) implementors.set(iface.qualname, [...(implementors.get(iface.qualname) ?? []), t.qualname])
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

    // A typed receiver's call: tier 2 on a class, tier 3 through an interface.
    const viaType = (typeName: string, name: string, info: FileInfo): { target: Def; kind: ExtractedConfidenceKind } | null => {
      const type = resolveType(typeName, info)
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
      const classBySimple = new Map<string, string | null>()
      for (const d of info.defs) {
        if (d.kind !== 'class') continue
        const simple = d.qualname.slice(d.qualname.lastIndexOf('.') + 1)
        classBySimple.set(simple, classBySimple.has(simple) ? null : d.qualname)
      }

      // The caller and the innermost named class, or null when an anonymous or
      // local class sits in between.
      const context = (call: Parser.SyntaxNode): { caller: Def; classNode: Parser.SyntaxNode; classQual: string } | null => {
        let caller: Def | null = null
        for (let n = call.parent; n; n = n.parent) {
          if (n.type === 'class_body' && n.parent?.type === 'object_creation_expression') return null
          if (!caller && (n.type === 'method_declaration' || n.type === 'constructor_declaration')) {
            caller = info.byStart.get(n.startIndex) ?? null
            if (!caller) return null
          }
          if (TYPE_DECLS.has(n.type)) {
            const cls = info.byStart.get(n.startIndex)
            if (!caller || !cls || cls.kind !== 'class') return null
            return { caller, classNode: n, classQual: cls.qualname }
          }
        }
        return null
      }

      const visit = (node: Parser.SyntaxNode): void => {
        if (node.type === 'method_invocation') {
          const name = node.childForFieldName('name')?.text
          const obj = node.childForFieldName('object')
          const ctx = name ? context(node) : null
          if (ctx && name) {
            const line = node.startPosition.row + 1
            let hit: { target: Def; kind: ExtractedConfidenceKind } | null = null
            if (!obj || obj.type === 'this') {
              // Tier 1: the enclosing class's own method.
              const t = uniqueMethod(ctx.classQual, name)
              if (t && info.defs.includes(t)) hit = { target: t, kind: 'structural' }
            } else if (obj.type === 'identifier') {
              const typeName = declaredType(obj.text, node, ctx.classNode)
              if (typeName) hit = viaType(typeName, name, info)
              else if (typeName === undefined) {
                // Tier 1: `Type.m()` on a same-file class.
                const cls = classBySimple.get(obj.text)
                const t = cls ? uniqueMethod(cls, name) : null
                if (t) hit = { target: t, kind: 'structural' }
              }
            } else if (obj.type === 'field_access' && obj.childForFieldName('object')?.type === 'this') {
              const field = obj.childForFieldName('field')?.text
              const typeName = field ? fieldType(field, ctx.classNode) : null
              if (typeName) hit = viaType(typeName, name, info)
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
