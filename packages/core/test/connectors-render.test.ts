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
  buildRenderRouteIndex,
  createRenderConnector,
  createRenderResolveTarget,
  mapRenderRequestLogsToSignals,
  type RenderConnectorConfig,
  type RenderLogEntry,
} from '../src/connectors/render/index.js'
import { PROVIDER_DISPATCH } from '../src/connectors/registry.js'
import { resetJunctionRateLimiters } from '../src/connectors/junction.js'
import requestLogsFixture from './fixtures/render/request-logs.json' with { type: 'json' }

// The fixture below mirrors Render's documented request-log object shape
// (api-docs.render.com/reference/list-logs; render.com/docs/logging): each
// entry carries a `timestamp`, a `message`, and a `labels` array whose
// `type`/`method`/`path`/`statusCode`/`host` entries are the same names the
// log-query filter parameters use. Per docs/contracts/connectors.md §5 these
// are the closest-documented real provider response shapes available without a
// live authenticated Render project to introspect — see the "What is verified"
// section of docs/connectors/render.md for exactly what remains unconfirmed.

const RENDER_OWNER_ID = 'tea-abc123'
const RENDER_RESOURCE_ID = 'srv-orders-9f8e7d'
const NEAT_SERVICE = 'orders-api'

function config(overrides: Partial<RenderConnectorConfig> = {}): RenderConnectorConfig {
  return {
    ownerId: RENDER_OWNER_ID,
    resourceId: RENDER_RESOURCE_ID,
    serviceName: NEAT_SERVICE,
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

  // EXTRACTED FileNode a static extractor already minted for the file the
  // routes below are declared in — the fusion target reconcileObservedRelPath
  // resolves onto (file-awareness.md §4).
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
    credentials: { token: 'rnd_test_api_key' },
    ...overrides,
  }
}

describe('Render connector — request logs → ObservedSignal mapping (ADR-166)', () => {
  it('normalizes and matches request logs onto existing RouteNodes, aggregating by route', () => {
    const graph = newGraph()
    const routeIndex = buildRenderRouteIndex(graph, NEAT_SERVICE)

    const signals = mapRenderRequestLogsToSignals(requestLogsFixture as RenderLogEntry[], routeIndex)

    // /users/42, /users/17 (with a query string), /users/999 all normalise to
    // /users/:param and match the declared GET /users/:id route — one
    // aggregated signal, not three, with the 500 counted as the error and the
    // latest timestamp winning.
    const getUserRoute = routeId(NEAT_SERVICE, 'GET', '/users/:id')
    const getUserSignal = signals.find((s) => s.targetKind === 'route' && s.targetName === getUserRoute)
    expect(getUserSignal).toBeDefined()
    expect(getUserSignal?.callCount).toBe(3)
    expect(getUserSignal?.errorCount).toBe(1)
    expect(getUserSignal?.lastObservedIso).toBe('2026-08-01T10:00:05.000Z')
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
    const routeIndex = buildRenderRouteIndex(graph, NEAT_SERVICE)

    const signals = mapRenderRequestLogsToSignals(requestLogsFixture as RenderLogEntry[], routeIndex)

    const unmatched = signals.find((s) => s.targetKind === 'unmatched-route')
    expect(unmatched).toBeDefined()
    expect(unmatched?.targetName).toBe('GET /internal/healthz')
    expect(unmatched?.callCount).toBe(1)
    expect(unmatched?.callSite).toBeUndefined()

    // createRenderResolveTarget must drop this honestly rather than fabricate a
    // RouteNode target (RouteNode.path is a required real source location,
    // packages/types/src/nodes.ts).
    const resolveTarget = createRenderResolveTarget(config())
    expect(resolveTarget(unmatched!, baseCtx())).toBeNull()
  })
})

describe('Render mapping — shape-drift robustness (never crashes a poll tick)', () => {
  it('drops null / empty rows, and rows missing timestamp / method / path labels', () => {
    expect(mapRenderRequestLogsToSignals([null as unknown as RenderLogEntry], [])).toEqual([])
    expect(mapRenderRequestLogsToSignals([{} as RenderLogEntry], [])).toEqual([])
    // No labels at all → dropped.
    expect(
      mapRenderRequestLogsToSignals([{ timestamp: '2026-08-01T10:00:00.000Z' } as RenderLogEntry], []),
    ).toEqual([])
    // A label set missing `path` → dropped (never guessed).
    expect(
      mapRenderRequestLogsToSignals(
        [
          {
            timestamp: '2026-08-01T10:00:00.000Z',
            labels: [{ name: 'method', value: 'GET' }],
          } as RenderLogEntry,
        ],
        [],
      ),
    ).toEqual([])
  })

  it('drops a non-array body honestly rather than throwing on for..of', () => {
    expect(mapRenderRequestLogsToSignals(undefined as unknown as RenderLogEntry[], [])).toEqual([])
  })

  it('treats a missing/garbage statusCode as a non-error observation, not a fabricated 4xx', () => {
    const graph = newGraph()
    const routeIndex = buildRenderRouteIndex(graph, NEAT_SERVICE)
    const signals = mapRenderRequestLogsToSignals(
      [
        {
          timestamp: '2026-08-01T10:00:00.000Z',
          labels: [
            { name: 'method', value: 'GET' },
            { name: 'path', value: '/users/1' },
          ],
        } as RenderLogEntry,
      ],
      routeIndex,
    )
    expect(signals).toHaveLength(1)
    expect(signals[0].errorCount).toBe(0)
  })
})

describe('Render connector — createRenderResolveTarget (ADR-166)', () => {
  it('resolves a matched route signal to the RouteNode with a CALLS edge', () => {
    const resolveTarget = createRenderResolveTarget(config())
    const routeNodeId = routeId(NEAT_SERVICE, 'GET', '/users/:id')

    const resolved = resolveTarget(
      {
        targetKind: 'route',
        targetName: routeNodeId,
        callCount: 3,
        errorCount: 1,
        lastObservedIso: '2026-08-01T10:00:05.000Z',
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

  it('drops an unmatched-route signal honestly (null)', () => {
    const resolveTarget = createRenderResolveTarget(config())
    const resolved = resolveTarget(
      {
        targetKind: 'unmatched-route',
        targetName: 'GET /internal/healthz',
        callCount: 1,
        errorCount: 0,
        lastObservedIso: '2026-08-01T10:00:04.000Z',
      },
      baseCtx(),
    )
    expect(resolved).toBeNull()
  })
})

describe('Render connector — end-to-end poll() against fixture REST responses (docs/contracts/connectors.md §5)', () => {
  let realFetch: typeof globalThis.fetch

  beforeEach(() => {
    realFetch = globalThis.fetch
    resetJunctionRateLimiters()
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  // Single-page fixture response — hasMore false, so the pagination walk stops
  // after one request.
  function stubRenderLogs(): { capturedQuery: Record<string, string | null> } {
    const capturedQuery: Record<string, string | null> = {}
    globalThis.fetch = (async (input: string | URL) => {
      const u = new URL(String(input))
      capturedQuery.ownerId = u.searchParams.get('ownerId')
      capturedQuery.resource = u.searchParams.get('resource')
      capturedQuery.type = u.searchParams.get('type')
      capturedQuery.startTime = u.searchParams.get('startTime')
      capturedQuery.endTime = u.searchParams.get('endTime')
      capturedQuery.limit = u.searchParams.get('limit')
      return new Response(JSON.stringify({ hasMore: false, logs: requestLogsFixture }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof globalThis.fetch
    return { capturedQuery }
  }

  it('poll() fetches the request-log surface, scoped by owner + resource + type=request', async () => {
    const { capturedQuery } = stubRenderLogs()
    const graph = newGraph()
    const connector = createRenderConnector(graph, config())

    const signals = await connector.poll(baseCtx())

    expect(capturedQuery.ownerId).toBe(RENDER_OWNER_ID)
    expect(capturedQuery.resource).toBe(RENDER_RESOURCE_ID)
    expect(capturedQuery.type).toBe('request')

    const routeSignals = signals.filter((s) => s.targetKind === 'route')
    const unmatchedSignals = signals.filter((s) => s.targetKind === 'unmatched-route')
    expect(routeSignals).toHaveLength(2)
    expect(unmatchedSignals).toHaveLength(1)
  })

  it('mints file-grained OBSERVED CALLS edges through runConnectorPoll', async () => {
    stubRenderLogs()
    const graph = newGraph()
    const connector = createRenderConnector(graph, config())
    const resolveTarget = createRenderResolveTarget(config())

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)

    // 2 matched routes resolve; the unmatched-route signal drops honestly.
    expect(result.edgesCreated).toBe(2)
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
  })

  it('follows Render pagination across pages, bounded by maxPages', async () => {
    const seenStarts: (string | null)[] = []
    let call = 0
    globalThis.fetch = (async (input: string | URL) => {
      const u = new URL(String(input))
      seenStarts.push(u.searchParams.get('startTime'))
      call++
      // First page reports more with fresh cursors; second page ends the walk.
      if (call === 1) {
        return new Response(
          JSON.stringify({
            hasMore: true,
            nextStartTime: '2026-08-01T09:00:00.000Z',
            nextEndTime: '2026-08-01T09:30:00.000Z',
            logs: [requestLogsFixture[0]],
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ hasMore: false, logs: [requestLogsFixture[3]] }), {
        status: 200,
      })
    }) as typeof globalThis.fetch

    const graph = newGraph()
    const connector = createRenderConnector(graph, config({ maxPages: 5 }))
    const signals = await connector.poll(baseCtx())

    expect(call).toBe(2)
    // Page two asked from the cursor page one returned.
    expect(seenStarts[1]).toBe('2026-08-01T09:00:00.000Z')
    // Both pages' logs were mapped (a GET /users/:id and a POST /users).
    expect(signals.filter((s) => s.targetKind === 'route')).toHaveLength(2)
  })

  it('passes since through unchanged when within the lookback window', async () => {
    const { capturedQuery } = stubRenderLogs()
    const graph = newGraph()
    const connector = createRenderConnector(graph, config())
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()

    await connector.poll(baseCtx({ since }))

    expect(capturedQuery.startTime).toBe(since)
  })

  it('bounds since to maxLookbackMs when the gap is too wide, or when since is absent', async () => {
    const { capturedQuery } = stubRenderLogs()
    const graph = newGraph()
    const connector = createRenderConnector(graph, config())
    const beforeMs = Date.now()

    const staleSince = new Date(beforeMs - 7 * 24 * 60 * 60 * 1000).toISOString()
    await connector.poll(baseCtx({ since: staleSince }))
    const staleStartMs = new Date(capturedQuery.startTime as string).getTime()
    expect(staleStartMs).toBeGreaterThan(new Date(staleSince).getTime())
    expect(beforeMs - staleStartMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5000)

    await connector.poll(baseCtx({ since: undefined }))
    const absentStartMs = new Date(capturedQuery.startTime as string).getTime()
    expect(beforeMs - absentStartMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5000)
  })

  it('requires ctx.credentials.token', async () => {
    const graph = newGraph()
    const connector = createRenderConnector(graph, config())
    await expect(connector.poll(baseCtx({ credentials: {} }))).rejects.toThrow(/credentials\.token/)
  })
})

describe('Render connector — validate probes the services endpoint (connector-config.md §4)', () => {
  it('a 2xx on GET /v1/services authenticates the API key; a 401 is a rejection', async () => {
    const urls: string[] = []
    const okFetch = (async (url: string | URL) => {
      urls.push(String(url))
      return new Response(JSON.stringify([]), { status: 200 })
    }) as typeof fetch
    const ok = await PROVIDER_DISPATCH.render!.validate({
      credentials: { token: 'rnd_key' },
      options: { ownerId: RENDER_OWNER_ID, resourceId: RENDER_RESOURCE_ID, serviceName: NEAT_SERVICE },
      fetchImpl: okFetch,
    })
    expect(ok).toEqual({ ok: true })
    expect(urls[0]).toContain('/services')

    const badFetch = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch
    const bad = await PROVIDER_DISPATCH.render!.validate({
      credentials: { token: 'wrong' },
      options: { ownerId: RENDER_OWNER_ID, resourceId: RENDER_RESOURCE_ID, serviceName: NEAT_SERVICE },
      fetchImpl: badFetch,
    })
    expect(bad.ok).toBe(false)
  })
})
