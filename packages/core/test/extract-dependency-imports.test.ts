import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  Provenance,
  dependencyId,
  fileId,
  isDependencyNodeId,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'

// dependency-inventory.md §4: a first-party import of a declared package is an
// EXTRACTED file→dep IMPORTS edge carrying the specifier and local bindings.

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function project(files: Record<string, unknown>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-dep-imports-'))
  dirs.push(root)
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  }
  return root
}

async function extract(root: string): Promise<NeatGraph> {
  const graph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false }) as NeatGraph
  await extractFromDirectory(graph, root, { announce: false })
  return graph
}

function depImports(graph: NeatGraph): GraphEdge[] {
  return graph
    .edges()
    .map((id) => graph.getEdgeAttributes(id) as GraphEdge)
    .filter((e) => e.type === EdgeType.IMPORTS && isDependencyNodeId(e.target))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
}

const npmProject = {
  'package.json': { name: 'shop', main: 'src/index.ts', dependencies: { lodash: '^4.17.0', '@acme/ui': '^1.0.0' } },
  'package-lock.json': {
    name: 'shop',
    lockfileVersion: 3,
    packages: {
      '': { name: 'shop', dependencies: { lodash: '^4.17.0', '@acme/ui': '^1.0.0' } },
      'node_modules/lodash': { version: '4.17.21' },
      'node_modules/@acme/ui': { version: '1.2.0' },
    },
  },
  // `@acme/ui/*` is also a path alias into the service's own source.
  'tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@acme/ui/local': ['src/ui/local.ts'] } } },
  'src/ui/local.ts': 'export const local = 1\n',
  'src/util.ts': 'export const util = 1\n',
  'src/index.ts': [
    "import _ from 'lodash'",
    "import { template as tpl, merge } from 'lodash'",
    "import { Button } from '@acme/ui/button'",
    "import { local } from '@acme/ui/local'",
    "import type { Thing } from '@acme/ui'",
    "import { util } from './util'",
    "import fs from 'node:fs'",
    'export const x = [_, tpl, merge, Button, local, util, fs]',
    '',
  ].join('\n'),
  'src/legacy.js': "const { get, set: put } = require('lodash/fp')\nmodule.exports = { get, put }\n",
  'src/index.test.ts': "import _ from 'lodash'\n",
}

describe('first-party imports of a package (dependency-inventory.md §4)', () => {
  it('mints file→dep IMPORTS edges with the specifier and the local bindings', async () => {
    const graph = await extract(await project(npmProject))
    const lodash = dependencyId('npm', 'lodash', '4.17.21')
    const ui = dependencyId('npm', '@acme/ui', '1.2.0')
    const index = fileId('shop', 'src/index.ts')

    const fromIndex = depImports(graph).filter((e) => e.source === index)
    expect(fromIndex.map((e) => e.target).sort()).toEqual([ui, lodash].sort())

    const toLodash = fromIndex.find((e) => e.target === lodash)!
    expect(toLodash.provenance).toBe(Provenance.EXTRACTED)
    // one edge per (file, dep): the earliest line, every binding
    expect(toLodash.evidence).toMatchObject({ file: 'src/index.ts', line: 1, specifier: 'lodash' })
    expect(toLodash.evidence!.bindings).toEqual(['_', 'merge', 'tpl'])

    const toUi = fromIndex.find((e) => e.target === ui)!
    expect(toUi.evidence).toMatchObject({ line: 3, specifier: '@acme/ui/button', bindings: ['Button'] })
  })

  it('reads require() destructuring, and skips path aliases, type-only, relative, builtin and test imports', async () => {
    const graph = await extract(await project(npmProject))
    const edges = depImports(graph)
    const legacy = edges.find((e) => e.source === fileId('shop', 'src/legacy.js'))!
    expect(legacy.evidence).toMatchObject({ specifier: 'lodash/fp', bindings: ['get', 'put'] })
    // no edge from the test file, and the alias / type-only lines don't add their own
    expect(edges.map((e) => e.source).sort()).toEqual([fileId('shop', 'src/index.ts'), fileId('shop', 'src/index.ts'), fileId('shop', 'src/legacy.js')])
    const ui = edges.find((e) => e.target === dependencyId('npm', '@acme/ui', '1.2.0'))!
    expect(ui.evidence!.specifier).toBe('@acme/ui/button')
  })

  it('matches Python from- and bare imports to declared PyPI packages', async () => {
    const graph = await extract(
      await project({
        'requirements.txt': 'Jinja2==3.1.4\nrequests==2.32.3\nPyYAML==6.0.2\n',
        'app/__init__.py': '',
        'app/helpers.py': 'def h():\n    return 1\n',
        'app/main.py': [
          'from jinja2 import Template, Environment as Env',
          'import requests',
          'import yaml',
          'from .helpers import h',
          'from app.helpers import h as h2',
          '',
        ].join('\n'),
      }),
    )
    const edges = depImports(graph)
    const byTarget = new Map(edges.map((e) => [e.target, e]))
    const jinja = [...byTarget.keys()].find((k) => k.includes('jinja2'))!
    expect(byTarget.get(jinja)!.evidence).toMatchObject({ specifier: 'jinja2', bindings: ['Env', 'Template'], line: 1 })
    const req = [...byTarget.keys()].find((k) => k.includes('requests'))!
    expect(byTarget.get(req)!.evidence).toMatchObject({ specifier: 'requests', bindings: ['requests'], line: 2 })
    // `yaml` is PyYAML's module, a different name: no match, no edge, nothing guessed
    expect([...byTarget.keys()].some((k) => k.toLowerCase().includes('pyyaml'))).toBe(false)
    expect(edges).toHaveLength(2)
  })

  it('matches a Go import to the longest declared module path', async () => {
    const graph = await extract(
      await project({
        'go.mod': [
          'module example.com/cart',
          '',
          'go 1.22',
          '',
          'require (',
          '\tgithub.com/redis/go-redis/v9 v9.5.1',
          '\tgolang.org/x/net v0.25.0',
          '\tgopkg.in/yaml.v3 v3.0.1',
          ')',
          '',
        ].join('\n'),
        'main.go': [
          'package main',
          '',
          'import (',
          '\t"fmt"',
          '\t"github.com/redis/go-redis/v9"',
          '\th2 "golang.org/x/net/http2"',
          '\t"gopkg.in/yaml.v3"',
          ')',
          '',
          'func main() { fmt.Println(redis.Nil, h2.ErrFrameTooLarge, yaml.Marshal) }',
          '',
        ].join('\n'),
      }),
    )
    const edges = depImports(graph)
    expect(edges.map((e) => [e.target, e.evidence!.specifier, e.evidence!.bindings])).toEqual(
      [
        // `go-redis` isn't a Go identifier, so the path doesn't tell the name: no binding is guessed
        [dependencyId('Go', 'github.com/redis/go-redis/v9', '9.5.1'), 'github.com/redis/go-redis/v9', []],
        [dependencyId('Go', 'golang.org/x/net', '0.25.0'), 'golang.org/x/net/http2', ['h2']],
        [dependencyId('Go', 'gopkg.in/yaml.v3', '3.0.1'), 'gopkg.in/yaml.v3', ['yaml']],
      ].sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)),
    )
  })

  it('is deterministic and rebuilds its own edges on a second pass', async () => {
    const root = await project(npmProject)
    const graph = await extract(root)
    const first = JSON.stringify(depImports(graph))
    await extractFromDirectory(graph, root, { announce: false })
    expect(JSON.stringify(depImports(graph))).toBe(first)
    expect(JSON.stringify(depImports(await extract(root)))).toBe(first)

    // drop lodash from the lockfile: its node and every IMPORTS edge into it go
    const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'))
    delete lock.packages['node_modules/lodash']
    delete lock.packages[''].dependencies.lodash
    await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock))
    await extractFromDirectory(graph, root, { announce: false })
    expect(graph.hasNode(dependencyId('npm', 'lodash', '4.17.21'))).toBe(false)
    expect(depImports(graph).map((e) => e.target)).toEqual([dependencyId('npm', '@acme/ui', '1.2.0')])
  })
})
