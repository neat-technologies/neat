import { describe, it, expect } from 'vitest'
import {
  ServiceNodeSchema,
  DatabaseNodeSchema,
  ConfigNodeSchema,
  InfraNodeSchema,
  FrontierNodeSchema,
  SymbolNodeSchema,
  GraphNodeSchema,
  GraphEdgeSchema,
  symbolId,
  parseSymbolId,
  ProvenanceSchema,
  EdgeTypeSchema,
  ErrorEventSchema,
  RootCauseResultSchema,
  BlastRadiusResultSchema,
  Provenance,
  EdgeType,
  NodeType,
} from '../src/index.js'

describe('runtime constants', () => {
  it('Provenance has 4 values (ADR-068)', () => {
    expect(Object.values(Provenance)).toHaveLength(4)
  })
  it('EdgeType has 9 values', () => {
    // CONTAINS joined the set with the file-first graph (ADR-089).
    // IMPORTS joined with the import graph (ADR-092).
    expect(Object.values(EdgeType)).toHaveLength(9)
  })
  it('NodeType has 11 values', () => {
    // FileNode joined the set with the file-first graph (ADR-089); RouteNode
    // joined with server-route extraction (ADR-119); GraphQLOperationNode joined
    // with operation-grain GraphQL observation (ADR-122); GrpcMethodNode joined
    // with method-grain gRPC observation + `.proto` extraction (ADR-123);
    // WebSocketChannelNode joined with channel-grain WebSocket observation
    // (ADR-125), minted OBSERVED-only from the HTTP upgrade span; SymbolNode
    // joined with symbol grain under files (ADR-158), minted static-first by the
    // extractor and landed OBSERVED-first by ingest.
    expect(Object.values(NodeType)).toHaveLength(11)
  })
})

describe('ServiceNodeSchema', () => {
  it('accepts a valid ServiceNode', () => {
    const node = {
      id: 'service-b',
      type: 'ServiceNode' as const,
      name: 'service-b',
      language: 'javascript',
      dependencies: { pg: '7.4.0' },
    }
    expect(ServiceNodeSchema.parse(node)).toEqual(node)
  })
  it('rejects wrong type literal', () => {
    expect(() =>
      ServiceNodeSchema.parse({ id: 'x', type: 'DatabaseNode', name: 'x', language: 'js' }),
    ).toThrow()
  })
  it('rejects missing required fields', () => {
    expect(() => ServiceNodeSchema.parse({ id: 'x', type: 'ServiceNode' })).toThrow()
  })
})

describe('DatabaseNodeSchema', () => {
  it('accepts a valid DatabaseNode with compatibleDrivers', () => {
    const node = {
      id: 'payments-db',
      type: 'DatabaseNode' as const,
      name: 'payments-db',
      engine: 'postgresql',
      engineVersion: '15',
      compatibleDrivers: [{ name: 'pg', minVersion: '8.0.0' }],
    }
    expect(DatabaseNodeSchema.parse(node)).toEqual(node)
  })
  it('rejects an empty compatibleDrivers array? actually empty is fine', () => {
    const node = {
      id: 'db',
      type: 'DatabaseNode' as const,
      name: 'db',
      engine: 'mysql',
      engineVersion: '8',
      compatibleDrivers: [],
    }
    expect(() => DatabaseNodeSchema.parse(node)).not.toThrow()
  })
})

describe('ConfigNodeSchema', () => {
  it('accepts a valid ConfigNode', () => {
    const node = {
      id: 'cfg',
      type: 'ConfigNode' as const,
      name: 'app.yaml',
      path: '/srv/app.yaml',
      fileType: 'yaml',
    }
    expect(ConfigNodeSchema.parse(node)).toEqual(node)
  })
})

describe('InfraNodeSchema', () => {
  it('accepts a valid InfraNode', () => {
    const node = {
      id: 'infra',
      type: 'InfraNode' as const,
      name: 'us-east-1',
      provider: 'aws',
      region: 'us-east-1',
    }
    expect(InfraNodeSchema.parse(node)).toEqual(node)
  })
})

describe('FrontierNodeSchema', () => {
  it('accepts a valid FrontierNode', () => {
    const node = {
      id: 'frontier:payments-api.cluster.local',
      type: 'FrontierNode' as const,
      name: 'payments-api.cluster.local',
      host: 'payments-api.cluster.local',
    }
    expect(FrontierNodeSchema.parse(node)).toEqual(node)
  })
  it('accepts firstObserved/lastObserved timestamps', () => {
    const node = {
      id: 'frontier:x',
      type: 'FrontierNode' as const,
      name: 'x',
      host: 'x',
      firstObserved: new Date().toISOString(),
      lastObserved: new Date().toISOString(),
    }
    expect(FrontierNodeSchema.parse(node)).toEqual(node)
  })
})

describe('SymbolNodeSchema (ADR-158)', () => {
  it('accepts a valid static SymbolNode', () => {
    const node = {
      id: 'symbol:orders-api:src/order-service.ts#OrderService.create',
      type: 'SymbolNode' as const,
      kind: 'method' as const,
      qualname: 'OrderService.create',
      span: { startLine: 12, endLine: 40 },
      service: 'orders-api',
      relPath: 'src/order-service.ts',
      discoveredVia: 'static' as const,
    }
    expect(SymbolNodeSchema.parse(node)).toEqual(node)
  })
  it('accepts each symbol kind', () => {
    for (const kind of ['function', 'method', 'constructor', 'class'] as const) {
      const node = {
        id: `symbol:svc:a.ts#Sym`,
        type: 'SymbolNode' as const,
        kind,
        qualname: 'Sym',
        span: { startLine: 1, endLine: 2 },
        service: 'svc',
        relPath: 'a.ts',
      }
      expect(() => SymbolNodeSchema.parse(node)).not.toThrow()
    }
  })
  it('rejects an unknown kind', () => {
    expect(() =>
      SymbolNodeSchema.parse({
        id: 'symbol:svc:a.ts#Sym',
        type: 'SymbolNode',
        kind: 'lambda',
        qualname: 'Sym',
        span: { startLine: 1, endLine: 2 },
        service: 'svc',
        relPath: 'a.ts',
      }),
    ).toThrow()
  })
  it('is a member of the GraphNode discriminated union', () => {
    const node = {
      id: 'symbol:svc:a.ts#foo',
      type: 'SymbolNode' as const,
      kind: 'function' as const,
      qualname: 'foo',
      span: { startLine: 3, endLine: 9 },
      service: 'svc',
      relPath: 'a.ts',
    }
    expect(GraphNodeSchema.parse(node)).toEqual(node)
  })
})

describe('symbolId / parseSymbolId (ADR-158)', () => {
  it('builds the stable wire format', () => {
    expect(symbolId('orders-api', 'src/order-service.ts', 'OrderService.create')).toBe(
      'symbol:orders-api:src/order-service.ts#OrderService.create',
    )
  })
  it('appends the disambiguator only when passed', () => {
    expect(symbolId('svc', 'a.ts', 'merge')).toBe('symbol:svc:a.ts#merge')
    expect(symbolId('svc', 'a.ts', 'merge', 2)).toBe('symbol:svc:a.ts#merge~2')
  })
  it('round-trips through parseSymbolId', () => {
    expect(parseSymbolId(symbolId('orders-api', 'src/order-service.ts', 'OrderService.create'))).toEqual({
      service: 'orders-api',
      relPath: 'src/order-service.ts',
      qualname: 'OrderService.create',
    })
    expect(parseSymbolId(symbolId('svc', 'a.ts', 'merge', 3))).toEqual({
      service: 'svc',
      relPath: 'a.ts',
      qualname: 'merge',
      disambiguator: 3,
    })
  })
  it('returns null for non-symbol ids and malformed input', () => {
    expect(parseSymbolId('file:svc:a.ts')).toBe(null)
    expect(parseSymbolId('symbol:svc')).toBe(null)
    expect(parseSymbolId('symbol:svc:a.ts')).toBe(null) // no `#qualname`
  })
})

describe('GraphEdgeSchema', () => {
  it('accepts a valid OBSERVED CALLS edge', () => {
    const edge = {
      id: 'e1',
      source: 'service-a',
      target: 'service-b',
      type: 'CALLS' as const,
      provenance: 'OBSERVED' as const,
      confidence: 0.95,
      lastObserved: new Date().toISOString(),
      callCount: 42,
    }
    expect(GraphEdgeSchema.parse(edge)).toEqual(edge)
  })
  it('rejects an invalid provenance', () => {
    expect(() =>
      GraphEdgeSchema.parse({
        id: 'e',
        source: 'a',
        target: 'b',
        type: 'CALLS',
        provenance: 'BOGUS',
      }),
    ).toThrow()
  })
  it('rejects confidence out of range', () => {
    expect(() =>
      GraphEdgeSchema.parse({
        id: 'e',
        source: 'a',
        target: 'b',
        type: 'CALLS',
        provenance: 'OBSERVED',
        confidence: 1.5,
      }),
    ).toThrow()
  })
})

describe('ProvenanceSchema and EdgeTypeSchema', () => {
  it.each(Object.values(Provenance))('accepts provenance %s', (p) => {
    expect(ProvenanceSchema.parse(p)).toBe(p)
  })
  it.each(Object.values(EdgeType))('accepts edge type %s', (t) => {
    expect(EdgeTypeSchema.parse(t)).toBe(t)
  })
})

describe('ErrorEventSchema', () => {
  it('accepts a valid error event', () => {
    const e = {
      id: 'err1',
      timestamp: new Date().toISOString(),
      service: 'service-b',
      traceId: 't1',
      spanId: 's1',
      errorMessage: 'connection refused',
      affectedNode: 'payments-db',
    }
    expect(ErrorEventSchema.parse(e)).toEqual(e)
  })
})

describe('RootCauseResultSchema', () => {
  it('accepts a valid result', () => {
    const r = {
      rootCauseNode: 'service-b',
      rootCauseReason: 'pg 7.4.0 incompatible with PostgreSQL 15',
      traversalPath: ['payments-db', 'service-b'],
      edgeProvenances: ['OBSERVED' as const, 'OBSERVED' as const],
      confidence: 1.0,
    }
    expect(RootCauseResultSchema.parse(r)).toEqual(r)
  })
})

describe('BlastRadiusResultSchema', () => {
  it('accepts a valid blast radius', () => {
    const b = {
      origin: 'service-a',
      affectedNodes: [
        {
          nodeId: 'service-b',
          distance: 1,
          edgeProvenance: 'OBSERVED' as const,
          path: ['service-a', 'service-b'],
          confidence: 1.0,
        },
        {
          nodeId: 'payments-db',
          distance: 2,
          edgeProvenance: 'OBSERVED' as const,
          path: ['service-a', 'service-b', 'payments-db'],
          confidence: 1.0,
        },
      ],
      totalAffected: 2,
    }
    expect(BlastRadiusResultSchema.parse(b)).toEqual(b)
  })
})
