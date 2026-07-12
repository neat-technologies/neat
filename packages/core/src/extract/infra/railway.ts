// Railway service extraction. Stamps the `platform: railway` identifier the
// frontend service-rollup badge keys on (mirroring ADR-133 for Cloudflare) when a
// service carries a `railway.toml`/`railway.json`/`railway.jsonc`, and models the
// config's declared surfaces — the healthcheck path and a cron schedule — as
// InfraNodes wired from the ServiceNode. No new NodeType. Railway's config names
// no service (that lives in Railway's own system, which the connector resolves by
// deploymentId), so no platformName is stamped here.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { ServiceNode } from '@neat.is/types'
import { EdgeType, EdgeTypeValue } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { exists, maskCommentsInSource, type DiscoveredService } from '../shared.js'
import { recordExtractionError } from '../errors.js'
import { toPosix } from '../calls/shared.js'
import { emitPlatformResourceEdge, lineContaining } from './shared.js'

interface RailwayDeploy {
  healthcheckPath?: string
  cronSchedule?: string
}

interface RailwayConfig {
  deploy?: RailwayDeploy
}

const RAILWAY_FILENAMES = ['railway.toml', 'railway.json', 'railway.jsonc']

interface RailwayRead {
  config: RailwayConfig
  relFile: string
  raw: string
}

async function readRailwayConfig(dir: string): Promise<RailwayRead | null> {
  for (const filename of RAILWAY_FILENAMES) {
    const abs = path.join(dir, filename)
    if (!(await exists(abs))) continue
    const raw = await fs.readFile(abs, 'utf8')
    const config =
      filename === 'railway.toml'
        ? (parseToml(raw) as unknown as RailwayConfig)
        : (JSON.parse(maskCommentsInSource(raw)) as RailwayConfig)
    return { config, relFile: filename, raw }
  }
  return null
}

export async function addRailwayServices(
  graph: NeatGraph,
  services: DiscoveredService[],
  scanPath: string,
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  let nodesAdded = 0
  let edgesAdded = 0

  for (const service of services) {
    let read: RailwayRead | null = null
    try {
      read = await readRailwayConfig(service.dir)
    } catch (err) {
      recordExtractionError('infra railway', path.relative(scanPath, service.dir), err)
      continue
    }
    if (!read) continue

    const serviceNode = graph.getNodeAttributes(service.node.id) as ServiceNode
    if (serviceNode.platform !== 'railway') {
      graph.replaceNodeAttributes(service.node.id, { ...serviceNode, platform: 'railway' })
    }

    const anchorId = service.node.id
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
        'railway',
        evidenceFile,
        lineContaining(raw, name),
      )
      nodesAdded += result.nodesAdded
      edgesAdded += result.edgesAdded
    }

    add(EdgeType.RUNS_ON, 'railway', 'railway')
    add(EdgeType.CONNECTS_TO, 'railway-route', config.deploy?.healthcheckPath)
    add(EdgeType.DEPENDS_ON, 'railway-cron', config.deploy?.cronSchedule)
  }

  return { nodesAdded, edgesAdded }
}
