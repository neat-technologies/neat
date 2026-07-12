import { describe, expect, it } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  infraId,
  observedEdgeId,
  serviceId,
  type GraphEdge,
  type GraphNode,
  type InfraNode,
  type ServiceNode,
} from '@neat.is/types'
import { runConnectorPoll } from '../src/connectors/index.js'
import {
  createSupabaseConnector,
  fetchPgStatStatements,
  fetchSupabaseEdgeLogs,
  mapEdgeLogRowsToSignals,
  type SupabaseConnectorConfig,
} from '../src/connectors/supabase/index.js'
import type { NeatGraph } from '../src/graph.js'

// Opt-in live fixture. This file never runs against a real Supabase project
// unless explicitly enabled; CI and local unit runs stay hermetic.
const LIVE_ENABLED = process.env.SUPABASE_CONNECTOR_LIVE === '1'
const describeLive = LIVE_ENABLED ? describe : describe.skip

const REQUIRED = ['SUPABASE_MGMT_TOKEN', 'SUPABASE_PROJECT_REF', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'] as const
const PROJECT_REF_RE = /^[a-z]{20}$/

function requireEnv(name: (typeof REQUIRED)[number]): string {
  const value = process.env[name]
  if (!value) throw new Error(`missing ${name}; live Supabase connector test requires ${REQUIRED.join(', ')}`)
  return value
}

function requireProjectRef(): string {
  const value = requireEnv('SUPABASE_PROJECT_REF')
  if (!PROJECT_REF_RE.test(value)) {
    throw new Error(
      `SUPABASE_PROJECT_REF must be the 20-character project ref only, not a dashboard URL. ` +
        `Example: abcdefghijklmnopqrst`,
    )
  }
  return value
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function loadSupabaseJs(): Promise<{
  createClient: (url: string, key: string) => {
    from(table: string): { select(columns?: string): Promise<unknown> }
    rpc(fn: string, args?: Record<string, unknown>): Promise<unknown>
  }
}> {
  const packageName = '@supabase/supabase-js'
  try {
    return (await import(packageName)) as {
      createClient: (url: string, key: string) => {
        from(table: string): { select(columns?: string): Promise<unknown> }
        rpc(fn: string, args?: Record<string, unknown>): Promise<unknown>
      }
    }
  } catch (err) {
    throw new Error(
      `live Supabase connector test requires ${packageName}. ` +
        `Install it in packages/core before running the live test: npm install -D ${packageName}. ` +
        `Original import error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

async function driveSupabaseJsTraffic(input: {
  projectUrl: string
  anonKey: string
  table: string
  rpc?: string
  iterations?: number
}): Promise<void> {
  const { createClient } = await loadSupabaseJs()
  const supabase = createClient(input.projectUrl, input.anonKey)
  for (let i = 0; i < (input.iterations ?? 3); i++) {
    try {
      await supabase.from(input.table).select('*')
    } catch {
      /* edge_logs still records the attempted PostgREST read */
    }
    if (input.rpc) {
      try {
        await supabase.rpc(input.rpc, {})
      } catch {
        /* edge_logs still records the attempted RPC */
      }
    }
  }
}

function liveGraph(config: SupabaseConnectorConfig): NeatGraph {
  const graph: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  const service: ServiceNode = {
    id: serviceId(config.serviceName),
    type: NodeType.ServiceNode,
    name: config.serviceName,
    language: 'typescript',
  }
  const supabaseProject: InfraNode = {
    id: infraId('supabase', config.nodeRef),
    type: NodeType.InfraNode,
    name: config.nodeRef,
    provider: 'self',
    kind: 'supabase',
  }
  graph.addNode(service.id, service)
  graph.addNode(supabaseProject.id, supabaseProject)
  return graph
}

describeLive('Supabase connector — live project fixture', () => {
  it(
    'observes real edge_logs table traffic and optional RPC traffic',
    async () => {
      const managementToken = requireEnv('SUPABASE_MGMT_TOKEN')
      const apiProjectRef = requireProjectRef()
      const projectUrl = requireEnv('SUPABASE_URL').replace(/\/+$/, '')
      const anonKey = requireEnv('SUPABASE_ANON_KEY')
      const table = process.env.SUPABASE_LIVE_TABLE ?? 'orders'
      const rpc = process.env.SUPABASE_LIVE_RPC
      const startedAt = new Date(Date.now() - 5 * 60 * 1000)
      const config: SupabaseConnectorConfig = {
        apiProjectRef,
        nodeRef: process.env.SUPABASE_NODE_REF ?? `${apiProjectRef}.supabase.co`,
        serviceName: process.env.SUPABASE_LIVE_SERVICE_NAME ?? 'supabase-live-fixture',
      }
      if (process.env.SUPABASE_MANAGEMENT_API_URL) config.managementApiUrl = process.env.SUPABASE_MANAGEMENT_API_URL

      await driveSupabaseJsTraffic({ projectUrl, anonKey, table, rpc, iterations: 3 })

      let lastTargets: string[] = []
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        const rows = await fetchSupabaseEdgeLogs(
          config,
          managementToken,
          startedAt.toISOString(),
          new Date().toISOString(),
        )
        const signals = mapEdgeLogRowsToSignals(rows)
        lastTargets = signals.map((s) => `${s.targetKind}:${s.targetName}`)
        const tableObserved = signals.some((s) => s.targetKind === 'supabase-table' && s.targetName === table)
        const rpcObserved = !rpc || signals.some((s) => s.targetKind === 'supabase-rpc' && s.targetName === rpc)
        if (tableObserved && rpcObserved) {
          expect(tableObserved).toBe(true)
          expect(rpcObserved).toBe(true)

          const graph = liveGraph(config)
          const { connector, resolveTarget } = createSupabaseConnector(graph, config)
          const result = await runConnectorPoll(
            connector,
            { projectDir: '/live/supabase-fixture', credentials: { managementToken } },
            graph,
            resolveTarget,
          )
          expect(result.signalCount).toBeGreaterThan(0)

          const edgeId = observedEdgeId(
            serviceId(config.serviceName),
            infraId('supabase', config.nodeRef),
            EdgeType.CALLS,
          )
          expect(graph.hasEdge(edgeId)).toBe(true)
          const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
          expect(edge.provenance).toBe(Provenance.OBSERVED)
          return
        }
        await delay(5_000)
      }

      throw new Error(`live Supabase edge_logs signal did not arrive; last observed targets: ${lastTargets.join(', ')}`)
    },
    180_000,
  )

  it(
    'optionally reads pg_stat_statements with a customer-provisioned local-profile role',
    async () => {
      if (process.env.SUPABASE_CONNECTOR_LIVE_PG !== '1') return
      const connectionString = process.env.SUPABASE_POSTGRES_URL
      if (!connectionString) throw new Error('missing SUPABASE_POSTGRES_URL for SUPABASE_CONNECTOR_LIVE_PG=1')

      const rows = await fetchPgStatStatements(
        connectionString,
        25,
        process.env.SUPABASE_PROJECT_REF ?? 'live-supabase-project',
      )

      expect(Array.isArray(rows)).toBe(true)
    },
    60_000,
  )
})
