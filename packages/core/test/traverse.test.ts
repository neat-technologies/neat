import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  databaseId,
  fileId,
  serviceId,
  symbolId,
  type ErrorEvent,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { getBlastRadius, getRootCause, getTransitiveDependencies } from '../src/traverse.js'

function makeNode(id: string, attrs: GraphNode): GraphNode {
  return { ...attrs, id }
}

function newDemoGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  g.addNode(
    'service:service-a',
    makeNode('service:service-a', {
      id: 'service:service-a',
      type: NodeType.ServiceNode,
      name: 'service-a',
      language: 'javascript',
    }),
  )
  g.addNode(
    'service:service-b',
    makeNode('service:service-b', {
      id: 'service:service-b',
      type: NodeType.ServiceNode,
      name: 'service-b',
      language: 'javascript',
      dependencies: { pg: '7.4.0' },
    }),
  )
  g.addNode(
    'database:payments-db',
    makeNode('database:payments-db', {
      id: 'database:payments-db',
      type: NodeType.DatabaseNode,
      name: 'payments',
      engine: 'postgresql',
      engineVersion: '15',
      compatibleDrivers: [{ name: 'pg', minVersion: '8.0.0' }],
    }),
  )
  return g
}

function addEdge(g: NeatGraph, e: GraphEdge): void {
  g.addEdgeWithKey(e.id, e.source, e.target, e)
}

function callsEdge(provenance: GraphEdge['provenance'], suffix = ''): GraphEdge {
  const id =
    provenance === Provenance.EXTRACTED
      ? `${EdgeType.CALLS}:service:service-a->service:service-b`
      : `${EdgeType.CALLS}:${provenance}${suffix}:service:service-a->service:service-b`
  return {
    id,
    source: 'service:service-a',
    target: 'service:service-b',
    type: EdgeType.CALLS,
    provenance,
  }
}

function connectsEdge(provenance: GraphEdge['provenance'], suffix = ''): GraphEdge {
  const id =
    provenance === Provenance.EXTRACTED
      ? `${EdgeType.CONNECTS_TO}:service:service-b->database:payments-db`
      : `${EdgeType.CONNECTS_TO}:${provenance}${suffix}:service:service-b->database:payments-db`
  return {
    id,
    source: 'service:service-b',
    target: 'database:payments-db',
    type: EdgeType.CONNECTS_TO,
    provenance,
  }
}

describe('getRootCause', () => {
  it('returns the pg-driver mismatch with the full incoming path on the demo graph', () => {
    const g = newDemoGraph()
    addEdge(g, callsEdge(Provenance.EXTRACTED))
    addEdge(g, connectsEdge(Provenance.EXTRACTED))

    const result = getRootCause(g, 'database:payments-db')
    expect(result).not.toBeNull()
    expect(result!.rootCauseNode).toBe('service:service-b')
    expect(result!.traversalPath).toEqual([
      'database:payments-db',
      'service:service-b',
      'service:service-a',
    ])
    expect(result!.rootCauseReason).toMatch(/pg|scram|postgres/i)
    expect(result!.fixRecommendation).toMatch(/8\.0\.0/)
  })

  it('reports confidence 0.5 when every edge along the path is EXTRACTED only', () => {
    const g = newDemoGraph()
    addEdge(g, callsEdge(Provenance.EXTRACTED))
    addEdge(g, connectsEdge(Provenance.EXTRACTED))

    const result = getRootCause(g, 'database:payments-db')
    // Multiplicative cascade per ADR-036: two EXTRACTED edges at ceiling 0.5
    // each → 0.5 × 0.5 = 0.25. Pre-contract min-reduce returned 0.5.
    expect(result!.confidence).toBeCloseTo(0.25, 5)
    expect(result!.edgeProvenances).toEqual([Provenance.EXTRACTED, Provenance.EXTRACTED])
  })

  it('reports confidence 1.0 when both edges along the path are OBSERVED', () => {
    const g = newDemoGraph()
    addEdge(g, callsEdge(Provenance.EXTRACTED))
    addEdge(g, connectsEdge(Provenance.EXTRACTED))
    addEdge(g, callsEdge(Provenance.OBSERVED))
    addEdge(g, connectsEdge(Provenance.OBSERVED))

    const result = getRootCause(g, 'database:payments-db')
    expect(result!.confidence).toBe(1.0)
    expect(result!.edgeProvenances).toEqual([Provenance.OBSERVED, Provenance.OBSERVED])
  })

  it('reports confidence 0.7 when any edge along the path is INFERRED', () => {
    const g = newDemoGraph()
    addEdge(g, callsEdge(Provenance.EXTRACTED))
    addEdge(g, callsEdge(Provenance.OBSERVED))
    // Only an INFERRED CONNECTS_TO exists for service-b -> db (the pg < 8 case).
    addEdge(g, connectsEdge(Provenance.INFERRED))

    const result = getRootCause(g, 'database:payments-db')
    expect(result!.confidence).toBe(0.7)
    // OBSERVED CALLS beats EXTRACTED CALLS; INFERRED is the only CONNECTS_TO option.
    expect(result!.edgeProvenances).toEqual([Provenance.INFERRED, Provenance.OBSERVED])
  })

  it('colours rootCauseReason with the observed error message when one is supplied', () => {
    const g = newDemoGraph()
    addEdge(g, callsEdge(Provenance.EXTRACTED))
    addEdge(g, connectsEdge(Provenance.EXTRACTED))

    const ev: ErrorEvent = {
      id: 'trace-1:span-b',
      timestamp: new Date().toISOString(),
      service: 'service-b',
      traceId: 'trace-1',
      spanId: 'span-b',
      errorMessage: 'SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string',
      affectedNode: 'database:payments-db',
    }
    const result = getRootCause(g, 'database:payments-db', ev)
    expect(result!.rootCauseReason).toContain('SCRAM')
  })

  it('returns null when the error node does not exist in the graph', () => {
    const g = newDemoGraph()
    addEdge(g, connectsEdge(Provenance.EXTRACTED))
    expect(getRootCause(g, 'database:does-not-exist')).toBeNull()
  })

  it('returns null when the error node is not a database', () => {
    const g = newDemoGraph()
    addEdge(g, callsEdge(Provenance.EXTRACTED))
    addEdge(g, connectsEdge(Provenance.EXTRACTED))
    expect(getRootCause(g, 'service:service-a')).toBeNull()
  })

  it('returns null when no service in the path has a known incompatibility', () => {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:happy', {
      id: 'service:happy',
      type: NodeType.ServiceNode,
      name: 'happy',
      language: 'javascript',
      dependencies: { pg: '8.11.0' },
    })
    g.addNode('database:payments-db', {
      id: 'database:payments-db',
      type: NodeType.DatabaseNode,
      name: 'payments',
      engine: 'postgresql',
      engineVersion: '15',
      compatibleDrivers: [{ name: 'pg', minVersion: '8.0.0' }],
    })
    g.addEdgeWithKey(
      'CONNECTS_TO:service:happy->database:payments-db',
      'service:happy',
      'database:payments-db',
      {
        id: 'CONNECTS_TO:service:happy->database:payments-db',
        source: 'service:happy',
        target: 'database:payments-db',
        type: EdgeType.CONNECTS_TO,
        provenance: Provenance.EXTRACTED,
      },
    )
    expect(getRootCause(g, 'database:payments-db')).toBeNull()
  })

  it('finds a mysql2 / MySQL 8 incompatibility — second failure scenario, no code change required', () => {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:orders', {
      id: 'service:orders',
      type: NodeType.ServiceNode,
      name: 'orders',
      language: 'javascript',
      dependencies: { mysql2: '1.7.0' },
    })
    g.addNode('database:orders-db', {
      id: 'database:orders-db',
      type: NodeType.DatabaseNode,
      name: 'orders',
      engine: 'mysql',
      engineVersion: '8',
      compatibleDrivers: [{ name: 'mysql2', minVersion: '3.0.0' }],
    })
    g.addEdgeWithKey(
      'CONNECTS_TO:service:orders->database:orders-db',
      'service:orders',
      'database:orders-db',
      {
        id: 'CONNECTS_TO:service:orders->database:orders-db',
        source: 'service:orders',
        target: 'database:orders-db',
        type: EdgeType.CONNECTS_TO,
        provenance: Provenance.EXTRACTED,
      },
    )

    const result = getRootCause(g, 'database:orders-db')
    expect(result).not.toBeNull()
    expect(result!.rootCauseNode).toBe('service:orders')
    expect(result!.rootCauseReason).toMatch(/mysql|caching_sha2/i)
    expect(result!.fixRecommendation).toMatch(/mysql2/)
    expect(result!.fixRecommendation).toMatch(/3\.0\.0/)
  })

  it('reads driver versions out of dependencies', () => {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:reports', {
      id: 'service:reports',
      type: NodeType.ServiceNode,
      name: 'reports',
      language: 'javascript',
      dependencies: { pg: '7.4.0' },
    })
    g.addNode('database:reports-db', {
      id: 'database:reports-db',
      type: NodeType.DatabaseNode,
      name: 'reports',
      engine: 'postgresql',
      engineVersion: '15',
      compatibleDrivers: [{ name: 'pg', minVersion: '8.0.0' }],
    })
    g.addEdgeWithKey(
      'CONNECTS_TO:service:reports->database:reports-db',
      'service:reports',
      'database:reports-db',
      {
        id: 'CONNECTS_TO:service:reports->database:reports-db',
        source: 'service:reports',
        target: 'database:reports-db',
        type: EdgeType.CONNECTS_TO,
        provenance: Provenance.EXTRACTED,
      },
    )

    const result = getRootCause(g, 'database:reports-db')
    expect(result).not.toBeNull()
    expect(result!.rootCauseNode).toBe('service:reports')
    expect(result!.fixRecommendation).toMatch(/pg/)
  })
})

// Incident-localized root cause (#584): a service can fail in process — a 500
// thrown inside its own handler — without the failure ever crossing a graph
// edge, so the edge walk reports nothing. getRootCause then consults the
// recorded incident store, which localizes the failure to the file:line / route
// the failing span captured.
describe('getRootCause — incident-localized fallback (#584)', () => {
  function harvestGraph(): NeatGraph {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:harvest-api', {
      id: 'service:harvest-api',
      type: NodeType.ServiceNode,
      name: 'harvest-api',
      language: 'javascript',
    })
    return g
  }

  function incident(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
    return {
      id: 'trace-x:span-x',
      timestamp: '2026-06-30T12:00:00.000Z',
      service: 'harvest-api',
      traceId: 'trace-x',
      spanId: 'span-x',
      errorMessage: '500 on GET /users/:id',
      affectedNode: 'file:harvest-api:src/index.js',
      attributes: {
        'code.filepath': 'src/index.js',
        'code.lineno': 22,
        'http.route': '/users/:id',
      },
      httpStatusCode: 500,
      ...overrides,
    }
  }

  it('localizes a service with recorded incidents instead of reporting healthy', () => {
    const g = harvestGraph()
    const incidents = [incident(), incident({ id: 'trace-y:span-y', timestamp: '2026-06-30T11:00:00.000Z' })]

    const result = getRootCause(g, 'service:harvest-api', undefined, incidents)
    expect(result).not.toBeNull()
    // Names the file the failure surfaced in, walked from the queried service
    // as a single OBSERVED hop.
    expect(result!.rootCauseNode).toBe('file:harvest-api:src/index.js')
    expect(result!.traversalPath).toEqual([
      'service:harvest-api',
      'file:harvest-api:src/index.js',
    ])
    expect(result!.edgeProvenances).toEqual([Provenance.OBSERVED])
    expect(result!.rootCauseReason).toContain('500 on GET /users/:id')
    expect(result!.rootCauseReason).toContain('src/index.js:22')
    expect(result!.rootCauseReason).toContain('2 recorded incidents')
    expect(result!.fixRecommendation).toContain('src/index.js:22')
    expect(result!.fixRecommendation).toContain('/users/:id')
  })

  it('counts only the failure mode the reason names, not the node total (#624)', () => {
    const g = harvestGraph()
    // The node is failing two different ways. The reason names the most recent
    // one, so its count must be the number of *that* failure, not every incident
    // on the node — "1 recorded incident", not "2".
    const incidents = [
      incident({
        id: 'trace-y:span-y',
        timestamp: '2026-06-30T11:00:00.000Z',
        errorMessage: 'connect ECONNREFUSED 10.0.0.5:5432',
      }),
      incident(), // newer, '500 on GET /users/:id'
    ]
    const result = getRootCause(g, 'service:harvest-api', undefined, incidents)
    expect(result).not.toBeNull()
    expect(result!.rootCauseReason).toContain('500 on GET /users/:id')
    expect(result!.rootCauseReason).toContain('1 recorded incident')
    expect(result!.rootCauseReason).not.toContain('2 recorded incidents')
  })

  it('matches incidents to the service by service name when affectedNode is file-grained', () => {
    const g = harvestGraph()
    // Querying the service must still surface a file-grained incident — the
    // service-name match mirrors the REST incident-history read.
    const result = getRootCause(g, 'service:harvest-api', undefined, [incident()])
    expect(result).not.toBeNull()
    expect(result!.confidence).toBeGreaterThan(0)
    expect(result!.confidence).toBeLessThan(1)
  })

  it('falls back to service grain when the incident carries no call site', () => {
    const g = harvestGraph()
    const result = getRootCause(g, 'service:harvest-api', undefined, [
      incident({ affectedNode: 'service:harvest-api', attributes: undefined }),
    ])
    expect(result).not.toBeNull()
    expect(result!.rootCauseNode).toBe('service:harvest-api')
    expect(result!.traversalPath).toEqual(['service:harvest-api'])
    expect(result!.edgeProvenances).toEqual([])
  })

  it('returns null when no incident touches the queried node', () => {
    const g = harvestGraph()
    const result = getRootCause(g, 'service:harvest-api', undefined, [
      incident({ service: 'other-svc', affectedNode: 'service:other-svc' }),
    ])
    expect(result).toBeNull()
  })
})

// Cross-service root-cause (#589): service-a is the entry service surfacing a
// 502. It calls service-b, whose /charge handler throws the 500. Nothing calls
// service-a, so the incoming walk is empty and naive incident matching would
// blame service-a's own CLIENT span for a route it never serves. Root-cause
// must follow the OBSERVED failing CALLS edge outbound to service-b's handler.
describe('getRootCause — cross-service failing CALLS chain (#589)', () => {
  function twoServiceGraph(): NeatGraph {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:service-a', {
      id: 'service:service-a',
      type: NodeType.ServiceNode,
      name: 'service-a',
      language: 'javascript',
    })
    g.addNode('service:service-b', {
      id: 'service:service-b',
      type: NodeType.ServiceNode,
      name: 'service-b',
      language: 'javascript',
    })
    // service-a --CALLS--> service-b, observed with recorded errors on the call.
    addEdge(g, {
      id: 'CALLS:OBSERVED:service:service-a->service:service-b',
      source: 'service:service-a',
      target: 'service:service-b',
      type: EdgeType.CALLS,
      provenance: Provenance.OBSERVED,
      signal: { spanCount: 40, errorCount: 12, lastObservedAgeMs: 0 },
    })
    return g
  }

  // The 500 the downstream handler threw, recorded against service-b's /charge.
  function chargeIncident(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
    return {
      id: 'trace-c:span-c',
      timestamp: '2026-06-30T12:00:00.000Z',
      service: 'service-b',
      traceId: 'trace-c',
      spanId: 'span-c',
      errorMessage: '500 on POST /charge',
      affectedNode: 'file:service-b:src/charge.js',
      attributes: {
        'code.filepath': 'src/charge.js',
        'code.lineno': 47,
        'http.route': '/charge',
      },
      httpStatusCode: 500,
      ...overrides,
    }
  }

  it('localizes the downstream culprit handler, not the calling entry service', () => {
    const g = twoServiceGraph()
    const result = getRootCause(g, 'service:service-a', undefined, [chargeIncident()])

    expect(result).not.toBeNull()
    // The root cause is service-b's handler file, reached by crossing the
    // failing CALLS edge — never the caller service-a.
    expect(result!.rootCauseNode).toBe('file:service-b:src/charge.js')
    expect(result!.rootCauseNode).not.toBe('service:service-a')
    expect(result!.traversalPath).toEqual([
      'service:service-a',
      'service:service-b',
      'file:service-b:src/charge.js',
    ])
    // The CALLS hop is OBSERVED, and so is the incident-localization hop.
    expect(result!.edgeProvenances).toEqual([Provenance.OBSERVED, Provenance.OBSERVED])
    expect(result!.rootCauseReason).toContain('service-b')
    expect(result!.rootCauseReason).toContain('/charge')
    // /charge belongs to service-b: the reason must not misattribute it to a-.
    expect(result!.rootCauseReason).not.toMatch(/service-a/)
    expect(result!.fixRecommendation).toContain('src/charge.js:47')
  })

  it('answers correctly when service-b is queried directly (the data was always there)', () => {
    const g = twoServiceGraph()
    const result = getRootCause(g, 'service:service-b', undefined, [chargeIncident()])
    expect(result).not.toBeNull()
    expect(result!.rootCauseNode).toBe('file:service-b:src/charge.js')
  })

  it('names the culprit service even when it has no recorded incident', () => {
    const g = twoServiceGraph()
    const result = getRootCause(g, 'service:service-a', undefined, [])
    expect(result).not.toBeNull()
    expect(result!.rootCauseNode).toBe('service:service-b')
    expect(result!.rootCauseReason).toContain('service-b')
    expect(result!.traversalPath).toEqual(['service:service-a', 'service:service-b'])
  })

  it('stays in-process (falls through to the origin) when no outbound call is failing', () => {
    const g = twoServiceGraph()
    // Clear the error signal so the outbound call is clean; the origin owns the
    // failure and the incident store localizes it against service-a.
    g.setEdgeAttribute(
      'CALLS:OBSERVED:service:service-a->service:service-b',
      'signal',
      { spanCount: 40, errorCount: 0, lastObservedAgeMs: 0 },
    )
    const result = getRootCause(g, 'service:service-a', undefined, [
      chargeIncident({
        id: 'trace-a:span-a',
        service: 'service-a',
        affectedNode: 'service:service-a',
        attributes: undefined,
        errorMessage: 'in-process boom',
      }),
    ])
    expect(result).not.toBeNull()
    expect(result!.rootCauseNode).toBe('service:service-a')
  })
})

// File-first graph (file-awareness.md §1–2, #392): relationships originate from
// files, the service owns them through CONTAINS. service-a's index.js calls
// service-b, service-b's db.js connects to the db, and service-b declares the
// incompatible pg 7.4.0. The incompatibility carrier is the service even though
// the caller on the walk is a file.
function newFileFirstGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  for (const [id, node] of [
    ['service:service-a', { id: 'service:service-a', type: NodeType.ServiceNode, name: 'service-a', language: 'javascript' }],
    ['service:service-b', { id: 'service:service-b', type: NodeType.ServiceNode, name: 'service-b', language: 'javascript', dependencies: { pg: '7.4.0' } }],
    ['file:service-a:index.js', { id: 'file:service-a:index.js', type: NodeType.FileNode, service: 'service-a', path: 'index.js', language: 'javascript' }],
    ['file:service-b:db.js', { id: 'file:service-b:db.js', type: NodeType.FileNode, service: 'service-b', path: 'db.js', language: 'javascript' }],
    ['database:payments-db', { id: 'database:payments-db', type: NodeType.DatabaseNode, name: 'payments', engine: 'postgresql', engineVersion: '15', compatibleDrivers: [{ name: 'pg', minVersion: '8.0.0' }] }],
  ] as [string, GraphNode][]) {
    g.addNode(id, node)
  }
  const edge = (id: string, source: string, target: string, type: GraphEdge['type']): GraphEdge => ({
    id,
    source,
    target,
    type,
    provenance: Provenance.EXTRACTED,
  })
  addEdge(g, edge('CONTAINS:service:service-a->file:service-a:index.js', 'service:service-a', 'file:service-a:index.js', EdgeType.CONTAINS))
  addEdge(g, edge('CONTAINS:service:service-b->file:service-b:db.js', 'service:service-b', 'file:service-b:db.js', EdgeType.CONTAINS))
  addEdge(g, edge('CALLS:file:service-a:index.js->service:service-b', 'file:service-a:index.js', 'service:service-b', EdgeType.CALLS))
  addEdge(g, edge('CONNECTS_TO:file:service-b:db.js->database:payments-db', 'file:service-b:db.js', 'database:payments-db', EdgeType.CONNECTS_TO))
  return g
}

describe('getRootCause — file-first graph (#392)', () => {
  it('resolves a file node on the walk path to its owning service and finds the pg mismatch', () => {
    const g = newFileFirstGraph()
    const result = getRootCause(g, 'database:payments-db')
    expect(result).not.toBeNull()
    // The carrier is the owning service, resolved from file:service-b:db.js via
    // CONTAINS — not the file itself.
    expect(result!.rootCauseNode).toBe('service:service-b')
    expect(result!.rootCauseReason).toMatch(/pg|scram|postgres/i)
    expect(result!.fixRecommendation).toMatch(/8\.0\.0/)
    // The traversal walked file-grained: the file node sits on the path.
    expect(result!.traversalPath).toContain('file:service-b:db.js')
  })

  it('handles a FileNode origin by resolving it to its owning service', () => {
    // The error lands on a file. The dispatch resolves it to the owning
    // service via CONTAINS and runs the service shape, which finds a
    // node-engine conflict declared on that service (next 14 needs Node
    // 18.17+, engines.node is >=16).
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:web', {
      id: 'service:web',
      type: NodeType.ServiceNode,
      name: 'web',
      language: 'javascript',
      dependencies: { next: '14.0.0' },
      nodeEngine: '>=16',
    })
    g.addNode('file:web:app.js', {
      id: 'file:web:app.js',
      type: NodeType.FileNode,
      service: 'web',
      path: 'app.js',
      language: 'javascript',
    })
    addEdge(g, {
      id: 'CONTAINS:service:web->file:web:app.js',
      source: 'service:web',
      target: 'file:web:app.js',
      type: EdgeType.CONTAINS,
      provenance: Provenance.EXTRACTED,
    })

    const result = getRootCause(g, 'file:web:app.js')
    expect(result).not.toBeNull()
    expect(result!.rootCauseNode).toBe('service:web')
    expect(result!.rootCauseReason).toMatch(/node|next/i)
    expect(result!.fixRecommendation).toMatch(/18\.17\.0/)
  })

  it('returns null for a FileNode origin whose owning service is healthy', () => {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:api', {
      id: 'service:api',
      type: NodeType.ServiceNode,
      name: 'api',
      language: 'javascript',
      // express carries no node-engine or package-conflict rule — nothing for
      // the service shape to flag.
      dependencies: { express: '4.19.0' },
    })
    g.addNode('file:api:server.js', {
      id: 'file:api:server.js',
      type: NodeType.FileNode,
      service: 'api',
      path: 'server.js',
      language: 'javascript',
    })
    addEdge(g, {
      id: 'CONTAINS:service:api->file:api:server.js',
      source: 'service:api',
      target: 'file:api:server.js',
      type: EdgeType.CONTAINS,
      provenance: Provenance.EXTRACTED,
    })
    expect(getRootCause(g, 'file:api:server.js')).toBeNull()
  })
})

describe('getBlastRadius', () => {
  it('walks a file-first graph and returns file-grained dependents (#392)', () => {
    const g = newFileFirstGraph()
    // The db is a pure sink — nothing flows out of it. But the file that
    // connects to it, that file's service, and everything upstream all break
    // if it changes. Blast radius walks inbound, so those dependents surface;
    // the walk is generic, so file nodes are first-class on the path.
    const result = getBlastRadius(g, 'database:payments-db')
    const ids = result.affectedNodes.map((n) => n.nodeId)
    expect(ids).toContain('file:service-b:db.js')
    expect(ids).toContain('service:service-b')
    expect(ids).toContain('service:service-a')
    const file = result.affectedNodes.find((n) => n.nodeId === 'file:service-b:db.js')!
    expect(file.distance).toBe(1)
    expect(file.path).toEqual(['database:payments-db', 'file:service-b:db.js'])
  })

  it('returns the dependents of payments-db (service-b then service-a) on the demo graph', () => {
    const g = newDemoGraph()
    addEdge(g, callsEdge(Provenance.EXTRACTED))
    addEdge(g, connectsEdge(Provenance.EXTRACTED))

    // service-a CALLS service-b CONNECTS_TO payments-db. Ask what breaks if the
    // db changes: its direct dependent service-b, then service-b's dependent
    // service-a. The walk runs inbound, back up the dependency chain.
    const result = getBlastRadius(g, 'database:payments-db')
    expect(result.origin).toBe('database:payments-db')
    expect(result.totalAffected).toBe(2)
    expect(result.affectedNodes).toEqual([
      {
        nodeId: 'service:service-b',
        distance: 1,
        edgeProvenance: Provenance.EXTRACTED,
        path: ['database:payments-db', 'service:service-b'],
        // 1-hop EXTRACTED at ceiling 0.5 → 0.5.
        confidence: 0.5,
      },
      {
        nodeId: 'service:service-a',
        distance: 2,
        edgeProvenance: Provenance.EXTRACTED,
        path: ['database:payments-db', 'service:service-b', 'service:service-a'],
        // 2-hop EXTRACTED-only path: 0.5 × 0.5 = 0.25 (multiplicative cascade).
        confidence: 0.25,
      },
    ])
  })

  it('reports OBSERVED provenance when an OBSERVED edge sits alongside the EXTRACTED one', () => {
    const g = newDemoGraph()
    addEdge(g, callsEdge(Provenance.EXTRACTED))
    addEdge(g, callsEdge(Provenance.OBSERVED))
    addEdge(g, connectsEdge(Provenance.EXTRACTED))
    addEdge(g, connectsEdge(Provenance.OBSERVED))

    const result = getBlastRadius(g, 'database:payments-db')
    expect(result.affectedNodes.find((n) => n.nodeId === 'service:service-b')!.edgeProvenance).toBe(
      Provenance.OBSERVED,
    )
    expect(
      result.affectedNodes.find((n) => n.nodeId === 'service:service-a')!.edgeProvenance,
    ).toBe(Provenance.OBSERVED)
  })

  it('returns nothing for a node with no dependents (no inbound edges)', () => {
    const g = newDemoGraph()
    addEdge(g, callsEdge(Provenance.EXTRACTED))
    addEdge(g, connectsEdge(Provenance.EXTRACTED))

    // service-a is the caller at the top of the chain — nothing depends on it,
    // so nothing breaks if it changes and the blast radius is empty.
    const result = getBlastRadius(g, 'service:service-a')
    expect(result.affectedNodes).toEqual([])
    expect(result.totalAffected).toBe(0)
    expect(result.origin).toBe('service:service-a')
  })

  it('returns an empty result for a node that does not exist', () => {
    const g = newDemoGraph()
    const result = getBlastRadius(g, 'service:nope')
    expect(result.affectedNodes).toEqual([])
    expect(result.totalAffected).toBe(0)
    expect(result.origin).toBe('service:nope')
  })

  it('respects the depth limit', () => {
    const g = newDemoGraph()
    addEdge(g, callsEdge(Provenance.EXTRACTED))
    addEdge(g, connectsEdge(Provenance.EXTRACTED))

    // Depth 1 from the db reaches only its direct dependent service-b, not
    // service-a two hops back.
    const result = getBlastRadius(g, 'database:payments-db', 1)
    expect(result.affectedNodes).toEqual([
      {
        nodeId: 'service:service-b',
        distance: 1,
        edgeProvenance: Provenance.EXTRACTED,
        path: ['database:payments-db', 'service:service-b'],
        confidence: 0.5,
      },
    ])
  })

  it('records the BFS-shortest distance when two paths reach the same node', () => {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:a', {
      id: 'service:a',
      type: NodeType.ServiceNode,
      name: 'a',
      language: 'javascript',
    })
    g.addNode('service:b', {
      id: 'service:b',
      type: NodeType.ServiceNode,
      name: 'b',
      language: 'javascript',
    })
    g.addNode('service:c', {
      id: 'service:c',
      type: NodeType.ServiceNode,
      name: 'c',
      language: 'javascript',
    })
    // a depends on c directly (a -> c) and via b (a -> b -> c). Walking inbound
    // from c, a is a dependent at distance 1 (direct) and distance 2 (via b);
    // the shortest, 1, should win.
    g.addEdgeWithKey('CALLS:service:a->service:c', 'service:a', 'service:c', {
      id: 'CALLS:service:a->service:c',
      source: 'service:a',
      target: 'service:c',
      type: EdgeType.CALLS,
      provenance: Provenance.EXTRACTED,
    })
    g.addEdgeWithKey('CALLS:service:a->service:b', 'service:a', 'service:b', {
      id: 'CALLS:service:a->service:b',
      source: 'service:a',
      target: 'service:b',
      type: EdgeType.CALLS,
      provenance: Provenance.EXTRACTED,
    })
    g.addEdgeWithKey('CALLS:service:b->service:c', 'service:b', 'service:c', {
      id: 'CALLS:service:b->service:c',
      source: 'service:b',
      target: 'service:c',
      type: EdgeType.CALLS,
      provenance: Provenance.EXTRACTED,
    })

    const result = getBlastRadius(g, 'service:c')
    const a = result.affectedNodes.find((n) => n.nodeId === 'service:a')
    expect(a!.distance).toBe(1)
  })

  it('returns the dependents of a shared leaf, not an empty list (#594)', () => {
    // A shared library that three services all import. It has only inbound
    // edges — no dependencies of its own. Asking "what breaks if this leaf
    // changes?" must return all three importers, not the empty list an
    // outbound walk would give.
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('library:shared-utils', {
      id: 'library:shared-utils',
      type: NodeType.ServiceNode,
      name: 'shared-utils',
      language: 'javascript',
    })
    for (const name of ['web', 'api', 'worker']) {
      g.addNode(`service:${name}`, {
        id: `service:${name}`,
        type: NodeType.ServiceNode,
        name,
        language: 'javascript',
      })
      addEdge(g, {
        id: `CALLS:service:${name}->library:shared-utils`,
        source: `service:${name}`,
        target: 'library:shared-utils',
        type: EdgeType.CALLS,
        provenance: Provenance.EXTRACTED,
      })
    }

    const result = getBlastRadius(g, 'library:shared-utils')
    expect(result.totalAffected).toBe(3)
    const ids = result.affectedNodes.map((n) => n.nodeId).sort()
    expect(ids).toEqual(['service:api', 'service:web', 'service:worker'])
    // Every dependent is one hop back and never the origin itself.
    for (const n of result.affectedNodes) {
      expect(n.distance).toBe(1)
      expect(n.path[0]).toBe('library:shared-utils')
      expect(n.path[n.path.length - 1]).toBe(n.nodeId)
      expect(n.nodeId).not.toBe('library:shared-utils')
    }
  })
})

// Symbol-grain graph (ADR-158 §7): the deterministic trace one grain below the
// file. `service:shop` owns `repo.ts` and `handlers.ts`; those files own their
// symbols through `file ──CONTAINS──▶ symbol`. `OrderRepo` inherits `BaseRepo`,
// `createOrder` instantiates `OrderRepo`, and `OrderRepo.save` carries the
// OBSERVED edge to the external database — the runtime external effect. The
// service declares `next@14` on Node `>=16`, the node-engine violation the
// symbol root-cause resolves up to. Every id is built from an identity helper.
const SHOP = 'shop'
const S_REPO_FILE = fileId(SHOP, 'src/repo.ts')
const S_HANDLERS_FILE = fileId(SHOP, 'src/handlers.ts')
const S_BASE_REPO = symbolId(SHOP, 'src/repo.ts', 'BaseRepo')
const S_ORDER_REPO = symbolId(SHOP, 'src/repo.ts', 'OrderRepo')
const S_ORDER_SAVE = symbolId(SHOP, 'src/repo.ts', 'OrderRepo.save')
const S_CREATE_ORDER = symbolId(SHOP, 'src/handlers.ts', 'createOrder')
const S_ORDERS_DB = databaseId('orders-db')

function newSymbolGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  const nodes: GraphNode[] = [
    { id: serviceId(SHOP), type: NodeType.ServiceNode, name: SHOP, language: 'javascript', dependencies: { next: '14.0.0' }, nodeEngine: '>=16' },
    { id: S_REPO_FILE, type: NodeType.FileNode, service: SHOP, path: 'src/repo.ts', language: 'javascript' },
    { id: S_HANDLERS_FILE, type: NodeType.FileNode, service: SHOP, path: 'src/handlers.ts', language: 'javascript' },
    { id: S_BASE_REPO, type: NodeType.SymbolNode, kind: 'class', qualname: 'BaseRepo', span: { startLine: 1, endLine: 12 }, service: SHOP, relPath: 'src/repo.ts', discoveredVia: 'static' },
    { id: S_ORDER_REPO, type: NodeType.SymbolNode, kind: 'class', qualname: 'OrderRepo', span: { startLine: 14, endLine: 40 }, service: SHOP, relPath: 'src/repo.ts', discoveredVia: 'static' },
    { id: S_ORDER_SAVE, type: NodeType.SymbolNode, kind: 'method', qualname: 'OrderRepo.save', span: { startLine: 20, endLine: 28 }, service: SHOP, relPath: 'src/repo.ts', discoveredVia: 'static' },
    { id: S_CREATE_ORDER, type: NodeType.SymbolNode, kind: 'function', qualname: 'createOrder', span: { startLine: 5, endLine: 18 }, service: SHOP, relPath: 'src/handlers.ts', discoveredVia: 'static' },
    { id: S_ORDERS_DB, type: NodeType.DatabaseNode, name: 'orders-db', engine: 'postgresql', engineVersion: '15', compatibleDrivers: [{ name: 'pg', minVersion: '8.0.0' }] },
  ]
  for (const n of nodes) g.addNode(n.id, n)

  const e = (id: string, source: string, target: string, type: GraphEdge['type'], provenance: GraphEdge['provenance'] = Provenance.EXTRACTED): GraphEdge => ({ id, source, target, type, provenance })
  const edges: GraphEdge[] = [
    // service ──CONTAINS──▶ file ──CONTAINS──▶ symbol, the two containment levels.
    e('CONTAINS:service:shop->file:repo', serviceId(SHOP), S_REPO_FILE, EdgeType.CONTAINS),
    e('CONTAINS:service:shop->file:handlers', serviceId(SHOP), S_HANDLERS_FILE, EdgeType.CONTAINS),
    e('CONTAINS:file:repo->BaseRepo', S_REPO_FILE, S_BASE_REPO, EdgeType.CONTAINS),
    e('CONTAINS:file:repo->OrderRepo', S_REPO_FILE, S_ORDER_REPO, EdgeType.CONTAINS),
    e('CONTAINS:file:repo->OrderRepo.save', S_REPO_FILE, S_ORDER_SAVE, EdgeType.CONTAINS),
    e('CONTAINS:file:handlers->createOrder', S_HANDLERS_FILE, S_CREATE_ORDER, EdgeType.CONTAINS),
    // Static symbol→symbol edges (ADR-158 §3): heritage + call.
    e('INHERITS:OrderRepo->BaseRepo', S_ORDER_REPO, S_BASE_REPO, EdgeType.INHERITS),
    e('CALLS:createOrder->OrderRepo', S_CREATE_ORDER, S_ORDER_REPO, EdgeType.CALLS),
    e('CALLS:createOrder->OrderRepo.save', S_CREATE_ORDER, S_ORDER_SAVE, EdgeType.CALLS),
    // The observed external effect: the save method reaches the database at runtime.
    e('CONNECTS_TO:OBSERVED:OrderRepo.save->orders-db', S_ORDER_SAVE, S_ORDERS_DB, EdgeType.CONNECTS_TO, Provenance.OBSERVED),
  ]
  for (const edge of edges) g.addEdgeWithKey(edge.id, edge.source, edge.target, edge)
  return g
}

describe('symbol-grain traversal (ADR-158 §7)', () => {
  it('getBlastRadius from a leaf symbol returns symbol dependents across CALLS and INHERITS', () => {
    // BaseRepo is the "bug in a symbol." Its dependents walk inbound: OrderRepo
    // inherits it, createOrder instantiates OrderRepo. The walk is generic, so
    // the symbols are first-class members of the paths — no traversal change.
    const result = getBlastRadius(newSymbolGraph(), S_BASE_REPO)
    const ids = result.affectedNodes.map((n) => n.nodeId)
    expect(ids).toContain(S_ORDER_REPO)
    expect(ids).toContain(S_CREATE_ORDER)

    // OrderRepo reaches BaseRepo across the INHERITS edge, one hop.
    const orderRepo = result.affectedNodes.find((n) => n.nodeId === S_ORDER_REPO)!
    expect(orderRepo.distance).toBe(1)
    expect(orderRepo.path).toEqual([S_BASE_REPO, S_ORDER_REPO])

    // createOrder reaches BaseRepo through OrderRepo — a pure symbol path
    // (INHERITS then CALLS), every id a `symbol:` id.
    const createOrder = result.affectedNodes.find((n) => n.nodeId === S_CREATE_ORDER)!
    expect(createOrder.path).toEqual([S_BASE_REPO, S_ORDER_REPO, S_CREATE_ORDER])
    expect(createOrder.path.every((id) => id.startsWith('symbol:'))).toBe(true)
  })

  it('getRootCause on a SymbolNode origin resolves the symbol to its owning service', () => {
    // The failure surfaces on a symbol. Dispatch resolves it up the CONTAINS
    // chain (symbol ◀─CONTAINS─ file ◀─CONTAINS─ service) and runs the service
    // shape, which flags the node-engine violation (next 14 needs Node 18.17+,
    // engines.node is >=16). The carrier named is the service; the symbol was
    // the origin.
    const result = getRootCause(newSymbolGraph(), S_ORDER_SAVE)
    expect(result).not.toBeNull()
    expect(result!.rootCauseNode).toBe(serviceId(SHOP))
    expect(result!.rootCauseReason).toMatch(/node|next/i)
    expect(result!.fixRecommendation).toMatch(/18\.17\.0/)
    expect(result!.traversalPath[0]).toBe(S_ORDER_SAVE)
  })

  it('getRootCause returns null for a SymbolNode whose owning service is healthy', () => {
    const g = newSymbolGraph()
    // Strip the failing dependency so the service shape finds nothing.
    g.replaceNodeAttributes(serviceId(SHOP), {
      id: serviceId(SHOP), type: NodeType.ServiceNode, name: SHOP, language: 'javascript',
      dependencies: { express: '4.19.0' },
    })
    expect(getRootCause(g, S_BASE_REPO)).toBeNull()
  })

  it('getBlastRadius from an external node crosses an OBSERVED edge onto a symbol', () => {
    // The database is a pure sink — the external effect. Its blast radius walks
    // inbound and the first dependent is the SymbolNode that reaches it at
    // runtime, across the OBSERVED edge. This is the runtime-reachable blast
    // surface of ADR-158 §7: a symbol carrying an OBSERVED edge to an external
    // effect, found by graph walk, provenance-tagged OBSERVED.
    const result = getBlastRadius(newSymbolGraph(), S_ORDERS_DB)
    const save = result.affectedNodes.find((n) => n.nodeId === S_ORDER_SAVE)
    expect(save).toBeDefined()
    expect(save!.distance).toBe(1)
    expect(save!.edgeProvenance).toBe(Provenance.OBSERVED)
    expect(save!.path).toEqual([S_ORDERS_DB, S_ORDER_SAVE])
    // The symbol's own callers are reachable one hop further, still on symbol ids.
    const createOrder = result.affectedNodes.find((n) => n.nodeId === S_CREATE_ORDER)
    expect(createOrder).toBeDefined()
    expect(createOrder!.path[createOrder!.path.length - 1]).toBe(S_CREATE_ORDER)
  })

  it('getTransitiveDependencies from a caller symbol reaches the external effect through symbol edges', () => {
    // createOrder → OrderRepo.save → orders-db. The outbound walk is generic:
    // it steps across the symbol CALLS edge and the OBSERVED CONNECTS_TO to the
    // external node, reporting each with its own edge type and provenance.
    const result = getTransitiveDependencies(newSymbolGraph(), S_CREATE_ORDER, 3)
    const ids = result.dependencies.map((d) => d.nodeId)
    expect(ids).toContain(S_ORDER_SAVE)
    expect(ids).toContain(S_ORDERS_DB)
    const dbDep = result.dependencies.find((d) => d.nodeId === S_ORDERS_DB)!
    expect(dbDep.provenance).toBe(Provenance.OBSERVED)
  })
})

describe('confidenceForEdge — signal-aware (#76)', () => {
  it('returns provenance ceiling when no signal data is present', async () => {
    const { confidenceForEdge } = await import('../src/traverse.js')
    const e: GraphEdge = {
      id: 'x',
      source: 's',
      target: 't',
      type: EdgeType.CALLS,
      provenance: Provenance.OBSERVED,
    }
    expect(confidenceForEdge(e)).toBe(1)
  })

  it('penalises a low-volume stale OBSERVED edge below a high-volume fresh one', async () => {
    const { confidenceForEdge } = await import('../src/traverse.js')
    const stale: GraphEdge = {
      id: 'a',
      source: 's',
      target: 't',
      type: EdgeType.CALLS,
      provenance: Provenance.OBSERVED,
      signal: { spanCount: 1, errorCount: 0, lastObservedAgeMs: 23 * 60 * 60 * 1000 },
    }
    const fresh: GraphEdge = {
      id: 'b',
      source: 's',
      target: 't',
      type: EdgeType.CALLS,
      provenance: Provenance.OBSERVED,
      signal: { spanCount: 10000, errorCount: 0, lastObservedAgeMs: 5 * 1000 },
    }
    const a = confidenceForEdge(stale)
    const b = confidenceForEdge(fresh)
    expect(a).toBeLessThan(b)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(b).toBeLessThanOrEqual(1)
  })

  it('penalises a flapping edge with high error rate', async () => {
    const { confidenceForEdge } = await import('../src/traverse.js')
    const clean: GraphEdge = {
      id: 'a',
      source: 's',
      target: 't',
      type: EdgeType.CALLS,
      provenance: Provenance.OBSERVED,
      signal: { spanCount: 100, errorCount: 0, lastObservedAgeMs: 1000 },
    }
    const flapping: GraphEdge = {
      id: 'b',
      source: 's',
      target: 't',
      type: EdgeType.CALLS,
      provenance: Provenance.OBSERVED,
      signal: { spanCount: 100, errorCount: 60, lastObservedAgeMs: 1000 },
    }
    expect(confidenceForEdge(flapping)).toBeLessThan(confidenceForEdge(clean))
  })
})
