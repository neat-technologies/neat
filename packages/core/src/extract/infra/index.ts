import type { NeatGraph } from '../../graph.js'
import { type DiscoveredService } from '../shared.js'
import { addComposeInfra } from './docker-compose.js'
import { addDockerfileRuntimes } from './dockerfile.js'
import { addTerraformResources } from './terraform.js'
import { addK8sResources } from './k8s.js'
import { addCloudflareWorkers } from './cloudflare.js'
import { addVercelServices } from './vercel.js'
import { addRailwayServices } from './railway.js'
import { addSupabaseProjects } from './supabase.js'

export interface InfraExtractResult {
  nodesAdded: number
  edgesAdded: number
}

// Phase 5 — infrastructure. Runs after services so RUNS_ON edges have a
// ServiceNode to anchor on. Each sub-source contributes its own nodes/edges
// independently. The platform producers (`cloudflare.ts`, `vercel.ts`,
// `railway.ts`, `supabase.ts`) also tag existing ServiceNode/FileNode
// attributes (`platform`/`platformName`, ADR-133) rather than only adding new
// nodes/edges — property updates on existing nodes are allowed per ADR-030.
export async function addInfra(
  graph: NeatGraph,
  scanPath: string,
  services: DiscoveredService[],
): Promise<InfraExtractResult> {
  const compose = await addComposeInfra(graph, scanPath, services)
  const dockerfile = await addDockerfileRuntimes(graph, services, scanPath)
  const terraform = await addTerraformResources(graph, scanPath)
  const k8s = await addK8sResources(graph, scanPath)
  const cloudflare = await addCloudflareWorkers(graph, services, scanPath)
  const vercel = await addVercelServices(graph, services, scanPath)
  const railway = await addRailwayServices(graph, services, scanPath)
  const supabase = await addSupabaseProjects(graph, services, scanPath)

  return {
    nodesAdded:
      compose.nodesAdded +
      dockerfile.nodesAdded +
      terraform.nodesAdded +
      k8s.nodesAdded +
      cloudflare.nodesAdded +
      vercel.nodesAdded +
      railway.nodesAdded +
      supabase.nodesAdded,
    edgesAdded:
      compose.edgesAdded +
      dockerfile.edgesAdded +
      terraform.edgesAdded +
      k8s.edgesAdded +
      cloudflare.edgesAdded +
      vercel.edgesAdded +
      railway.edgesAdded +
      supabase.edgesAdded,
  }
}
