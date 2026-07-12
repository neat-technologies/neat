// Vercel project extraction. Stamps the `platform: vercel` identifier the
// frontend service-rollup badge keys on (static-extraction.md, mirroring ADR-133
// for Cloudflare) whenever a service carries a `vercel.json`/`vercel.jsonc` or a
// linked `.vercel/project.json`, and models the config's declared resources —
// crons, env-var names, routes/rewrites — as InfraNodes wired from the
// ServiceNode. No new NodeType; env-var values are never read (ADR-016 spirit),
// only names. Vercel apps have no single Worker-style entry file, so the tag and
// the resource edges anchor on the ServiceNode itself.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ServiceNode } from '@neat.is/types'
import { EdgeType, EdgeTypeValue } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { exists, maskCommentsInSource, type DiscoveredService } from '../shared.js'
import { recordExtractionError } from '../errors.js'
import { toPosix } from '../calls/shared.js'
import { emitPlatformResourceEdge, lineContaining } from './shared.js'

interface VercelCron {
  path?: string
  schedule?: string
}

interface VercelRoute {
  source?: string
  src?: string
}

interface VercelConfig {
  crons?: VercelCron[]
  env?: Record<string, unknown>
  build?: { env?: Record<string, unknown> }
  rewrites?: VercelRoute[]
  redirects?: VercelRoute[]
  routes?: VercelRoute[]
}

const VERCEL_CONFIG_FILENAMES = ['vercel.json', 'vercel.jsonc']

interface VercelRead {
  config: VercelConfig
  relFile: string
  raw: string
}

async function readVercelConfig(dir: string): Promise<VercelRead | null> {
  for (const filename of VERCEL_CONFIG_FILENAMES) {
    const abs = path.join(dir, filename)
    if (!(await exists(abs))) continue
    const raw = await fs.readFile(abs, 'utf8')
    const config = JSON.parse(maskCommentsInSource(raw)) as VercelConfig
    return { config, relFile: filename, raw }
  }
  return null
}

// `vercel link` writes `.vercel/project.json` — a strong platform signal even
// when the repo carries no vercel.json, and the only place the human-readable
// project name lives (the equivalent of a Worker's script name).
async function readLinkedProjectName(dir: string): Promise<string | undefined> {
  const abs = path.join(dir, '.vercel', 'project.json')
  if (!(await exists(abs))) return undefined
  const parsed = JSON.parse(await fs.readFile(abs, 'utf8')) as { projectName?: unknown }
  return typeof parsed.projectName === 'string' ? parsed.projectName : undefined
}

function routeSource(route: VercelRoute): string | undefined {
  return route.source ?? route.src
}

export async function addVercelServices(
  graph: NeatGraph,
  services: DiscoveredService[],
  scanPath: string,
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  let nodesAdded = 0
  let edgesAdded = 0

  for (const service of services) {
    let read: VercelRead | null = null
    let projectName: string | undefined
    try {
      read = await readVercelConfig(service.dir)
      projectName = await readLinkedProjectName(service.dir)
    } catch (err) {
      recordExtractionError('infra vercel', path.relative(scanPath, service.dir), err)
      continue
    }
    // A Vercel service is one with a vercel.json or a linked .vercel/project.json.
    if (!read && !projectName) continue

    const serviceNode = graph.getNodeAttributes(service.node.id) as ServiceNode
    if (serviceNode.platform !== 'vercel' || (projectName && serviceNode.platformName !== projectName)) {
      const updated: ServiceNode = {
        ...serviceNode,
        platform: 'vercel',
        ...(projectName ? { platformName: projectName } : {}),
      }
      graph.replaceNodeAttributes(service.node.id, updated)
    }

    const anchorId = service.node.id
    if (!read) continue // linked but no config file to mine resources from
    const { config, relFile, raw } = read
    const evidenceFile = toPosix(path.relative(scanPath, path.join(service.dir, relFile)))

    const add = (edgeType: EdgeTypeValue, kind: string, name: string | undefined): void => {
      if (!name) return
      const result = emitPlatformResourceEdge(
        graph,
        anchorId,
        edgeType,
        kind,
        name,
        'vercel',
        evidenceFile,
        lineContaining(raw, name),
      )
      nodesAdded += result.nodesAdded
      edgesAdded += result.edgesAdded
    }

    // Runtime marker — one shared node every Vercel service RUNS_ON.
    add(EdgeType.RUNS_ON, 'vercel', 'vercel')

    // Scheduled functions.
    for (const cron of config.crons ?? []) add(EdgeType.DEPENDS_ON, 'vercel-cron', cron.path ?? cron.schedule)

    // Declared env vars — names only, value never read.
    for (const varName of Object.keys(config.env ?? {})) add(EdgeType.DEPENDS_ON, 'vercel-env-var', varName)
    for (const varName of Object.keys(config.build?.env ?? {})) add(EdgeType.DEPENDS_ON, 'vercel-env-var', varName)

    // Routes / rewrites / redirects — network-reachability, CONNECTS_TO.
    for (const route of [...(config.rewrites ?? []), ...(config.redirects ?? []), ...(config.routes ?? [])]) {
      add(EdgeType.CONNECTS_TO, 'vercel-route', routeSource(route))
    }
  }

  return { nodesAdded, edgesAdded }
}
