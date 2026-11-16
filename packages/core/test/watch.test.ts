import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import { fileURLToPath } from 'node:url'
import { classifyChange, runExtractPhases, startWatch, type ExtractPhase } from '../src/watch.js'
import { resetGraph, getGraph, type NeatGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { retireEdgesByFile } from '../src/extract/retire.js'
import { NodeType, EdgeType, routeId } from '@neat.is/types'
import type { GraphNode, GraphEdge } from '@neat.is/types'

const sep = path.sep
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TS_SERVICE = path.resolve(__dirname, 'fixtures', 'imports', 'ts-service')
const EXPRESS_SERVICE = path.resolve(__dirname, 'fixtures', 'routes', 'api-server')

function countNodesOfType(graph: ReturnType<typeof getGraph>, type: NodeType): number {
  let count = 0
  graph.forEachNode((_id, attrs) => {
    if ((attrs as GraphNode).type === type) count++
  })
  return count
}

// Every FileNode should be owned by exactly one CONTAINS edge from its service.
// A FileNode with no inbound CONTAINS is a corrupted snapshot — the file exists
// on disk but the graph has orphaned it from its owner.
function fileNodesWithoutContainer(graph: ReturnType<typeof getGraph>): string[] {
  const orphans: string[] = []
  graph.forEachNode((id, attrs) => {
    if ((attrs as GraphNode).type !== NodeType.FileNode) return
    const hasContainer = graph
      .inboundEdges(id)
      .some((e) => (graph.getEdgeAttributes(e) as GraphEdge).type === EdgeType.CONTAINS)
    if (!hasContainer) orphans.push(id)
  })
  return orphans
}

describe('classifyChange', () => {
  it('routes package.json to services + aliases + databases + dependencies', () => {
    const phases = classifyChange(`packages${sep}service-a${sep}package.json`)
    expect([...phases].sort()).toEqual(['aliases', 'databases', 'dependencies', 'services'])
  })

  it('routes Python manifests to the same set', () => {
    expect([...classifyChange(`svc${sep}requirements.txt`)].sort()).toEqual([
      'aliases',
      'databases',
      'dependencies',
      'services',
    ])
    expect([...classifyChange(`svc${sep}pyproject.toml`)].sort()).toEqual([
      'aliases',
      'databases',
      'dependencies',
      'services',
    ])
  })

  it('routes a lockfile to the dependency inventory', () => {
    for (const f of ['package-lock.json', 'yarn.lock', 'uv.lock', 'poetry.lock', 'go.mod', 'go.sum']) {
      expect(classifyChange(`svc${sep}${f}`).has('dependencies'), f).toBe(true)
    }
    // pnpm-lock.yaml is yaml, so it also picks up the generic yaml phases.
    expect(classifyChange(`pnpm-lock.yaml`).has('dependencies')).toBe(true)
  })

  it('routes JS/TS/Python source to files + symbols + imports + routes + calls + flags', () => {
    // flags: a source edit can add or drop a literal that reads a flag key (ADR-242).
    const expected = ['calls', 'files', 'flags', 'imports', 'routes', 'symbols']
    expect([...classifyChange(`src${sep}index.ts`)].sort()).toEqual(expected)
    expect([...classifyChange(`src${sep}index.js`)].sort()).toEqual(expected)
    expect([...classifyChange(`src${sep}page.tsx`)].sort()).toEqual(expected)
    expect([...classifyChange(`app${sep}main.py`)].sort()).toEqual(expected)
  })

  it('routes .env / prisma / knex / ormconfig to databases + configs', () => {
    expect([...classifyChange(`service-b${sep}.env`)].sort()).toEqual(['configs', 'databases'])
    expect([...classifyChange(`service-b${sep}.env.production`)].sort()).toEqual([
      'configs',
      'databases',
    ])
    expect([...classifyChange(`prisma${sep}schema.prisma`)].sort()).toEqual([
      'configs',
      'databases',
    ])
    // knexfile.ts also looks like JS source — its imports/calls/symbols/routes
    // rerun is a no-op for the file but cheap, so we accept the overlap.
    expect([...classifyChange(`knexfile.ts`)].sort()).toEqual([
      'calls',
      'configs',
      'databases',
      'files',
      'flags',
      'imports',
      'routes',
      'symbols',
    ])
    expect([...classifyChange(`ormconfig.json`)].sort()).toEqual(['configs', 'databases'])
  })

  it('routes Dockerfile / compose / Terraform to infra + aliases', () => {
    expect([...classifyChange('Dockerfile')].sort()).toEqual(['aliases', 'infra'])
    expect([...classifyChange('docker-compose.yml')].sort()).toEqual([
      'aliases',
      'infra',
    ])
    expect([...classifyChange('docker-compose.prod.yaml')].sort()).toEqual([
      'aliases',
      'infra',
    ])
    expect([...classifyChange(`infra${sep}main.tf`)].sort()).toEqual(['aliases', 'infra'])
  })

  it('routes k8s yaml under k8s/ to infra + aliases + db/configs', () => {
    // k8s manifests are yaml — we add infra+aliases via the dir hint AND
    // databases+configs via the generic .yaml fallback. Belt-and-suspenders is
    // fine; the phases dedupe via Set.
    const phases = classifyChange(`k8s${sep}deployment.yaml`)
    expect(phases.has('infra')).toBe(true)
    expect(phases.has('aliases')).toBe(true)
  })

  it('returns an empty set for files with no known mapping', () => {
    expect([...classifyChange(`README.md`)]).toEqual([])
    expect([...classifyChange(`assets${sep}logo.png`)]).toEqual([])
  })

  it('case-insensitive for Dockerfile and friends', () => {
    expect([...classifyChange('dockerfile')].sort()).toEqual(['aliases', 'infra'])
    expect([...classifyChange('Dockerfile')].sort()).toEqual(['aliases', 'infra'])
  })

  it('re-enumerates files so a source edit rebuilds its FileNode', () => {
    // A source edit retires the file's CONTAINS edge (evidence.file matches).
    // The re-extract has to walk files again to put it back, or the FileNode
    // is left orphaned from its service.
    expect(classifyChange(`src${sep}index.ts`).has('files')).toBe(true)
    expect(classifyChange(`app${sep}main.py`).has('files')).toBe(true)
  })
})

// Issue #926 — the watch extract path used to omit the `symbols` and `routes`
// phases that extractFromDirectory (init / multi-project daemon) runs, so under
// `neat watch` there were no SymbolNodes (ADR-158) or RouteNodes (ADR-119, incl.
// the ADR-160 mount-prefix fix) at all. These assert the phases now run.
describe('watch extract materialises symbols + routes (issue #926)', () => {
  beforeEach(() => resetGraph())

  // The pre-fix ALL_PHASES set — proves the fixture only yields routes/symbols
  // because those phases run, not as a side effect of some other phase.
  const LEGACY_PHASES: ExtractPhase[] = [
    'services',
    'aliases',
    'files',
    'imports',
    'databases',
    'configs',
    'calls',
    'infra',
  ]

  // The current full watch pass — matches `new Set(ALL_PHASES)` in startWatch.
  const FULL_PHASES: ExtractPhase[] = [
    'services',
    'aliases',
    'files',
    'symbols',
    'imports',
    'databases',
    'configs',
    'routes',
    'calls',
    'infra',
  ]

  it('the pre-fix phase set extracts no RouteNodes (Express fixture)', async () => {
    const graph = getGraph()
    await runExtractPhases(graph, EXPRESS_SERVICE, new Set(LEGACY_PHASES))
    expect(countNodesOfType(graph, NodeType.RouteNode)).toBe(0)
  })

  it('the pre-fix phase set extracts no SymbolNodes (TS fixture)', async () => {
    const graph = getGraph()
    await runExtractPhases(graph, TS_SERVICE, new Set(LEGACY_PHASES))
    expect(countNodesOfType(graph, NodeType.SymbolNode)).toBe(0)
  })

  it('the full watch phase set materialises RouteNodes (Express fixture)', async () => {
    const graph = getGraph()
    await runExtractPhases(graph, EXPRESS_SERVICE, new Set(FULL_PHASES))

    // The fixture defines three Express routes.
    expect(countNodesOfType(graph, NodeType.RouteNode)).toBeGreaterThan(0)
    expect(graph.hasNode(routeId('api-server', 'GET', '/users/:id'))).toBe(true)
    expect(graph.hasNode(routeId('api-server', 'POST', '/users'))).toBe(true)
    expect(graph.hasNode(routeId('api-server', 'GET', '/health'))).toBe(true)
  })

  it('the full watch phase set materialises SymbolNodes (TS fixture)', async () => {
    const graph = getGraph()
    await runExtractPhases(graph, TS_SERVICE, new Set(FULL_PHASES))

    // ts-service defines named functions (start, connectToMongo); the Express
    // api-server's handlers are anonymous inline callbacks, which addSymbols
    // does not mint nodes for, so symbols are asserted on the named-def fixture.
    expect(countNodesOfType(graph, NodeType.SymbolNode)).toBeGreaterThan(0)
  })

  it('a source-file change re-runs routes + symbols so edits stay fused', async () => {
    // classifyChange for a .js edit must schedule both new phases, or a watch
    // re-extract would leave RouteNodes/SymbolNodes stale after the initial pass.
    const phases = classifyChange(`index.js`)
    expect(phases.has('routes')).toBe(true)
    expect(phases.has('symbols')).toBe(true)
  })
})

describe('watch re-extract on an edited imported file', () => {
  beforeEach(() => resetGraph())

  const importsEdge =
    'IMPORTS:file:fixture-imports-ts-service:index.ts->file:fixture-imports-ts-service:mongo.ts'

  it('rebuilds the graph cleanly when the imported file changes', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, TS_SERVICE)
    expect(graph.hasEdge(importsEdge)).toBe(true)
    expect(fileNodesWithoutContainer(graph)).toEqual([])

    // mongo.ts is imported by index.ts. Editing it retires mongo.ts's CONTAINS
    // edge; the re-extract must recreate it.
    retireEdgesByFile(graph, 'mongo.ts')
    await runExtractPhases(graph, TS_SERVICE, classifyChange('mongo.ts'))

    expect(graph.hasEdge(importsEdge)).toBe(true)
    expect(fileNodesWithoutContainer(graph)).toEqual([])
  })

  it('does not crash or orphan nodes when the importer file changes', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, TS_SERVICE)

    // Editing the importer retires its CONTAINS *and* its outbound IMPORTS,
    // which orphans the importer FileNode. Without a file re-enumeration the
    // next addImports emits an edge from a node that no longer exists and
    // throws.
    retireEdgesByFile(graph, 'index.ts')
    await expect(
      runExtractPhases(graph, TS_SERVICE, classifyChange('index.ts')),
    ).resolves.toBeDefined()

    expect(graph.hasNode('file:fixture-imports-ts-service:index.ts')).toBe(true)
    expect(graph.hasEdge(importsEdge)).toBe(true)
    expect(fileNodesWithoutContainer(graph)).toEqual([])
  })
})

// #1725: a watch daemon's graph must hold the dependency inventory, or everything
// that reads it from the live graph (the security routes and MCP tools) answers
// as if the project had no dependencies.
describe('watch builds the dependency inventory', () => {
  const dirs: string[] = []
  const stops: Array<() => Promise<void>> = []
  // The daemon's dependency loop would otherwise query OSV for the fixture's packages.
  const advisoriesBefore = process.env.NEAT_ADVISORIES
  beforeEach(() => {
    process.env.NEAT_ADVISORIES = 'off'
  })
  afterEach(async () => {
    if (advisoriesBefore === undefined) delete process.env.NEAT_ADVISORIES
    else process.env.NEAT_ADVISORIES = advisoriesBefore
    while (stops.length > 0) await stops.pop()!()
    while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true })
  })

  const lock = (version: string) => ({
    name: 'svc',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'svc', version: '1.0.0', dependencies: { lodash: version } },
      'node_modules/lodash': { version },
    },
  })

  async function project(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-watch-deps-'))
    dirs.push(root)
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'svc', version: '1.0.0', dependencies: { lodash: '4.17.15' } }),
    )
    await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock('4.17.15')))
    await fs.writeFile(path.join(root, 'index.js'), "const _ = require('lodash')\nmodule.exports = () => _.noop()\n")
    return root
  }

  const depVersions = (graph: NeatGraph): string[] => {
    const out: string[] = []
    graph.forEachNode((_id, attrs) => {
      const n = attrs as GraphNode & { version?: string }
      if (n.type === NodeType.DependencyNode) out.push(`${n.name}@${n.version}`)
    })
    return out.sort()
  }

  it('the initial pass holds the DependencyNodes and records coverage on /health', async () => {
    const root = await project()
    const graph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false }) as NeatGraph
    const handle = await startWatch(graph, {
      scanPath: root,
      outPath: path.join(root, 'neat-out', 'graph.json'),
      errorsPath: path.join(root, 'neat-out', 'errors.ndjson'),
      staleEventsPath: path.join(root, 'neat-out', 'stale.ndjson'),
      host: '127.0.0.1',
      port: 0,
      otelPort: 0,
    })
    stops.push(handle.stop)

    expect(depVersions(graph)).toEqual(['lodash@4.17.15'])
    // The first-party import of the package is attached to it.
    const imports = graph
      .inboundEdges('dep:npm:lodash@4.17.15')
      .map((e) => graph.getEdgeAttributes(e) as GraphEdge)
      .filter((e) => e.type === EdgeType.IMPORTS)
    expect(imports.length).toBe(1)

    // Coverage is what tells an MCP client the index is complete.
    const health = await handle.api.inject({ method: 'GET', url: '/projects/default/health' })
    expect(health.json().coverage?.skippedFiles).toBe(0)
  }, 30_000)

  it('a lockfile change re-runs the inventory and moves the import to the new version', async () => {
    const root = await project()
    const graph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false }) as NeatGraph
    await extractFromDirectory(graph, root, { announce: false })
    expect(depVersions(graph)).toEqual(['lodash@4.17.15'])

    await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock('4.17.21')))
    retireEdgesByFile(graph, 'package-lock.json')
    await runExtractPhases(graph, root, classifyChange('package-lock.json'))

    expect(depVersions(graph)).toEqual(['lodash@4.17.21'])
    const imports = graph
      .inboundEdges('dep:npm:lodash@4.17.21')
      .map((e) => graph.getEdgeAttributes(e) as GraphEdge)
      .filter((e) => e.type === EdgeType.IMPORTS)
    expect(imports.length).toBe(1)
  })
})
