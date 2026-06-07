import path from 'node:path'
import { promises as fs } from 'node:fs'
import Parser from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import Python from 'tree-sitter-python'
import type { GraphEdge } from '@neat.is/types'
import {
  EdgeType,
  Provenance,
  confidenceForExtracted,
  extractedEdgeId,
  fileId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import { isTestPath, type DiscoveredService } from './shared.js'
import { recordExtractionError } from './errors.js'
import { loadSourceFiles, toPosix } from './calls/shared.js'

// Phase 2 — import graph extraction (ADR-092, file-awareness.md §10). Walks
// every source file's AST for import / require statements and emits IMPORTS
// edges between FileNodes within the same service. Cross-service and
// unresolvable specifiers are silent skips — Phase 3's CALLS producers cover
// the cross-service case where an external-call pattern matches.

// Same chunked-parse approach as calls/shared.ts — tree-sitter's bare string
// path throws "Invalid argument" once the source clears ~32K code units. The
// callback form streams the source in bounded slices instead.
const PARSE_CHUNK = 16384

function parseSource(parser: Parser, source: string): Parser.Tree {
  return parser.parse((index: number) =>
    index >= source.length ? '' : source.slice(index, index + PARSE_CHUNK),
  )
}

function makeJsParser(): Parser {
  const p = new Parser()
  p.setLanguage(JavaScript)
  return p
}

function makePyParser(): Parser {
  const p = new Parser()
  p.setLanguage(Python)
  return p
}

// ── string-literal text ────────────────────────────────────────────────────

// The interior text of a string literal node, stripped of quote characters.
// tree-sitter-javascript wraps the content in a `string_fragment` child;
// fall back to slicing the raw text when that shape isn't present (e.g. an
// empty string literal has no fragment child at all).
function stringLiteralText(node: Parser.SyntaxNode): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child?.type === 'string_fragment') return child.text
  }
  const raw = node.text
  if (raw.length >= 2) return raw.slice(1, -1)
  return raw.length === 0 ? null : ''
}

function clipSnippet(text: string): string {
  const oneLine = text.split('\n')[0] ?? text
  return oneLine.length > 120 ? oneLine.slice(0, 120) : oneLine
}

// ── JS / TS import collection ──────────────────────────────────────────────

interface RawImport {
  specifier: string
  line: number // 1-indexed
  snippet: string
}

// Walks the AST for `import ... from 'spec'` / `import 'spec'` (ES modules)
// and `require('spec')` (CommonJS). Doesn't recurse into import_statement —
// its only string child is the source specifier, never a nested import.
function collectJsImports(node: Parser.SyntaxNode, out: RawImport[]): void {
  if (node.type === 'import_statement') {
    const source = node.childForFieldName('source')
    if (source) {
      const specifier = stringLiteralText(source)
      if (specifier) {
        out.push({ specifier, line: node.startPosition.row + 1, snippet: clipSnippet(node.text) })
      }
    }
    return
  }

  if (node.type === 'call_expression') {
    const fn = node.childForFieldName('function')
    if (fn?.type === 'identifier' && fn.text === 'require') {
      const args = node.childForFieldName('arguments')
      const firstArg = args?.namedChild(0)
      if (firstArg?.type === 'string') {
        const specifier = stringLiteralText(firstArg)
        if (specifier) {
          out.push({ specifier, line: node.startPosition.row + 1, snippet: clipSnippet(node.text) })
        }
      }
    }
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (child) collectJsImports(child, out)
  }
}

// ── Python import collection ───────────────────────────────────────────────

interface RawPyImport {
  modulePath: string // dotted path with the leading dots stripped, e.g. 'utils.auth'
  level: number // count of leading dots; 0 = absolute import
  line: number
  snippet: string
}

// Walks the AST for `from X import ...` / `from .X import ...`. Bare `import
// X` statements name modules without resolving to a single file (`import
// os.path` doesn't tell us which file in `os` got used), so Phase 2 limits
// itself to the `from`-form per the resolution rules in the contract.
function collectPyImports(node: Parser.SyntaxNode, out: RawPyImport[]): void {
  if (node.type === 'import_from_statement') {
    let level = 0
    let modulePath = ''
    let pastFrom = false

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (!child) continue
      if (!pastFrom) {
        if (child.type === 'from') pastFrom = true
        continue
      }
      if (child.type === 'import') break

      if (child.type === 'relative_import') {
        for (let j = 0; j < child.childCount; j++) {
          const rc = child.child(j)
          if (!rc) continue
          // tree-sitter-python groups every leading dot into a single
          // import_prefix node — `..` parses as one import_prefix with two
          // `.` children, not two import_prefix nodes. Count the `.` tokens,
          // not the prefix nodes, or multi-dot imports under-count `level`
          // and resolve onto the wrong (sometimes self) target (#457).
          if (rc.type === 'import_prefix') {
            for (let k = 0; k < rc.childCount; k++) {
              if (rc.child(k)?.type === '.') level++
            }
          } else if (rc.type === 'dotted_name') modulePath = rc.text
        }
        break
      }
      if (child.type === 'dotted_name') {
        modulePath = child.text
        break
      }
    }

    if (level > 0 || modulePath) {
      out.push({ modulePath, level, line: node.startPosition.row + 1, snippet: clipSnippet(node.text) })
    }
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (child) collectPyImports(child, out)
  }
}

// ── filesystem resolution helpers ──────────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

// An import that escapes the service directory (`../../other-service/x`)
// isn't an intra-service edge — Phase 2 is scoped to within-service module
// dependencies (file-awareness.md §10).
function isWithinServiceDir(candidate: string, serviceDir: string): boolean {
  const rel = path.relative(serviceDir, candidate)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const JS_INDEX_FILES = JS_EXTENSIONS.map((ext) => `index${ext}`)

// Try `base`, `base.<ext>`, and `base/index.<ext>` in TypeScript-resolution
// order. Returns the service-relative posix path of the first hit.
async function firstExistingCandidate(
  base: string,
  serviceDir: string,
): Promise<string | null> {
  for (const ext of JS_EXTENSIONS) {
    const candidate = base + ext
    if (isWithinServiceDir(candidate, serviceDir) && (await fileExists(candidate))) {
      return toPosix(path.relative(serviceDir, candidate))
    }
  }
  for (const indexFile of JS_INDEX_FILES) {
    const candidate = path.join(base, indexFile)
    if (isWithinServiceDir(candidate, serviceDir) && (await fileExists(candidate))) {
      return toPosix(path.relative(serviceDir, candidate))
    }
  }
  return null
}

interface TsPathConfig {
  paths: Record<string, string[]>
  baseDir: string // absolute directory compilerOptions.baseUrl resolves against
}

// `tsconfig.json` at the service root. The contract names scanPath as a
// fallback location too, but every discovered service already carries its own
// root — the scanPath fallback only matters for configs that live above the
// service tree, which the resolver doesn't have a path back to from here.
async function loadTsPathConfig(serviceDir: string): Promise<TsPathConfig | null> {
  const tsconfigPath = path.join(serviceDir, 'tsconfig.json')
  let raw: string
  try {
    raw = await fs.readFile(tsconfigPath, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as {
      compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string }
    }
    const paths = parsed.compilerOptions?.paths
    if (!paths || Object.keys(paths).length === 0) return null
    const baseUrl = parsed.compilerOptions?.baseUrl
    return { paths, baseDir: baseUrl ? path.resolve(serviceDir, baseUrl) : serviceDir }
  } catch (err) {
    recordExtractionError('import alias resolution', tsconfigPath, err)
    return null
  }
}

// Resolve a bare specifier against `compilerOptions.paths`. Matches the first
// alias whose pattern fits — exact (`@db`) or wildcard (`@db/*`) — and tries
// each mapped target in declaration order. No match anywhere → null, the
// silent-skip the contract calls for.
async function resolveTsAlias(
  specifier: string,
  config: TsPathConfig,
  serviceDir: string,
): Promise<string | null> {
  for (const [pattern, targets] of Object.entries(config.paths)) {
    let suffix: string | null = null
    if (pattern === specifier) {
      suffix = ''
    } else if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1) // keep the trailing '/'
      if (specifier.startsWith(prefix)) suffix = specifier.slice(prefix.length)
    }
    if (suffix === null) continue

    for (const target of targets) {
      const targetBase = target.endsWith('/*') ? target.slice(0, -2) : target.replace(/\*$/, '')
      const resolvedBase = path.resolve(config.baseDir, targetBase, suffix)
      const hit = await firstExistingCandidate(resolvedBase, serviceDir)
      if (hit) return hit
      // The candidate may already carry its own extension (`@db/mongo.ts`).
      if (isWithinServiceDir(resolvedBase, serviceDir) && (await fileExists(resolvedBase))) {
        return toPosix(path.relative(serviceDir, resolvedBase))
      }
    }
  }
  return null
}

// Resolves a JS/TS module specifier to a service-relative posix path, or
// null when it names something outside the service (node_modules, Node
// builtins, an alias with no tsconfig match, an escaping relative path).
async function resolveJsImport(
  specifier: string,
  importerDir: string,
  serviceDir: string,
  tsPaths: TsPathConfig | null,
): Promise<string | null> {
  if (!specifier) return null

  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const base = path.resolve(importerDir, specifier)
    const ext = path.extname(specifier)

    if (ext) {
      // `./foo.js` written against a `.ts` source — the TypeScript ESM
      // convention of naming the post-build extension in source. Try the
      // TS sibling before the literal path.
      if (ext === '.js' || ext === '.jsx') {
        const tsExt = ext === '.jsx' ? '.tsx' : '.ts'
        const tsSibling = base.slice(0, -ext.length) + tsExt
        if (isWithinServiceDir(tsSibling, serviceDir) && (await fileExists(tsSibling))) {
          return toPosix(path.relative(serviceDir, tsSibling))
        }
      }
      if (isWithinServiceDir(base, serviceDir) && (await fileExists(base))) {
        return toPosix(path.relative(serviceDir, base))
      }
      return null
    }

    return firstExistingCandidate(base, serviceDir)
  }

  // Bare specifier — only a registered TS path alias can make this
  // intra-service. Anything else is node_modules / a Node builtin.
  if (tsPaths) return resolveTsAlias(specifier, tsPaths, serviceDir)
  return null
}

// Resolves a Python `from`-import to a service-relative posix path.
// Relative imports (level > 0) walk up from the importing module's directory;
// absolute imports match against the service source tree directly.
async function resolvePyImport(
  imp: RawPyImport,
  importerPath: string,
  serviceDir: string,
): Promise<string | null> {
  if (!imp.modulePath) return null // bare `from . import x` names a package, not a file

  const relPath = imp.modulePath.split('.').join('/')
  let baseDir: string
  if (imp.level > 0) {
    baseDir = path.dirname(importerPath)
    for (let i = 1; i < imp.level; i++) baseDir = path.dirname(baseDir)
  } else {
    baseDir = serviceDir
  }

  const candidates = [path.join(baseDir, `${relPath}.py`), path.join(baseDir, relPath, '__init__.py')]
  for (const candidate of candidates) {
    if (isWithinServiceDir(candidate, serviceDir) && (await fileExists(candidate))) {
      return toPosix(path.relative(serviceDir, candidate))
    }
  }
  return null
}

// ── edge emission ──────────────────────────────────────────────────────────

function emitImportEdge(
  graph: NeatGraph,
  serviceName: string,
  importerFileId: string,
  importerRelPath: string,
  importeeRelPath: string,
  line: number,
  snippet: string,
): number {
  const importeeFileId = fileId(serviceName, importeeRelPath)
  // Phase 1 enumerates every source file unconditionally; a resolved path
  // that isn't a FileNode is outside SERVICE_FILE_EXTENSIONS or otherwise
  // wasn't walked — not an intra-service module edge.
  if (!graph.hasNode(importeeFileId)) return 0

  const edgeId = extractedEdgeId(importerFileId, importeeFileId, EdgeType.IMPORTS)
  if (graph.hasEdge(edgeId)) return 0

  const edge: GraphEdge = {
    id: edgeId,
    source: importerFileId,
    target: importeeFileId,
    type: EdgeType.IMPORTS,
    provenance: Provenance.EXTRACTED,
    confidence: confidenceForExtracted('structural'),
    evidence: { file: importerRelPath, line, snippet },
  }
  graph.addEdgeWithKey(edgeId, importerFileId, importeeFileId, edge)
  return 1
}

// ── producer ───────────────────────────────────────────────────────────────

export async function addImports(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  const jsParser = makeJsParser()
  const pyParser = makePyParser()
  let edgesAdded = 0

  for (const service of services) {
    const tsPaths = await loadTsPathConfig(service.dir)
    const files = await loadSourceFiles(service.dir)

    for (const file of files) {
      // ADR-065 §1 — test-scope exclusion. The file stays a FileNode (Phase 1);
      // only its outbound module edges are filtered (file-awareness.md §10).
      if (isTestPath(file.path)) continue

      const relFile = toPosix(path.relative(service.dir, file.path))
      const importerFileId = fileId(service.pkg.name, relFile)
      const isPython = path.extname(file.path) === '.py'

      if (isPython) {
        let pyImports: RawPyImport[] = []
        try {
          const tree = parseSource(pyParser, file.content)
          collectPyImports(tree.rootNode, pyImports)
        } catch (err) {
          recordExtractionError('import extraction', file.path, err)
          continue
        }
        for (const imp of pyImports) {
          const resolved = await resolvePyImport(imp, file.path, service.dir)
          if (!resolved) continue
          edgesAdded += emitImportEdge(
            graph,
            service.pkg.name,
            importerFileId,
            relFile,
            resolved,
            imp.line,
            imp.snippet,
          )
        }
        continue
      }

      let jsImports: RawImport[] = []
      try {
        const tree = parseSource(jsParser, file.content)
        collectJsImports(tree.rootNode, jsImports)
      } catch (err) {
        recordExtractionError('import extraction', file.path, err)
        continue
      }
      for (const imp of jsImports) {
        const resolved = await resolveJsImport(imp.specifier, path.dirname(file.path), service.dir, tsPaths)
        if (!resolved) continue
        edgesAdded += emitImportEdge(
          graph,
          service.pkg.name,
          importerFileId,
          relFile,
          resolved,
          imp.line,
          imp.snippet,
        )
      }
    }
  }

  return { nodesAdded: 0, edgesAdded }
}
