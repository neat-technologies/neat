import { describe, it, expect, afterEach, vi } from 'vitest'
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
import { runConnectorPoll, type ConnectorContext } from '../src/connectors/index.js'
import {
  CloudRunConnector,
  createCloudRunConnector,
  boundedSinceIso,
  buildCloudRunEntriesFilter,
  cloudRunRequestLogName,
  mapLogEntriesToSignals,
  packCloudRunTargetName,
  parseCloudRunTargetName,
} from '../src/connectors/cloud-run/index.js'
import type { EntriesListResponse, LogEntry } from '../src/connectors/cloud-run/client.js'
import type { CloudRunConnectorConfig } from '../src/connectors/cloud-run/types.js'
import type { NeatGraph } from '../src/graph.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Fixture shape confirmed live against Google's own Cloud Logging + Cloud Run
// docs during this connector's build (ADR-165 §Context), the same real-shape
// static fixture Firebase's connector test uses (the emulator has no telemetry
// parity):
//   - request/response envelope: https://cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list
//   - LogEntry + HttpRequest field names: https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry
//   - cloud_run_revision labels: https://cloud.google.com/logging/docs/api/v2/resource-list
//   - the run.googleapis.com%2Frequests log name: https://cloud.google.com/run/docs/logging
const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/cloud-run/entries-list-response.json')
const FIXTURE: EntriesListResponse = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))

const ORDERS_SERVICE = 'orders-api-svc'

// GCP service_name -> NEAT manifest service name (docs/connectors/cloud-run.md
// §Fusion — "resolved once, never guessed"). `payments-svc` (fixture entry 2)
// is deliberately absent — it exercises the tier-2 fallback sourcing the edge
// from the Cloud Run service's own name.
const SERVICE_MAP: Record<string, string> = { 'orders-api': ORDERS_SERVICE }

function config(): CloudRunConnectorConfig {
  return { serviceMap: SERVICE_MAP }
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

  // A statically-extracted Express route (routes.ts) — GET /orders/:id — the
  // one the Cloud Run request-log entry for GET /orders/42 should resolve onto
  // once its concrete path normalises against this template.
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

describe('Cloud Run connector — the entries.list filter (ADR-165, verified live against GCP docs)', () => {
  it('pins the Cloud Run request log name (URL-encoded %2F), the resource type, and the watermark', () => {
    expect(cloudRunRequestLogName('neat-demo')).toBe('projects/neat-demo/logs/run.googleapis.com%2Frequests')
    const filter = buildCloudRunEntriesFilter('neat-demo', '2026-07-03T10:00:00Z')
    expect(filter).toContain('logName = "projects/neat-demo/logs/run.googleapis.com%2Frequests"')
    expect(filter).toContain('resource.type = "cloud_run_revision"')
    expect(filter).toContain('httpRequest.requestMethod != ""')
    expect(filter).toContain('timestamp >= "2026-07-03T10:00:00Z"')
  })
})

describe('Cloud Run connector — mapping (docs/connectors/cloud-run.md, ADR-165)', () => {
  it('maps each Cloud Run request-log entry to one ObservedSignal, dropping non-request-log resources', () => {
    const signals = mapLogEntriesToSignals(FIXTURE.entries ?? [])
    // Three cloud_run_revision entries map; the cloud_function entry drops.
    expect(signals).toHaveLength(3)

    const [ordersGet, webhookPost, health] = signals

    expect(ordersGet).toMatchObject({
      targetKind: 'cloud_run_revision',
      callCount: 1,
      errorCount: 0,
      lastObservedIso: '2026-07-03T10:00:00.100000Z',
    })
    expect(parseCloudRunTargetName(ordersGet!.targetName)).toEqual({
      serviceName: 'orders-api',
      method: 'GET',
      path: '/orders/42',
    })

    // 500 -> counted as an error (the 5xx threshold ingest.ts draws for a
    // failing-response incident). Bare path (fixture entry 1 is a full URL).
    expect(webhookPost).toMatchObject({ targetKind: 'cloud_run_revision', callCount: 1, errorCount: 1 })
    expect(parseCloudRunTargetName(webhookPost!.targetName)).toEqual({
      serviceName: 'orders-api',
      method: 'POST',
      path: '/webhooks/stripe',
    })

    // A requestUrl that is already a bare path ("/health") maps unchanged.
    expect(parseCloudRunTargetName(health!.targetName)).toEqual({
      serviceName: 'payments-svc',
      method: 'GET',
      path: '/health',
    })
  })

  it('packs and parses a target identity round-trip, including a path that could carry the separator', () => {
    const packed = packCloudRunTargetName({ serviceName: 'svc', method: 'GET', path: '/a b/c' })
    expect(parseCloudRunTargetName(packed)).toEqual({ serviceName: 'svc', method: 'GET', path: '/a b/c' })
  })

  it('drops an entry with no httpRequest, a non-Cloud-Run resource, or no service_name label', () => {
    const signals = mapLogEntriesToSignals([
      { resource: { type: 'cloud_run_revision', labels: { service_name: 'x' } } }, // no httpRequest
      { resource: { type: 'gce_instance', labels: {} }, httpRequest: { requestMethod: 'GET', requestUrl: '/x' }, timestamp: 't' },
      { resource: { type: 'cloud_run_revision', labels: {} }, httpRequest: { requestMethod: 'GET', requestUrl: '/x' }, timestamp: 't' }, // no service_name
    ])
    expect(signals).toEqual([])
  })

  it('drops null / empty / drift entries honestly rather than throwing (connectors.md §4)', () => {
    expect(mapLogEntriesToSignals([null as unknown as LogEntry])).toEqual([])
    expect(mapLogEntriesToSignals([{} as LogEntry])).toEqual([])
    const base = {
      resource: { type: 'cloud_run_revision', labels: { service_name: 's' } },
      timestamp: '2026-07-03T10:00:00.000Z',
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

describe('Cloud Run connector — target resolution and full pull/map/fuse (docs/contracts/connectors.md)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('tier 1: resolves a request to the matching RouteNode, minting a file-precise OBSERVED CALLS edge', async () => {
    const graph = newGraph()
    const { connector, resolveTarget } = createCloudRunConnector(graph, config())
    stubFetch({ entries: [FIXTURE.entries![0]] })

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)
    expect(result).toEqual({ signalCount: 1, edgesCreated: 1, edgesUpdated: 0, unresolved: 0 })

    const routeNodeId = routeId(ORDERS_SERVICE, 'GET', '/orders/:id')
    // File-precise (ADR-143): the connector carries no callSite of its own, but
    // the RouteNode records its definition site (src/index.ts, line 12), so the
    // OBSERVED edge originates from that file — not the coarse service node.
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

  it('tier 2: a mapped service with no matching route lands an honest cloud-run-service InfraNode edge (missing-extracted divergence)', async () => {
    const graph = newGraph()
    const { connector, resolveTarget } = createCloudRunConnector(graph, config())
    stubFetch({ entries: [FIXTURE.entries![1]] }) // POST /webhooks/stripe — no RouteNode for it

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)
    expect(result).toEqual({ signalCount: 1, edgesCreated: 1, edgesUpdated: 0, unresolved: 0 })

    // The fallback InfraNode the shared pipeline created (ensureInfraNode, §4a).
    const infraNodeId = infraId('cloud-run-service', 'orders-api')
    expect(graph.hasNode(infraNodeId)).toBe(true)
    const infra = graph.getNodeAttributes(infraNodeId) as { type: string; provider?: string }
    expect(infra.type).toBe(NodeType.InfraNode)
    expect(infra.provider).toBe('cloud-run')

    // Service-grained OBSERVED edge: source is the mapped NEAT service, target
    // the Cloud Run service's own InfraNode — never a self-loop, never a route.
    const edgeId = observedEdgeId(serviceId(ORDERS_SERVICE), infraNodeId, EdgeType.CALLS)
    expect(graph.hasEdge(edgeId)).toBe(true)
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    // The 500 was carried through as an error on the observed edge.
    expect(edge.signal?.errorCount).toBeGreaterThanOrEqual(1)
  })

  it('tier 2: an unmapped service sources the fallback edge from the Cloud Run service name itself', async () => {
    const graph = newGraph()
    const { connector, resolveTarget } = createCloudRunConnector(graph, config())
    stubFetch({ entries: [FIXTURE.entries![2]] }) // GET /health on payments-svc, absent from SERVICE_MAP

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)
    expect(result).toEqual({ signalCount: 1, edgesCreated: 1, edgesUpdated: 0, unresolved: 0 })

    const infraNodeId = infraId('cloud-run-service', 'payments-svc')
    const sourceId = serviceId('payments-svc') // auto-created by the shared pipeline
    expect(graph.hasNode(infraNodeId)).toBe(true)
    expect(graph.hasNode(sourceId)).toBe(true)
    expect(graph.hasEdge(observedEdgeId(sourceId, infraNodeId, EdgeType.CALLS))).toBe(true)
  })

  it('one poll over the whole fixture: 1 route-grain + 2 service-grain edges, no misses, the cloud_function entry dropped', async () => {
    const graph = newGraph()
    const { connector, resolveTarget } = createCloudRunConnector(graph, config())
    stubFetch(FIXTURE)

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)
    expect(result).toEqual({ signalCount: 3, edgesCreated: 3, edgesUpdated: 0, unresolved: 0 })
  })
})

describe('Cloud Run connector credentials (docs/contracts/connectors.md §6)', () => {
  it('throws honestly rather than polling with missing credentials', async () => {
    const connector = new CloudRunConnector()
    await expect(connector.poll({ projectDir: '/repo', credentials: {} })).rejects.toThrow(/projectId/)
    await expect(
      connector.poll({ projectDir: '/repo', credentials: { projectId: 'p' } }),
    ).rejects.toThrow(/accessToken/)
  })
})

describe('Cloud Run connector — watermark backfill bound (connectors.md "Poll cadence and backfill")', () => {
  const now = new Date('2026-07-03T12:00:00.000Z')
  const dayMs = 24 * 60 * 60 * 1000

  it('floors a first poll (no since) and a too-old since at now - maxLookbackMs, and honors a recent since', () => {
    expect(boundedSinceIso(undefined, now, dayMs)).toBe(new Date(now.getTime() - dayMs).toISOString())
    expect(boundedSinceIso('2026-06-01T00:00:00.000Z', now, dayMs)).toBe(
      new Date(now.getTime() - dayMs).toISOString(),
    )
    const recent = '2026-07-03T11:30:00.000Z'
    expect(boundedSinceIso(recent, now, dayMs)).toBe(new Date(recent).toISOString())
  })
})

describe('Cloud Run connector scope guard — request logs only (cloud-run.md §Out of scope)', () => {
  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) out.push(...walk(full))
      else if (entry.endsWith('.ts')) out.push(full)
    }
    return out
  }

  it('never calls a non-logging Google API surface (no Firestore / Auth / Storage / Monitoring)', () => {
    const dir = path.resolve(__dirname, '../src/connectors/cloud-run')
    const offenders: string[] = []
    const scopeCreepPattern =
      /firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|storage\.googleapis\.com|monitoring\.googleapis\.com|getFirestore\(|getAuth\(/i
    for (const file of walk(dir)) {
      if (scopeCreepPattern.test(readFileSync(file, 'utf8'))) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('connectors/cloud-run/** never mutates the graph directly (ADR-030) and never mints a credential onto a mutation call', () => {
    const dir = path.resolve(__dirname, '../src/connectors/cloud-run')
    const mutators =
      /\b(graph|g)\.(addNode|addEdge|addEdgeWithKey|addDirectedEdge|addDirectedEdgeWithKey|dropNode|dropEdge|replaceNodeAttributes|replaceEdgeAttributes|mergeNodeAttributes|mergeEdgeAttributes)\s*\(/
    function walkDir(dirPath: string): string[] {
      const out: string[] = []
      for (const entry of readdirSync(dirPath)) {
        const full = path.join(dirPath, entry)
        if (statSync(full).isDirectory()) out.push(...walkDir(full))
        else if (entry.endsWith('.ts')) out.push(full)
      }
      return out
    }
    for (const file of walkDir(dir)) {
      const src = readFileSync(file, 'utf8')
      expect(mutators.test(src), file).toBe(false)
      src.split('\n').forEach((line) => {
        if (/credentials/.test(line)) expect(mutators.test(line), `${file}: ${line}`).toBe(false)
      })
    }
  })
})
