import { promises as fs } from 'node:fs'
import path from 'node:path'
import ignore, { type Ignore } from 'ignore'
import { minimatch } from 'minimatch'
import type { ServiceNode } from '@neat.is/types'
import { NodeType, serviceId } from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import {
  IGNORED_DIRS,
  exists,
  readJson,
  type DiscoveredService,
  type PackageJson,
} from './shared.js'
import { discoverPythonService, pythonToPackage } from './python.js'
import { computeServiceOwner, loadCodeowners } from './owners.js'
import { recordExtractionError } from './errors.js'

const DEFAULT_SCAN_DEPTH = 5

interface RootPackageJson extends PackageJson {
  workspaces?: string[] | { packages?: string[] }
}

function parseScanDepth(): number {
  const raw = process.env.NEAT_SCAN_DEPTH
  if (!raw) return DEFAULT_SCAN_DEPTH
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SCAN_DEPTH
}

function workspaceGlobs(pkg: RootPackageJson): string[] | null {
  const ws = pkg.workspaces
  if (!ws) return null
  if (Array.isArray(ws)) return ws.length > 0 ? ws : null
  if (Array.isArray(ws.packages)) return ws.packages.length > 0 ? ws.packages : null
  return null
}

async function loadGitignore(scanPath: string): Promise<Ignore | null> {
  const gitignorePath = path.join(scanPath, '.gitignore')
  if (!(await exists(gitignorePath))) return null
  const raw = await fs.readFile(gitignorePath, 'utf8')
  return ignore().add(raw)
}

interface WalkOptions {
  maxDepth: number
  ig: Ignore | null
}

async function walkDirs(
  start: string,
  scanPath: string,
  options: WalkOptions,
  visit: (dir: string) => Promise<void> | void,
): Promise<void> {
  async function recurse(current: string, depth: number): Promise<void> {
    if (depth > options.maxDepth) return
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (IGNORED_DIRS.has(entry.name)) continue
      const child = path.join(current, entry.name)
      if (options.ig) {
        const rel = path.relative(scanPath, child).split(path.sep).join('/')
        // Trailing slash so `ignore` evaluates the entry as a directory; without
        // it, gitignore patterns like `dist/` won't match because the lib
        // distinguishes file vs. directory tests.
        if (rel && options.ig.ignores(rel + '/')) continue
      }
      await visit(child)
      await recurse(child, depth + 1)
    }
  }
  await recurse(start, 0)
}

async function expandWorkspaceGlobs(
  scanPath: string,
  globs: string[],
): Promise<string[]> {
  const found = new Set<string>()
  const scanDepth = parseScanDepth()

  for (const raw of globs) {
    const pattern = raw.replace(/^\.\//, '')

    if (!pattern.includes('*')) {
      const candidate = path.join(scanPath, pattern)
      if (await exists(path.join(candidate, 'package.json'))) found.add(candidate)
      continue
    }

    const segments = pattern.split('/')
    const staticSegments: string[] = []
    for (const seg of segments) {
      if (seg.includes('*')) break
      staticSegments.push(seg)
    }
    const start = path.join(scanPath, ...staticSegments)
    if (!(await exists(start))) continue

    const hasDoubleStar = pattern.includes('**')
    const walkDepth = hasDoubleStar
      ? scanDepth
      : Math.max(0, segments.length - staticSegments.length - 1)

    await walkDirs(start, scanPath, { maxDepth: walkDepth, ig: null }, async (dir) => {
      const rel = path.relative(scanPath, dir).split(path.sep).join('/')
      if (minimatch(rel, pattern) && (await exists(path.join(dir, 'package.json')))) {
        found.add(dir)
      }
    })
  }

  return [...found]
}

// Framework detection from package.json deps (ADR-074 §3). Mirrors the
// installer dispatch precedence so a project the installer recognises as
// Remix records `framework: 'remix'` on its ServiceNode. The static
// extractor sees only manifest data, so detection is dep-presence based —
// it doesn't crack open config files. Detection precedence: Next → Remix
// → SvelteKit → Nuxt → Astro → vanilla Node.
function detectJsFramework(pkg: PackageJson): string | undefined {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  if (deps['next'] !== undefined) return 'next'
  if (deps['remix'] !== undefined) return 'remix'
  for (const k of Object.keys(deps)) {
    if (k.startsWith('@remix-run/')) return 'remix'
  }
  if (deps['@sveltejs/kit'] !== undefined) return 'sveltekit'
  if (deps['nuxt'] !== undefined) return 'nuxt'
  if (deps['astro'] !== undefined) return 'astro'
  return undefined
}

async function discoverNodeService(
  scanPath: string,
  dir: string,
): Promise<DiscoveredService | null> {
  const pkgPath = path.join(dir, 'package.json')
  if (!(await exists(pkgPath))) return null
  let pkg: PackageJson
  try {
    pkg = await readJson<PackageJson>(pkgPath)
  } catch (err) {
    recordExtractionError('services', path.relative(scanPath, pkgPath), err)
    return null
  }
  if (!pkg.name) return null
  const framework = detectJsFramework(pkg)
  const node: ServiceNode = {
    id: serviceId(pkg.name),
    type: NodeType.ServiceNode,
    name: pkg.name,
    language: 'javascript',
    version: pkg.version,
    dependencies: pkg.dependencies ?? {},
    repoPath: path.relative(scanPath, dir),
    ...(pkg.engines?.node ? { nodeEngine: pkg.engines.node } : {}),
    ...(framework ? { framework } : {}),
  }
  return { pkg, dir, node }
}

async function discoverPyService(
  scanPath: string,
  dir: string,
): Promise<DiscoveredService | null> {
  const py = await discoverPythonService(dir)
  if (!py) return null
  const pkg = pythonToPackage(py)
  const node: ServiceNode = {
    id: serviceId(py.name),
    type: NodeType.ServiceNode,
    name: py.name,
    language: 'python',
    version: py.version,
    dependencies: py.dependencies,
    repoPath: path.relative(scanPath, dir),
  }
  return { pkg, dir, node }
}

// Phase 1 — discover service directories under scanPath. A service is any
// directory containing a JS/TS manifest (`package.json`) or a Python manifest
// (`pyproject.toml` / `requirements.txt` / `setup.py`). JS wins on tie.
//
// If the root `package.json` declares `workspaces`, those globs are
// authoritative — we don't fall back to a free recursive walk. Otherwise we
// walk recursively, depth-bounded by `NEAT_SCAN_DEPTH` (default 5), skipping
// `IGNORED_DIRS` and anything matched by the root `.gitignore`.
//
// Two manifests sharing a `name` collapse to one node per ADR-010; the
// duplicate logs a warning naming both paths.
export async function discoverServices(scanPath: string): Promise<DiscoveredService[]> {
  const rootPkgPath = path.join(scanPath, 'package.json')
  let rootPkg: RootPackageJson | null = null
  if (await exists(rootPkgPath)) {
    try {
      rootPkg = await readJson<RootPackageJson>(rootPkgPath)
    } catch (err) {
      recordExtractionError(
        'services workspaces',
        path.relative(scanPath, rootPkgPath),
        err,
      )
    }
  }
  const wsGlobs = rootPkg ? workspaceGlobs(rootPkg) : null

  const candidateDirs: string[] = []
  if (wsGlobs) {
    candidateDirs.push(...(await expandWorkspaceGlobs(scanPath, wsGlobs)))
  } else {
    if (rootPkg && rootPkg.name) candidateDirs.push(scanPath)
    const ig = await loadGitignore(scanPath)
    await walkDirs(
      scanPath,
      scanPath,
      { maxDepth: parseScanDepth(), ig },
      async (dir) => {
        if (await exists(path.join(dir, 'package.json'))) {
          candidateDirs.push(dir)
        } else if (
          (await exists(path.join(dir, 'pyproject.toml'))) ||
          (await exists(path.join(dir, 'requirements.txt'))) ||
          (await exists(path.join(dir, 'setup.py')))
        ) {
          candidateDirs.push(dir)
        }
      },
    )
  }

  candidateDirs.sort()

  const seen = new Map<string, string>()
  const out: DiscoveredService[] = []
  for (const dir of candidateDirs) {
    const service =
      (await discoverNodeService(scanPath, dir)) ??
      (await discoverPyService(scanPath, dir))
    if (!service) continue

    const existingDir = seen.get(service.node.name)
    if (existingDir !== undefined) {
      const a = path.relative(scanPath, existingDir) || '.'
      const b = path.relative(scanPath, dir) || '.'
      console.warn(
        `[neat] duplicate package name "${service.node.name}" — keeping ${a}, ignoring ${b}`,
      )
      continue
    }
    seen.set(service.node.name, dir)
    out.push(service)
  }

  // Owner extraction (ADR-054). CODEOWNERS first, package.json `author`
  // fallback, undefined otherwise. Read once per discovery pass; the file
  // is small and parsing it per-service would be wasteful.
  const codeowners = await loadCodeowners(scanPath)
  for (const service of out) {
    const owner = await computeServiceOwner(codeowners, service.node.repoPath, service.dir)
    if (owner !== undefined) service.node.owner = owner
  }

  return out
}

export function addServiceNodes(graph: NeatGraph, services: DiscoveredService[]): number {
  let nodesAdded = 0
  for (const service of services) {
    if (!graph.hasNode(service.node.id)) {
      graph.addNode(service.node.id, { ...service.node, discoveredVia: 'static' })
      nodesAdded++
      continue
    }
    // OTel ingest may have auto-created a minimal node at this id. Merge per
    // ADR-033 / identity contract: static fields override OTel-derived fields,
    // and discoveredVia flips to 'merged' when both layers contributed.
    const existing = graph.getNodeAttributes(service.node.id) as ServiceNode
    const mergedDiscoveredVia: 'static' | 'otel' | 'merged' =
      existing.discoveredVia === 'otel' ? 'merged' : 'static'
    graph.replaceNodeAttributes(service.node.id, {
      ...existing,
      ...service.node,
      discoveredVia: mergedDiscoveredVia,
    })
  }
  return nodesAdded
}
