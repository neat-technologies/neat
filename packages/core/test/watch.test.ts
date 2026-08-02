import { describe, expect, it, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyChange, runExtractPhases, type ExtractPhase } from '../src/watch.js'
import { resetGraph, getGraph } from '../src/graph.js'
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
  it('routes package.json to services + aliases + databases', () => {
    const phases = classifyChange(`packages${sep}service-a${sep}package.json`)
    expect([...phases].sort()).toEqual(['aliases', 'databases', 'services'])
  })

  it('routes Python manifests to the same trio', () => {
    expect([...classifyChange(`svc${sep}requirements.txt`)].sort()).toEqual([
      'aliases',
      'databases',
      'services',
    ])
    expect([...classifyChange(`svc${sep}pyproject.toml`)].sort()).toEqual([
      'aliases',
      'databases',
      'services',
    ])
  })

  it('routes JS/TS/Python source to files + symbols + imports + routes + calls', () => {
    const expected = ['calls', 'files', 'imports', 'routes', 'symbols']
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
