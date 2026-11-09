import path from 'node:path'
import Parser from 'tree-sitter'
import semver from 'semver'
import {
  SYMBOL_GRAMMAR_BY_EXT,
  collectGoSymbolDefs,
  collectPythonSymbolDefs,
  collectSymbolDefs,
  disambiguate,
  parseSource,
  type SymbolDef,
} from '../extract/symbols.js'
import { comparePep440, parsePep440 } from './pep440.js'

// The fix-diff (ADR-274, advisory-cache.md §4): what the release that fixed an
// advisory changed, at symbol grain, computed with NEAT's own symbol extraction
// (ADR-158) over the last affected and first fixed releases. This module is
// pure: it takes the two releases' source files in memory and returns the set.
// Fetching releases is the registry/cache module's job, not this one's.

export type ChangeStatus = 'modified' | 'new' | 'removed'

export interface ChangedSymbol {
  // The symbol's qualname, as NEAT's extractor names it (`Parser.parse`, `template`).
  symbol: string
  // Package-relative path of the file it's in.
  file: string
  kind: string
  status: ChangeStatus
  // The symbol's name appears in the advisory's summary or details. A ranking
  // hint only, never a filter (advisory-cache.md §4).
  namedInAdvisory: boolean
}

export interface FixDiff {
  from: string
  to: string
  changed: ChangedSymbol[]
}

// What counts as the package's own source: no tests, examples, docs, vendored
// copies or build output. Those either never run in a consumer or duplicate the
// real source, and would inflate the changed set with noise.
const SKIP_DIRS = new Set([
  'test', 'tests', '__tests__', 'testdata', 'testing', 'example', 'examples', '_examples', 'doc', 'docs',
  'benchmark', 'benchmarks', 'bench', 'vendor', 'node_modules', 'dist', 'fixtures', '.github',
])
const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go'])

export function isPackageSource(relPath: string): boolean {
  const parts = relPath.split('/')
  if (parts.slice(0, -1).some((d) => SKIP_DIRS.has(d))) return false
  const base = parts[parts.length - 1] ?? ''
  if (!SOURCE_EXTS.has(path.extname(base))) return false
  if (base.endsWith('.d.ts') || /\.min\.js$/.test(base) || /\.bundle\.js$/.test(base)) return false
  if (/_test\.go$/.test(base) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return false
  if (/^test_.*\.py$/.test(base) || /_test\.py$/.test(base) || base === 'conftest.py') return false
  return true
}

interface SymbolBody {
  file: string
  qualname: string
  kind: string
  // The symbol's own tokens: leaves inside its span that don't belong to a nested
  // symbol, without comments or type annotations. Joined, so equality is a string
  // compare and formatting-only churn doesn't count as a change.
  tokens: string
}

const parsers = new Map<string, Parser>()
function parserFor(ext: string): Parser | null {
  const grammar = SYMBOL_GRAMMAR_BY_EXT[ext]
  if (!grammar) return null
  let p = parsers.get(ext)
  if (!p) {
    p = new Parser()
    p.setLanguage(grammar)
    parsers.set(ext, p)
  }
  return p
}

function collect(ext: string, root: Parser.SyntaxNode): SymbolDef[] {
  if (ext === '.py') return collectPythonSymbolDefs(root)
  if (ext === '.go') return collectGoSymbolDefs(root)
  return collectSymbolDefs(root)
}

function excluded(ext: string, n: Parser.SyntaxNode): boolean {
  if (n.type === 'comment' || n.type === 'html_comment') return true
  if ((ext === '.ts' || ext === '.tsx') && n.type === 'type_annotation') return true
  if (ext === '.py') {
    if (n.type === 'type') return true
    // A docstring is a bare string statement: an expression_statement whose sole
    // child is a string literal. Python's docstring is the leading such statement
    // of a module/class/function body; a bare string elsewhere is inert, so
    // excluding all of them never hides a behavioral change and keeps the diff off
    // docstring churn (advisory-cache.md §4). JS/Go docstrings are comments,
    // already handled above.
    if (n.type === 'expression_statement' && n.namedChildCount === 1) {
      const child = n.namedChild(0)!.type
      if (child === 'string' || child === 'concatenated_string') return true
    }
  }
  return false
}

function symbolsOfFile(file: string, source: string): SymbolBody[] {
  const ext = path.extname(file)
  const parser = parserFor(ext)
  if (!parser) return []
  const root = parseSource(parser, source).rootNode
  const defs = disambiguate(collect(ext, root))
  const bySpan = new Map<string, number>()
  defs.forEach(({ def }, i) => bySpan.set(`${def.startIndex}:${def.endIndex}`, i))
  const tokens: string[][] = defs.map(() => [])
  // Each leaf goes to the innermost symbol whose span contains it.
  const walk = (n: Parser.SyntaxNode, owner: number) => {
    if (excluded(ext, n)) return
    const own = bySpan.get(`${n.startIndex}:${n.endIndex}`)
    const cur = own ?? owner
    if (n.childCount === 0) {
      if (cur >= 0) tokens[cur]!.push(n.text)
      return
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i)!, cur)
  }
  walk(root, -1)
  return defs.map(({ def, disambiguator }, i) => ({
    file,
    qualname: disambiguator !== undefined ? `${def.qualname}~${disambiguator}` : def.qualname,
    kind: def.kind,
    tokens: tokens[i]!.join('\u0001'),
  }))
}

function symbolsOf(files: Map<string, string>): Map<string, SymbolBody> {
  const out = new Map<string, SymbolBody>()
  for (const [file, source] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!isPackageSource(file)) continue
    for (const s of symbolsOfFile(file, source)) out.set(`${s.file}#${s.qualname}`, s)
  }
  return out
}

/** One symbol of a package's own source, as both the fix-diff and the graph see it. */
export interface PackageSymbol {
  file: string
  qualname: string
  disambiguator?: number
  kind: SymbolDef['kind']
  startLine: number
  endLine: number
}

/**
 * Every symbol in a package's own source (`isPackageSource`), from the same
 * parser, collector and disambiguation the fix-diff runs, so a changed symbol and
 * the graph's dependency SymbolNode for it name the same thing. Pure and
 * deterministic: files in path order, symbols in source order.
 */
export function packageSymbols(files: Map<string, string>): PackageSymbol[] {
  const out: PackageSymbol[] = []
  for (const [file, source] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!isPackageSource(file)) continue
    const ext = path.extname(file)
    const parser = parserFor(ext)
    if (!parser) continue
    for (const { def, disambiguator } of disambiguate(collect(ext, parseSource(parser, source).rootNode))) {
      out.push({
        file,
        qualname: def.qualname,
        ...(disambiguator !== undefined ? { disambiguator } : {}),
        kind: def.kind,
        startLine: def.startLine,
        endLine: def.endLine,
      })
    }
  }
  return out
}

function namedIn(qualname: string, text: string): boolean {
  const name = qualname.replace(/~\d+$/, '').split('.').pop() ?? qualname
  if (name.length < 3) return false
  return new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/\$/g, '\\$')}([^A-Za-z0-9_]|$)`).test(text)
}

/**
 * The symbols a fix release changed: modified (own tokens differ), new in `to`,
 * or removed in `to`. Class-kind symbols are left out, because their methods
 * carry the change. Deterministic: the same two file sets always give the same
 * result, in the same order.
 */
export function computeFixDiff(
  from: { version: string; files: Map<string, string> },
  to: { version: string; files: Map<string, string> },
  advisoryText: string,
): FixDiff {
  const [a, b] = [symbolsOf(from.files), symbolsOf(to.files)]
  const changed: ChangedSymbol[] = []
  const push = (s: SymbolBody, status: ChangeStatus) => {
    if (s.kind === 'class') return
    changed.push({
      symbol: s.qualname,
      file: s.file,
      kind: s.kind,
      status,
      namedInAdvisory: namedIn(s.qualname, advisoryText),
    })
  }
  for (const [key, s] of b) {
    const old = a.get(key)
    if (!old) push(s, 'new')
    else if (old.tokens !== s.tokens) push(s, 'modified')
  }
  for (const [key, s] of a) if (!b.has(key)) push(s, 'removed')
  changed.sort(
    (x, y) => x.file.localeCompare(y.file) || x.symbol.localeCompare(y.symbol) || x.status.localeCompare(y.status),
  )
  return { from: from.version, to: to.version, changed }
}

/**
 * The release pair to diff (advisory-cache.md §4): `to` is the first fixed
 * version, `from` is the newest stable release below it. Returns null when no
 * such release exists, or when it would fall below the range's `introduced`
 * bound (the fix landed in the first affected release, so there's nothing
 * unaffected to diff against).
 */
export function fixDiffPair(
  ecosystem: string,
  published: string[],
  fixed: string,
  introduced: string,
): { from: string; to: string } | null {
  const cmp = ecosystem === 'PyPI' ? pep440Cmp : semverCmp
  const stable = ecosystem === 'PyPI' ? isStablePep440 : isStableSemver
  const below = published.filter((v) => stable(v) && cmp(v, fixed) !== null && cmp(v, fixed)! < 0)
  below.sort((x, y) => cmp(x, y) ?? 0)
  const from = below[below.length - 1]
  if (!from) return null
  if (introduced !== '0' && (cmp(from, introduced) ?? -1) < 0) return null
  return { from, to: fixed }
}

function semverCmp(a: string, b: string): number | null {
  const [x, y] = [semver.parse(a.replace(/^v/, '')), semver.parse(b.replace(/^v/, ''))]
  return x && y ? semver.compare(x, y) : null
}
function isStableSemver(v: string): boolean {
  const p = semver.parse(v.replace(/^v/, ''))
  return !!p && p.prerelease.length === 0
}
function pep440Cmp(a: string, b: string): number | null {
  const [x, y] = [parsePep440(a), parsePep440(b)]
  return x && y ? comparePep440(x, y) : null
}
function isStablePep440(v: string): boolean {
  const p = parsePep440(v)
  return !!p && p.pre === null && p.dev === null
}
