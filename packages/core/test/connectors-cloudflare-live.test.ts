import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  fileId,
  observedEdgeId,
  serviceId,
  type FileNode,
  type GraphEdge,
  type GraphNode,
  type ServiceNode,
} from '@neat.is/types'
import { runConnectorPoll, type ConnectorContext } from '../src/connectors/index.js'
import type { NeatGraph } from '../src/graph.js'
import {
  CloudflareConnector,
  createCloudflareResolveTarget,
  type CloudflareConnectorConfig,
} from '../src/connectors/cloudflare/index.js'

// Opt-in live fixture. Never runs in CI unless CLOUDFLARE_CONNECTOR_LIVE=1 with a
// real API token (Account Analytics / Workers Observability read), a deployed
// Worker whose wrangler.toml has observability.enabled, and the Worker's public
// URL to drive traffic against. Mirrors connectors-supabase-live.test.ts.
const LIVE = process.env.CLOUDFLARE_CONNECTOR_LIVE === '1'
const describeLive = LIVE ? describe : describe.skip

function reqEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing ${name}; live Cloudflare connector test requires it`)
  return v
}

const SERVICE = process.env.CLOUDFLARE_LIVE_SERVICE_NAME ?? 'cf-live-fixture'
const ENTRY_FILE = process.env.CLOUDFLARE_LIVE_ENTRY_FILE ?? 'src/index.js'

function buildGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  const service: ServiceNode = {
    id: serviceId(SERVICE),
    type: NodeType.ServiceNode,
    name: SERVICE,
    language: 'typescript',
  }
  g.addNode(service.id, service)
  // The EXTRACTED FileNode a static extractor would have minted for the Worker's
  // entry file — so the connector can resolve whole-file grain.
  const entry: FileNode = {
    id: fileId(SERVICE, ENTRY_FILE),
    type: NodeType.FileNode,
    service: SERVICE,
    path: ENTRY_FILE,
    language: 'typescript',
  }
  g.addNode(entry.id, entry)
  return g
}

async function driveTraffic(url: string, iterations = 10): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    for (const path of ['/orders', '/health', '/']) {
      try {
        await fetch(`${url}${path}`)
      } catch {
        /* still emits worker telemetry */
      }
    }
  }
}

describeLive('Cloudflare connector — live worker fixture', () => {
  it(
    'observes real worker telemetry and mints an OBSERVED CALLS edge',
    async () => {
      const apiToken = reqEnv('CLOUDFLARE_API_TOKEN')
      const accountId = reqEnv('CLOUDFLARE_ACCOUNT_ID')
      const workerName = reqEnv('CLOUDFLARE_WORKER_NAME')
      const workerUrl = reqEnv('CLOUDFLARE_WORKER_URL').replace(/\/+$/, '')

      const config: CloudflareConnectorConfig = {
        accountId,
        // explicit worker→file mapping so the observed edge lands file-grained
        // without needing an extracted platform tag in this synthetic graph.
        workers: { [workerName]: { service: SERVICE, entryFile: ENTRY_FILE } },
      }
      const ctx: ConnectorContext = {
        projectDir: '/live/cf-fixture',
        credentials: { apiToken },
      }
      const expectedEdgeId = observedEdgeId(
        serviceId(SERVICE),
        fileId(SERVICE, ENTRY_FILE),
        EdgeType.CALLS,
      )

      await driveTraffic(workerUrl, 12)

      const deadline = Date.now() + 180_000
      let lastEdges = 0
      while (Date.now() < deadline) {
        // fresh connector + graph each tick so the 1h lookback window always
        // re-covers the traffic we just drove (a persisted `since` watermark
        // would skip past it once an early, still-lagging poll returned empty).
        const graph = buildGraph()
        const connector = new CloudflareConnector(config)
        const resolveTarget = createCloudflareResolveTarget(config, graph)
        const result = await runConnectorPoll(connector, ctx, graph, resolveTarget)
        lastEdges = result.edgesCreated
        if (result.edgesCreated >= 1 && graph.hasEdge(expectedEdgeId)) {
          const edge = graph.getEdgeAttributes(expectedEdgeId) as GraphEdge
          expect(edge.provenance).toBe(Provenance.OBSERVED)
          expect(edge.type).toBe(EdgeType.CALLS)
          return
        }
        await driveTraffic(workerUrl, 4)
        await new Promise((r) => setTimeout(r, 8000))
      }
      throw new Error(
        `no OBSERVED edge from real worker telemetry after 180s (last edgesCreated=${lastEdges}) — ` +
          `telemetry may not be queryable yet, or the query shape/scope needs work`,
      )
    },
    200_000,
  )
})
