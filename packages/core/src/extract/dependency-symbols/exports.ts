import path from 'node:path'
import type Parser from 'tree-sitter'
import { collectSymbolDefs, disambiguate, parseSource } from '../symbols.js'
import { symbolEdgeParserFor } from '../symbol-edges.js'
import { resolveInPackage } from './extract.js'

// A package's export table (dependency-inventory.md §5): which of its symbols an
// import of it lands on. Pure over the package's files and manifest. Resolves the
// clean cases only, and leaves the rest unresolved rather than guessed:
//
// - entry files from `exports` (a string, a subpath map, condition objects, a
//   single `*` pattern) or `main`, else `index`
// - CommonJS `module.exports = <fn | class | identifier | { a, b: c }>`, chained
//   (`exports = module.exports = fn`), and `exports.x = …` / `module.exports.x = …`
// - ESM `export function / class / const`, `export { a as b }`, `export default`
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

/** One module file's exports: export name → the symbol it names. `default` is the whole module value. */
export function moduleExports(
  root: Parser.SyntaxNode,
  file: string,
  follow: (specifier: string) => Map<string, ExportTarget> | null = () => null,
): Map<string, ExportTarget> {
  const defs = disambiguate(collectSymbolDefs(root))
  const bareCount = new Map<string, number>()
  for (const { def } of defs) {
    if (!def.qualname.includes('.')) bareCount.set(def.qualname, (bareCount.get(def.qualname) ?? 0) + 1)
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
  // A value an export names: a function or class written in place, an
  // identifier naming exactly one top-level definition in the file, or a local
  // module it requires.
  const targetOf = (value: Parser.SyntaxNode | null): ExportTarget | null => {
    if (!value) return null
    if (FUNCTION_LIKE.has(value.type) || value.type === 'class_declaration' || value.type === 'function_declaration') {
      return defOf(value)
    }
    if (value.type === 'identifier' || value.type === 'shorthand_property_identifier') {
      if (bareCount.get(value.text) === 1) return { file, qualname: value.text }
      const req = required.get(value.text)
      return req ? (follow(req.specifier)?.get(req.name) ?? null) : null
    }
    const req = localRequire(value)
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
          const req = localRequire(value)
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

  for (const stmt of root.namedChildren) {
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
  return out
}

