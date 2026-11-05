import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import type { DependencyNode, GraphEdge, GraphNode, ServiceNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  dependencyId,
  isDependencyNodeId,
} from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { exists, makeEdgeId, type DiscoveredService } from '../shared.js'
import { recordExtractionError } from '../errors.js'
import { resolveNpmLock } from './npm-lock.js'
import { resolvePnpmLock } from './pnpm-lock.js'
import { resolveYarnLock } from './yarn-lock.js'
import {
  resolvePoetryLock,
  resolveRequirementsPins,
  resolveUvLock,
  type PoetryProject,
} from './python-lock.js'
import { purlFor, type ResolvedDependency, type ServiceInventory } from './resolved.js'

// Dependency inventory (ADR-274, docs/contracts/dependency-inventory.md). Reads
// each service's lockfile and mints one DependencyNode per resolved package
// version, plus a `service ──DEPENDS_ON──▶ dep` edge carrying the per-service
// facts. The producer owns those edges: each pass replaces a service's set, and
// a version no service depends on any more is dropped.

const EXACT_SEMVER = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

async function readText(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8')
  } catch {
    return null
  }
}

// The JS lockfiles NEAT reads, in the order it prefers them when one directory
// holds more than one.
const JS_LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] as const
type JsLockfile = (typeof JS_LOCKFILES)[number]

// The nearest JS lockfile at or above the service directory, without leaving the
// scan root (a workspace's lockfile sits at the workspace root).
async function nearestJsLock(serviceDir: string, scanPath: string): Promise<{ path: string; kind: JsLockfile } | null> {
  const root = path.resolve(scanPath)
  let dir = path.resolve(serviceDir)
  for (;;) {
    for (const kind of JS_LOCKFILES) {
      const candidate = path.join(dir, kind)
      if (await exists(candidate)) return { path: candidate, kind }
    }
    if (dir === root || !dir.startsWith(root)) return null
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

function exactPins(deps: Record<string, string> | undefined, ecosystem: ResolvedDependency['ecosystem']): ResolvedDependency[] {
  return Object.entries(deps ?? {})
    .filter(([, v]) => EXACT_SEMVER.test(v.trim()))
    .map(([name, v]) => ({
      ecosystem,
      name,
      version: v.trim().replace(/^v/, ''),
      scope: 'direct' as const,
      dev: false,
      introducedBy: [],
    }))
}

async function npmInventory(svc: DiscoveredService, scanPath: string): Promise<ServiceInventory | null> {
  const lock = await nearestJsLock(svc.dir, scanPath)
  if (lock) {
    const raw = await readText(lock.path)
    if (raw !== null) {
      try {
        const serviceKey = path.relative(path.dirname(lock.path), svc.dir).split(path.sep).join('/')
        const inv =
          lock.kind === 'package-lock.json'
            ? resolveNpmLock(JSON.parse(raw), lock.path, serviceKey, svc.pkg)
            : lock.kind === 'pnpm-lock.yaml'
              ? resolvePnpmLock(parseYaml(raw), lock.path, serviceKey)
              : resolveYarnLock(raw, lock.path, svc.pkg, { ownsLockfile: serviceKey === '' })
        if (inv) return inv
      } catch (err) {
        recordExtractionError('dependencies', path.relative(scanPath, lock.path), err)
      }
    }
  }
  const pins = exactPins(svc.pkg.dependencies, 'npm')
  return { source: path.join(svc.dir, 'package.json'), resolution: 'partial', dependencies: pins }
}

async function pythonInventory(svc: DiscoveredService, scanPath: string): Promise<ServiceInventory | null> {
  const uvPath = path.join(svc.dir, 'uv.lock')
  const uv = await readText(uvPath)
  if (uv !== null) {
    try {
      const inv = resolveUvLock(parseToml(uv) as never, uvPath, svc.node.name)
      if (inv) return inv
    } catch (err) {
      recordExtractionError('dependencies', path.relative(scanPath, uvPath), err)
    }
  }
  const poetryPath = path.join(svc.dir, 'poetry.lock')
  const poetry = await readText(poetryPath)
  if (poetry !== null) {
    try {
      const pyprojectRaw = await readText(path.join(svc.dir, 'pyproject.toml'))
      const pyproject = (pyprojectRaw ? parseToml(pyprojectRaw) : {}) as PoetryProject
      return resolvePoetryLock(parseToml(poetry) as never, poetryPath, pyproject)
    } catch (err) {
      recordExtractionError('dependencies', path.relative(scanPath, poetryPath), err)
    }
  }
  const reqPath = path.join(svc.dir, 'requirements.txt')
  const req = await readText(reqPath)
  if (req !== null) return resolveRequirementsPins(req, reqPath)
  return null
}

async function inventoryFor(svc: DiscoveredService, scanPath: string): Promise<ServiceInventory | null> {
  if (svc.node.language === 'python') return pythonInventory(svc, scanPath)
  if (await exists(path.join(svc.dir, 'package.json'))) return npmInventory(svc, scanPath)
  // Other ecosystems (Go, then the rest) join in later passes.
  return null
}

export interface DependencyPhaseResult {
  nodesAdded: number
  edgesAdded: number
  edgesRemoved: number
  nodesRemoved: number
}

export async function addDependencies(
  graph: NeatGraph,
  services: DiscoveredService[],
  scanPath: string,
): Promise<DependencyPhaseResult> {
  const result: DependencyPhaseResult = { nodesAdded: 0, edgesAdded: 0, edgesRemoved: 0, nodesRemoved: 0 }

  for (const svc of services) {
    const svcId = svc.node.id
    if (!graph.hasNode(svcId)) continue
    let inv: ServiceInventory | null
    try {
      inv = await inventoryFor(svc, scanPath)
    } catch (err) {
      recordExtractionError('dependencies', path.relative(scanPath, svc.dir) || '.', err)
      continue
    }
    if (!inv) continue

    const evidenceFile = path.relative(scanPath, inv.source).split(path.sep).join('/')
    const wanted = new Map<string, ResolvedDependency>()
    for (const d of inv.dependencies) wanted.set(dependencyId(d.ecosystem, d.name, d.version), d)

    // Replace this service's dependency edges with the ones this pass resolved.
    for (const edgeId of [...graph.outboundEdges(svcId)]) {
      const e = graph.getEdgeAttributes(edgeId) as GraphEdge
      if (e.type !== EdgeType.DEPENDS_ON || e.provenance !== Provenance.EXTRACTED) continue
      if (!isDependencyNodeId(e.target) || wanted.has(e.target)) continue
      graph.dropEdge(edgeId)
      result.edgesRemoved++
    }

    for (const [depId, d] of wanted) {
      if (!graph.hasNode(depId)) {
        const node: DependencyNode = {
          id: depId,
          type: NodeType.DependencyNode,
          name: d.name,
          ecosystem: d.ecosystem,
          version: d.version,
          purl: purlFor(d.ecosystem, d.name, d.version),
          discoveredVia: 'static',
        }
        graph.addNode(depId, node as GraphNode)
        result.nodesAdded++
      }
      const edgeId = makeEdgeId(svcId, depId, EdgeType.DEPENDS_ON)
      const edge: GraphEdge = {
        id: edgeId,
        source: svcId,
        target: depId,
        type: EdgeType.DEPENDS_ON,
        provenance: Provenance.EXTRACTED,
        confidence: confidenceForExtracted('structural'),
        evidence: { file: evidenceFile },
        dependency: { scope: d.scope, dev: d.dev, introducedBy: d.introducedBy },
      }
      if (graph.hasEdge(edgeId)) {
        graph.replaceEdgeAttributes(edgeId, edge)
      } else {
        graph.addEdgeWithKey(edgeId, svcId, depId, edge)
        result.edgesAdded++
      }
    }

    graph.mergeNodeAttributes(svcId, { dependencyResolution: inv.resolution } as Partial<ServiceNode>)
  }

  // A version no service depends on any more leaves the graph.
  const orphans: string[] = []
  graph.forEachNode((id, attrs) => {
    if ((attrs as GraphNode).type === NodeType.DependencyNode && graph.inDegree(id) === 0) orphans.push(id)
  })
  for (const id of orphans) {
    graph.dropNode(id)
    result.nodesRemoved++
  }
  return result
}
