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
  FirebaseConnector,
  createFirebaseConnector,
  mapLogEntriesToSignals,
  packFirebaseTargetName,
  parseFirebaseTargetName,
} from '../src/connectors/firebase/index.js'
import type { EntriesListResponse } from '../src/connectors/firebase/logging-api.js'
import type { FirebaseServiceMap } from '../src/connectors/firebase/resolve.js'
import type { NeatGraph } from '../src/graph.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Fixture shape confirmed live against Google's own Cloud Logging docs
// (fetched during this connector's build, per docs/connectors/firebase.md's
// testing note — the emulator suite has no telemetry parity so a real-shape
// static fixture stands in, the same way observed-e2e.md accepts one for
// Brief):
//   - request/response envelope: https://cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list
//   - LogEntry + HttpRequest field names: https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry
//   - cloud_function / cloud_run_revision / firebase_domain monitored-resource
//     labels: https://cloud.google.com/logging/docs/api/v2/resource-list
const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/firebase/entries-list-response.json')
const FIXTURE: EntriesListResponse = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))

const ORDERS_SERVICE = 'orders-api-svc'
const HOSTING_SERVICE = 'hosting-svc'

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
  // one the Cloud Run request-log entry for GET /orders/42 should resolve
  // onto once its concrete path normalises against this template.
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

  const hostingService: ServiceNode = {
    id: serviceId(HOSTING_SERVICE),
    type: NodeType.ServiceNode,
    name: HOSTING_SERVICE,
    language: 'typescript',
  }
  g.addNode(hostingService.id, hostingService)

  const statusRoute: RouteNode = {
    id: routeId(HOSTING_SERVICE, 'GET', '/status/:id'),
    type: NodeType.RouteNode,
    name: 'GET /status/:id',
    service: HOSTING_SERVICE,
    method: 'GET',
    pathTemplate: '/status/:id',
    path: 'functions/src/index.ts',
    line: 7,
    framework: 'express',
    discoveredVia: 'static',
  }
  g.addNode(statusRoute.id, statusRoute)

  return g
}

// Config-time resource -> NEAT service mapping (docs/connectors/firebase.md
// §Fusion — "an explicit config-time mapping ... supplied once at connector
// setup", the same discipline ADR-127 states for Railway). Note `legacyPing`
// (the fixture's cloud_function entry) is deliberately absent — it exercises
// the "no configured mapping" honest miss, distinct from the "mapped but no
// route resolves" honest miss the webhooks/stripe entry exercises.
const SERVICE_MAP: FirebaseServiceMap = {
  cloudRun: { 'orders-api': ORDERS_SERVICE },
  hosting: { 'neat-demo-site': HOSTING_SERVICE },
}

function baseCtx(): ConnectorContext {
  return { projectDir: '/repo/orders-api', credentials: { projectId: 'neat-demo', accessToken: 'test-token' } }
}

describe('Firebase connector — mapping (docs/connectors/firebase.md, ADR-128)', () => {
  it('maps each fixture LogEntry to one ObservedSignal, carrying the provider event time and 5xx-only error counting', () => {
    const signals = mapLogEntriesToSignals(FIXTURE.entries ?? [])
    expect(signals).toHaveLength(4)

    const [ordersGet, webhookPost, legacyPing, hostingGet] = signals

    expect(ordersGet).toMatchObject({
      targetKind: 'cloud_run_revision',
      callCount: 1,
      errorCount: 0,
      lastObservedIso: '2026-07-03T10:00:00.100000Z',
    })
    expect(parseFirebaseTargetName(ordersGet!.targetName)).toEqual({
      resourceName: 'orders-api',
      method: 'GET',
      path: '/orders/42',
    })

    // 500 status -> counted as an error (the same 5xx threshold ingest.ts
    // draws for a failing-response incident).
    expect(webhookPost).toMatchObject({
      targetKind: 'cloud_run_revision',
      callCount: 1,
      errorCount: 1,
    })
    expect(parseFirebaseTargetName(webhookPost!.targetName)).toEqual({
      resourceName: 'orders-api',
      method: 'POST',
      path: '/webhooks/stripe',
    })

    expect(legacyPing).toMatchObject({ targetKind: 'cloud_function', errorCount: 0 })
    expect(parseFirebaseTargetName(legacyPing!.targetName)).toEqual({
      resourceName: 'legacyPing',
      method: 'GET',
      path: '/ping',
    })

    expect(hostingGet).toMatchObject({ targetKind: 'firebase_domain', errorCount: 0 })
    expect(parseFirebaseTargetName(hostingGet!.targetName)).toEqual({
      resourceName: 'neat-demo-site',
      method: 'GET',
      path: '/status/42',
    })
  })

  it('packs and parses a target identity round-trip, including a path (last field) that could carry the separator', () => {
    const packed = packFirebaseTargetName({ resourceName: 'svc', method: 'GET', path: '/a b/c' })
    expect(parseFirebaseTargetName(packed)).toEqual({ resourceName: 'svc', method: 'GET', path: '/a b/c' })
  })

  it('drops an entry with no httpRequest, no resource, or an unrecognised resource type', () => {
    const signals = mapLogEntriesToSignals([
      { resource: { type: 'cloud_run_revision', labels: { service_name: 'x' } } }, // no httpRequest
      { resource: { type: 'gce_instance', labels: {} }, httpRequest: { requestMethod: 'GET', requestUrl: '/x' }, timestamp: 't' },
      { httpRequest: { requestMethod: 'GET', requestUrl: '/x' }, timestamp: 't' }, // no resource
    ])
    expect(signals).toEqual([])
  })
})

describe('Firebase connector — target resolution and full pull/map/fuse (docs/contracts/connectors.md)', () => {
  it('resolves a Cloud Run request to the matching RouteNode, minting a file-precise OBSERVED CALLS edge', async () => {
    const graph = newGraph()
    const { connector, resolveTarget } = createFirebaseConnector(graph, SERVICE_MAP)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ entries: [FIXTURE.entries![0]] }),
      }),
    )

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)

    expect(result).toEqual({ signalCount: 1, edgesCreated: 1, edgesUpdated: 0, unresolved: 0 })

    const routeNodeId = routeId(ORDERS_SERVICE, 'GET', '/orders/:id')
    // File-precise (ADR-143): the connector carries no callSite of its own, but
    // the RouteNode records its definition site (path 'src/index.ts', line 12),
    // so the OBSERVED edge originates from that file — not the coarse service
    // node — making good on this test's "file-precise" claim.
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

    vi.unstubAllGlobals()
  })

  it('falls back to an honest miss (unresolved), never a self-referential edge, when no static route matches the path', async () => {
    const graph = newGraph()
    const { connector, resolveTarget } = createFirebaseConnector(graph, SERVICE_MAP)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ entries: [FIXTURE.entries![1]] }), // POST /webhooks/stripe — no RouteNode for it
      }),
    )

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)

    expect(result).toEqual({ signalCount: 1, edgesCreated: 0, edgesUpdated: 0, unresolved: 1 })
    // Nothing invented: the orders-api-svc ServiceNode carries no new
    // self-referential edge.
    expect(graph.outboundEdges(serviceId(ORDERS_SERVICE))).toEqual([])

    vi.unstubAllGlobals()
  })

  it('falls back to an honest miss when the resource has no configured service mapping at all', async () => {
    const graph = newGraph()
    const { connector, resolveTarget } = createFirebaseConnector(graph, SERVICE_MAP)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ entries: [FIXTURE.entries![2]] }), // legacyPing — absent from SERVICE_MAP.functions
      }),
    )

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)
    expect(result).toEqual({ signalCount: 1, edgesCreated: 0, edgesUpdated: 0, unresolved: 1 })

    vi.unstubAllGlobals()
  })

  it('resolves a Firebase Hosting request the same way, proving the fusion pattern is resource-type-agnostic', async () => {
    const graph = newGraph()
    const { connector, resolveTarget } = createFirebaseConnector(graph, SERVICE_MAP)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ entries: [FIXTURE.entries![3]] }),
      }),
    )

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)
    expect(result).toEqual({ signalCount: 1, edgesCreated: 1, edgesUpdated: 0, unresolved: 0 })

    const routeNodeId = routeId(HOSTING_SERVICE, 'GET', '/status/:id')
    // Same file-grain (ADR-143), a Hosting route this time — its RouteNode
    // records path 'functions/src/index.ts', line 7, so the edge lands there.
    const fileSource = fileId(HOSTING_SERVICE, 'functions/src/index.ts')
    const edgeId = observedEdgeId(fileSource, routeNodeId, EdgeType.CALLS)
    expect(graph.hasEdge(edgeId)).toBe(true)
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.grain).toBe('file')
    expect(edge.evidence?.line).toBe(7)

    vi.unstubAllGlobals()
  })

  it('all four fixture entries in one poll: 2 resolved (route + hosting), 2 honest misses', async () => {
    const graph = newGraph()
    const { connector, resolveTarget } = createFirebaseConnector(graph, SERVICE_MAP)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => FIXTURE,
      }),
    )

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)
    expect(result).toEqual({ signalCount: 4, edgesCreated: 2, edgesUpdated: 0, unresolved: 2 })

    vi.unstubAllGlobals()
  })
})

describe('Firebase connector credentials (docs/contracts/connectors.md §6)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('throws honestly rather than polling with missing credentials', async () => {
    const connector = new FirebaseConnector()
    await expect(
      connector.poll({ projectDir: '/repo', credentials: {} }),
    ).rejects.toThrow(/credentials/)
  })
})

describe('Firebase connector scope guard — Firestore / Auth are non-goals (firebase.md §Scope)', () => {
  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) out.push(...walk(full))
      else if (entry.endsWith('.ts')) out.push(full)
    }
    return out
  }

  it('never calls a Firestore / Realtime Database / Firebase Auth API surface', () => {
    // A prose comment explaining these are non-goals (this file's own header
    // docs, matching firebase.md) is expected and fine; what must never
    // appear is an actual call into one of those APIs — an SDK import, an
    // API host, or an IAM role name scoped to one of them.
    const dir = path.resolve(__dirname, '../src/connectors/firebase')
    const offenders: string[] = []
    const scopeCreepPattern =
      /firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|firebaseio\.com|getFirestore\(|getAuth\(|firebase-admin\/(firestore|auth)|roles\/datastore\.viewer/i
    for (const file of walk(dir)) {
      const src = readFileSync(file, 'utf8')
      if (scopeCreepPattern.test(src)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})

describe('Firebase connector — contracts.md §6 (credentials never reach a graph mutation call)', () => {
  it('no line in connectors/firebase/** mentions credentials alongside a graph mutator', () => {
    const dir = path.resolve(__dirname, '../src/connectors/firebase')
    const mutators = /\b(graph|g)\.(addNode|addEdge|addEdgeWithKey|addDirectedEdge|addDirectedEdgeWithKey|replaceNodeAttributes|replaceEdgeAttributes|mergeNodeAttributes|mergeEdgeAttributes)\s*\(/
    const offenders: string[] = []
    function walk(dirPath: string): string[] {
      const out: string[] = []
      for (const entry of readdirSync(dirPath)) {
        const full = path.join(dirPath, entry)
        if (statSync(full).isDirectory()) out.push(...walk(full))
        else if (entry.endsWith('.ts')) out.push(full)
      }
      return out
    }
    for (const file of walk(dir)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/credentials/.test(line) && mutators.test(line)) offenders.push(`${file}:${i + 1}`)
        })
    }
    expect(offenders).toEqual([])
  })

  it('connectors/firebase/** never mutates the graph directly (ADR-030) — only reads via forEachNode/hasNode', () => {
    const dir = path.resolve(__dirname, '../src/connectors/firebase')
    const mutators = /\b(graph|g)\.(addNode|addEdge|addEdgeWithKey|addDirectedEdge|addDirectedEdgeWithKey|dropNode|dropEdge|replaceNodeAttributes|replaceEdgeAttributes|mergeNodeAttributes|mergeEdgeAttributes)\s*\(/
    function walk(dirPath: string): string[] {
      const out: string[] = []
      for (const entry of readdirSync(dirPath)) {
        const full = path.join(dirPath, entry)
        if (statSync(full).isDirectory()) out.push(...walk(full))
        else if (entry.endsWith('.ts')) out.push(full)
      }
      return out
    }
    for (const file of walk(dir)) {
      expect(mutators.test(readFileSync(file, 'utf8')), file).toBe(false)
    }
  })
})
