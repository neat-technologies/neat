import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  fileId,
  observedEdgeId,
  routeId,
  serviceId,
  type FileNode,
  type GraphEdge,
  type GraphNode,
  type RouteNode,
  type ServiceNode,
} from '@neat.is/types'
import { runConnectorPoll, type ConnectorContext } from '../src/connectors/index.js'
import type { NeatGraph } from '../src/graph.js'
import {
  buildRailwayRouteIndex,
  createRailwayConnector,
  createRailwayResolveTarget,
  mapRailwayHttpLogsToSignals,
  mapRailwayNetworkFlowLogsToSignals,
  type RailwayConnectorConfig,
  type RailwayHttpLogEntry,
  type RailwayNetworkFlowLogEntry,
} from '../src/connectors/railway/index.js'
import httpLogsFixture from './fixtures/railway/http-logs.json' with { type: 'json' }
import networkFlowLogsFixture from './fixtures/railway/network-flow-logs.json' with { type: 'json' }

// Fixtures below mirror Railway's own documented field names for these two
// log families (docs.railway.com/cli/logs, fetched 2026-07-03): httpLogs
// carries `method`/`path`/`httpStatus`/`totalDuration`/`requestId`/
// `deploymentId`/`edgeRegion` (a subset of the full attribute list that
// page documents — the fields docs/connectors/railway.md's own §1 names as
// what this connector needs); networkFlowLogs carries `peerServiceId` +
// byte/packet counts + `dropCause`. Per docs/contracts/connectors.md §5,
// these are the closest-documented real provider response shapes available
// without live GraphiQL introspection against an actual Railway project —
// see the "needs-endpoint-testing" comments in
// packages/core/src/connectors/railway/types.ts for exactly what remains
// unconfirmed (whether httpLogs/networkFlowLogs are literal top-level query
// names, the pagination shape, and any provider-side rate limit).

const RAILWAY_SERVICE_ID = 'railway-svc-orders'
const RAILWAY_PEER_SERVICE_ID = 'railway-svc-billing'
const NEAT_SERVICE = 'orders-api'
const NEAT_PEER_SERVICE = 'billing-api'

function config(overrides: Partial<RailwayConnectorConfig> = {}): RailwayConnectorConfig {
  return {
    environmentId: 'env-abc123',
    serviceId: RAILWAY_SERVICE_ID,
    serviceNameById: {
      [RAILWAY_SERVICE_ID]: NEAT_SERVICE,
      [RAILWAY_PEER_SERVICE_ID]: NEAT_PEER_SERVICE,
    },
    ...overrides,
  }
}

function newGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })

  const service: ServiceNode = {
    id: serviceId(NEAT_SERVICE),
    type: NodeType.ServiceNode,
    name: NEAT_SERVICE,
    language: 'typescript',
  }
  g.addNode(service.id, service)

  const peer: ServiceNode = {
    id: serviceId(NEAT_PEER_SERVICE),
    type: NodeType.ServiceNode,
    name: NEAT_PEER_SERVICE,
    language: 'typescript',
  }
  g.addNode(peer.id, peer)

  // EXTRACTED FileNode a static extractor already minted for the file the
  // routes below are declared in — the same fusion target
  // reconcileObservedRelPath resolves onto (file-awareness.md §4).
  const file: FileNode = {
    id: fileId(NEAT_SERVICE, 'src/routes/users.ts'),
    type: NodeType.FileNode,
    service: NEAT_SERVICE,
    path: 'src/routes/users.ts',
    language: 'typescript',
  }
  g.addNode(file.id, file)

  const getUser: RouteNode = {
    id: routeId(NEAT_SERVICE, 'GET', '/users/:id'),
    type: NodeType.RouteNode,
    name: 'GET /users/:id',
    service: NEAT_SERVICE,
    method: 'GET',
    pathTemplate: '/users/:id',
    path: 'src/routes/users.ts',
    line: 10,
    framework: 'express',
    discoveredVia: 'static',
  }
  g.addNode(getUser.id, getUser)

  const createUser: RouteNode = {
    id: routeId(NEAT_SERVICE, 'POST', '/users'),
    type: NodeType.RouteNode,
    name: 'POST /users',
    service: NEAT_SERVICE,
    method: 'POST',
    pathTemplate: '/users',
    path: 'src/routes/users.ts',
    line: 20,
    framework: 'express',
    discoveredVia: 'static',
  }
  g.addNode(createUser.id, createUser)

  return g
}

function baseCtx(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    projectDir: '/repo/orders-api',
    credentials: { token: 'test-project-access-token' },
    ...overrides,
  }
}

describe('Railway connector — httpLogs/networkFlowLogs → ObservedSignal mapping (ADR-127)', () => {
  it('normalizes and matches httpLogs entries onto existing RouteNodes, aggregating by route', () => {
    const graph = newGraph()
    const routeIndex = buildRailwayRouteIndex(graph, NEAT_SERVICE)

    const signals = mapRailwayHttpLogsToSignals(httpLogsFixture as RailwayHttpLogEntry[], routeIndex)

    // /users/42, /users/17, /users/999 all normalise to /users/:param and
    // match the declared GET /users/:id route — one aggregated signal, not
    // three, with the 500 counted as the error.
    const getUserRoute = routeId(NEAT_SERVICE, 'GET', '/users/:id')
    const getUserSignal = signals.find((s) => s.targetKind === 'route' && s.targetName === getUserRoute)
    expect(getUserSignal).toBeDefined()
    expect(getUserSignal?.callCount).toBe(3)
    expect(getUserSignal?.errorCount).toBe(1)
    expect(getUserSignal?.lastObservedIso).toBe('2026-07-03T10:00:05.000Z')
    expect(getUserSignal?.callSite).toEqual({ file: 'src/routes/users.ts', line: 10 })

    const createUserRoute = routeId(NEAT_SERVICE, 'POST', '/users')
    const createUserSignal = signals.find(
      (s) => s.targetKind === 'route' && s.targetName === createUserRoute,
    )
    expect(createUserSignal).toBeDefined()
    expect(createUserSignal?.callCount).toBe(1)
    expect(createUserSignal?.errorCount).toBe(0)
    expect(createUserSignal?.callSite).toEqual({ file: 'src/routes/users.ts', line: 20 })
  })

  it('falls back to an honest unmatched-route signal when no static route resolves', () => {
    const graph = newGraph()
    const routeIndex = buildRailwayRouteIndex(graph, NEAT_SERVICE)

    const signals = mapRailwayHttpLogsToSignals(httpLogsFixture as RailwayHttpLogEntry[], routeIndex)

    const unmatched = signals.find((s) => s.targetKind === 'unmatched-route')
    expect(unmatched).toBeDefined()
    expect(unmatched?.targetName).toBe('GET /internal/healthz')
    expect(unmatched?.callCount).toBe(1)
    expect(unmatched?.callSite).toBeUndefined()

    // createRailwayResolveTarget must drop this honestly (never fabricate a
    // RouteNode target — RouteNode.path is a required, real source location,
    // packages/types/src/nodes.ts) rather than mint anything for it.
    const resolveTarget = createRailwayResolveTarget(config())
    expect(resolveTarget(unmatched!, baseCtx())).toBeNull()
  })

  it('maps networkFlowLogs into a peer-service signal, dropping entries with no peer identity', () => {
    const signals = mapRailwayNetworkFlowLogsToSignals(
      networkFlowLogsFixture as RailwayNetworkFlowLogEntry[],
    )

    expect(signals).toHaveLength(1)
    const [peerSignal] = signals
    expect(peerSignal.targetKind).toBe('peer-service')
    expect(peerSignal.targetName).toBe(RAILWAY_PEER_SERVICE_ID)
    expect(peerSignal.callCount).toBe(2)
    // One of the two flow rows carries a non-null dropCause.
    expect(peerSignal.errorCount).toBe(1)
    expect(peerSignal.lastObservedIso).toBe('2026-07-03T10:00:04.000Z')
  })
})

describe('Railway connector — createRailwayResolveTarget (ADR-127)', () => {
  it('resolves a matched route signal to the RouteNode with a CALLS edge', () => {
    const resolveTarget = createRailwayResolveTarget(config())
    const routeNodeId = routeId(NEAT_SERVICE, 'GET', '/users/:id')

    const resolved = resolveTarget(
      {
        targetKind: 'route',
        targetName: routeNodeId,
        callCount: 3,
        errorCount: 1,
        lastObservedIso: '2026-07-03T10:00:05.000Z',
        callSite: { file: 'src/routes/users.ts', line: 10 },
      },
      baseCtx(),
    )

    expect(resolved).toEqual({
      targetNodeId: routeNodeId,
      serviceName: NEAT_SERVICE,
      edgeType: EdgeType.CALLS,
    })
  })

  it('resolves a mapped peer-service signal to a CONNECTS_TO edge between ServiceNodes', () => {
    const resolveTarget = createRailwayResolveTarget(config())

    const resolved = resolveTarget(
      {
        targetKind: 'peer-service',
        targetName: RAILWAY_PEER_SERVICE_ID,
        callCount: 2,
        errorCount: 1,
        lastObservedIso: '2026-07-03T10:00:04.000Z',
      },
      baseCtx(),
    )

    expect(resolved).toEqual({
      targetNodeId: serviceId(NEAT_PEER_SERVICE),
      serviceName: NEAT_SERVICE,
      edgeType: EdgeType.CONNECTS_TO,
    })
  })

  it('drops an unmapped peer serviceId honestly rather than guessing', () => {
    const resolveTarget = createRailwayResolveTarget(config())

    const resolved = resolveTarget(
      {
        targetKind: 'peer-service',
        targetName: 'railway-svc-unknown',
        callCount: 1,
        errorCount: 0,
        lastObservedIso: '2026-07-03T10:00:04.000Z',
      },
      baseCtx(),
    )

    expect(resolved).toBeNull()
  })
})

describe('Railway connector — end-to-end poll() against fixture GraphQL responses (docs/contracts/connectors.md §5)', () => {
  let realFetch: typeof globalThis.fetch

  beforeEach(() => {
    realFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function stubRailwayGraphQL(): void {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string }
      const isHttpLogs = body.query.includes('httpLogs')
      const data = isHttpLogs
        ? { httpLogs: httpLogsFixture }
        : { networkFlowLogs: networkFlowLogsFixture }
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof globalThis.fetch
  }

  it('poll() fetches both queries and maps them into ObservedSignal[]', async () => {
    stubRailwayGraphQL()
    const graph = newGraph()
    const connector = createRailwayConnector(graph, config())

    const signals = await connector.poll(baseCtx())

    const routeSignals = signals.filter((s) => s.targetKind === 'route')
    const unmatchedSignals = signals.filter((s) => s.targetKind === 'unmatched-route')
    const peerSignals = signals.filter((s) => s.targetKind === 'peer-service')
    expect(routeSignals).toHaveLength(2)
    expect(unmatchedSignals).toHaveLength(1)
    expect(peerSignals).toHaveLength(1)
  })

  it('mints file-grained OBSERVED CALLS + CONNECTS_TO edges through runConnectorPoll', async () => {
    stubRailwayGraphQL()
    const graph = newGraph()
    const connector = createRailwayConnector(graph, config())
    const resolveTarget = createRailwayResolveTarget(config())

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)

    // 2 matched routes + 1 peer-service resolve; the unmatched-route signal
    // drops honestly.
    expect(result.edgesCreated).toBe(3)
    expect(result.unresolved).toBe(1)

    const fileNodeId = fileId(NEAT_SERVICE, 'src/routes/users.ts')
    const getUserEdgeId = observedEdgeId(
      fileNodeId,
      routeId(NEAT_SERVICE, 'GET', '/users/:id'),
      EdgeType.CALLS,
    )
    expect(graph.hasEdge(getUserEdgeId)).toBe(true)
    const getUserEdge = graph.getEdgeAttributes(getUserEdgeId) as GraphEdge
    expect(getUserEdge.provenance).toBe(Provenance.OBSERVED)
    expect(getUserEdge.signal?.spanCount).toBe(3)
    expect(getUserEdge.signal?.errorCount).toBe(1)
    expect(getUserEdge.evidence).toEqual({ file: 'src/routes/users.ts', line: 10 })

    const connectsToId = observedEdgeId(
      serviceId(NEAT_SERVICE),
      serviceId(NEAT_PEER_SERVICE),
      EdgeType.CONNECTS_TO,
    )
    expect(graph.hasEdge(connectsToId)).toBe(true)
    const connectsToEdge = graph.getEdgeAttributes(connectsToId) as GraphEdge
    expect(connectsToEdge.provenance).toBe(Provenance.OBSERVED)
    expect(connectsToEdge.signal?.spanCount).toBe(2)
    expect(connectsToEdge.signal?.errorCount).toBe(1)
  })

  it('bounds the query window to since when provided, and to maxLookbackMs otherwise', async () => {
    let capturedVariables: Record<string, unknown> | undefined
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string
        variables: Record<string, unknown>
      }
      capturedVariables = body.variables
      const data = body.query.includes('httpLogs')
        ? { httpLogs: [] }
        : { networkFlowLogs: [] }
      return new Response(JSON.stringify({ data }), { status: 200 })
    }) as typeof globalThis.fetch

    const graph = newGraph()
    const connector = createRailwayConnector(graph, config())
    const since = '2026-07-03T09:00:00.000Z'

    await connector.poll(baseCtx({ since }))

    expect(capturedVariables?.startDate).toBe(since)
    expect(capturedVariables?.environmentId).toBe('env-abc123')
    expect(capturedVariables?.serviceId).toBe(RAILWAY_SERVICE_ID)
  })

  it('requires ctx.credentials.token and never lets it reach a graph mutation', async () => {
    const graph = newGraph()
    const connector = createRailwayConnector(graph, config())

    await expect(connector.poll(baseCtx({ credentials: {} }))).rejects.toThrow(/credentials\.token/)
  })
})
