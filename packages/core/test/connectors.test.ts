import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  fileId,
  infraId,
  observedEdgeId,
  serviceId,
  type FileNode,
  type GraphEdge,
  type GraphNode,
  type InfraNode,
  type ServiceNode,
} from '@neat.is/types'
import {
  runConnectorPoll,
  type ConnectorContext,
  type ObservedConnector,
  type ObservedSignal,
  type ResolveConnectorTarget,
} from '../src/connectors/index.js'
import type { NeatGraph } from '../src/graph.js'

const SERVICE = 'orders-api'
const TABLE_TARGET = infraId('supabase-table', 'proj-ref/orders')
const RPC_TARGET = infraId('supabase-rpc', 'proj-ref/get_totals')

function newGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  const service: ServiceNode = {
    id: serviceId(SERVICE),
    type: NodeType.ServiceNode,
    name: SERVICE,
    language: 'javascript',
  }
  g.addNode(service.id, service)

  // EXTRACTED FileNode a static extractor already minted — the trailing
  // segment reconcileObservedRelPath must match against a connector
  // signal's own (unanchored) callSite path.
  const file: FileNode = {
    id: fileId(SERVICE, 'src/db/orders.ts'),
    type: NodeType.FileNode,
    service: SERVICE,
    path: 'src/db/orders.ts',
    language: 'typescript',
  }
  g.addNode(file.id, file)

  const table: InfraNode = {
    id: TABLE_TARGET,
    type: NodeType.InfraNode,
    name: 'proj-ref/orders',
    provider: 'supabase',
    kind: 'supabase-table',
  }
  g.addNode(table.id, table)

  const rpc: InfraNode = {
    id: RPC_TARGET,
    type: NodeType.InfraNode,
    name: 'proj-ref/get_totals',
    provider: 'supabase',
    kind: 'supabase-rpc',
  }
  g.addNode(rpc.id, rpc)

  return g
}

// A trivial in-memory test double — not a real provider. Real poll()
// implementations (Supabase, Railway, Firebase, Cloudflare) are out of
// scope for this scaffold; this fake only exercises the pull/map/fuse
// pipeline the four provider designs will plug into.
class FakeConnector implements ObservedConnector {
  readonly provider = 'fake'
  constructor(private readonly signals: ObservedSignal[]) {}
  async poll(_ctx: ConnectorContext): Promise<ObservedSignal[]> {
    return this.signals
  }
}

const resolveTarget: ResolveConnectorTarget = (signal) => {
  if (signal.targetKind === 'supabase-table') {
    return {
      targetNodeId: infraId('supabase-table', signal.targetName),
      serviceName: SERVICE,
      edgeType: EdgeType.CALLS,
    }
  }
  if (signal.targetKind === 'supabase-rpc') {
    return {
      targetNodeId: infraId('supabase-rpc', signal.targetName),
      serviceName: SERVICE,
      edgeType: EdgeType.CALLS,
    }
  }
  return null
}

function baseCtx(): ConnectorContext {
  return { projectDir: '/repo/orders-api', credentials: {} }
}

describe('connectors plane — runConnectorPoll (docs/contracts/connectors.md)', () => {
  it('mints an OBSERVED edge, file-grained, when the signal carries a callSite', async () => {
    const graph = newGraph()
    const signal: ObservedSignal = {
      targetKind: 'supabase-table',
      targetName: 'proj-ref/orders',
      callCount: 5,
      errorCount: 1,
      lastObservedIso: '2026-07-03T12:00:00.000Z',
      // Unanchored leading segment ("app/") the extractor's own path
      // ("src/db/orders.ts") doesn't carry — reconcileObservedRelPath must
      // recover it via trailing-suffix match, same as an OTel call site.
      callSite: { file: 'app/src/db/orders.ts', line: 42 },
    }
    const connector = new FakeConnector([signal])

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)

    expect(result).toEqual({
      signalCount: 1,
      edgesCreated: 1,
      edgesUpdated: 0,
      unresolved: 0,
    })

    const fileNodeId = fileId(SERVICE, 'src/db/orders.ts')
    const edgeId = observedEdgeId(fileNodeId, TABLE_TARGET, EdgeType.CALLS)
    expect(graph.hasEdge(edgeId)).toBe(true)

    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    expect(edge.source).toBe(fileNodeId)
    expect(edge.target).toBe(TABLE_TARGET)
    // callCount=5/errorCount=1 replay as 5 upserts (1 erroring) — the same
    // signal.spanCount/errorCount shape a burst of 5 individual spans would
    // produce, not a flat +1 per signal.
    expect(edge.signal?.spanCount).toBe(5)
    expect(edge.signal?.errorCount).toBe(1)
    expect(edge.evidence).toEqual({ file: 'src/db/orders.ts', line: 42 })

    // The edge id and its endpoints were built via the identity helpers
    // (observedEdgeId / fileId / infraId), never a hand-rolled template
    // literal — contracts.test.ts's Rule 16 / Rule 2 audits cover this at
    // the source level; this assertion pins the same expectation for the
    // connectors path specifically.
    expect(edgeId).toBe(`CALLS:OBSERVED:${fileNodeId}->${TABLE_TARGET}`)
  })

  it('falls back to a service-level edge when the signal carries no callSite', async () => {
    const graph = newGraph()
    const signal: ObservedSignal = {
      targetKind: 'supabase-rpc',
      targetName: 'proj-ref/get_totals',
      callCount: 2,
      errorCount: 0,
      lastObservedIso: '2026-07-03T12:05:00.000Z',
    }
    const connector = new FakeConnector([signal])

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)

    expect(result).toEqual({
      signalCount: 1,
      edgesCreated: 1,
      edgesUpdated: 0,
      unresolved: 0,
    })

    const serviceNodeId = serviceId(SERVICE)
    const edgeId = observedEdgeId(serviceNodeId, RPC_TARGET, EdgeType.CALLS)
    expect(graph.hasEdge(edgeId)).toBe(true)

    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    expect(edge.source).toBe(serviceNodeId)
    expect(edge.evidence).toBeUndefined()
    expect(edge.signal?.spanCount).toBe(2)
    expect(edge.signal?.errorCount).toBe(0)

    // No FileNode should have been created for this fallback path.
    expect(graph.hasNode(fileId(SERVICE, 'src/db/get_totals.ts'))).toBe(false)
  })

  it('an unresolved signal is dropped honestly, never fabricated', async () => {
    const graph = newGraph()
    const signal: ObservedSignal = {
      targetKind: 'supabase-storage', // resolveTarget above knows nothing of this kind
      targetName: 'proj-ref/avatars',
      callCount: 3,
      errorCount: 0,
      lastObservedIso: '2026-07-03T12:10:00.000Z',
    }
    const connector = new FakeConnector([signal])

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)

    expect(result).toEqual({
      signalCount: 1,
      edgesCreated: 0,
      edgesUpdated: 0,
      unresolved: 1,
    })
  })

  it('re-polling the same signal updates the existing edge instead of minting a twin', async () => {
    const graph = newGraph()
    const signal: ObservedSignal = {
      targetKind: 'supabase-rpc',
      targetName: 'proj-ref/get_totals',
      callCount: 1,
      errorCount: 0,
      lastObservedIso: '2026-07-03T12:05:00.000Z',
    }
    const connector = new FakeConnector([signal])

    await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)
    const second = await runConnectorPoll(
      connector,
      { ...baseCtx(), since: '2026-07-03T12:05:00.000Z' },
      graph,
      resolveTarget,
    )

    expect(second).toEqual({
      signalCount: 1,
      edgesCreated: 0,
      edgesUpdated: 1,
      unresolved: 0,
    })

    const edgeId = observedEdgeId(serviceId(SERVICE), RPC_TARGET, EdgeType.CALLS)
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.signal?.spanCount).toBe(2)
  })
})
