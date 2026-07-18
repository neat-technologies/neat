import { describe, it, expect, vi } from 'vitest'
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
import { computeDivergences } from '../src/divergences.js'
import {
  CloudflareConnector,
  createCloudflareResolveTarget,
  mapEventToSignal,
  parseHttpMethodFromTrigger,
  parsePathFromTrigger,
  queryWorkerInvocations,
  type CloudflareConnectorConfig,
  type CloudflareObservedSignal,
  type CloudflareTelemetryEvent,
  type CloudflareTelemetryQueryResponse,
} from '../src/connectors/cloudflare/index.js'

const SERVICE = 'orders-worker'
const ENTRY_FILE = 'src/index.ts'

// Fixture shape confirmed against Cloudflare's live API reference —
// developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/
// (fetched 2026-07-03) — not invented. Three invocation records under the
// `view: 'events'` response shape: an ok GET, a failing POST, and a queue
// message (no HTTP trigger — out of scope per docs/connectors/cloudflare.md
// §Out of scope, and must be dropped rather than mapped).
const TELEMETRY_RESPONSE: CloudflareTelemetryQueryResponse = {
  success: true,
  messages: [{ message: 'Successful request' }],
  result: {
    events: {
      count: 3,
      events: [
        {
          timestamp: 1751566800000,
          dataset: 'cloudflare-workers',
          $metadata: {
            service: SERVICE,
            trigger: 'GET /users',
            url: 'https://orders-worker.example.workers.dev/users',
            statusCode: 200,
            duration: 12.4,
            traceDuration: 14.1,
          },
          $workers: {
            eventType: 'fetch',
            scriptName: SERVICE,
            outcome: 'ok',
          },
        },
        {
          timestamp: 1751566801000,
          dataset: 'cloudflare-workers',
          $metadata: {
            service: SERVICE,
            trigger: 'POST /orders',
            url: 'https://orders-worker.example.workers.dev/orders',
            statusCode: 500,
            duration: 340.2,
          },
          $workers: {
            eventType: 'fetch',
            scriptName: SERVICE,
            outcome: 'exception',
          },
        },
        {
          timestamp: 1751566802000,
          dataset: 'cloudflare-workers',
          $metadata: {
            service: SERVICE,
            trigger: 'queue message',
          },
          $workers: {
            eventType: 'queue',
            scriptName: SERVICE,
          },
        },
      ] satisfies CloudflareTelemetryEvent[],
    },
  },
}

function newGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  const service: ServiceNode = {
    id: serviceId(SERVICE),
    type: NodeType.ServiceNode,
    name: SERVICE,
    language: 'typescript',
  }
  g.addNode(service.id, service)

  // EXTRACTED FileNode a static extractor already minted for the Worker's
  // entry file — the file containing `export default { fetch }`.
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

function baseCtx(): ConnectorContext {
  return { projectDir: '/repo/orders-worker', credentials: { apiToken: 'test-token' } }
}

function baseConfig(): CloudflareConnectorConfig {
  return {
    accountId: 'acct-123',
    workers: {
      [SERVICE]: { service: SERVICE, entryFile: ENTRY_FILE },
    },
  }
}

describe('parseHttpMethodFromTrigger', () => {
  it('parses the leading HTTP method token off an HTTP-shaped trigger', () => {
    expect(parseHttpMethodFromTrigger('GET /users')).toBe('GET')
    expect(parseHttpMethodFromTrigger('post /orders')).toBe('POST')
  })

  it('returns null for a non-HTTP trigger (queue, cron, ...)', () => {
    expect(parseHttpMethodFromTrigger('queue message')).toBeNull()
    expect(parseHttpMethodFromTrigger(undefined)).toBeNull()
  })
})

describe('parsePathFromTrigger (ADR-133 §5)', () => {
  it('returns everything after the leading method token', () => {
    expect(parsePathFromTrigger('GET /users')).toBe('/users')
    expect(parsePathFromTrigger('POST /orders/123')).toBe('/orders/123')
  })

  it('returns undefined when the trigger carries no path at all', () => {
    expect(parsePathFromTrigger('GET')).toBeUndefined()
  })
})

describe('mapEventToSignal (docs/connectors/cloudflare.md §Fusion)', () => {
  it('maps an ok HTTP invocation to a whole-file-grain signal with the method parsed out of trigger', () => {
    const signal = mapEventToSignal(TELEMETRY_RESPONSE.result!.events!.events[0])

    expect(signal).not.toBeNull()
    expect(signal!.targetName).toBe(SERVICE)
    expect(signal!.method).toBe('GET')
    expect(signal!.statusCode).toBe(200)
    expect(signal!.duration).toBe(12.4)
    expect(signal!.callCount).toBe(1)
    expect(signal!.errorCount).toBe(0)
    expect(signal!.lastObservedIso).toBe(new Date(1751566800000).toISOString())
    // The path rides along too (ADR-133 §5) — parsed, not matched, here;
    // matching against a Worker's own RouteNodes is
    // createCloudflareResolveTarget's job (connector.ts), not the mapper's.
    expect(signal!.path).toBe('/users')
    expect(signal).not.toHaveProperty('route')
  })

  it('maps a failing (5xx) HTTP invocation with errorCount 1', () => {
    const signal = mapEventToSignal(TELEMETRY_RESPONSE.result!.events!.events[1])

    expect(signal).not.toBeNull()
    expect(signal!.method).toBe('POST')
    expect(signal!.statusCode).toBe(500)
    expect(signal!.errorCount).toBe(1)
  })

  it('drops a non-HTTP-triggered invocation (queue message) honestly, never fabricating a method', () => {
    const signal = mapEventToSignal(TELEMETRY_RESPONSE.result!.events!.events[2])
    expect(signal).toBeNull()
  })

  it('drops an event naming no script at all', () => {
    const signal = mapEventToSignal({
      timestamp: 1751566800000,
      $metadata: { trigger: 'GET /users', statusCode: 200 },
    })
    expect(signal).toBeNull()
  })
})

describe('queryWorkerInvocations', () => {
  it('sends a bearer-token-authed query and returns the response events', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string)
      expect(body.timeframe).toEqual({ from: 1000, to: 2000 })
      expect(body.view).toBe('events')
      const headers = init!.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer test-token')
      return new Response(JSON.stringify(TELEMETRY_RESPONSE), { status: 200 })
    })

    const events = await queryWorkerInvocations(
      baseCtx(),
      baseConfig(),
      { fromMs: 1000, toMs: 2000 },
      fetchImpl as unknown as typeof fetch,
    )

    expect(events).toHaveLength(3)
    const [url] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-123/workers/observability/telemetry/query',
    )
  })

  it('throws when the response reports success: false', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: false, errors: [{ message: 'bad token' }] }),
          { status: 200 },
        ),
    )

    await expect(
      queryWorkerInvocations(
        baseCtx(),
        baseConfig(),
        { fromMs: 1000, toMs: 2000 },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/bad token/)
  })

  it('warns on shape drift — success:true with no result.events.events array, instead of silently returning []', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const events = await queryWorkerInvocations(
        baseCtx(),
        baseConfig(),
        { fromMs: 1000, toMs: 2000 },
        fetchImpl as unknown as typeof fetch,
      )
      expect(events).toEqual([])
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]?.[0]).toContain('response shape may have changed')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('does not warn when result.events.events is legitimately an empty array (no events this window)', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, result: { events: { count: 0, events: [] } } }), {
          status: 200,
        }),
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const events = await queryWorkerInvocations(
        baseCtx(),
        baseConfig(),
        { fromMs: 1000, toMs: 2000 },
        fetchImpl as unknown as typeof fetch,
      )
      expect(events).toEqual([])
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('createCloudflareResolveTarget (ADR-133 resolution order)', () => {
  it('1. resolves via the explicit config.workers override', () => {
    const resolveTarget = createCloudflareResolveTarget(baseConfig(), newGraph())
    const signal = mapEventToSignal(TELEMETRY_RESPONSE.result!.events!.events[0])!
    const resolved = resolveTarget(signal, baseCtx())

    expect(resolved).toEqual({
      targetNodeId: fileId(SERVICE, ENTRY_FILE),
      serviceName: SERVICE,
      edgeType: EdgeType.CALLS,
    })
  })

  it('2. resolves via the extracted graph platform tag when no override is configured', () => {
    const graph = newGraph()
    const taggedService = 'tagged-orders-worker'
    const taggedEntry = 'src/entry.ts'
    const taggedFileId = fileId(taggedService, taggedEntry)
    const fileNode: FileNode = {
      id: taggedFileId,
      type: NodeType.FileNode,
      service: taggedService,
      path: taggedEntry,
      platform: 'cloudflare',
      platformName: 'tagged-script',
    }
    graph.addNode(taggedFileId, fileNode)

    const resolveTarget = createCloudflareResolveTarget({ accountId: 'acct-123' }, graph)
    const resolved = resolveTarget(
      {
        targetKind: 'cloudflare-worker-invocation',
        targetName: 'tagged-script',
        callCount: 1,
        errorCount: 0,
        lastObservedIso: new Date().toISOString(),
      },
      baseCtx(),
    )

    expect(resolved).toEqual({
      targetNodeId: taggedFileId,
      serviceName: taggedService,
      edgeType: EdgeType.CALLS,
    })
  })

  it('override wins even when the graph also carries a tagged match for the same script', () => {
    const graph = newGraph()
    // Tag a *different* FileNode under the same script name the config also maps.
    const taggedFileId = fileId('other-service', 'src/other.ts')
    graph.addNode(taggedFileId, {
      id: taggedFileId,
      type: NodeType.FileNode,
      service: 'other-service',
      path: 'src/other.ts',
      platform: 'cloudflare',
      platformName: SERVICE,
    } satisfies FileNode)

    const resolveTarget = createCloudflareResolveTarget(baseConfig(), graph)
    const signal = mapEventToSignal(TELEMETRY_RESPONSE.result!.events!.events[0])!
    const resolved = resolveTarget(signal, baseCtx())

    expect(resolved?.targetNodeId).toBe(fileId(SERVICE, ENTRY_FILE))
  })

  it('3. honest fallback: a script with neither an override nor a tagged match declares ensureInfraNode instead of dropping silently', () => {
    const resolveTarget = createCloudflareResolveTarget(baseConfig(), newGraph())
    const resolved = resolveTarget(
      {
        targetKind: 'cloudflare-worker-invocation',
        targetName: 'some-other-worker',
        callCount: 1,
        errorCount: 0,
        lastObservedIso: new Date().toISOString(),
      },
      baseCtx(),
    )

    expect(resolved).not.toBeNull()
    expect(resolved).toEqual({
      targetNodeId: 'infra:cloudflare-worker:some-other-worker',
      serviceName: 'some-other-worker',
      edgeType: EdgeType.CALLS,
      ensureInfraNode: { kind: 'cloudflare-worker', name: 'some-other-worker', provider: 'cloudflare' },
    })
  })

  it('returns null outright for a signal of the wrong targetKind', () => {
    const resolveTarget = createCloudflareResolveTarget(baseConfig(), newGraph())
    const resolved = resolveTarget(
      {
        targetKind: 'some-other-provider-kind',
        targetName: SERVICE,
        callCount: 1,
        errorCount: 0,
        lastObservedIso: new Date().toISOString(),
      },
      baseCtx(),
    )
    expect(resolved).toBeNull()
  })

  it('4. sharpens to route grain when the signal (method, path) matches a RouteNode owned by the resolved service (ADR-133 §5)', () => {
    const graph = newGraph()
    const route = routeId(SERVICE, 'GET', '/users/:id')
    graph.addNode(route, {
      id: route,
      type: NodeType.RouteNode,
      name: 'GET /users/:id',
      service: SERVICE,
      method: 'GET',
      pathTemplate: '/users/:id',
      path: ENTRY_FILE,
      framework: 'hono',
    } satisfies RouteNode)

    // Resolved via the config.workers override (baseConfig()) — route-grain
    // sharpening applies the same way regardless of which branch resolved
    // the whole-file target first.
    const resolveTarget = createCloudflareResolveTarget(baseConfig(), graph)
    const resolved = resolveTarget(
      {
        targetKind: 'cloudflare-worker-invocation',
        targetName: SERVICE,
        callCount: 1,
        errorCount: 0,
        lastObservedIso: new Date().toISOString(),
        method: 'GET',
        path: '/users/123',
      } satisfies CloudflareObservedSignal,
      baseCtx(),
    )

    expect(resolved).toEqual({ targetNodeId: route, serviceName: SERVICE, edgeType: EdgeType.CALLS })
  })

  it('falls back to the whole-file target when no RouteNode matches (method or path differ)', () => {
    const graph = newGraph()
    const route = routeId(SERVICE, 'POST', '/users')
    graph.addNode(route, {
      id: route,
      type: NodeType.RouteNode,
      name: 'POST /users',
      service: SERVICE,
      method: 'POST',
      pathTemplate: '/users',
      path: ENTRY_FILE,
      framework: 'hono',
    } satisfies RouteNode)

    const resolveTarget = createCloudflareResolveTarget(baseConfig(), graph)
    const resolved = resolveTarget(
      {
        targetKind: 'cloudflare-worker-invocation',
        targetName: SERVICE,
        callCount: 1,
        errorCount: 0,
        lastObservedIso: new Date().toISOString(),
        method: 'GET',
        path: '/users/123',
      } satisfies CloudflareObservedSignal,
      baseCtx(),
    )

    expect(resolved).toEqual({
      targetNodeId: fileId(SERVICE, ENTRY_FILE),
      serviceName: SERVICE,
      edgeType: EdgeType.CALLS,
    })
  })

  it('falls back to the whole-file target when the signal carries no path at all', () => {
    const graph = newGraph()
    graph.addNode(routeId(SERVICE, 'GET', '/users/:id'), {
      id: routeId(SERVICE, 'GET', '/users/:id'),
      type: NodeType.RouteNode,
      name: 'GET /users/:id',
      service: SERVICE,
      method: 'GET',
      pathTemplate: '/users/:id',
      path: ENTRY_FILE,
      framework: 'hono',
    } satisfies RouteNode)

    const resolveTarget = createCloudflareResolveTarget(baseConfig(), graph)
    const resolved = resolveTarget(
      {
        targetKind: 'cloudflare-worker-invocation',
        targetName: SERVICE,
        callCount: 1,
        errorCount: 0,
        lastObservedIso: new Date().toISOString(),
        method: 'GET',
      } satisfies CloudflareObservedSignal,
      baseCtx(),
    )

    expect(resolved?.targetNodeId).toBe(fileId(SERVICE, ENTRY_FILE))
  })
})

describe('CloudflareConnector end-to-end via runConnectorPoll', () => {
  it('mints one whole-file OBSERVED CALLS edge from two HTTP invocations, dropping the queue message', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(TELEMETRY_RESPONSE), { status: 200 }))
    const config = baseConfig()
    const connector = new CloudflareConnector(config)
    // Inject the fake fetch the same way queryWorkerInvocations exposes it —
    // poll() itself doesn't take a fetchImpl, so exercise the connector via
    // its own poll() by stubbing the global fetch for this call only.
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchImpl as unknown as typeof fetch
    try {
      const graph = newGraph()
      const resolveTarget = createCloudflareResolveTarget(config, graph)
      const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)

      // 3 raw events in, 1 dropped (queue message) — 2 HTTP signals reach the
      // pipeline; both resolve to the same whole-file target so one edge is
      // created and the second call updates it rather than minting a twin.
      expect(result).toEqual({
        signalCount: 2,
        edgesCreated: 1,
        edgesUpdated: 1,
        unresolved: 0,
      })

      const serviceNodeId = serviceId(SERVICE)
      const entryFileId = fileId(SERVICE, ENTRY_FILE)
      const edgeId = observedEdgeId(serviceNodeId, entryFileId, EdgeType.CALLS)
      expect(graph.hasEdge(edgeId)).toBe(true)

      const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
      expect(edge.provenance).toBe(Provenance.OBSERVED)
      // Direction: the service (not an unknown external caller) is the
      // source, the Worker's own entry FileNode is the target — the same
      // "serving service → its own child node" shape the WebSocket channel
      // connector-adjacent precedent uses (ADR-125), reusing CALLS the way
      // that precedent reuses CONNECTS_TO.
      expect(edge.source).toBe(serviceNodeId)
      expect(edge.target).toBe(entryFileId)
      // No callSite on either signal, so no file-grain fusion evidence — the
      // edge lands directly on the pre-resolved whole-file target.
      expect(edge.evidence).toBeUndefined()
      // 2 invocations replayed (GET 200 + POST 500) — one error.
      expect(edge.signal?.spanCount).toBe(2)
      expect(edge.signal?.errorCount).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('file-grains onto each route\'s own definition site once the Worker\'s routes are recognized (ADR-143)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(TELEMETRY_RESPONSE), { status: 200 }))
    const config = baseConfig()
    const connector = new CloudflareConnector(config)
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchImpl as unknown as typeof fetch
    try {
      const graph = newGraph()
      // Two RouteNodes a static router recognizer (Hono, ADR-133 §5) minted for
      // this Worker. Each records its own definition site — `path` (the entry
      // file it was parsed from) and `line`. The fixture's two HTTP invocations
      // (GET /users, POST /orders) match these routes, so the resolver sharpens
      // each target to its RouteNode.
      const getRoute = routeId(SERVICE, 'GET', '/users')
      graph.addNode(getRoute, {
        id: getRoute,
        type: NodeType.RouteNode,
        name: 'GET /users',
        service: SERVICE,
        method: 'GET',
        pathTemplate: '/users',
        path: ENTRY_FILE,
        line: 12,
        framework: 'hono',
      } satisfies RouteNode)
      const postRoute = routeId(SERVICE, 'POST', '/orders')
      graph.addNode(postRoute, {
        id: postRoute,
        type: NodeType.RouteNode,
        name: 'POST /orders',
        service: SERVICE,
        method: 'POST',
        pathTemplate: '/orders',
        path: ENTRY_FILE,
        line: 20,
        framework: 'hono',
      } satisfies RouteNode)

      const resolveTarget = createCloudflareResolveTarget(config, graph)
      const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)

      // Each invocation resolves to its own route target — two distinct edges,
      // neither an update of the other.
      expect(result).toEqual({ signalCount: 2, edgesCreated: 2, edgesUpdated: 0, unresolved: 0 })

      // The GET edge originates from the route's own source file (the entry
      // file), NOT the coarse service node — the connector carried no callSite,
      // yet the observation file-grains off the route's recorded definition
      // site. This is the whole point of ADR-143.
      const fileSource = fileId(SERVICE, ENTRY_FILE)
      const getEdgeId = observedEdgeId(fileSource, getRoute, EdgeType.CALLS)
      expect(graph.hasEdge(getEdgeId)).toBe(true)
      const getEdge = graph.getEdgeAttributes(getEdgeId) as GraphEdge
      expect(getEdge.provenance).toBe(Provenance.OBSERVED)
      expect(getEdge.source).toBe(fileSource)
      expect(getEdge.target).toBe(getRoute)
      // grain: 'file' (ADR-142), evidence carried straight off the route's own
      // path/line — the site routes.ts parsed the route from.
      expect(getEdge.grain).toBe('file')
      expect(getEdge.evidence?.file).toBe(ENTRY_FILE)
      expect(getEdge.evidence?.line).toBe(12)

      // The POST edge likewise file-grains, at its own route's line, and still
      // carries the 500 as an error in its signal block.
      const postEdgeId = observedEdgeId(fileSource, postRoute, EdgeType.CALLS)
      expect(graph.hasEdge(postEdgeId)).toBe(true)
      const postEdge = graph.getEdgeAttributes(postEdgeId) as GraphEdge
      expect(postEdge.grain).toBe('file')
      expect(postEdge.evidence?.line).toBe(20)
      expect(postEdge.signal?.errorCount).toBe(1)

      // And no coarse service→file edge was minted alongside — the file-grain
      // path replaced the service-coarse fallback, it didn't double up.
      const coarseId = observedEdgeId(serviceId(SERVICE), fileId(SERVICE, ENTRY_FILE), EdgeType.CALLS)
      expect(graph.hasEdge(coarseId)).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('honest fallback surfaces as a missing-extracted divergence (ADR-133 §3)', () => {
  it('an observed-but-undeclared Worker lands a real edge, not a silent drop, and get_divergences reports it', async () => {
    // An empty graph — this scan never declared "undeclared-worker" anywhere.
    const graph: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    const config: CloudflareConnectorConfig = { accountId: 'acct-123' }
    const connector = new CloudflareConnector(config)
    const resolveTarget = createCloudflareResolveTarget(config, graph)

    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: {
            events: {
              count: 1,
              events: [
                {
                  timestamp: 1751566800000,
                  $metadata: { service: 'undeclared-worker', trigger: 'GET /', statusCode: 200 },
                  $workers: { scriptName: 'undeclared-worker', outcome: 'ok' },
                },
              ],
            },
          },
        } satisfies CloudflareTelemetryQueryResponse),
        { status: 200 },
      ),
    )
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchImpl as unknown as typeof fetch
    try {
      const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)
      expect(result.unresolved).toBe(0)
      expect(result.edgesCreated).toBe(1)

      const infraId = 'infra:cloudflare-worker:undeclared-worker'
      expect(graph.hasNode(infraId)).toBe(true)
      const serviceNodeId = serviceId('undeclared-worker')
      expect(graph.hasNode(serviceNodeId)).toBe(true)
      const edgeId = observedEdgeId(serviceNodeId, infraId, EdgeType.CALLS)
      expect(graph.hasEdge(edgeId)).toBe(true)

      // No EXTRACTED twin exists on this (source, target, type) triple — the
      // exact shape `missing-extracted` detects.
      const { divergences } = computeDivergences(graph)
      const found = divergences.find(
        (d) => d.type === 'missing-extracted' && d.source === serviceNodeId && d.target === infraId,
      )
      expect(found).toBeDefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
