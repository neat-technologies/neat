import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import { computeDivergences } from '../src/divergences.js'
import {
  EdgeType,
  NodeType,
  Provenance,
  databaseId,
  websocketChannelId,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'

// A WebSocket channel is OBSERVED-only by design (ADR-125): it is minted from the
// HTTP upgrade span and has no static twin to fuse with. Its edge is a
// `CONNECTS_TO`, which lives in the missing-extracted allowlist — so without a
// target-type exclusion an OBSERVED-only `service ──CONNECTS_TO──▶ ws-channel`
// would flag a spurious `missing-extracted`. This proves the exclusion is real
// and targeted: the channel is suppressed, a plain observed-only DB edge is not.
describe('WebSocket channel missing-extracted exclusion (#617, ADR-125)', () => {
  function graphWithService(): NeatGraph {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:service-a', {
      id: 'service:service-a',
      type: NodeType.ServiceNode,
      name: 'service-a',
      language: 'javascript',
    })
    return g
  }

  it('does not flag an OBSERVED-only CONNECTS_TO onto a WebSocket channel as missing-extracted', () => {
    const g = graphWithService()
    const channelId = websocketChannelId('service-a', '/chat')
    g.addNode(channelId, {
      id: channelId,
      type: NodeType.WebSocketChannelNode,
      name: '/chat',
      service: 'service-a',
      channel: '/chat',
      discoveredVia: 'otel',
    } as GraphNode)
    const edgeId = `${EdgeType.CONNECTS_TO}:OBSERVED:service:service-a->${channelId}`
    g.addEdgeWithKey(edgeId, 'service:service-a', channelId, {
      id: edgeId,
      source: 'service:service-a',
      target: channelId,
      type: EdgeType.CONNECTS_TO,
      provenance: Provenance.OBSERVED,
      lastObserved: new Date().toISOString(),
    })

    const { divergences } = computeDivergences(g)
    const onChannel = divergences.filter(
      (d) => d.type === 'missing-extracted' && d.target === channelId,
    )
    expect(onChannel).toHaveLength(0)
  })

  it('still flags an OBSERVED-only CONNECTS_TO onto a real database node (control)', () => {
    const g = graphWithService()
    const dbId = databaseId('payments-host')
    g.addNode(dbId, {
      id: dbId,
      type: NodeType.DatabaseNode,
      name: 'payments-host',
      engine: 'postgresql',
      engineVersion: 'unknown',
      compatibleDrivers: [],
      host: 'payments-host',
      discoveredVia: 'otel',
    } as GraphNode)
    const edgeId = `${EdgeType.CONNECTS_TO}:OBSERVED:service:service-a->${dbId}`
    g.addEdgeWithKey(edgeId, 'service:service-a', dbId, {
      id: edgeId,
      source: 'service:service-a',
      target: dbId,
      type: EdgeType.CONNECTS_TO,
      provenance: Provenance.OBSERVED,
      lastObserved: new Date().toISOString(),
    })

    const { divergences } = computeDivergences(g)
    const onDb = divergences.filter(
      (d) => d.type === 'missing-extracted' && d.target === dbId,
    )
    expect(onDb).toHaveLength(1)
  })
})
