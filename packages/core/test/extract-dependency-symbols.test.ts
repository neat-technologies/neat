import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  dependencyId,
  dependencySymbolId,
  isDependencySymbolId,
  type GraphEdge,
  type GraphNode,
  type SymbolNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { discoverServices } from '../src/extract/services.js'
import {
  extractDependencyCode,
  dependencySymbolEdges,
  dependencySymbolGraph,
  locateInstalledSource,
  resolveInPackage,
} from '../src/extract/dependency-symbols/index.js'
import { computeFixDiff, packageSymbols } from '../src/advisories/fixdiff.js'

// dependency-inventory.md §5: an advisory-matched dependency's own symbols,
// owned by its DependencyNode.

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function tree(files: Record<string, unknown>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-dep-syms-'))
  dirs.push(root)
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  }
  return root
}

const lodash = { ecosystem: 'npm', name: 'lodash', version: '4.17.20' }
const lodashFiles = new Map([
  ['template.js', 'function template(s) { return s }\nfunction helper() {}\nmodule.exports = template\n'],
  ['lib/merge.js', 'class Merger { run() {} }\nexports.merge = function merge() {}\n'],
  ['test/template.test.js', 'function shouldNotAppear() {}\n'],
  ['docs/example.js', 'function nope() {}\n'],
  ['template.d.ts', 'export declare function template(s: string): string\n'],
])

describe('dependencySymbolGraph (pure)', () => {
  it('mints dep-owned symbols with dependency symbol ids, skipping tests, docs and typings', () => {
    const { nodes, edges } = dependencySymbolGraph(lodash, lodashFiles)
    const owner = dependencyId('npm', 'lodash', '4.17.20')
    expect(nodes.map((n) => n.id)).toEqual([
      dependencySymbolId('npm', 'lodash', '4.17.20', 'lib/merge.js', 'Merger'),
      dependencySymbolId('npm', 'lodash', '4.17.20', 'lib/merge.js', 'Merger.run'),
      dependencySymbolId('npm', 'lodash', '4.17.20', 'lib/merge.js', 'exports.merge'),
      dependencySymbolId('npm', 'lodash', '4.17.20', 'template.js', 'template'),
      dependencySymbolId('npm', 'lodash', '4.17.20', 'template.js', 'helper'),
    ])
    for (const n of nodes) {
      expect(n.type).toBe(NodeType.SymbolNode)
      expect(n.service).toBe(owner)
      expect(isDependencySymbolId(n.id)).toBe(true)
    }
    expect(nodes.find((n) => n.qualname === 'template')!.span).toEqual({ startLine: 1, endLine: 1 })
    expect(edges.every((e) => e.source === owner && e.type === EdgeType.CONTAINS)).toBe(true)
    expect(edges.map((e) => e.target)).toEqual(nodes.map((n) => n.id))
  })

  it('names the same symbols the fix-diff does', () => {
    const fixed = new Map(lodashFiles)
    fixed.set('template.js', 'function template(s) { return String(s) }\nfunction helper() {}\nmodule.exports = template\n')
    const diff = computeFixDiff({ version: '4.17.20', files: lodashFiles }, { version: '4.17.21', files: fixed }, '')
    const graphSyms = new Set(packageSymbols(lodashFiles).map((s) => `${s.file}#${s.qualname}`))
    expect(diff.changed.map((c) => `${c.file}#${c.symbol}`)).toEqual(['template.js#template'])
    for (const c of diff.changed) expect(graphSyms.has(`${c.file}#${c.symbol}`)).toBe(true)
  })

  it('is deterministic whatever order the files arrive in', () => {
    const reversed = new Map([...lodashFiles].reverse())
    expect(JSON.stringify(dependencySymbolGraph(lodash, reversed))).toBe(JSON.stringify(dependencySymbolGraph(lodash, lodashFiles)))
  })
})

describe('locateInstalledSource', () => {
  it('reads node_modules only when the installed version matches', async () => {
    const root = await tree({
      'node_modules/lodash/package.json': { name: 'lodash', version: '4.17.20' },
      'node_modules/lodash/template.js': 'function template() {}\n',
      'node_modules/lodash/node_modules/other/x.js': 'function x() {}\n',
      'app/package.json': { name: 'app' },
    })
    const found = await locateInstalledSource(lodash, [path.join(root, 'app')], root)
    expect([...found!.files.keys()]).toEqual(['template.js'])
    expect(await locateInstalledSource({ ...lodash, version: '4.17.21' }, [root], root)).toBeNull()
  })

  it('reads a PyPI distribution from its RECORD, under its own import name', async () => {
    const sp = '.venv/lib/python3.12/site-packages'
    const root = await tree({
      [`${sp}/PyYAML-6.0.2.dist-info/RECORD`]: 'yaml/__init__.py,sha256=x,10\nyaml/tests/test_x.py,,\n../../../bin/yamlx,,\nPyYAML-6.0.2.dist-info/METADATA,,\n',
      [`${sp}/PyYAML-6.0.2.dist-info/top_level.txt`]: '_yaml\nyaml\n',
      [`${sp}/yaml/__init__.py`]: 'def safe_load(stream):\n    return stream\n',
    })
    const found = await locateInstalledSource({ ecosystem: 'PyPI', name: 'pyyaml', version: '6.0.2' }, [root], root, {})
    expect([...found!.files.keys()]).toEqual(['yaml/__init__.py'])
  })

  it('reads the Go module cache, escaping uppercase in the module path', async () => {
    const cache = await tree({
      'github.com/!burnt!sushi/toml@v1.3.2/decode.go': 'package toml\n\nfunc Decode(s string) error { return nil }\n',
      'github.com/!burnt!sushi/toml@v1.3.2/decode_test.go': 'package toml\n\nfunc TestX() {}\n',
    })
    const found = await locateInstalledSource({ ecosystem: 'Go', name: 'github.com/BurntSushi/toml', version: '1.3.2' }, [], cache, { GOMODCACHE: cache })
    expect([...found!.files.keys()]).toEqual(['decode.go'])
  })
})

describe('extractDependencyCode', () => {
  async function project() {
    return tree({
      'package.json': { name: 'shop', main: 'index.js', dependencies: { lodash: '4.17.20' } },
      'package-lock.json': {
        name: 'shop',
        lockfileVersion: 3,
        packages: { '': { name: 'shop', dependencies: { lodash: '4.17.20' } }, 'node_modules/lodash': { version: '4.17.20' } },
      },
      'index.js': "const template = require('lodash/template')\nmodule.exports = template\n",
      'node_modules/lodash/package.json': { name: 'lodash', version: '4.17.20' },
      'node_modules/lodash/template.js': 'function template(s) { return s }\nfunction helper() {}\n',
    })
  }
  const owner = dependencyId('npm', 'lodash', '4.17.20')

  async function run(root: string, graph?: NeatGraph) {
    const g = graph ?? (new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false }) as NeatGraph)
    await extractFromDirectory(g, root, { announce: false })
    const r = await extractDependencyCode(g, await discoverServices(root), root, [owner])
    return { g, r }
  }

  it('adds only the asked-for versions, owned by the DependencyNode, and survives the ghost sweep', async () => {
    const root = await project()
    const { g, r } = await run(root)
    expect(r.nodesAdded).toBe(2)
    expect(g.outNeighbors(owner).filter(isDependencySymbolId).sort()).toEqual([
      dependencySymbolId('npm', 'lodash', '4.17.20', 'template.js', 'helper'),
      dependencySymbolId('npm', 'lodash', '4.17.20', 'template.js', 'template'),
    ])
    // no first-party service or file owns them
    for (const id of g.outNeighbors(owner).filter(isDependencySymbolId)) {
      expect(g.inNeighbors(id)).toEqual([owner])
      expect((g.getNodeAttributes(id) as SymbolNode).service).toBe(owner)
    }
    // a second full pass (which runs the ghost sweep) keeps them; re-adding is a no-op
    await extractFromDirectory(g, root, { announce: false })
    expect(g.outNeighbors(owner).filter(isDependencySymbolId)).toHaveLength(2)
    const again = await extractDependencyCode(g, await discoverServices(root), root, [owner])
    expect(again.nodesAdded + again.edgesAdded + again.nodesRemoved).toBe(0)
  })

  it('replaces a version symbol set, and drops it with the version', async () => {
    const root = await project()
    const { g } = await run(root)
    await fs.writeFile(path.join(root, 'node_modules/lodash/template.js'), 'function template(s) { return s }\n')
    const r = await extractDependencyCode(g, await discoverServices(root), root, [owner])
    expect(r.nodesRemoved).toBe(1)
    expect(g.outNeighbors(owner).filter(isDependencySymbolId)).toHaveLength(1)

    // lodash leaves the lockfile: the version and its code leave the graph
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'shop', main: 'index.js' }))
    await fs.writeFile(
      path.join(root, 'package-lock.json'),
      JSON.stringify({ name: 'shop', lockfileVersion: 3, packages: { '': { name: 'shop' } } }),
    )
    await extractFromDirectory(g, root, { announce: false })
    expect(g.hasNode(owner)).toBe(false)
    expect(g.nodes().filter(isDependencySymbolId)).toEqual([])
  })

  it('reports a version with no installed copy and mints nothing for it', async () => {
    const root = await project()
    await fs.rm(path.join(root, 'node_modules'), { recursive: true })
    const { g, r } = await run(root)
    expect(r.notLocated).toEqual([owner])
    expect(g.nodes().filter(isDependencySymbolId)).toEqual([])
  })
})

describe('PyPI import names from the installed distribution', () => {
  it('matches `import yaml` to PyYAML through top_level.txt', async () => {
    const sp = '.venv/lib/python3.12/site-packages'
    const root = await tree({
      'requirements.txt': 'PyYAML==6.0.2\n',
      'app/main.py': 'import yaml\n',
      [`${sp}/PyYAML-6.0.2.dist-info/RECORD`]: 'yaml/__init__.py,,\n',
      [`${sp}/PyYAML-6.0.2.dist-info/top_level.txt`]: 'yaml\n',
      [`${sp}/yaml/__init__.py`]: 'def safe_load(s):\n    return s\n',
    })
    const g = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false }) as NeatGraph
    await extractFromDirectory(g, root, { announce: false })
    const imports = g
      .edges()
      .map((id) => g.getEdgeAttributes(id) as GraphEdge)
      .filter((e) => e.type === EdgeType.IMPORTS && e.target.startsWith('dep:'))
    expect(imports.map((e) => [e.target, e.evidence!.specifier])).toEqual([[dependencyId('PyPI', 'pyyaml', '6.0.2'), 'yaml']])
  })
})

describe('package-internal calls (dependency-inventory.md §5)', () => {
  const pkg = { ecosystem: 'npm', name: 'acme', version: '1.0.0' }
  const id = (rel: string, q: string) => dependencySymbolId('npm', 'acme', '1.0.0', rel, q)
  const files = new Map([
    ['src/index.ts', "import { helper } from './util'\nexport function main() { return helper() + local() }\nfunction local() { return 1 }\n"],
    ['src/util.ts', 'export function helper() { return 2 }\nexport class Base {}\n'],
    ['src/child.ts', "import { Base } from './util.js'\nexport class Child extends Base {}\n"],
    ['lib/cjs.js', "const u = require('./u')\nfunction run() { return u.go() + inner() }\nfunction inner() { return 3 }\n"],
    ['lib/u.js', 'exports.go = function go() { return 4 }\n'],
    ['test/index.test.ts', "import { main } from '../src/index'\nfunction t() { main() }\n"],
  ])

  it('resolves same-file calls and named imports inside the package, never across it', async () => {
    const edges = await dependencySymbolEdges(pkg, files)
    expect(edges.map((e) => [e.type, e.source, e.target])).toEqual([
      ['CALLS', id('lib/cjs.js', 'run'), id('lib/cjs.js', 'inner')],
      ['INHERITS', id('src/child.ts', 'Child'), id('src/util.ts', 'Base')],
      ['CALLS', id('src/index.ts', 'main'), id('src/util.ts', 'helper')],
      ['CALLS', id('src/index.ts', 'main'), id('src/index.ts', 'local')],
    ])
    for (const e of edges) {
      expect(e.provenance).toBe('EXTRACTED')
      expect(isDependencySymbolId(e.source) && isDependencySymbolId(e.target)).toBe(true)
    }
    // the test file's call into main is not package code
    expect(edges.some((e) => e.evidence!.file.startsWith('test/'))).toBe(false)
  })

  it('resolves relative specifiers against the package files only', () => {
    const paths = new Set(['a/b.ts', 'a/c/index.js', 'x.js', 'y.ts'])
    expect(resolveInPackage(paths, './b', 'a/main.ts')).toBe('a/b.ts')
    expect(resolveInPackage(paths, './c', 'a/main.ts')).toBe('a/c/index.js')
    expect(resolveInPackage(paths, '../x.js', 'a/main.ts')).toBe('x.js')
    expect(resolveInPackage(paths, '../y.js', 'a/main.ts')).toBe('y.ts')
    expect(resolveInPackage(paths, 'lodash', 'a/main.ts')).toBeNull()
    expect(resolveInPackage(paths, '../../outside', 'a/main.ts')).toBeNull()
  })

  it('writes them with the symbols, and drops one that a later pass no longer finds', async () => {
    const root = await tree({
      'package.json': { name: 'shop', main: 'index.js', dependencies: { lodash: '4.17.20' } },
      'package-lock.json': {
        name: 'shop',
        lockfileVersion: 3,
        packages: { '': { name: 'shop', dependencies: { lodash: '4.17.20' } }, 'node_modules/lodash': { version: '4.17.20' } },
      },
      'index.js': "require('lodash')\n",
      'node_modules/lodash/package.json': { name: 'lodash', version: '4.17.20' },
      'node_modules/lodash/template.js': 'function template(s) { return helper(s) }\nfunction helper(s) { return s }\n',
    })
    const owner = dependencyId('npm', 'lodash', '4.17.20')
    const g = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false }) as NeatGraph
    await extractFromDirectory(g, root, { announce: false })
    await extractDependencyCode(g, await discoverServices(root), root, [owner])
    const call = `CALLS:${dependencySymbolId('npm', 'lodash', '4.17.20', 'template.js', 'template')}->${dependencySymbolId('npm', 'lodash', '4.17.20', 'template.js', 'helper')}`
    expect(g.edges().filter((e) => e.startsWith('CALLS:'))).toEqual([call])

    // a full pass with its ghost sweep keeps it
    await extractFromDirectory(g, root, { announce: false })
    expect(g.hasEdge(call)).toBe(true)

    await fs.writeFile(path.join(root, 'node_modules/lodash/template.js'), 'function template(s) { return s }\nfunction helper(s) { return s }\n')
    const r = await extractDependencyCode(g, await discoverServices(root), root, [owner])
    expect(r.edgesRemoved).toBe(1)
    expect(g.hasEdge(call)).toBe(false)
  })
})
