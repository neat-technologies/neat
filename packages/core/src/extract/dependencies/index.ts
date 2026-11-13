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
  isDependencySymbolId,
} from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { exists, makeEdgeId, readJson, type DiscoveredService } from '../shared.js'
import { recordExtractionError } from '../errors.js'
import { resolveGoMod } from './go-mod.js'
import { resolveNpmLock, type ServiceManifest } from './npm-lock.js'
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
  // The npm manifest always comes from package.json on disk, never from
  // `svc.pkg`: for a Go- or Python-primary service `svc.pkg` carries that other
  // ecosystem's modules (discoverGoService fills `pkg.dependencies` with Go
  // modules), so feeding it to the npm resolver would mint Go modules as npm
  // nodes. No package.json in the service directory means npm contributes
  // nothing.
  const pkgPath = path.join(svc.dir, 'package.json')
  let manifest: ServiceManifest
  try {
    manifest = await readJson<ServiceManifest>(pkgPath)
  } catch {
    return null
  }
  const lock = await nearestJsLock(svc.dir, scanPath)
  if (lock) {
    const raw = await readText(lock.path)
    if (raw !== null) {
      try {
        const serviceKey = path.relative(path.dirname(lock.path), svc.dir).split(path.sep).join('/')
        const inv =
          lock.kind === 'package-lock.json'
            ? resolveNpmLock(JSON.parse(raw), lock.path, serviceKey, manifest)
            : lock.kind === 'pnpm-lock.yaml'
              ? resolvePnpmLock(parseYaml(raw), lock.path, serviceKey)
              : resolveYarnLock(raw, lock.path, manifest, { ownsLockfile: serviceKey === '' })
        if (inv) return inv
      } catch (err) {
        recordExtractionError('dependencies', path.relative(scanPath, lock.path), err)
      }
    }
  }
  // With no lockfile, exact pins are all that resolve. A manifest that declares no
  // dependencies at all has nothing to inventory and returns null, so a Go or
  // Python service that merely ships a package.json is not marked partial on its
  // account. A manifest that declares dependencies it could not resolve stays
  // partial, so a surface never reads an incomplete inventory as complete.
  const declared = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }
  if (Object.keys(declared).length === 0) return null
  const pins = exactPins(manifest.dependencies, 'npm')
  return { source: pkgPath, resolution: 'partial', dependencies: pins }
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

// The nearest go.mod at or above the service directory: a Go binary under
// cmd/<name> shares its module root's go.mod (ADR-255).
async function goInventory(svc: DiscoveredService, scanPath: string): Promise<ServiceInventory | null> {
  const root = path.resolve(scanPath)
  let dir = path.resolve(svc.dir)
  for (;;) {
    const modPath = path.join(dir, 'go.mod')
    const source = await readText(modPath)
    if (source !== null) {
      // go.sum sits beside go.mod and completes a pre-1.17 module set.
      const sum = await readText(path.join(dir, 'go.sum'))
      return resolveGoMod(source, modPath, sum)
    }
    if (dir === root || !dir.startsWith(root)) return null
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

// Every ecosystem whose manifest a service directory holds contributes an
// inventory, independent of the service's primary language. A directory with a
// go.mod and a package.json side by side (a Go backend shipping a bundled JS
// frontend) yields both a Go and an npm inventory, so neither module tree is
// missed. Each resolver self-gates on its own manifests and returns null when
// none are present. An inventory that resolved a real manifest is kept even when
// it minted no nodes, so its resolution still stamps the service (a
// declared-but-unresolved manifest keeps the service partial).
async function inventoriesFor(svc: DiscoveredService, scanPath: string): Promise<ServiceInventory[]> {
  const gathered = [
    await npmInventory(svc, scanPath),
    await pythonInventory(svc, scanPath),
    await goInventory(svc, scanPath),
  ]
  return gathered.filter((inv): inv is ServiceInventory => inv !== null)
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
    let invs: ServiceInventory[]
    try {
      invs = await inventoriesFor(svc, scanPath)
    } catch (err) {
      recordExtractionError('dependencies', path.relative(scanPath, svc.dir) || '.', err)
      continue
    }
    if (invs.length === 0) continue

    // Union every ecosystem's resolved dependencies, keyed by dependency id, each
    // carrying the manifest that resolved it so a dependency's DEPENDS_ON edge
    // points at its own ecosystem's file. First writer wins on a duplicate id.
    const wanted = new Map<string, { dep: ResolvedDependency; source: string }>()
    for (const inv of invs) {
      for (const d of inv.dependencies) {
        const depId = dependencyId(d.ecosystem, d.name, d.version)
        if (!wanted.has(depId)) wanted.set(depId, { dep: d, source: inv.source })
      }
    }

    // Replace this service's dependency edges with the union this pass resolved.
    // Running against the full union keeps a service's Go edges while its npm
    // inventory is written, and vice versa.
    for (const edgeId of [...graph.outboundEdges(svcId)]) {
      const e = graph.getEdgeAttributes(edgeId) as GraphEdge
      if (e.type !== EdgeType.DEPENDS_ON || e.provenance !== Provenance.EXTRACTED) continue
      if (!isDependencyNodeId(e.target) || wanted.has(e.target)) continue
      graph.dropEdge(edgeId)
      result.edgesRemoved++
    }

    for (const [depId, { dep: d, source }] of wanted) {
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
      const evidenceFile = path.relative(scanPath, source).split(path.sep).join('/')
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

    // Partial if any ecosystem's inventory is partial, otherwise complete.
    const resolution = invs.some((inv) => inv.resolution === 'partial') ? 'partial' : 'complete'
    graph.mergeNodeAttributes(svcId, { dependencyResolution: resolution } as Partial<ServiceNode>)
  }

  // A version no service depends on any more leaves the graph. Only DEPENDS_ON
  // counts: a first-party IMPORTS edge (imports-to-deps.ts) is rebuilt after this
  // phase, so a leftover one must not keep a dropped version alive.
  const orphans: string[] = []
  graph.forEachNode((id, attrs) => {
    if ((attrs as GraphNode).type !== NodeType.DependencyNode) return
    const depended = graph.someInEdge(id, (_e, a) => (a as GraphEdge).type === EdgeType.DEPENDS_ON)
    if (!depended) orphans.push(id)
  })
  for (const id of orphans) {
    // Its extracted code goes with it (dependency-symbols, ADR-274).
    for (const sym of graph.outNeighbors(id).filter(isDependencySymbolId)) {
      graph.dropNode(sym)
      result.nodesRemoved++
    }
    graph.dropNode(id)
    result.nodesRemoved++
  }
  return result
}
