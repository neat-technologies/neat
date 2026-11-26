import path from 'node:path'
import type Parser from 'tree-sitter'
import { collectSymbolDefs, disambiguate, parseSource } from '../symbols.js'
import { symbolEdgeParserFor } from '../symbol-edges.js'
import { resolveInPackage } from './resolve.js'

// A package's export table (dependency-inventory.md §5): which of its symbols an
// import of it lands on. Pure over the package's files and manifest. Resolves the
// clean cases only, and leaves the rest unresolved rather than guessed:
//
// - entry files from `exports` (a string, a subpath map, condition objects, a
//   single `*` pattern) or `main`, else `index`
// - CommonJS `module.exports = <fn | class | identifier | { a, b: c }>`, chained
//   (`exports = module.exports = fn`), and `exports.x = …` / `module.exports.x = …`
// - ESM `export function / class / const`, `export { a as b }`, `export default`
// - a browserify standalone bundle: the entry module's `module.exports` /
//   `exports.x`, naming a definition inside that module
// - a single-file UMD / IIFE build: the object its `module.exports` is set to,
//   followed through `var v = f()` to what `f` returns, and that object's
//   `obj.name = fn` members where it is built
//
// Not resolved: re-exports (`exports.x = require('./y')`, `export … from`),
// anything assigned at runtime (a mixin loop), and computed or nested exports.

export const DEFAULT_EXPORT = 'default'

// A symbol in one file, named the way the symbol producer named it.
export interface ExportTarget {
  file: string
  qualname: string
  disambiguator?: number
}

type Manifest = { main?: unknown; exports?: unknown } | null | undefined

function pickCondition(value: unknown, conditions: readonly string[]): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = pickCondition(v, conditions)
      if (hit) return hit
    }
    return null
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const c of conditions) if (c in obj) {
      const hit = pickCondition(obj[c], conditions)
      if (hit) return hit
    }
  }
  return null
}

function resolveTarget(files: ReadonlySet<string>, target: string): string | null {
  const rel = target.replace(/^\.\//, '')
  if (files.has(rel)) return rel
  return resolveInPackage(files, `./${rel}`, 'package.json')
}

/**
 * The file an import of the package lands on. `subpath` is what follows the
 * package name (`''` for `lodash`, `'template'` for `lodash/template`), and
 * `style` says whether it was `require`d or `import`ed, which picks among
 * conditional exports.
 */
export function packageEntry(
  manifest: Manifest,
  files: ReadonlySet<string>,
  subpath: string,
  style: 'require' | 'import',
): string | null {
  const conditions = [style, 'node', 'default', style === 'require' ? 'import' : 'require']
  const key = subpath ? `./${subpath}` : '.'
  const exp = manifest?.exports
  if (exp !== undefined && exp !== null) {
    const isMap = typeof exp === 'object' && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith('.'))
    if (!isMap) return key === '.' ? (() => { const t = pickCondition(exp, conditions); return t ? resolveTarget(files, t) : null })() : null
    const map = exp as Record<string, unknown>
    if (key in map) {
      const t = pickCondition(map[key], conditions)
      return t ? resolveTarget(files, t) : null
    }
    for (const [pattern, value] of Object.entries(map)) {
      const star = pattern.indexOf('*')
      if (star < 0) continue
      const [pre, post] = [pattern.slice(0, star), pattern.slice(star + 1)]
      if (!key.startsWith(pre) || !key.endsWith(post) || key.length < pre.length + post.length) continue
      const hole = key.slice(pre.length, key.length - post.length)
      const t = pickCondition(value, conditions)
      return t ? resolveTarget(files, t.replace('*', hole)) : null
    }
    // A package with an exports map exposes nothing outside it.
    return null
  }
  if (subpath) return resolveTarget(files, subpath)
  const main = typeof manifest?.main === 'string' ? manifest.main : 'index'
  return resolveTarget(files, main)
}

const FUNCTION_LIKE = new Set(['function', 'function_expression', 'arrow_function', 'generator_function', 'class'])
const MAX_DEPTH = 4

// `require('./x')` or `require('./x').y`: the local module and the export it
// takes, or null for anything else (another package, a computed path).
function localRequire(node: Parser.SyntaxNode | null): { specifier: string; name: string } | null {
  if (!node) return null
  let name = DEFAULT_EXPORT
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

/**
 * The export tables of one package, memoized per file. An export that is a
 * local `require` (`module.exports = require('./lib/x')`, `{ parse }` where
 * `const parse = require('./parse')`) is followed into that file, a few hops at
 * most.
 */
export class PackageExports {
  private readonly paths: ReadonlySet<string>
  private readonly memo = new Map<string, Map<string, ExportTarget>>()

  constructor(
    private readonly manifest: Manifest,
    private readonly files: Map<string, string>,
  ) {
    this.paths = new Set(files.keys())
  }

  /** The exports an import of the package lands on, or null when its entry doesn't resolve. */
  forImport(subpath: string, style: 'require' | 'import'): Map<string, ExportTarget> | null {
    const entry = packageEntry(this.manifest, this.paths, subpath, style)
    return entry ? this.ofFile(entry, 0) : null
  }

  ofFile(file: string, depth: number): Map<string, ExportTarget> {
    const hit = this.memo.get(file)
    if (hit) return hit
    const out = new Map<string, ExportTarget>()
    this.memo.set(file, out) // a require cycle ends here, with what's known so far
    const parser = symbolEdgeParserFor(path.posix.extname(file))
    const source = this.files.get(file)
    if (!parser || source === undefined || depth > MAX_DEPTH) return out
    const follow = (specifier: string): Map<string, ExportTarget> | null => {
      const target = resolveInPackage(this.paths, specifier, file)
      return target ? this.ofFile(target, depth + 1) : null
    }
    const own = moduleExports(parseSource(parser, source).rootNode, file, follow)
    for (const [k, v] of own) out.set(k, v)
    if (esmTables.has(own)) esmTables.add(out)
    return out
  }
}

// Tables built from a module with ESM exports. A default import of anything else
// is the CommonJS `module.exports` value, so `x.m()` on it reads export `m`.
const esmTables = new WeakSet<Map<string, ExportTarget>>()
export function isEsmExports(table: Map<string, ExportTarget>): boolean {
  return esmTables.has(table)
}

const isComment = (n: Parser.SyntaxNode) => n.type === 'comment'

// A function's body, through the parentheses a bundler wraps it in.
function functionBody(node: Parser.SyntaxNode | null | undefined): Parser.SyntaxNode | null {
  let cur = node ?? null
  while (cur?.type === 'parenthesized_expression') cur = cur.namedChild(0)
  if (!cur || (cur.type !== 'function_expression' && cur.type !== 'function' && cur.type !== 'arrow_function')) return null
  const body = cur.childForFieldName('body')
  return body?.type === 'statement_block' ? body : null
}

/**
 * The entry module's body in a browserify standalone bundle, or null for any
 * other file. The whole file is one call, `(function(f){ … })(function(){ … })`,
 * whose argument returns `prelude()({ id: [function(require,module,exports){ … },
 * deps], … }, {}, [entry])(entry)`. What the entry module assigns to
 * `module.exports` is what a `require` of the file gets.
 */
export function browserifyEntryBody(root: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const stmts = root.namedChildren.filter((n) => !isComment(n))
  if (stmts.length !== 1 || stmts[0]!.type !== 'expression_statement') return null
  const outer = stmts[0]!.namedChild(0)
  if (outer?.type !== 'call_expression' || !functionBody(outer.childForFieldName('function'))) return null
  const outerArgs = outer.childForFieldName('arguments')?.namedChildren.filter((n) => !isComment(n)) ?? []
  const factory = outerArgs.length === 1 ? functionBody(outerArgs[0]) : null
  const ret = factory?.namedChildren.filter((n) => !isComment(n)).at(-1)
  if (ret?.type !== 'return_statement') return null

  // `<load>(entry)`, where `<load>` is `<prelude>(modules, cache, [entry])`.
  const pick = ret.namedChild(0)
  const pickArgs = pick?.type === 'call_expression' ? pick.childForFieldName('arguments')?.namedChildren ?? [] : []
  const load = pick?.type === 'call_expression' ? pick.childForFieldName('function') : null
  if (pickArgs.length !== 1 || pickArgs[0]!.type !== 'number' || load?.type !== 'call_expression') return null
  const entry = pickArgs[0]!.text
  const loadArgs = load.childForFieldName('arguments')?.namedChildren ?? []
  if (loadArgs.length !== 3 || loadArgs[0]!.type !== 'object' || loadArgs[2]!.type !== 'array') return null
  if (!loadArgs[2]!.namedChildren.some((n) => n.type === 'number' && n.text === entry)) return null

  for (const pair of loadArgs[0]!.namedChildren) {
    if (pair.type !== 'pair' || pair.childForFieldName('key')?.text.replace(/^['"]|['"]$/g, '') !== entry) continue
    const def = pair.childForFieldName('value')
    return def?.type === 'array' ? functionBody(def.namedChild(0)) : null
  }
  return null
}

// The body of an immediately invoked function, through the wrappers bundlers
// write: `(function () { … })()`, `(function () { … }.call(this))`,
// `!function () { … }()`. Returns the function node and its call's arguments.
function iife(expr: Parser.SyntaxNode | null): { fn: Parser.SyntaxNode; args: Parser.SyntaxNode[] } | null {
  let cur = expr
  while (cur?.type === 'parenthesized_expression' || cur?.type === 'unary_expression') {
    cur = cur.type === 'unary_expression' ? cur.childForFieldName('argument') : cur.namedChild(0)
  }
  if (cur?.type !== 'call_expression') return null
  let callee = cur.childForFieldName('function')
  const args = cur.childForFieldName('arguments')?.namedChildren.filter((n) => !isComment(n)) ?? []
  let callArgs = args
  while (callee?.type === 'parenthesized_expression') callee = callee.namedChild(0)
  if (callee?.type === 'member_expression') {
    // `fn.call(thisArg, ...args)`: the function's own arguments follow thisArg.
    const prop = callee.childForFieldName('property')?.text
    if (prop !== 'call' && prop !== 'apply') return null
    callee = callee.childForFieldName('object')
    callArgs = prop === 'call' ? args.slice(1) : []
    while (callee?.type === 'parenthesized_expression') callee = callee.namedChild(0)
  }
  return callee && functionBody(callee) ? { fn: callee, args: callArgs } : null
}

const FUNCTION_NODES = new Set(['function_expression', 'function', 'function_declaration', 'arrow_function', 'generator_function', 'generator_function_declaration'])

function descendants(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = []
  const walk = (n: Parser.SyntaxNode) => {
    if (n.type === type) out.push(n)
    for (const c of n.namedChildren) walk(c)
  }
  walk(node)
  return out
}

/**
 * Where the value of a single-file bundle's `module.exports` gets its members
 * (the UMD / IIFE build a package ships as `main` beside its modular files).
 * The whole file is one immediately invoked function; somewhere inside it
 * assigns `<x>.exports = <value>` (`module.exports`, or the `freeModule` alias a
 * UMD header makes). The value is followed through identifiers, `var v = f()`
 * calls to a local function (to the identifier that function returns), and a
 * factory passed as the IIFE's argument. What comes back is that object's name
 * and the function body its members are assigned in (`lodash.template =
 * template` inside `runInContext`). Null for any other file, or when the chain
 * leaves what is written in the file.
 */
export function bundleExportObject(root: Parser.SyntaxNode): { name: string; scope: Parser.SyntaxNode } | null {
  const stmts = root.namedChildren.filter((n) => !isComment(n) && n.type !== 'empty_statement')
  if (stmts.length !== 1 || stmts[0]!.type !== 'expression_statement') return null
  const outer = iife(stmts[0]!.namedChild(0))
  if (!outer) return null
  const outerBody = functionBody(outer.fn)!

  // The function an identifier names in the bundle: a declaration, a
  // `var f = (function f() { … })`, or an IIFE parameter bound to a function
  // argument (the UMD factory).
  const functionNamed = (name: string): Parser.SyntaxNode | null => {
    const params = outer.fn.childForFieldName('parameters')?.namedChildren ?? []
    const at = params.findIndex((p) => p.type === 'identifier' && p.text === name)
    if (at >= 0) {
      let arg: Parser.SyntaxNode | null = outer.args[at] ?? null
      while (arg?.type === 'parenthesized_expression') arg = arg.namedChild(0)
      return arg && FUNCTION_NODES.has(arg.type) ? arg : null
    }
    const hits: Parser.SyntaxNode[] = []
    for (const d of descendants(outerBody, 'function_declaration')) if (d.childForFieldName('name')?.text === name) hits.push(d)
    for (const d of descendants(outerBody, 'variable_declarator')) {
      if (d.childForFieldName('name')?.text !== name) continue
      let v = d.childForFieldName('value')
      while (v?.type === 'parenthesized_expression') v = v.namedChild(0)
      if (v && FUNCTION_NODES.has(v.type)) hits.push(v)
    }
    return hits.length === 1 ? hits[0]! : null
  }
  // The one initializer `var name = …` has in `scope`, or undefined when the
  // name is declared there without one (or not as a variable), null when ambiguous.
  const initOf = (name: string, scope: Parser.SyntaxNode): Parser.SyntaxNode | null | undefined => {
    const decls = descendants(scope, 'variable_declarator').filter((d) => d.childForFieldName('name')?.text === name)
    if (decls.length === 0) return undefined
    if (decls.length > 1) return null
    return decls[0]!.childForFieldName('value') ?? undefined
  }

  const resolve = (value: Parser.SyntaxNode | null, scope: Parser.SyntaxNode, hops: number): { name: string; scope: Parser.SyntaxNode } | null => {
    while (value?.type === 'parenthesized_expression') value = value.namedChild(0)
    if (!value || hops > MAX_DEPTH) return null
    if (value.type === 'identifier') {
      const init = initOf(value.text, scope)
      if (init === null) return null
      if (init === undefined || FUNCTION_NODES.has(init.type) || init.type === 'class' || init.type === 'object') return { name: value.text, scope }
      return resolve(init, scope, hops + 1)
    }
    if (value.type === 'call_expression') {
      const callee = value.childForFieldName('function')
      const fn = callee?.type === 'identifier' ? functionNamed(callee.text) : null
      const body = functionBody(fn)
      if (!body) return null
      // The function's own top-level `return x`, one identifier for every return.
      const returned = body.namedChildren.filter((n) => n.type === 'return_statement').map((r) => r.namedChild(0))
      if (returned.length === 0 || returned.some((r) => r?.type !== 'identifier' || r.text !== returned[0]!.text)) return null
      return resolve(returned[0]!, body, hops + 1)
    }
    return null
  }

  const exported = descendants(outerBody, 'assignment_expression').filter((a) => {
    const left = a.childForFieldName('left')
    return left?.type === 'member_expression' && left.childForFieldName('property')?.text === 'exports' && left.childForFieldName('object')?.type === 'identifier'
  })
  let found: { name: string; scope: Parser.SyntaxNode } | null = null
  for (const a of exported) {
    const r = resolve(a.childForFieldName('right'), outerBody, 0)
    if (!r) continue
    if (found && (found.name !== r.name || found.scope.startIndex !== r.scope.startIndex)) return null
    found = r
  }
  return found
}

/** One module file's exports: export name → the symbol it names. `default` is the whole module value. */
export function moduleExports(
  root: Parser.SyntaxNode,
  file: string,
  follow: (specifier: string) => Map<string, ExportTarget> | null = () => null,
): Map<string, ExportTarget> {
  const defs = disambiguate(collectSymbolDefs(root))
  // In a bundle the module is the entry module's function body, not the file:
  // its statements are the ones read, a name it exports has to be defined
  // inside it, and its `require('./x')` names another module of the bundle,
  // not a file, so it isn't followed.
  const bundle = browserifyEntryBody(root)
  const inModule = (start: number, end: number) => !bundle || (start >= bundle.startIndex && end <= bundle.endIndex)
  const bareCount = new Map<string, number>()
  for (const { def } of defs) {
    if (def.qualname.includes('.') || !inModule(def.startIndex, def.endIndex)) continue
    bareCount.set(def.qualname, (bareCount.get(def.qualname) ?? 0) + 1)
  }
  // The definition a function or class node is: the symbol producer records an
  // assigned function (`module.exports = function () {}`, `x.y = () => {}`) from
  // the assignment, so match on where the span ends and take the innermost one
  // that starts at or before the node.
  const defOf = (node: Parser.SyntaxNode): ExportTarget | null => {
    let best: (typeof defs)[number] | null = null
    for (const d of defs) {
      if (d.def.endIndex !== node.endIndex || d.def.startIndex > node.startIndex) continue
      if (!best || d.def.startIndex > best.def.startIndex) best = d
    }
    if (!best) return null
    return { file, qualname: best.def.qualname, ...(best.disambiguator !== undefined ? { disambiguator: best.disambiguator } : {}) }
  }
  // Top-level `const x = require('./y')` bindings, followed on use.
  const required = new Map<string, { specifier: string; name: string }>()
  for (const stmt of root.namedChildren) {
    if (stmt.type !== 'lexical_declaration' && stmt.type !== 'variable_declaration') continue
    for (const d of stmt.namedChildren) {
      const name = d.type === 'variable_declarator' ? d.childForFieldName('name') : null
      const req = localRequire(d.childForFieldName?.('value') ?? null)
      if (name?.type === 'identifier' && req) required.set(name.text, req)
    }
  }
  // The one definition in the module with this bare name.
  const named = (name: string): ExportTarget | null => {
    const d = defs.find((x) => x.def.qualname === name && inModule(x.def.startIndex, x.def.endIndex))
    return d ? { file, qualname: name, ...(d.disambiguator !== undefined ? { disambiguator: d.disambiguator } : {}) } : null
  }
  // A value an export names: a function or class written in place, an
  // identifier naming exactly one top-level definition in the file, or a local
  // module it requires.
  const targetOf = (value: Parser.SyntaxNode | null): ExportTarget | null => {
    if (!value) return null
    if (FUNCTION_LIKE.has(value.type) || value.type === 'class_declaration' || value.type === 'function_declaration') {
      return defOf(value)
    }
    if (value.type === 'identifier' || value.type === 'shorthand_property_identifier') {
      if (bareCount.get(value.text) === 1) return named(value.text)
      const req = required.get(value.text)
      return req ? (follow(req.specifier)?.get(req.name) ?? null) : null
    }
    const req = bundle ? null : localRequire(value)
    return req ? (follow(req.specifier)?.get(req.name) ?? null) : null
  }
  const out = new Map<string, ExportTarget>()
  const set = (name: string, t: ExportTarget | null) => {
    if (t && !out.has(name)) out.set(name, t)
  }

  // `a = b = value`: every target in the chain gets the final value.
  const assignment = (node: Parser.SyntaxNode) => {
    const lefts: string[] = []
    let cur: Parser.SyntaxNode | null = node
    while (cur?.type === 'assignment_expression') {
      lefts.push(cur.childForFieldName('left')?.text.replace(/\s+/g, '') ?? '')
      cur = cur.childForFieldName('right')
    }
    const value = cur
    for (const left of lefts) {
      if (left === 'module.exports') {
        if (value?.type === 'object') {
          for (const prop of value.namedChildren) {
            if (prop.type === 'shorthand_property_identifier') set(prop.text, targetOf(prop))
            else if (prop.type === 'pair') {
              const key = prop.childForFieldName('key')
              if (key && (key.type === 'property_identifier' || key.type === 'string')) {
                set(key.text.replace(/^['"]|['"]$/g, ''), targetOf(prop.childForFieldName('value')))
              }
            }
          }
        } else {
          const req = bundle ? null : localRequire(value)
          if (req && req.name === DEFAULT_EXPORT) {
            // `module.exports = require('./x')`: this module is that one.
            for (const [k, v] of follow(req.specifier) ?? []) set(k, v)
          } else set(DEFAULT_EXPORT, targetOf(value))
        }
        continue
      }
      const m = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(left)
      if (m) set(m[1]!, targetOf(value))
    }
  }

  for (const stmt of (bundle ?? root).namedChildren) {
    if (stmt.type === 'expression_statement') {
      const expr = stmt.namedChild(0)
      if (expr?.type === 'assignment_expression') assignment(expr)
      continue
    }
    if (stmt.type !== 'export_statement') continue
    esmTables.add(out)
    if (stmt.childForFieldName('source')) continue // a re-export
    const decl = stmt.childForFieldName('declaration')
    const isDefault = stmt.children.some((c) => c.type === 'default')
    if (decl) {
      if (decl.type === 'function_declaration' || decl.type === 'generator_function_declaration' || decl.type === 'class_declaration') {
        const name = decl.childForFieldName('name')?.text
        const t = defOf(decl) ?? (name && bareCount.get(name) === 1 ? { file, qualname: name } : null)
        if (isDefault) set(DEFAULT_EXPORT, t)
        if (name) set(name, t)
      } else if (decl.type === 'lexical_declaration' || decl.type === 'variable_declaration') {
        for (const d of decl.namedChildren) {
          if (d.type !== 'variable_declarator') continue
          const name = d.childForFieldName('name')
          if (name?.type === 'identifier') set(name.text, targetOf(d.childForFieldName('value')) ?? (bareCount.get(name.text) === 1 ? { file, qualname: name.text } : null))
        }
      }
      continue
    }
    const value = stmt.childForFieldName('value')
    if (isDefault && value) {
      set(DEFAULT_EXPORT, targetOf(value))
      continue
    }
    for (const clause of stmt.namedChildren) {
      if (clause.type !== 'export_clause') continue
      for (const spec of clause.namedChildren) {
        if (spec.type !== 'export_specifier') continue
        const local = spec.childForFieldName('name')
        const alias = spec.childForFieldName('alias')
        if (local) set(alias?.text ?? local.text, targetOf(local))
      }
    }
  }

  // A single-file UMD / IIFE build exports nothing at the top level: what a
  // require of it gets is the object its `module.exports` is set to, and that
  // object's members are the `obj.name = value` assignments made where it is
  // built.
  if (out.size === 0 && !bundle) {
    const obj = bundleExportObject(root)
    if (obj) {
      if (bareCount.get(obj.name) === 1) set(DEFAULT_EXPORT, named(obj.name))
      for (const stmt of obj.scope.namedChildren) {
        if (stmt.type !== 'expression_statement') continue
        let cur: Parser.SyntaxNode | null = stmt.namedChild(0)
        const names: string[] = []
        while (cur?.type === 'assignment_expression') {
          const left = cur.childForFieldName('left')
          const m = left?.type === 'member_expression' ? /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(left.text.replace(/\s+/g, '')) : null
          if (m && m[1] === obj.name) names.push(m[2]!)
          cur = cur.childForFieldName('right')
        }
        if (names.length === 0) continue
        const t = targetOf(cur)
        for (const n of names) set(n, t)
      }
    }
  }
  return out
}

