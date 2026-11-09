import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  dependencyId,
  dependencySymbolId,
  fileId,
  symbolId,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { discoverServices } from '../src/extract/services.js'
import { extractDependencyCode, PackageExports, packageEntry } from '../src/extract/dependency-symbols/index.js'

// dependency-inventory.md §5: first-party calls resolve through the import
// bindings to the package's exported symbols.

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

describe('packageEntry', () => {
  const files = new Set(['index.js', 'lib/main.js', 'dist/cjs/index.js', 'dist/esm/index.mjs', 'lib/sub/x.js', 'fp.js'])
  it('reads main, exports strings, condition objects, subpaths and patterns', () => {
    expect(packageEntry({}, files, '', 'require')).toBe('index.js')
    expect(packageEntry({ main: './lib/main' }, files, '', 'require')).toBe('lib/main.js')
    expect(packageEntry({}, files, 'fp', 'require')).toBe('fp.js')
    const exp = {
      exports: {
        '.': { import: './dist/esm/index.mjs', require: './dist/cjs/index.js' },
        './sub/*': './lib/sub/*.js',
      },
    }
    expect(packageEntry(exp, files, '', 'require')).toBe('dist/cjs/index.js')
    expect(packageEntry(exp, files, '', 'import')).toBe('dist/esm/index.mjs')
    expect(packageEntry(exp, files, 'sub/x', 'require')).toBe('lib/sub/x.js')
    // an exports map hides everything it doesn't list
    expect(packageEntry(exp, files, 'fp', 'require')).toBeNull()
    expect(packageEntry({ exports: './lib/main.js' }, files, '', 'import')).toBe('lib/main.js')
  })
})

describe('PackageExports', () => {
  const t = (file: string, qualname: string) => ({ file, qualname })
  it('reads CommonJS exports, following local requires', () => {
    const files = new Map([
      ['index.js', "module.exports = require('./lib/app')\n"],
      ['lib/app.js', "exports = module.exports = createApp\nfunction createApp() {}\nexports.helper = require('./helper')\nexports.other = require('other-pkg')\n"],
      ['lib/helper.js', 'module.exports = function helper() {}\n'],
      ['obj.js', "const parse = require('./parse')\nfunction stringify() {}\nmodule.exports = { parse, stringify, version: '1' }\n"],
      ['parse.js', 'module.exports = function (s) { return s }\n'],
      ['named.js', 'exports.run = function () {}\nmodule.exports.stop = () => {}\n'],
    ])
    const ex = new PackageExports({}, files)
    expect([...ex.forImport('', 'require')!]).toEqual([
      ['default', t('lib/app.js', 'createApp')],
      ['helper', t('lib/helper.js', 'helper')],
    ])
    expect([...ex.forImport('obj', 'require')!]).toEqual([
      ['parse', t('parse.js', 'module.exports')],
      ['stringify', t('obj.js', 'stringify')],
    ])
    expect([...ex.forImport('named', 'require')!]).toEqual([
      ['run', t('named.js', 'exports.run')],
      ['stop', t('named.js', 'module.exports.stop')],
    ])
  })

  it('reads ESM exports and skips re-exports from elsewhere', () => {
    const files = new Map([
      ['index.ts', [
        'export function a() {}',
        'export class B {}',
        'export const c = () => {}',
        'function d() {}',
        'export { d as dee }',
        'export default function main() {}',
        "export { x } from './x'",
        '',
      ].join('\n')],
    ])
    expect([...new PackageExports({ main: 'index.ts' }, files).forImport('', 'import')!].map(([k, v]) => `${k}=${v.qualname}`)).toEqual([
      'a=a', 'B=B', 'c=c', 'dee=d', 'default=main', 'main=main',
    ])
  })
})

async function project(files: Record<string, unknown>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-calls-into-'))
  dirs.push(root)
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  }
  return root
}

const deps = { tpl: '1.0.0', qs: '2.0.0', semverish: '3.0.0' }
const lock = {
  name: 'shop',
  lockfileVersion: 3,
  packages: {
    '': { name: 'shop', dependencies: Object.fromEntries(Object.keys(deps).map((n) => [n, '*'])) },
    ...Object.fromEntries(Object.entries(deps).map(([n, v]) => [`node_modules/${n}`, { version: v }])),
  },
}
const app = [
  "const render = require('tpl/render')",
  "import qs from 'qs'",
  "import { Range } from 'semverish'",
  "render('boot')",
  'export function page(s) { return render(s) + qs.parse(s) }',
  'export function check(v) { return new Range(v).test(v) }',
  'export function nope(v) { return qs.missing(v) + other(v) }',
  '',
].join('\n')

function files(appSource = app): Record<string, unknown> {
  return {
    'package.json': { name: 'shop', main: 'app.js', dependencies: Object.fromEntries(Object.keys(deps).map((n) => [n, '*'])) },
    'package-lock.json': lock,
    'app.js': appSource,
    'app.test.js': "const render = require('tpl/render')\nfunction t() { render('x') }\n",
    'node_modules/tpl/package.json': { name: 'tpl', version: '1.0.0' },
    'node_modules/tpl/render.js': 'module.exports = function render(s) { return s }\n',
    'node_modules/qs/package.json': { name: 'qs', version: '2.0.0', main: 'lib/index.js' },
    'node_modules/qs/lib/index.js': "const parse = require('./parse')\nmodule.exports = { parse }\n",
    'node_modules/qs/lib/parse.js': 'module.exports = function (s) { return s }\n',
    'node_modules/semverish/package.json': { name: 'semverish', version: '3.0.0', exports: { '.': { import: './esm.mjs', require: './cjs.js' } } },
    'node_modules/semverish/esm.mjs': 'export class Range { test() {} }\n',
    'node_modules/semverish/cjs.js': 'class Range {}\nmodule.exports = { Range }\n',
  }
}

async function run(root: string, graph?: NeatGraph) {
  const g = graph ?? (new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false }) as NeatGraph)
  await extractFromDirectory(g, root, { announce: false })
  const ids = Object.entries(deps).map(([n, v]) => dependencyId('npm', n, v))
  const r = await extractDependencyCode(g, await discoverServices(root), root, ids)
  return { g, r }
}

const intoDeps = (g: NeatGraph) =>
  g
    .edges()
    .map((id) => g.getEdgeAttributes(id) as GraphEdge)
    .filter((e) => e.type === EdgeType.CALLS && e.target.startsWith('symbol:dep:') && !e.source.startsWith('symbol:dep:'))
    .map((e) => [e.source, e.target, e.evidence!.line, e.evidence!.specifier])
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])) || String(a[0]).localeCompare(String(b[0])))

describe('first-party calls into package exports', () => {
  it('resolves bound calls, namespace members and constructors, from the enclosing symbol or the module', async () => {
    const { g } = await run(await project(files()))
    const dsym = (n: string, v: string, f: string, q: string) => dependencySymbolId('npm', n, v, f, q)
    expect(intoDeps(g)).toEqual([
      [symbolId('shop', 'app.js', 'page'), dsym('qs', '2.0.0', 'lib/parse.js', 'module.exports'), 5, 'qs'],
      [symbolId('shop', 'app.js', 'check'), dsym('semverish', '3.0.0', 'esm.mjs', 'Range'), 6, 'semverish'],
      [fileId('shop', 'app.js'), dsym('tpl', '1.0.0', 'render.js', 'render'), 4, 'tpl/render'],
      [symbolId('shop', 'app.js', 'page'), dsym('tpl', '1.0.0', 'render.js', 'render'), 5, 'tpl/render'],
    ])
  })

  it('updates in place on a second run and drops a call that went away', async () => {
    const root = await project(files())
    const { g } = await run(root)
    const again = await extractDependencyCode(
      g,
      await discoverServices(root),
      root,
      Object.entries(deps).map(([n, v]) => dependencyId('npm', n, v)),
    )
    expect(again.edgesAdded).toBe(0)
    await fs.writeFile(path.join(root, 'app.js'), app.replace(' + qs.parse(s)', ''))
    await run(root, g)
    expect(intoDeps(g).map((e) => e[3])).not.toContain('qs')
  })
})
