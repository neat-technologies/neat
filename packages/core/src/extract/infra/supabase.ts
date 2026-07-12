// Supabase project extraction. Stamps the `platform: supabase` identifier the
// frontend service-rollup badge keys on (mirroring ADR-133 for Cloudflare) when a
// service carries a `supabase/config.toml`, using the config's `project_id` as
// platformName (the ref the Supabase connector resolves against), and models the
// declared surfaces — edge functions, storage, auth — as InfraNodes wired from
// the ServiceNode. No new NodeType.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { ServiceNode } from '@neat.is/types'
import { EdgeType, EdgeTypeValue } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { exists, type DiscoveredService } from '../shared.js'
import { recordExtractionError } from '../errors.js'
import { toPosix } from '../calls/shared.js'
import { emitPlatformResourceEdge, lineContaining } from './shared.js'

interface SupabaseConfig {
  project_id?: string
  functions?: Record<string, unknown>
  storage?: Record<string, unknown>
  auth?: Record<string, unknown>
}

interface SupabaseRead {
  config: SupabaseConfig
  relFile: string
  raw: string
}

// Supabase's config lives at <service>/supabase/config.toml, not the service root.
async function readSupabaseConfig(dir: string): Promise<SupabaseRead | null> {
  const relFile = path.join('supabase', 'config.toml')
  const abs = path.join(dir, relFile)
  if (!(await exists(abs))) return null
  const raw = await fs.readFile(abs, 'utf8')
  const config = parseToml(raw) as unknown as SupabaseConfig
  return { config, relFile, raw }
}

export async function addSupabaseProjects(
  graph: NeatGraph,
  services: DiscoveredService[],
  scanPath: string,
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  let nodesAdded = 0
  let edgesAdded = 0

  for (const service of services) {
    let read: SupabaseRead | null = null
    try {
      read = await readSupabaseConfig(service.dir)
    } catch (err) {
      recordExtractionError('infra supabase', path.relative(scanPath, service.dir), err)
      continue
    }
    if (!read) continue

    const { config, relFile, raw } = read
    const projectId = typeof config.project_id === 'string' ? config.project_id : undefined

    const serviceNode = graph.getNodeAttributes(service.node.id) as ServiceNode
    if (serviceNode.platform !== 'supabase' || (projectId && serviceNode.platformName !== projectId)) {
      graph.replaceNodeAttributes(service.node.id, {
        ...serviceNode,
        platform: 'supabase',
        ...(projectId ? { platformName: projectId } : {}),
      })
    }

    const anchorId = service.node.id
    const evidenceFile = toPosix(path.relative(scanPath, path.join(service.dir, relFile)))

    const add = (edgeType: EdgeTypeValue, kind: string, name: string | undefined): void => {
      if (!name) return
      const result = emitPlatformResourceEdge(
        graph,
        anchorId,
        edgeType,
        kind,
        name,
        'supabase',
        evidenceFile,
        lineContaining(raw, name),
      )
      nodesAdded += result.nodesAdded
      edgesAdded += result.edgesAdded
    }

    add(EdgeType.RUNS_ON, 'supabase', 'supabase')
    // Edge functions — each [functions.X] section becomes a declared function.
    for (const fn of Object.keys(config.functions ?? {})) add(EdgeType.DEPENDS_ON, 'supabase-function', fn)
    // Managed surfaces the project declares.
    if (config.storage) add(EdgeType.DEPENDS_ON, 'supabase-storage', 'storage')
    if (config.auth) add(EdgeType.DEPENDS_ON, 'supabase-auth', 'auth')
  }

  return { nodesAdded, edgesAdded }
}
