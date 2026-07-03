import { describe, it, expect, vi } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  fileId,
  observedEdgeId,
  serviceId,
  type FileNode,
  type GraphEdge,
  type GraphNode,
  type ServiceNode,
} from '@neat.is/types'
import { runConnectorPoll, type ConnectorContext } from '../src/connectors/index.js'
import type { NeatGraph } from '../src/graph.js'
import {
  CloudflareConnector,
  createCloudflareResolveTarget,
  mapEventToSignal,
  parseHttpMethodFromTrigger,
  queryWorkerInvocations,
  type CloudflareConnectorConfig,
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
    // No route-matching attempt: the signal carries no path/route field at
    // all, only the parsed method — confirms the mapper never touches the
    // remainder of `trigger` beyond the leading method token.
    expect(signal).not.toHaveProperty('route')
    expect(signal).not.toHaveProperty('path')
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
})

describe('createCloudflareResolveTarget', () => {
  it('resolves a mapped script to the Worker entry FileNode, service-sourced', () => {
    const resolveTarget = createCloudflareResolveTarget(baseConfig())
    const signal = mapEventToSignal(TELEMETRY_RESPONSE.result!.events!.events[0])!
    const resolved = resolveTarget(signal, baseCtx())

    expect(resolved).toEqual({
      targetNodeId: fileId(SERVICE, ENTRY_FILE),
      serviceName: SERVICE,
      edgeType: EdgeType.CALLS,
    })
  })

  it('returns null for a script with no configured mapping — honest miss, never guessed', () => {
    const resolveTarget = createCloudflareResolveTarget(baseConfig())
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
    expect(resolved).toBeNull()
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
      const resolveTarget = createCloudflareResolveTarget(config)
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
})
