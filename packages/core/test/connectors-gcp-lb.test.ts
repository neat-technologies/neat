import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  fileId,
  infraId,
  observedEdgeId,
  routeId,
  serviceId,
  type GraphEdge,
  type GraphNode,
  type RouteNode,
  type ServiceNode,
} from '@neat.is/types'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { runConnectorPoll, type ConnectorContext } from '../src/connectors/index.js'
import {
  GcpLbConnector,
  createGcpLbConnector,
  boundedSinceIso,
  buildGcpLbEntriesFilter,
  gcpLbRequestLogName,
  mapLogEntriesToSignals,
  packGcpLbTargetName,
  parseGcpLbTargetName,
} from '../src/connectors/gcp-lb/index.js'
import type { EntriesListResponse, LogEntry } from '../src/connectors/gcp-lb/client.js'
import type { GcpLbConnectorConfig } from '../src/connectors/gcp-lb/types.js'
import type { NeatGraph } from '../src/graph.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Fixture shape confirmed live against Google's own Cloud Logging + load-balancing
// docs during this connector's build (ADR-218 §Context), the same real-shape
// static fixture Cloud Run's and Firebase's connector tests use:
//   - request/response envelope: https://cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list
//   - LogEntry + HttpRequest field names: https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry
//   - http_load_balancer labels: https://cloud.google.com/logging/docs/api/v2/resource-list
//   - the ".../logs/requests" log name + http_load_balancer resource type:
//     https://cloud.google.com/load-balancing/docs/https/https-logging-monitoring
const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/gcp-lb/entries-list-response.json')
const FIXTURE: EntriesListResponse = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))

const ORDERS_SERVICE = 'orders-api-svc'

// GCP backend_service_name -> NEAT manifest service name (docs/connectors/gcp-lb.md
// §Fusion — "resolved once, never guessed"). `payments-backend` (fixture entry 3)
// is deliberately absent — it exercises the tier-2 fallback sourcing the edge from
// the LB backend service's own name.
const BACKEND_MAP: Record<string, string> = { 'orders-api-backend': ORDERS_SERVICE }

function config(): GcpLbConnectorConfig {
  return { backendServiceMap: BACKEND_MAP }
}

function newGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })

  const ordersService: ServiceNode = {
    id: serviceId(ORDERS_SERVICE),
    type: NodeType.ServiceNode,
    name: ORDERS_SERVICE,
    language: 'typescript',
  }
  g.addNode(ordersService.id, ordersService)

  // A statically-extracted Express route (routes.ts) — GET /orders/:id — the one
  // the LB request-log entry for GET /orders/42 should resolve onto once its
  // concrete path normalises against this template.
  const ordersRoute: RouteNode = {
    id: routeId(ORDERS_SERVICE, 'GET', '/orders/:id'),
    type: NodeType.RouteNode,
    name: 'GET /orders/:id',
    service: ORDERS_SERVICE,
    method: 'GET',
    pathTemplate: '/orders/:id',
    path: 'src/index.ts',
    line: 12,
    framework: 'express',
    discoveredVia: 'static',
  }
  g.addNode(ordersRoute.id, ordersRoute)

  return g
}

function baseCtx(): ConnectorContext {
  return { projectDir: '/repo/orders-api', credentials: { projectId: 'neat-demo', accessToken: 'test-token' } }
}

function stubFetch(body: EntriesListResponse): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', json: async () => body }),
  )
}

describe('GCP LB connector — the entries.list filter (ADR-218, verified live against GCP docs)', () => {
  it('pins the LB request log name (plain `requests`, no %2F), the resource type, and the watermark', () => {
    expect(gcpLbRequestLogName('neat-demo')).toBe('projects/neat-demo/logs/requests')
    const filter = buildGcpLbEntriesFilter('neat-demo', '2026-08-19T10:00:00Z')
    expect(filter).toContain('logName = "projects/neat-demo/logs/requests"')
    expect(filter).toContain('resource.type = "http_load_balancer"')
    expect(filter).toContain('httpRequest.requestMethod != ""')
    expect(filter).toContain('timestamp >= "2026-08-19T10:00:00Z"')
  })
})

describe('GCP LB connector — mapping (docs/connectors/gcp-lb.md, ADR-218)', () => {
  it('maps each LB request-log entry to one ObservedSignal, dropping the no-backend and non-LB resources', () => {
    const signals = mapLogEntriesToSignals(FIXTURE.entries ?? [])
    // Three http_load_balancer entries with a backend_service_name map; the
    // no-backend 502 (LB-synthesized) and the cloud_run_revision entry drop.
    expect(signals).toHaveLength(3)

    const [ordersGet, webhookPost, health] = signals

    // A full absolute requestUrl (fixture entry 1) reduces to its path.
    expect(ordersGet).toMatchObject({
      targetKind: 'http_load_balancer',
      callCount: 1,
      errorCount: 0,
      lastObservedIso: '2026-08-19T10:00:00.100000Z',
    })
    expect(parseGcpLbTargetName(ordersGet!.targetName)).toEqual({
      backendServiceName: 'orders-api-backend',
      method: 'GET',
      path: '/orders/42',
    })

    // 500 -> counted as an error (the 5xx threshold ingest.ts draws for a failing
    // response). Also a full absolute URL reduced to its path.
    expect(webhookPost).toMatchObject({ targetKind: 'http_load_balancer', callCount: 1, errorCount: 1 })
    expect(parseGcpLbTargetName(webhookPost!.targetName)).toEqual({
      backendServiceName: 'orders-api-backend',
      method: 'POST',
      path: '/webhooks/stripe',
    })

    // A requestUrl that is already a bare path ("/health") maps unchanged.
    expect(parseGcpLbTargetName(health!.targetName)).toEqual({
      backendServiceName: 'payments-backend',
      method: 'GET',
      path: '/health',
    })
  })

  it('packs and parses a target identity round-trip, including a path that could carry the separator', () => {
    const packed = packGcpLbTargetName({ backendServiceName: 'svc', method: 'GET', path: '/a b/c' })
    expect(parseGcpLbTargetName(packed)).toEqual({ backendServiceName: 'svc', method: 'GET', path: '/a b/c' })
  })

  it('drops an entry with no httpRequest, a non-LB resource, or no backend_service_name label', () => {
    const signals = mapLogEntriesToSignals([
      { resource: { type: 'http_load_balancer', labels: { backend_service_name: 'x' } } }, // no httpRequest
      { resource: { type: 'gce_instance', labels: {} }, httpRequest: { requestMethod: 'GET', requestUrl: '/x' }, timestamp: 't' },
      { resource: { type: 'http_load_balancer', labels: {} }, httpRequest: { requestMethod: 'GET', requestUrl: '/x' }, timestamp: 't' }, // no backend
    ])
    expect(signals).toEqual([])
  })

  it('drops null / empty / drift entries honestly rather than throwing (connectors.md §4)', () => {
    expect(mapLogEntriesToSignals([null as unknown as LogEntry])).toEqual([])
    expect(mapLogEntriesToSignals([{} as LogEntry])).toEqual([])
    const base = {
      resource: { type: 'http_load_balancer', labels: { backend_service_name: 'b' } },
      timestamp: '2026-08-19T10:00:00.000Z',
    }
    expect(
      mapLogEntriesToSignals([
        { ...base, httpRequest: { requestMethod: 123 as unknown as string, requestUrl: '/x' } } as LogEntry,
      ]),
    ).toEqual([])
    expect(
      mapLogEntriesToSignals([
        { ...base, httpRequest: { requestMethod: 'GET', requestUrl: 123 as unknown as string } } as LogEntry,
      ]),
    ).toEqual([])
  })
})

describe('GCP LB connector — target resolution and full pull/map/fuse (docs/contracts/connectors.md)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('tier 1: resolves a request to the matching RouteNode, minting a file-precise OBSERVED CALLS edge', async () => {
    const graph = newGraph()
    const { connector, resolveTarget } = createGcpLbConnector(graph, config())
    stubFetch({ entries: [FIXTURE.entries![0]] })

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)
    expect(result).toEqual({ signalCount: 1, edgesCreated: 1, edgesUpdated: 0, unresolved: 0 })

    const routeNodeId = routeId(ORDERS_SERVICE, 'GET', '/orders/:id')
    // File-precise (ADR-143): the connector carries no callSite of its own, but the
    // RouteNode records its definition site (src/index.ts, line 12), so the OBSERVED
    // edge originates from that file — not the coarse service node.
    const fileSource = fileId(ORDERS_SERVICE, 'src/index.ts')
    const edgeId = observedEdgeId(fileSource, routeNodeId, EdgeType.CALLS)
    expect(graph.hasEdge(edgeId)).toBe(true)
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    expect(edge.source).toBe(fileSource)
    expect(edge.target).toBe(routeNodeId)
    expect(edge.grain).toBe('file')
    expect(edge.evidence?.file).toBe('src/index.ts')
    expect(edge.evidence?.line).toBe(12)
  })

  it('tier 2: a mapped backend with no matching route lands an honest gcp-lb-backend InfraNode edge (missing-extracted divergence)', async () => {
    const graph = newGraph()
    const { connector, resolveTarget } = createGcpLbConnector(graph, config())
    stubFetch({ entries: [FIXTURE.entries![1]] }) // POST /webhooks/stripe — no RouteNode for it

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)
    expect(result).toEqual({ signalCount: 1, edgesCreated: 1, edgesUpdated: 0, unresolved: 0 })

    // The fallback InfraNode the shared pipeline created (ensureInfraNode, §4a).
    const infraNodeId = infraId('gcp-lb-backend', 'orders-api-backend')
    expect(graph.hasNode(infraNodeId)).toBe(true)
    const infra = graph.getNodeAttributes(infraNodeId) as { type: string; provider?: string }
    expect(infra.type).toBe(NodeType.InfraNode)
    expect(infra.provider).toBe('gcp-lb')

    // Backend-grained OBSERVED edge: source is the mapped NEAT service, target the
    // LB backend's own InfraNode — never a self-loop, never a route.
    const edgeId = observedEdgeId(serviceId(ORDERS_SERVICE), infraNodeId, EdgeType.CALLS)
    expect(graph.hasEdge(edgeId)).toBe(true)
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    // The 500 was carried through as an error on the observed edge.
    expect(edge.signal?.errorCount).toBeGreaterThanOrEqual(1)
  })

  it('tier 2: an unmapped backend sources the fallback edge from the LB backend name itself', async () => {
    const graph = newGraph()
    const { connector, resolveTarget } = createGcpLbConnector(graph, config())
    stubFetch({ entries: [FIXTURE.entries![2]] }) // GET /health on payments-backend, absent from BACKEND_MAP

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)
    expect(result).toEqual({ signalCount: 1, edgesCreated: 1, edgesUpdated: 0, unresolved: 0 })

    const infraNodeId = infraId('gcp-lb-backend', 'payments-backend')
    const sourceId = serviceId('payments-backend') // auto-created by the shared pipeline
    expect(graph.hasNode(infraNodeId)).toBe(true)
    expect(graph.hasNode(sourceId)).toBe(true)
    expect(graph.hasEdge(observedEdgeId(sourceId, infraNodeId, EdgeType.CALLS))).toBe(true)
  })

  it('one poll over the whole fixture: 1 route-grain + 2 backend-grain edges, no misses; no-backend + cloud_run entries dropped', async () => {
    const graph = newGraph()
    const { connector, resolveTarget } = createGcpLbConnector(graph, config())
    stubFetch(FIXTURE)

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)
    expect(result).toEqual({ signalCount: 3, edgesCreated: 3, edgesUpdated: 0, unresolved: 0 })
  })
})

describe('GCP LB connector — two-sided fusion (the extractor-built RouteNode is the observed target)', () => {
  beforeEach(() => resetGraph())
  afterEach(() => vi.unstubAllGlobals())

  it('an LB request log for GET /items/42 fuses onto the RouteNode the FastAPI extractor built', async () => {
    // EXTRACTED side: run the real route extractor over a real fixture. `fastapi-server`
    // declares `@items.get("/{item_id}")` under `APIRouter(prefix="/items")`.
    const graph = getGraph()
    await extractFromDirectory(graph, path.resolve(__dirname, 'fixtures', 'routes'))
    const rid = routeId('fastapi-server', 'GET', '/items/{item_id}')
    expect(graph.hasNode(rid)).toBe(true)

    // OBSERVED side: an LB request-log entry for the concrete path GET /items/42 on a
    // backend mapped to `fastapi-server`. The concrete path and the declared template
    // collapse to the same normalized key, so the connector's edge lands on the
    // extractor-built RouteNode — one node id, both provenances — never an LB twin.
    const { connector, resolveTarget } = createGcpLbConnector(graph, {
      backendServiceMap: { 'items-backend': 'fastapi-server' },
    })
    stubFetch({
      entries: [
        {
          logName: 'projects/neat-demo/logs/requests',
          resource: {
            type: 'http_load_balancer',
            labels: { project_id: 'neat-demo', backend_service_name: 'items-backend', url_map_name: 'items-url-map' },
          },
          timestamp: '2026-08-19T11:00:00.000000Z',
          httpRequest: { requestMethod: 'GET', requestUrl: 'https://shop.example.com/items/42', status: 200 },
        },
      ],
    })

    const ctx: ConnectorContext = {
      projectDir: path.resolve(__dirname, 'fixtures', 'routes'),
      credentials: { projectId: 'neat-demo', accessToken: 'test-token' },
    }
    const result = await runConnectorPoll(connector, ctx, graph, resolveTarget)
    expect(result).toEqual({ signalCount: 1, edgesCreated: 1, edgesUpdated: 0, unresolved: 0 })

    // The observed edge targets the extractor-built RouteNode id, and it is OBSERVED —
    // the fusion the connectors plane exists to produce.
    const observedInto = graph
      .inboundEdges(rid)
      .map((e) => graph.getEdgeAttributes(e) as GraphEdge)
      .filter((e) => e.provenance === Provenance.OBSERVED && e.type === EdgeType.CALLS)
    expect(observedInto.length).toBe(1)
    expect(observedInto[0]!.target).toBe(rid)
  })
})

describe('GCP LB connector credentials (docs/contracts/connectors.md §6)', () => {
  it('throws honestly rather than polling with missing credentials', async () => {
    const connector = new GcpLbConnector()
    await expect(connector.poll({ projectDir: '/repo', credentials: {} })).rejects.toThrow(/projectId/)
    await expect(
      connector.poll({ projectDir: '/repo', credentials: { projectId: 'p' } }),
    ).rejects.toThrow(/accessToken/)
  })
})

describe('GCP LB connector — watermark backfill bound (connectors.md "Poll cadence and backfill")', () => {
  const now = new Date('2026-08-19T12:00:00.000Z')
  const dayMs = 24 * 60 * 60 * 1000

  it('floors a first poll (no since) and a too-old since at now - maxLookbackMs, and honors a recent since', () => {
    expect(boundedSinceIso(undefined, now, dayMs)).toBe(new Date(now.getTime() - dayMs).toISOString())
    expect(boundedSinceIso('2026-07-01T00:00:00.000Z', now, dayMs)).toBe(
      new Date(now.getTime() - dayMs).toISOString(),
    )
    const recent = '2026-08-19T11:30:00.000Z'
    expect(boundedSinceIso(recent, now, dayMs)).toBe(new Date(recent).toISOString())
  })
})

describe('GCP LB connector scope guard — request logs only (gcp-lb.md §Out of scope)', () => {
  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) out.push(...walk(full))
      else if (entry.endsWith('.ts')) out.push(full)
    }
    return out
  }

  it('never calls a non-logging Google API surface (no Compute / Monitoring / Container / Storage)', () => {
    const dir = path.resolve(__dirname, '../src/connectors/gcp-lb')
    const offenders: string[] = []
    const scopeCreepPattern =
      /compute\.googleapis\.com|monitoring\.googleapis\.com|container\.googleapis\.com|storage\.googleapis\.com/i
    for (const file of walk(dir)) {
      if (scopeCreepPattern.test(readFileSync(file, 'utf8'))) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('connectors/gcp-lb/** never mutates the graph directly (ADR-030) and never mints a credential onto a mutation call', () => {
    const dir = path.resolve(__dirname, '../src/connectors/gcp-lb')
    const mutators =
      /\b(graph|g)\.(addNode|addEdge|addEdgeWithKey|addDirectedEdge|addDirectedEdgeWithKey|dropNode|dropEdge|replaceNodeAttributes|replaceEdgeAttributes|mergeNodeAttributes|mergeEdgeAttributes)\s*\(/
    for (const file of walk(dir)) {
      const src = readFileSync(file, 'utf8')
      expect(mutators.test(src), file).toBe(false)
      src.split('\n').forEach((line) => {
        if (/credentials/.test(line)) expect(mutators.test(line), `${file}: ${line}`).toBe(false)
      })
    }
  })
})
