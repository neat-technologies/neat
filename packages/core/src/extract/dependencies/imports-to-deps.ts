import path from 'node:path'
import type Parser from 'tree-sitter'
import type { DependencyNode, GraphEdge } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  extractedEdgeId,
  fileId,
  isDependencyNodeId,
} from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { isTestPath, type DiscoveredService } from '../shared.js'
import { recordExtractionError } from '../errors.js'
import { loadSourceFiles, toPosix } from '../calls/shared.js'
import {
  collectGoImports,
  collectJsImports,
  collectPyBareImports,
  collectPyImports,
  loadTsPathConfig,
  makeGoParser,
  makeJsParser,
  makePyParser,
  parseSource,
  resolveJsImport,
  type RawImport,
  type RawPyImport,
} from '../imports.js'
import { normalizePypiName } from './resolved.js'
import { findPythonDistribution, pythonTopLevelModules } from '../dependency-symbols/locate.js'

// First-party imports of a package become EXTRACTED `file ──IMPORTS──▶ dep:`
// edges (ADR-274, dependency-inventory.md §4). This is the `imported`
// reachability level: the finding's package is pulled into code the service
// runs, not just sitting in the lockfile. Runs after addDependencies, since it
// matches imports against the DependencyNodes that phase minted.
//
// Matching only ever lands on a package the service declares, so first-party
// imports filter themselves out. The producer owns its edges: every pass drops a
// service's file→dep IMPORTS edges and rebuilds them.

interface Hit {
  depId: string
  line: number
  snippet: string
  specifier: string
  bindings: string[]
}

// One service's dependency versions by ecosystem and name. A name with several
// versions (a transitive duplicate) resolves to the direct one; with no direct
// one there's no telling which copy an import gets, so that name is left out
// rather than guessed.
function depsOf(graph: NeatGraph, serviceId: string): Map<string, Map<string, string>> {
  const byName = new Map<string, Map<string, { id: string; direct: boolean }[]>>()
  graph.forEachOutEdge(serviceId, (_e, attrs, _src, target) => {
    const edge = attrs as GraphEdge
    if (edge.type !== EdgeType.DEPENDS_ON || !isDependencyNodeId(target)) return
    const dep = graph.getNodeAttributes(target) as DependencyNode
    if (dep.type !== NodeType.DependencyNode) return
    const eco = byName.get(dep.ecosystem) ?? new Map()
    byName.set(dep.ecosystem, eco)
    const name = dep.ecosystem === 'PyPI' ? normalizePypiName(dep.name) : dep.name
    const list = eco.get(name) ?? []
    list.push({ id: target, direct: edge.dependency?.scope === 'direct' })
    eco.set(name, list)
  })
  const out = new Map<string, Map<string, string>>()
  for (const [eco, names] of byName) {
    const picked = new Map<string, string>()
    for (const [name, list] of names) {
      const direct = list.filter((d) => d.direct)
      if (direct.length === 1) picked.set(name, direct[0]!.id)
      else if (list.length === 1) picked.set(name, list[0]!.id)
    }
    out.set(eco, picked)
  }
  return out
}

// `lodash/template` → `lodash`, `@scope/pkg/sub` → `@scope/pkg`. Null for a
// relative, absolute or `node:` specifier, none of which is a package.
function npmPackageName(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return null
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null
  return parts[0] || null
}

// `import type` carries no runtime code, so it doesn't make a package reachable.
const TYPE_ONLY = /^import\s+type[\s{]/

async function jsHits(
  imports: RawImport[],
  deps: Map<string, string>,
  importerDir: string,
  service: DiscoveredService,
  tsPaths: Awaited<ReturnType<typeof loadTsPathConfig>>,
): Promise<Hit[]> {
  const hits: Hit[] = []
  for (const imp of imports) {
    if (TYPE_ONLY.test(imp.snippet)) continue
    const name = npmPackageName(imp.specifier)
    if (!name) continue
    const depId = deps.get(name)
    if (!depId) continue
    // A tsconfig path alias that resolves inside the service is first-party,
    // even when its prefix looks like a package name.
    if ((await resolveJsImport(imp.specifier, importerDir, service.dir, tsPaths)) !== null) continue
    hits.push({ depId, line: imp.line, snippet: imp.snippet, specifier: imp.specifier, bindings: imp.bindings ?? [] })
  }
  return hits
}

function pyHits(imports: RawPyImport[], deps: Map<string, string>): Hit[] {
  const hits: Hit[] = []
  for (const imp of imports) {
    if (imp.level > 0 || !imp.modulePath) continue
    // The top-level module name, matched to the distribution name or, when the
    // distribution is installed, to the import names it provides. A module that
    // matches neither gets no edge.
    const top = normalizePypiName(imp.modulePath.split('.')[0]!)
    const depId = deps.get(top)
    if (!depId) continue
    hits.push({ depId, line: imp.line, snippet: imp.snippet, specifier: imp.modulePath, bindings: imp.bindings ?? [] })
  }
  return hits
}

// The longest declared module path that is the import path or a prefix of it at
// a `/` boundary: `github.com/a/b/sub` belongs to module `github.com/a/b`.
function goHits(imports: RawImport[], deps: Map<string, string>): Hit[] {
  const names = [...deps.keys()].sort((a, b) => b.length - a.length)
  const hits: Hit[] = []
  for (const imp of imports) {
    const mod = names.find((n) => imp.specifier === n || imp.specifier.startsWith(n + '/'))
    if (!mod) continue
    hits.push({ depId: deps.get(mod)!, line: imp.line, snippet: imp.snippet, specifier: imp.specifier, bindings: imp.bindings ?? [] })
  }
  return hits
}

function parseWith<T>(parser: Parser, source: string, collect: (root: Parser.SyntaxNode, out: T[]) => void, out: T[]): void {
  collect(parseSource(parser, source).rootNode, out)
}

// PyPI distributions whose import name isn't their own (`yaml` from PyYAML, `PIL`
// from Pillow), read from the installed copy's `top_level.txt` or RECORD. A
// module two installed distributions both claim (a namespace package) is left
// unmatched rather than given to either.
async function addPypiModuleNames(
  pypi: Map<string, string>,
  graph: NeatGraph,
  serviceDir: string,
  scanPath: string,
): Promise<Map<string, string>> {
  const claims = new Map<string, Set<string>>()
  for (const depId of [...new Set(pypi.values())].sort()) {
    const dep = graph.getNodeAttributes(depId) as DependencyNode
    const dist = await findPythonDistribution(dep, [serviceDir], scanPath)
    if (!dist) continue
    for (const mod of await pythonTopLevelModules(dist)) {
      const key = normalizePypiName(mod)
      const set = claims.get(key) ?? new Set<string>()
      set.add(depId)
      claims.set(key, set)
    }
  }
  const out = new Map(pypi)
  for (const [key, ids] of claims) {
    if (!out.has(key) && ids.size === 1) out.set(key, [...ids][0]!)
  }
  return out
}

export async function addDependencyImports(
  graph: NeatGraph,
  services: DiscoveredService[],
  scanPath?: string,
): Promise<{ edgesAdded: number; edgesRemoved: number }> {
  const jsParser = makeJsParser()
  const pyParser = makePyParser()
  const goParser = makeGoParser()
  let edgesAdded = 0
  let edgesRemoved = 0

  for (const service of services) {
    const svcName = service.pkg.name
    if (!svcName || !graph.hasNode(service.node.id)) continue

    // This service's file→dep IMPORTS edges from earlier passes. The ones this pass
    // mints again are updated in place; whatever is left at the end is dropped.
    const filePrefix = fileId(svcName, '')
    const stale = new Set<string>()
    graph.forEachEdge((id, attrs, source, target) => {
      const e = attrs as GraphEdge
      if (e.type === EdgeType.IMPORTS && e.provenance === Provenance.EXTRACTED && isDependencyNodeId(target) && source.startsWith(filePrefix)) {
        stale.add(id)
      }
    })
    const dropStale = () => {
      for (const id of stale) graph.dropEdge(id)
      edgesRemoved += stale.size
    }

    const deps = depsOf(graph, service.node.id)
    if (deps.size === 0) {
      dropStale()
      continue
    }
    const npm = deps.get('npm') ?? new Map<string, string>()
    const pypiByDist = deps.get('PyPI') ?? new Map<string, string>()
    const pypi = pypiByDist.size
      ? await addPypiModuleNames(pypiByDist, graph, service.dir, scanPath ?? service.dir)
      : pypiByDist
    const golang = deps.get('Go') ?? new Map<string, string>()
    const tsPaths = npm.size ? await loadTsPathConfig(service.dir) : null
    const files = await loadSourceFiles(service.dir, service.excludeDirs)

    for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      // Test files don't make a package reachable from what runs (ADR-065 §1).
      if (isTestPath(file.path)) continue
      const relFile = toPosix(path.relative(service.dir, file.path))
      const importer = fileId(svcName, relFile)
      if (!graph.hasNode(importer)) continue
      const ext = path.extname(file.path)

      let hits: Hit[]
      try {
        if (ext === '.py') {
          if (!pypi.size) continue
          const imports: RawPyImport[] = []
          parseWith(pyParser, file.content, collectPyImports, imports)
          parseWith(pyParser, file.content, collectPyBareImports, imports)
          hits = pyHits(imports, pypi)
        } else if (ext === '.go') {
          if (!golang.size) continue
          const imports: RawImport[] = []
          parseWith(goParser, file.content, collectGoImports, imports)
          hits = goHits(imports, golang)
        } else if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'].includes(ext)) {
          if (!npm.size) continue
          const imports: RawImport[] = []
          parseWith(jsParser, file.content, collectJsImports, imports)
          hits = await jsHits(imports, npm, path.dirname(file.path), service, tsPaths)
        } else continue
      } catch (err) {
        recordExtractionError('dependency imports', file.path, err)
        continue
      }

      // One edge per (file, dependency): the earliest line, every binding.
      const perDep = new Map<string, Hit>()
      for (const h of hits) {
        const prev = perDep.get(h.depId)
        if (!prev) {
          perDep.set(h.depId, { ...h, bindings: [...h.bindings] })
          continue
        }
        const merged = [...prev.bindings, ...h.bindings]
        const first = h.line < prev.line ? h : prev
        perDep.set(h.depId, { ...first, bindings: merged })
      }

      for (const depId of [...perDep.keys()].sort()) {
        const h = perDep.get(depId)!
        const edgeId = extractedEdgeId(importer, depId, EdgeType.IMPORTS)
        const edge: GraphEdge = {
          id: edgeId,
          source: importer,
          target: depId,
          type: EdgeType.IMPORTS,
          provenance: Provenance.EXTRACTED,
          confidence: confidenceForExtracted('structural'),
          evidence: {
            file: relFile,
            line: h.line,
            snippet: h.snippet,
            specifier: h.specifier,
            bindings: [...new Set(h.bindings)].sort(),
          },
        }
        if (graph.hasEdge(edgeId)) {
          graph.replaceEdgeAttributes(edgeId, edge)
          stale.delete(edgeId)
          continue
        }
        graph.addEdgeWithKey(edgeId, importer, depId, edge)
        edgesAdded++
      }
    }
    dropStale()
  }
  return { edgesAdded, edgesRemoved }
}
