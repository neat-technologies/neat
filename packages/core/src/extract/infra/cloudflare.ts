// Cloudflare Workers/Pages extraction (ADR-133, docs/contracts/static-extraction.md).
//
// Reads a service's `wrangler.toml`/`wrangler.jsonc`/`wrangler.json` and stamps
// the `platform: cloudflare` identifier every downstream consumer keys on: the
// ServiceNode (the frontend's icon key at the service-rollup level) and the
// Worker's entry FileNode, which also carries `platformName` — the Worker's own
// script name, the only identifier Cloudflare's own telemetry carries and what
// the Cloudflare connector's resolveTarget looks up against
// (docs/contracts/connectors.md §4a).
//
// Declared resources (bindings, routes, cron triggers, env-var names) become
// InfraNodes wired from the entry file, the same shape dockerfile.ts/k8s.ts/
// docker-compose.ts already use — no new NodeType. Per-environment `[env.X]`
// wrangler sections are out of scope for v1; only top-level config is read.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { FileNode, GraphEdge, ServiceNode } from '@neat.is/types'
import { EdgeType, EdgeTypeValue, Provenance, confidenceForExtracted } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { exists, maskCommentsInSource, makeEdgeId, type DiscoveredService } from '../shared.js'
import { recordExtractionError } from '../errors.js'
import { ensureFileNode, toPosix } from '../calls/shared.js'
import { makeInfraNode } from './shared.js'

interface WranglerBindingLike {
  binding?: string
  name?: string
  queue?: string
}

interface WranglerRouteLike {
  pattern?: string
}

interface WranglerServiceBinding {
  binding?: string
  service?: string
}

interface WranglerConfig {
  name?: string
  main?: string
  compatibility_date?: string
  routes?: (string | WranglerRouteLike)[]
  route?: string | WranglerRouteLike
  kv_namespaces?: WranglerBindingLike[]
  d1_databases?: WranglerBindingLike[]
  r2_buckets?: WranglerBindingLike[]
  durable_objects?: { bindings?: WranglerBindingLike[] }
  queues?: { producers?: WranglerBindingLike[]; consumers?: WranglerBindingLike[] }
  triggers?: { crons?: string[] }
  services?: WranglerServiceBinding[]
  vars?: Record<string, unknown>
}

interface WranglerRead {
  config: WranglerConfig
  relFile: string
  raw: string
}

const WRANGLER_FILENAMES = ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json']

async function readWranglerConfig(dir: string): Promise<WranglerRead | null> {
  for (const filename of WRANGLER_FILENAMES) {
    const abs = path.join(dir, filename)
    if (!(await exists(abs))) continue
    const raw = await fs.readFile(abs, 'utf8')
    const config =
      filename === 'wrangler.toml'
        ? (parseToml(raw) as unknown as WranglerConfig)
        : (JSON.parse(maskCommentsInSource(raw)) as WranglerConfig)
    return { config, relFile: filename, raw }
  }
  return null
}

// Best-effort 1-indexed line for a declared value — a simple text search, the
// same "read config as data" discipline `proto.ts`'s brace-balanced scan and
// `terraform.ts`'s `lineAt` already use rather than a real TOML/JSONC AST.
function lineContaining(raw: string, needle: string | undefined): number | undefined {
  if (!needle) return undefined
  const idx = raw.indexOf(needle)
  if (idx === -1) return undefined
  let line = 1
  for (let i = 0; i < idx; i++) if (raw[i] === '\n') line++
  return line
}

function normalizeRoutes(config: WranglerConfig): string[] {
  const out: string[] = []
  const pushOne = (r: unknown): void => {
    if (typeof r === 'string') out.push(r)
    else if (r && typeof r === 'object' && typeof (r as WranglerRouteLike).pattern === 'string') {
      out.push((r as WranglerRouteLike).pattern!)
    }
  }
  if (Array.isArray(config.routes)) config.routes.forEach(pushOne)
  else if (config.route) pushOne(config.route)
  return out
}

// One declared-resource InfraNode + edge from the entry anchor (FileNode, or
// the ServiceNode itself when no entry file resolved — the honest
// service-level fallback file-awareness.md already names for this case).
function addResourceEdge(
  graph: NeatGraph,
  anchorId: string,
  edgeType: EdgeTypeValue,
  kind: string,
  name: string,
  evidenceFile: string,
  line: number | undefined,
): { nodesAdded: number; edgesAdded: number } {
  let nodesAdded = 0
  let edgesAdded = 0
  const node = makeInfraNode(kind, name, 'cloudflare')
  if (!graph.hasNode(node.id)) {
    graph.addNode(node.id, node)
    nodesAdded++
  }
  if (node.id === anchorId) return { nodesAdded, edgesAdded } // no self-loops
  const edgeId = makeEdgeId(anchorId, node.id, edgeType)
  if (!graph.hasEdge(edgeId)) {
    const edge: GraphEdge = {
      id: edgeId,
      source: anchorId,
      target: node.id,
      type: edgeType,
      provenance: Provenance.EXTRACTED,
      confidence: confidenceForExtracted('structural'),
      evidence: { file: evidenceFile, ...(line !== undefined ? { line } : {}) },
    }
    graph.addEdgeWithKey(edgeId, edge.source, edge.target, edge)
    edgesAdded++
  }
  return { nodesAdded, edgesAdded }
}

interface DiscoveredWorker {
  service: DiscoveredService
  config: WranglerConfig
  relFile: string
  raw: string
  evidenceFile: string
}

export async function addCloudflareWorkers(
  graph: NeatGraph,
  services: DiscoveredService[],
  scanPath: string,
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  let nodesAdded = 0
  let edgesAdded = 0

  // Pass 1 — read every service's wrangler config (if any) before writing a
  // single node, so pass 2's service-binding resolution sees the full
  // worker-name → entry-file map for this scan, same discipline `route-match.ts`
  // uses running routes before calls.
  const discovered: DiscoveredWorker[] = []
  const workerIndex = new Map<string, { anchorId: string }>()

  for (const service of services) {
    let read: WranglerRead | null
    try {
      read = await readWranglerConfig(service.dir)
    } catch (err) {
      recordExtractionError('infra cloudflare', path.relative(scanPath, service.dir), err)
      continue
    }
    if (!read || !read.config.name) continue

    const evidenceFile = toPosix(path.relative(scanPath, path.join(service.dir, read.relFile)))
    discovered.push({ service, config: read.config, relFile: read.relFile, raw: read.raw, evidenceFile })
  }

  // Tag every ServiceNode + entry FileNode first, populating workerIndex, so
  // pass 2's service-binding resolution can target a real FileNode even when
  // the referenced Worker is later in `services` than the one declaring the
  // binding.
  for (const worker of discovered) {
    const { service, config } = worker

    const serviceNode = graph.getNodeAttributes(service.node.id) as ServiceNode
    if (serviceNode.platform !== 'cloudflare') {
      const updated: ServiceNode = { ...serviceNode, platform: 'cloudflare' }
      graph.replaceNodeAttributes(service.node.id, updated)
    }

    let anchorId = service.node.id
    if (config.main) {
      const entryRelPath = toPosix(path.normalize(config.main))
      const { fileNodeId, nodesAdded: fn, edgesAdded: fe } = ensureFileNode(
        graph,
        service.pkg.name,
        service.node.id,
        entryRelPath,
      )
      nodesAdded += fn
      edgesAdded += fe
      const fileNode = graph.getNodeAttributes(fileNodeId) as FileNode
      if (fileNode.platform !== 'cloudflare' || fileNode.platformName !== config.name) {
        const updated: FileNode = { ...fileNode, platform: 'cloudflare', platformName: config.name }
        graph.replaceNodeAttributes(fileNodeId, updated)
      }
      anchorId = fileNodeId
    }

    workerIndex.set(config.name!, { anchorId })
  }

  // Pass 2 — declared resources, wired from each worker's anchor (entry
  // FileNode, or the ServiceNode when `main` was absent).
  for (const worker of discovered) {
    const { config, evidenceFile, raw } = worker
    const anchorId = workerIndex.get(config.name!)!.anchorId

    // Runtime marker — one shared node every Cloudflare Worker in this scan
    // RUNS_ON, compat date carried as evidence.snippet (mirrors dockerfile.ts's
    // image-node + entrypoint-snippet pattern).
    const runtimeNode = makeInfraNode('workerd', 'cloudflare', 'cloudflare')
    if (!graph.hasNode(runtimeNode.id)) {
      graph.addNode(runtimeNode.id, runtimeNode)
      nodesAdded++
    }
    if (runtimeNode.id !== anchorId) {
      const runsOnId = makeEdgeId(anchorId, runtimeNode.id, EdgeType.RUNS_ON)
      if (!graph.hasEdge(runsOnId)) {
        const edge: GraphEdge = {
          id: runsOnId,
          source: anchorId,
          target: runtimeNode.id,
          type: EdgeType.RUNS_ON,
          provenance: Provenance.EXTRACTED,
          confidence: confidenceForExtracted('structural'),
          evidence: {
            file: evidenceFile,
            ...(config.compatibility_date
              ? { snippet: `compatibility_date = ${config.compatibility_date}`.slice(0, 120) }
              : {}),
          },
        }
        graph.addEdgeWithKey(runsOnId, edge.source, edge.target, edge)
        edgesAdded++
      }
    }

    // Routes / custom domains — network-reachability, same CONNECTS_TO
    // semantics dockerfile.ts's EXPOSE→port edge already uses.
    for (const route of normalizeRoutes(config)) {
      const result = addResourceEdge(
        graph,
        anchorId,
        EdgeType.CONNECTS_TO,
        'cloudflare-route',
        route,
        evidenceFile,
        lineContaining(raw, route),
      )
      nodesAdded += result.nodesAdded
      edgesAdded += result.edgesAdded
    }

    // Bindings — declared runtime dependencies, DEPENDS_ON.
    const bindingGroups: { kind: string; entries: WranglerBindingLike[]; nameOf: (b: WranglerBindingLike) => string | undefined }[] = [
      { kind: 'cloudflare-kv', entries: config.kv_namespaces ?? [], nameOf: (b) => b.binding },
      { kind: 'cloudflare-d1', entries: config.d1_databases ?? [], nameOf: (b) => b.binding },
      { kind: 'cloudflare-r2', entries: config.r2_buckets ?? [], nameOf: (b) => b.binding },
      { kind: 'cloudflare-durable-object', entries: config.durable_objects?.bindings ?? [], nameOf: (b) => b.name },
      { kind: 'cloudflare-queue', entries: config.queues?.producers ?? [], nameOf: (b) => b.queue },
      { kind: 'cloudflare-queue', entries: config.queues?.consumers ?? [], nameOf: (b) => b.queue },
    ]
    for (const group of bindingGroups) {
      for (const entry of group.entries) {
        const name = group.nameOf(entry)
        if (!name) continue
        const result = addResourceEdge(
          graph,
          anchorId,
          EdgeType.DEPENDS_ON,
          group.kind,
          name,
          evidenceFile,
          lineContaining(raw, name),
        )
        nodesAdded += result.nodesAdded
        edgesAdded += result.edgesAdded
      }
    }

    // Cron triggers.
    for (const cron of config.triggers?.crons ?? []) {
      const result = addResourceEdge(
        graph,
        anchorId,
        EdgeType.DEPENDS_ON,
        'cloudflare-cron',
        cron,
        evidenceFile,
        lineContaining(raw, cron),
      )
      nodesAdded += result.nodesAdded
      edgesAdded += result.edgesAdded
    }

    // Declared env vars — name only, value never read (ADR-016 spirit).
    for (const varName of Object.keys(config.vars ?? {})) {
      const result = addResourceEdge(
        graph,
        anchorId,
        EdgeType.DEPENDS_ON,
        'cloudflare-env-var',
        varName,
        evidenceFile,
        lineContaining(raw, varName),
      )
      nodesAdded += result.nodesAdded
      edgesAdded += result.edgesAdded
    }

    // Service bindings — resolve directly onto the target Worker's own entry
    // node when it's tagged in this same scan (CALLS: this Worker can invoke
    // that one); otherwise an honest InfraNode fallback, never guessed.
    for (const svc of config.services ?? []) {
      if (!svc.service) continue
      const target = workerIndex.get(svc.service)
      if (target && target.anchorId !== anchorId) {
        const edgeId = makeEdgeId(anchorId, target.anchorId, EdgeType.CALLS)
        if (!graph.hasEdge(edgeId)) {
          const edge: GraphEdge = {
            id: edgeId,
            source: anchorId,
            target: target.anchorId,
            type: EdgeType.CALLS,
            provenance: Provenance.EXTRACTED,
            confidence: confidenceForExtracted('structural'),
            evidence: { file: evidenceFile, line: lineContaining(raw, svc.service) },
          }
          graph.addEdgeWithKey(edgeId, edge.source, edge.target, edge)
          edgesAdded++
        }
        continue
      }
      const result = addResourceEdge(
        graph,
        anchorId,
        EdgeType.DEPENDS_ON,
        'cloudflare-service-binding',
        svc.service,
        evidenceFile,
        lineContaining(raw, svc.service),
      )
      nodesAdded += result.nodesAdded
      edgesAdded += result.edgesAdded
    }
  }

  return { nodesAdded, edgesAdded }
}
