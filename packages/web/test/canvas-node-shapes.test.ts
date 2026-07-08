import { describe, it, expect } from 'vitest'
import type { GraphNode, GraphEdge } from '@neat.is/types'
import { buildModel, compoundElements, isObservedNode } from '../app/components/graph-model'

// Gate 2 (truthful frontend): the four operation node types (ADR-119/122/123/125)
// — RouteNode, GraphQLOperationNode, GrpcMethodNode, WebSocketChannelNode — gained
// distinct canvas shapes. They must actually render (be in the compound element
// set) and carry their own `_kind`, and observed ones must flag `_observed` so the
// canvas tints them the OBSERVED green.

const nodes: GraphNode[] = [
  { id: 'service:gw', type: 'ServiceNode', name: 'gw' } as GraphNode,
  { id: 'file:gw:proxy.ts', type: 'FileNode', service: 'gw', path: 'src/proxy.ts' } as GraphNode,
  { id: 'route:gw:GET /x', type: 'RouteNode', name: 'GET /x', lastObserved: '2026-07-08T00:00:00.000Z' } as unknown as GraphNode,
  { id: 'graphql:gw:query q', type: 'GraphQLOperationNode', name: 'query q', lastObserved: '2026-07-08T00:00:00.000Z' } as unknown as GraphNode,
  { id: 'grpc:svc/M', type: 'GrpcMethodNode', name: 'svc/M', lastObserved: '2026-07-08T00:00:00.000Z' } as unknown as GraphNode,
  // a declared-only route with no runtime footprint — stays muted, not green.
  { id: 'route:gw:GET /unhit', type: 'RouteNode', name: 'GET /unhit' } as unknown as GraphNode,
  { id: 'ws:gw:/live', type: 'WebSocketChannelNode', name: '/live', lastObserved: '2026-07-08T00:00:00.000Z' } as unknown as GraphNode,
]
const edges: GraphEdge[] = [
  { id: 'c1', source: 'service:gw', target: 'file:gw:proxy.ts', type: 'CONTAINS', provenance: 'EXTRACTED' } as GraphEdge,
]

describe('canvas node shapes — the four operation node types', () => {
  const model = buildModel(nodes, edges)
  const els = compoundElements(nodes, edges, model)
  const nodeEls = els.filter((e) => e.group === 'nodes')
  const byId = new Map(nodeEls.map((e) => [String(e.data.id), e.data]))

  it('renders each operation node with its own visual kind', () => {
    expect(byId.get('route:gw:GET /x')?._kind).toBe('route')
    expect(byId.get('graphql:gw:query q')?._kind).toBe('graphql')
    expect(byId.get('grpc:svc/M')?._kind).toBe('grpc')
    expect(byId.get('ws:gw:/live')?._kind).toBe('ws')
  })

  it('flags observed operation nodes as _observed and leaves declared-only ones muted', () => {
    expect(byId.get('route:gw:GET /x')?._observed).toBe(true)
    expect(byId.get('ws:gw:/live')?._observed).toBe(true)
    expect(byId.get('route:gw:GET /unhit')?._observed).toBe(false)
  })

  it('isObservedNode reads the runtime footprint off lastObserved / firstObserved', () => {
    expect(isObservedNode({ id: 'a', type: 'RouteNode', lastObserved: 'x' } as unknown as GraphNode)).toBe(true)
    expect(isObservedNode({ id: 'b', type: 'RouteNode', firstObserved: 'x' } as unknown as GraphNode)).toBe(true)
    expect(isObservedNode({ id: 'c', type: 'RouteNode' } as unknown as GraphNode)).toBe(false)
  })
})
