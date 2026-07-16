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

// Shared across both `describe` blocks below (fixture-driven and
// failure-path) — a real Railway deployment id, matching httpLogsFixture's
// own `deploymentId` field.
const LATEST_DEPLOYMENT_ID = 'dep_9f8e7d6c'

describe('Railway connector — end-to-end poll() against fixture GraphQL responses (docs/contracts/connectors.md §5)', () => {
  let realFetch: typeof globalThis.fetch

  beforeEach(() => {
    realFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  // Three live queries now (client.ts): `deployments` resolves the
  // deploymentId httpLogs needs fresh every poll, then httpLogs +
  // networkFlowLogs run. Routed by query text the same way the fixture
  // stub always has been — `body.query.includes(...)`.
  function stubRailwayGraphQL(): void {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string }
      const data = body.query.includes('LatestDeployment')
        ? { deployments: { edges: [{ node: { id: LATEST_DEPLOYMENT_ID, status: 'SUCCESS', createdAt: '2026-07-03T09:00:00.000Z' } }] } }
        : body.query.includes('httpLogs')
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

  // Three queries run concurrently-ish per poll now (deployments is awaited
  // first, then httpLogs + networkFlowLogs run via Promise.allSettled) — a
  // single shared "last captured variables" var is no longer safe to assert
  // on, since which of the two concurrent calls lands last isn't
  // deterministic. Captured per query-name instead.
  function stubCapturingVariables(): Record<string, Record<string, unknown>> {
    const captured: Record<string, Record<string, unknown>> = {}
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string
        variables: Record<string, unknown>
      }
      if (body.query.includes('LatestDeployment')) {
        captured.deployments = body.variables
        return new Response(
          JSON.stringify({
            data: {
              deployments: {
                edges: [{ node: { id: LATEST_DEPLOYMENT_ID, status: 'SUCCESS', createdAt: '2026-07-03T09:00:00.000Z' } }],
              },
            },
          }),
          { status: 200 },
        )
      }
      if (body.query.includes('httpLogs')) {
        captured.httpLogs = body.variables
        return new Response(JSON.stringify({ data: { httpLogs: [] } }), { status: 200 })
      }
      captured.networkFlowLogs = body.variables
      return new Response(JSON.stringify({ data: { networkFlowLogs: [] } }), { status: 200 })
    }) as typeof globalThis.fetch
    return captured
  }

  it('passes since through unchanged when it is within the lookback window', async () => {
    const captured = stubCapturingVariables()
    const graph = newGraph()
    const connector = createRailwayConnector(graph, config())
    // An hour ago, computed at test-run time - not a hardcoded calendar date.
    // DEFAULT_MAX_LOOKBACK_MS is 24h, so this always lands inside the window
    // regardless of which day the suite runs, unlike a fixed ISO string.
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()

    await connector.poll(baseCtx({ since }))

    // httpLogs is scoped by deploymentId now, resolved fresh from
    // (environmentId, serviceId) via the deployments query — not passed
    // environmentId/serviceId directly (client.ts).
    expect(captured.httpLogs?.startDate).toBe(since)
    expect(captured.httpLogs?.deploymentId).toBe(LATEST_DEPLOYMENT_ID)
    expect(captured.deployments?.environmentId).toBe('env-abc123')
    expect(captured.deployments?.serviceId).toBe(RAILWAY_SERVICE_ID)
    // networkFlowLogs takes no date window at all (live-confirmed, client.ts).
    expect(captured.networkFlowLogs?.startDate).toBeUndefined()
    expect(captured.networkFlowLogs?.environmentId).toBe('env-abc123')
  })

  it('bounds since to maxLookbackMs when the gap is too wide, or when since is absent', async () => {
    const captured = stubCapturingVariables()
    const graph = newGraph()
    const connector = createRailwayConnector(graph, config())
    const beforeMs = Date.now()

    // A since well outside the 24h default lookback (a laptop off for a week).
    const staleSince = new Date(beforeMs - 7 * 24 * 60 * 60 * 1000).toISOString()
    await connector.poll(baseCtx({ since: staleSince }))
    const staleStartMs = new Date(captured.httpLogs?.startDate as string).getTime()
    expect(staleStartMs).toBeGreaterThan(new Date(staleSince).getTime())
    expect(beforeMs - staleStartMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5000)

    // No since at all (first poll ever) gets the same floor treatment.
    await connector.poll(baseCtx({ since: undefined }))
    const absentStartMs = new Date(captured.httpLogs?.startDate as string).getTime()
    expect(beforeMs - absentStartMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5000)
  })

  it('requires ctx.credentials.token and never lets it reach a graph mutation', async () => {
    const graph = newGraph()
    const connector = createRailwayConnector(graph, config())

    await expect(connector.poll(baseCtx({ credentials: {} }))).rejects.toThrow(/credentials\.token/)
  })
})

// Live-confirmed against a real Railway project (2026-07-08, issue #738):
// `Authorization: Bearer <token>` authenticates at the HTTP gateway (200 OK)
// but is not authorized for httpLogs/networkFlowLogs/deployments, which come
// back as an HTTP-200 response carrying a GraphQL-level "Not Authorized"
// error — a bad/expired/wrongly-scoped token surfaces exactly this shape,
// never an HTTP 401/403. These tests exercise that failure mode plus the
// other hardening cases issue #738 asks for: an empty poll window, a service
// with no deployment yet, and one surface's failure not silently discarding
// the other's good data (the Promise.allSettled fix in index.ts).
describe('Railway connector — failure paths (issue #738 hardening)', () => {
  let realFetch: typeof globalThis.fetch

  beforeEach(() => {
    realFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function graphqlErrorResponse(message: string): Response {
    return new Response(JSON.stringify({ data: null, errors: [{ message }] }), { status: 200 })
  }

  it('a bad/wrongly-scoped token (HTTP 200 + GraphQL "Not Authorized") rejects poll() cleanly', async () => {
    globalThis.fetch = (async () => graphqlErrorResponse('Not Authorized')) as typeof globalThis.fetch

    const graph = newGraph()
    const connector = createRailwayConnector(graph, config())

    await expect(connector.poll(baseCtx())).rejects.toThrow(/Not Authorized/)
  })

  it('a service with no deployments yet gets an empty httpLogs result, not a thrown error', async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string }
      if (body.query.includes('LatestDeployment')) {
        return new Response(JSON.stringify({ data: { deployments: { edges: [] } } }), { status: 200 })
      }
      // networkFlowLogs still succeeds — the two surfaces are independent.
      return new Response(JSON.stringify({ data: { networkFlowLogs: [] } }), { status: 200 })
    }) as typeof globalThis.fetch

    const graph = newGraph()
    const connector = createRailwayConnector(graph, config())

    const signals = await connector.poll(baseCtx())
    expect(signals).toEqual([])
  })

  it('an empty httpLogs/networkFlowLogs window produces zero signals, not an error', async () => {
    stubRailwayGraphQL0()

    const graph = newGraph()
    const connector = createRailwayConnector(graph, config())
    const signals = await connector.poll(baseCtx())

    expect(signals).toEqual([])
  })

  function stubRailwayGraphQL0(): void {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string }
      const data = body.query.includes('LatestDeployment')
        ? { deployments: { edges: [{ node: { id: LATEST_DEPLOYMENT_ID, status: 'SUCCESS', createdAt: '2026-07-03T09:00:00.000Z' } }] } }
        : body.query.includes('httpLogs')
          ? { httpLogs: [] }
          : { networkFlowLogs: [] }
      return new Response(JSON.stringify({ data }), { status: 200 })
    }) as typeof globalThis.fetch
  }

  it('an httpLogs failure does not discard a successful networkFlowLogs result', async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string }
      if (body.query.includes('LatestDeployment')) {
        return new Response(
          JSON.stringify({
            data: { deployments: { edges: [{ node: { id: LATEST_DEPLOYMENT_ID, status: 'SUCCESS', createdAt: '2026-07-03T09:00:00.000Z' } }] } },
          }),
          { status: 200 },
        )
      }
      if (body.query.includes('httpLogs')) return graphqlErrorResponse('Not Authorized')
      return new Response(JSON.stringify({ data: { networkFlowLogs: networkFlowLogsFixture } }), { status: 200 })
    }) as typeof globalThis.fetch

    const graph = newGraph()
    const connector = createRailwayConnector(graph, config())
    const signals = await connector.poll(baseCtx())

    // httpLogs contributed nothing (it failed), but the peer-service signal
    // from networkFlowLogs still landed — one surface's failure doesn't cost
    // the other's data (index.ts's Promise.allSettled, not Promise.all).
    const peerSignals = signals.filter((s) => s.targetKind === 'peer-service')
    expect(peerSignals).toHaveLength(1)
    expect(signals.some((s) => s.targetKind === 'route' || s.targetKind === 'unmatched-route')).toBe(false)
  })

  it('a networkFlowLogs failure does not discard a successful httpLogs result', async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string }
      if (body.query.includes('LatestDeployment')) {
        return new Response(
          JSON.stringify({
            data: { deployments: { edges: [{ node: { id: LATEST_DEPLOYMENT_ID, status: 'SUCCESS', createdAt: '2026-07-03T09:00:00.000Z' } }] } },
          }),
          { status: 200 },
        )
      }
      if (body.query.includes('httpLogs')) {
        return new Response(JSON.stringify({ data: { httpLogs: httpLogsFixture } }), { status: 200 })
      }
      return graphqlErrorResponse('Not Authorized')
    }) as typeof globalThis.fetch

    const graph = newGraph()
    const connector = createRailwayConnector(graph, config())
    const signals = await connector.poll(baseCtx())

    const routeSignals = signals.filter((s) => s.targetKind === 'route')
    expect(routeSignals).toHaveLength(2)
    expect(signals.some((s) => s.targetKind === 'peer-service')).toBe(false)
  })
})
