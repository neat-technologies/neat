import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import { EdgeType, NodeType, dependencyId, type GraphEdge, type GraphNode, type ServiceNode } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { resolveRequirementsPins } from '../src/extract/dependencies/python-lock.js'

// Dependency inventory (ADR-274, dependency-inventory.md): lockfiles become one
// DependencyNode per resolved version and a service→dep DEPENDS_ON edge with the
// per-service facts.

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true })
})

async function project(files: Record<string, unknown>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-deps-'))
  dirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel)
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
  return root
}

async function extract(root: string): Promise<NeatGraph> {
  const graph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false }) as NeatGraph
  await extractFromDirectory(graph, root, { announce: false })
  return graph
}

function depEdges(graph: NeatGraph, svc: string): Record<string, GraphEdge> {
  const out: Record<string, GraphEdge> = {}
  for (const id of graph.outboundEdges(svc)) {
    const e = graph.getEdgeAttributes(id) as GraphEdge
    if (e.type === EdgeType.DEPENDS_ON && e.target.startsWith('dep:')) out[e.target] = e
  }
  return out
}

const API_PKG = {
  name: 'api',
  version: '1.0.0',
  dependencies: { express: '^4.18.0', shared: '*' },
  devDependencies: { vitest: '^2.0.0' },
}

// A workspace root with one service (packages/api), a first-party workspace lib
// (packages/shared) linked in, hoisted deps, and a nested second version of qs.
const NPM_LOCK = {
  name: 'monorepo',
  lockfileVersion: 3,
  packages: {
    '': { name: 'monorepo', workspaces: ['packages/*'] },
    'packages/api': { name: 'api', version: '1.0.0', dependencies: API_PKG.dependencies, devDependencies: API_PKG.devDependencies },
    'packages/shared': { name: 'shared', version: '0.0.1', dependencies: { lodash: '^4.17.0' } },
    'node_modules/api': { resolved: 'packages/api', link: true },
    'node_modules/shared': { resolved: 'packages/shared', link: true },
    'node_modules/express': { version: '4.18.2', dependencies: { qs: '6.11.0', 'body-parser': '1.20.1' } },
    'node_modules/body-parser': { version: '1.20.1', dependencies: { qs: '6.10.3' } },
    'node_modules/body-parser/node_modules/qs': { version: '6.10.3' },
    'node_modules/qs': { version: '6.11.0' },
    'node_modules/lodash': { version: '4.17.15' },
    'node_modules/vitest': { version: '2.1.9', dev: true, dependencies: { qs: '6.11.0' } },
  },
}

describe('package-lock.json (v3, workspaces)', () => {
  it('resolves the service tree through hoisting, nesting and workspace links', async () => {
    const root = await project({
      'package.json': { name: 'monorepo', private: true, workspaces: ['packages/*'] },
      'package-lock.json': NPM_LOCK,
      'packages/api/package.json': API_PKG,
      'packages/api/index.js': "require('express')\n",
      'packages/shared/package.json': { name: 'shared', version: '0.0.1', dependencies: { lodash: '^4.17.0' } },
      'packages/shared/index.js': "module.exports = require('lodash')\n",
    })
    const graph = await extract(root)
    const edges = depEdges(graph, 'service:api')

    expect(Object.keys(edges).sort()).toEqual(
      [
        dependencyId('npm', 'body-parser', '1.20.1'),
        dependencyId('npm', 'express', '4.18.2'),
        dependencyId('npm', 'lodash', '4.17.15'),
        dependencyId('npm', 'qs', '6.10.3'),
        dependencyId('npm', 'qs', '6.11.0'),
        dependencyId('npm', 'vitest', '2.1.9'),
      ].sort(),
    )
    const e = (n: string, v: string) => edges[dependencyId('npm', n, v)].dependency
    expect(e('express', '4.18.2')).toEqual({ scope: 'direct', dev: false, introducedBy: [] })
    // Reached from a prod root and a dev root: it runs in production, so not dev.
    expect(e('qs', '6.11.0')).toEqual({ scope: 'transitive', dev: false, introducedBy: ['express', 'vitest'] })
    expect(e('qs', '6.10.3')).toEqual({ scope: 'transitive', dev: false, introducedBy: ['express'] })
    // Through the first-party workspace lib, never as a dependency itself.
    expect(e('lodash', '4.17.15')).toEqual({ scope: 'transitive', dev: false, introducedBy: ['shared'] })
    expect(e('vitest', '2.1.9')).toEqual({ scope: 'direct', dev: true, introducedBy: [] })
    expect(graph.hasNode(dependencyId('npm', 'shared', '0.0.1'))).toBe(false)

    const qs = graph.getNodeAttributes(dependencyId('npm', 'qs', '6.11.0'))
    expect(qs).toMatchObject({ type: NodeType.DependencyNode, ecosystem: 'npm', name: 'qs', version: '6.11.0', purl: 'pkg:npm/qs@6.11.0' })
    expect(edges[dependencyId('npm', 'qs', '6.11.0')].evidence?.file).toBe('package-lock.json')
    expect((graph.getNodeAttributes('service:api') as ServiceNode).dependencyResolution).toBe('complete')
  })

  it('a lockfile change replaces the edges and drops versions nothing depends on', async () => {
    const root = await project({
      'package.json': { name: 'app', version: '1.0.0', dependencies: { lodash: '^4.17.0' } },
      'package-lock.json': { lockfileVersion: 3, packages: { '': { name: 'app' }, 'node_modules/lodash': { version: '4.17.15' } } },
    })
    const graph = await extract(root)
    expect(graph.hasNode(dependencyId('npm', 'lodash', '4.17.15'))).toBe(true)

    await fs.writeFile(
      path.join(root, 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'app' }, 'node_modules/lodash': { version: '4.17.21' } } }),
    )
    await extractFromDirectory(graph, root, { announce: false })
    expect(graph.hasNode(dependencyId('npm', 'lodash', '4.17.15'))).toBe(false)
    expect(Object.keys(depEdges(graph, 'service:app'))).toEqual([dependencyId('npm', 'lodash', '4.17.21')])
  })

  it('without a lockfile only exact pins become nodes, and the inventory is partial', async () => {
    const root = await project({
      'package.json': { name: 'app', version: '1.0.0', dependencies: { pg: '7.4.0', express: '^4.18.0' } },
    })
    const graph = await extract(root)
    expect(Object.keys(depEdges(graph, 'service:app'))).toEqual([dependencyId('npm', 'pg', '7.4.0')])
    expect((graph.getNodeAttributes('service:app') as ServiceNode).dependencyResolution).toBe('partial')
  })

  it('scoped names get an encoded purl', async () => {
    const root = await project({
      'package.json': { name: 'app', version: '1.0.0', dependencies: { '@opentelemetry/api': '^1.9.0' } },
      'package-lock.json': { lockfileVersion: 3, packages: { '': { name: 'app' }, 'node_modules/@opentelemetry/api': { version: '1.9.0' } } },
    })
    const graph = await extract(root)
    expect(graph.getNodeAttributes(dependencyId('npm', '@opentelemetry/api', '1.9.0'))).toMatchObject({
      purl: 'pkg:npm/%40opentelemetry/api@1.9.0',
    })
  })
})

const PNPM_V9 = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      next:
        specifier: 15.0.0
        version: 15.0.0(react@19.0.0)
      react:
        specifier: 19.0.0
        version: 19.0.0
    devDependencies:
      typescript:
        specifier: ^5
        version: 5.6.3

  packages/api:
    dependencies:
      shared:
        specifier: workspace:*
        version: link:../shared
      string-width-cjs:
        specifier: npm:string-width@^4.2.0
        version: string-width@4.2.3

  packages/shared:
    dependencies:
      lodash:
        specifier: ^4.17.0
        version: 4.17.15

packages:

  lodash@4.17.15:
    resolution: {integrity: sha512-x}

snapshots:

  next@15.0.0(react@19.0.0):
    dependencies:
      react: 19.0.0
      styled-jsx: 5.1.6(react@19.0.0)

  react@19.0.0: {}

  styled-jsx@5.1.6(react@19.0.0):
    dependencies:
      react: 19.0.0

  typescript@5.6.3: {}

  lodash@4.17.15: {}

  string-width@4.2.3: {}
`

describe('pnpm-lock.yaml', () => {
  it('v9: peer-suffixed keys fold to one node per version; dev; root importer', async () => {
    const root = await project({
      'package.json': { name: 'web', version: '1.0.0', dependencies: { next: '15.0.0', react: '19.0.0' }, devDependencies: { typescript: '^5' } },
      'pnpm-lock.yaml': PNPM_V9,
    })
    const graph = await extract(root)
    const edges = depEdges(graph, 'service:web')
    expect(Object.keys(edges).sort()).toEqual(
      [
        dependencyId('npm', 'next', '15.0.0'),
        dependencyId('npm', 'react', '19.0.0'),
        dependencyId('npm', 'styled-jsx', '5.1.6'),
        dependencyId('npm', 'typescript', '5.6.3'),
      ].sort(),
    )
    expect(edges[dependencyId('npm', 'styled-jsx', '5.1.6')].dependency).toEqual({ scope: 'transitive', dev: false, introducedBy: ['next'] })
    expect(edges[dependencyId('npm', 'typescript', '5.6.3')].dependency?.dev).toBe(true)
    expect(edges[dependencyId('npm', 'react', '19.0.0')].evidence?.file).toBe('pnpm-lock.yaml')
  })

  it('v9: a workspace importer walks through a linked package, and resolves aliases', async () => {
    const root = await project({
      'package.json': { name: 'web', version: '1.0.0', dependencies: { next: '15.0.0', react: '19.0.0' } },
      'pnpm-lock.yaml': PNPM_V9,
      'packages/api/package.json': { name: 'api', version: '1.0.0', dependencies: { shared: 'workspace:*' } },
      'packages/shared/package.json': { name: 'shared', version: '0.0.1', dependencies: { lodash: '^4.17.0' } },
    })
    const graph = await extract(root)
    const edges = depEdges(graph, 'service:api')
    expect(Object.keys(edges).sort()).toEqual(
      [dependencyId('npm', 'lodash', '4.17.15'), dependencyId('npm', 'string-width', '4.2.3')].sort(),
    )
    expect(edges[dependencyId('npm', 'lodash', '4.17.15')].dependency).toEqual({ scope: 'transitive', dev: false, introducedBy: ['shared'] })
    expect(edges[dependencyId('npm', 'string-width', '4.2.3')].dependency?.scope).toBe('direct')
  })

  it('v6: packages keyed with a leading slash', async () => {
    const root = await project({
      'package.json': { name: 'app', version: '1.0.0', dependencies: { express: '^4.18.0' } },
      'pnpm-lock.yaml': `lockfileVersion: '6.0'\n\ndependencies:\n  express:\n    specifier: ^4.18.0\n    version: 4.18.2\n\npackages:\n\n  /express@4.18.2:\n    resolution: {integrity: sha512-x}\n    dependencies:\n      qs: 6.11.0\n    dev: false\n\n  /qs@6.11.0:\n    resolution: {integrity: sha512-y}\n    dev: false\n`,
    })
    const graph = await extract(root)
    const edges = depEdges(graph, 'service:app')
    expect(Object.keys(edges).sort()).toEqual([dependencyId('npm', 'express', '4.18.2'), dependencyId('npm', 'qs', '6.11.0')].sort())
    expect(edges[dependencyId('npm', 'qs', '6.11.0')].dependency?.introducedBy).toEqual(['express'])
  })
})

describe('Python lockfiles', () => {
  it('poetry.lock: direct from pyproject, dev groups, normalized names', async () => {
    const root = await project({
      'pyproject.toml': `[tool.poetry]\nname = "svc"\nversion = "0.1.0"\n\n[tool.poetry.dependencies]\npython = "^3.11"\nFlask = "^2.0"\n\n[tool.poetry.group.dev.dependencies]\npytest = "^8"\n`,
      'poetry.lock': `[[package]]\nname = "flask"\nversion = "2.3.2"\n\n[package.dependencies]\nJinja2 = ">=3.1.2"\n\n[[package]]\nname = "jinja2"\nversion = "3.1.2"\n\n[[package]]\nname = "pytest"\nversion = "8.3.0"\n`,
      'app.py': 'import flask\n',
    })
    const graph = await extract(root)
    const edges = depEdges(graph, 'service:svc')
    expect(edges[dependencyId('PyPI', 'flask', '2.3.2')].dependency).toEqual({ scope: 'direct', dev: false, introducedBy: [] })
    expect(edges[dependencyId('PyPI', 'jinja2', '3.1.2')].dependency).toEqual({ scope: 'transitive', dev: false, introducedBy: ['flask'] })
    expect(edges[dependencyId('PyPI', 'pytest', '8.3.0')].dependency).toEqual({ scope: 'direct', dev: true, introducedBy: [] })
    expect(graph.getNodeAttributes(dependencyId('PyPI', 'jinja2', '3.1.2'))).toMatchObject({ purl: 'pkg:pypi/jinja2@3.1.2' })
  })

  it('uv.lock: the editable project entry names the direct dependencies', async () => {
    const root = await project({
      'pyproject.toml': `[project]\nname = "svc"\nversion = "0.1.0"\ndependencies = ["requests"]\n`,
      'uv.lock': `version = 1\n\n[[package]]\nname = "svc"\nversion = "0.1.0"\nsource = { editable = "." }\ndependencies = [{ name = "requests" }]\n\n[package.dev-dependencies]\ndev = [{ name = "ruff" }]\n\n[[package]]\nname = "requests"\nversion = "2.30.0"\nsource = { registry = "https://pypi.org/simple" }\ndependencies = [{ name = "urllib3" }]\n\n[[package]]\nname = "urllib3"\nversion = "2.0.2"\nsource = { registry = "https://pypi.org/simple" }\n\n[[package]]\nname = "ruff"\nversion = "0.6.0"\nsource = { registry = "https://pypi.org/simple" }\n`,
      'main.py': 'import requests\n',
    })
    const graph = await extract(root)
    const edges = depEdges(graph, 'service:svc')
    expect(Object.keys(edges).sort()).toEqual(
      [dependencyId('PyPI', 'requests', '2.30.0'), dependencyId('PyPI', 'ruff', '0.6.0'), dependencyId('PyPI', 'urllib3', '2.0.2')].sort(),
    )
    expect(edges[dependencyId('PyPI', 'urllib3', '2.0.2')].dependency?.introducedBy).toEqual(['requests'])
    expect(edges[dependencyId('PyPI', 'ruff', '0.6.0')].dependency?.dev).toBe(true)
  })

  it('pip-compile requirements: # via chains resolve to the direct dependency', () => {
    const inv = resolveRequirementsPins(
      [
        'flask==2.3.2',
        '    # via -r requirements.in',
        'jinja2==3.1.2',
        '    # via flask',
        'markupsafe==2.1.3',
        '    # via',
        '    #   jinja2',
        '    #   werkzeug',
        'werkzeug==2.3.6',
        '    # via flask',
        'requests>=2',
      ].join('\n'),
      '/x/requirements.txt',
    )
    expect(inv.resolution).toBe('partial')
    const by = Object.fromEntries(inv.dependencies.map((d) => [d.name, d]))
    expect(Object.keys(by).sort()).toEqual(['flask', 'jinja2', 'markupsafe', 'werkzeug'])
    expect(by.flask).toMatchObject({ scope: 'direct', introducedBy: [] })
    expect(by.markupsafe).toMatchObject({ scope: 'transitive', introducedBy: ['flask'] })
  })
})
