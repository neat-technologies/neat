import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { resetGraph, getGraph } from '../src/graph.js'
import { buildApi } from '../src/api.js'
import { extractFromDirectory } from '../src/extract.js'

const __dirname = path.dirname(new URL(import.meta.url).pathname)
const DEMO_PATH = path.resolve(__dirname, '../../../demo')

describe('REST API (fastify.inject)', () => {
  let app: FastifyInstance
  let prevFloor: string | undefined

  beforeEach(async () => {
    // The demo's service-a → service-b CALLS edge comes from the hostname-
    // shape matcher and grades at 0.2 — below the default precision floor
    // (0.7) per ADR-066. Flip the floor off so the API tests against the
    // demo see the full edge set the root-cause / blast-radius assertions
    // depend on. Restored in afterEach.
    prevFloor = process.env.NEAT_EXTRACTED_PRECISION_FLOOR
    process.env.NEAT_EXTRACTED_PRECISION_FLOOR = '0'
    resetGraph()
    const graph = getGraph()
    await extractFromDirectory(graph, DEMO_PATH)
    app = await buildApi({ graph, scanPath: DEMO_PATH })
  })

  afterEach(async () => {
    await app.close()
    if (prevFloor === undefined) delete process.env.NEAT_EXTRACTED_PRECISION_FLOOR
    else process.env.NEAT_EXTRACTED_PRECISION_FLOOR = prevFloor
  })

  it('GET /health returns the daemon-wide readiness shape', async () => {
    // Issue #343 — unscoped /health answers daemon-wide; per-project shape
    // moved to /projects/:project/health.
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({
      ok: true,
      uptimeMs: expect.any(Number),
      projects: expect.any(Array),
    })
  })

  it('GET /projects/:project/health returns the per-project shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/projects/default/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // ADR-061 canonical triple plus legacy extras (passthrough).
    expect(body).toMatchObject({
      ok: true,
      project: expect.any(String),
      uptimeMs: expect.any(Number),
      nodeCount: expect.any(Number),
      edgeCount: expect.any(Number),
      lastUpdated: expect.any(String),
    })
    expect(body.nodeCount).toBeGreaterThanOrEqual(3)
  })

  it('GET /graph returns nodes and edges arrays', async () => {
    const res = await app.inject({ method: 'GET', url: '/graph' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.nodes.length).toBeGreaterThanOrEqual(3)
    expect(body.edges.length).toBeGreaterThanOrEqual(2)

    const serviceB = body.nodes.find((n: { id: string }) => n.id === 'service:service-b')
    expect(serviceB.dependencies.pg).toBe('7.4.0')

    const db = body.nodes.find((n: { id: string }) => n.id === 'database:payments-db')
    expect(db.engineVersion).toBe('15')
    expect(db.compatibleDrivers.find((d: { name: string }) => d.name === 'pg').minVersion).toBe(
      '8.0.0',
    )
  })

  it('GET /graph/node/:id returns a single node', async () => {
    const res = await app.inject({ method: 'GET', url: '/graph/node/service:service-b' })
    expect(res.statusCode).toBe(200)
    expect(res.json().node.dependencies.pg).toBe('7.4.0')
  })

  it('GET /graph/node/:id returns 404 for an unknown node', async () => {
    const res = await app.inject({ method: 'GET', url: '/graph/node/nope' })
    expect(res.statusCode).toBe(404)
  })

  it('GET /graph/edges/:id returns inbound and outbound', async () => {
    const res = await app.inject({ method: 'GET', url: '/graph/edges/service:service-b' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.inbound.length).toBeGreaterThanOrEqual(1)
    expect(body.outbound.length).toBeGreaterThanOrEqual(1)
  })

  it('GET /graph/observed-dependencies/:nodeId returns the observed-deps shape (issue #578/#593)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/graph/observed-dependencies/service:service-a',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.origin).toBe('service:service-a')
    // The demo graph is static-only, so there are no OBSERVED deps — but the
    // EXTRACTED CALLS to service-b is present, so the "is OTel running?" note is
    // the honest one here.
    expect(body.dependencies).toEqual([])
    expect(body.observed).toBe(false)
    expect(body.hasExtractedOutbound).toBe(true)
  })

  it('GET /graph/observed-dependencies/:nodeId returns 404 for an unknown node', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/graph/observed-dependencies/nope',
    })
    expect(res.statusCode).toBe(404)
  })

  it('GET /incidents returns a wrapped empty list when no log is configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/incidents' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ count: 0, total: 0, events: [] })
  })

  it('GET /incidents/:nodeId returns a wrapped empty list for a known node', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/incidents/service:service-b',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ count: 0, total: 0, events: [] })
  })

  it('GET /graph/incident-history/:nodeId mirrors /incidents/:nodeId (issue #593)', async () => {
    const alias = await app.inject({
      method: 'GET',
      url: '/graph/incident-history/service:service-b',
    })
    expect(alias.statusCode).toBe(200)
    expect(alias.json()).toEqual({ count: 0, total: 0, events: [] })

    const unknown = await app.inject({
      method: 'GET',
      url: '/graph/incident-history/nope',
    })
    expect(unknown.statusCode).toBe(404)
  })

  it('GET /search?q=service-b finds the matching node', async () => {
    const res = await app.inject({ method: 'GET', url: '/search?q=service-b' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.query).toBe('service-b')
    expect(body.matches.length).toBeGreaterThanOrEqual(1)
    expect(body.matches.some((n: { id: string }) => n.id === 'service:service-b')).toBe(true)
  })

  it('GET /search with no q returns 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/search' })
    expect(res.statusCode).toBe(400)
  })

  it('POST /graph/scan re-runs extraction (idempotent — adds nothing the second time)', async () => {
    const res = await app.inject({ method: 'POST', url: '/graph/scan' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.scanned).toMatch(/demo$/)
    expect(body.nodesAdded).toBe(0)
    expect(body.edgesAdded).toBe(0)
    expect(body.nodeCount).toBeGreaterThanOrEqual(3)
  })

  it('POST /graph/scan returns 409 when scanPath was not configured', async () => {
    await app.close()
    const graph = getGraph()
    app = await buildApi({ graph })
    const res = await app.inject({ method: 'POST', url: '/graph/scan' })
    expect(res.statusCode).toBe(409)
  })

  it('GET /graph/root-cause/:nodeId returns the demo pg incompatibility', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/graph/root-cause/database:payments-db',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.rootCauseNode).toBe('service:service-b')
    // File-first (ADR-089): service-a reaches service-b through its file, so
    // the incoming walk runs db ← file:service-b:db-config.yaml ← service-b ←
    // file:service-a:index.js ← service-a. The bad-pg service (service-b) is
    // still the root cause.
    expect(body.traversalPath).toEqual([
      'database:payments-db',
      'file:service-b:db-config.yaml',
      'service:service-b',
      'file:service-a:index.js',
      'service:service-a',
    ])
    // Multiplicative cascade per ADR-036: four EXTRACTED hops at ceiling 0.5
    // each → 0.0625 (CONNECTS_TO now originates from the db-config FileNode).
    expect(body.confidence).toBeCloseTo(0.0625, 5)
    expect(body.fixRecommendation).toMatch(/8\.0\.0/)
  })

  it('GET /graph/root-cause/:nodeId returns 404 for an unknown node', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/graph/root-cause/database:nope',
    })
    expect(res.statusCode).toBe(404)
  })

  it('GET /graph/root-cause/:nodeId returns 404 when no root cause is found', async () => {
    // service:service-a is a service node, not a database — getRootCause bails out.
    const res = await app.inject({
      method: 'GET',
      url: '/graph/root-cause/service:service-a',
    })
    expect(res.statusCode).toBe(404)
  })

  it('GET /graph/blast-radius/:nodeId returns the dependents of a sink with distances', async () => {
    // Blast radius walks inbound — "what breaks if this changes?" — so a sink
    // like the database returns the things that depend on it, not the empty
    // list an outbound walk gives for a node with no dependencies of its own.
    // The chain runs back up the dependencies: db-config.yaml connects to
    // payments-db (distance 1), service-b owns that config via CONTAINS
    // (distance 2), service-a's index.js calls service-b (distance 3), and
    // service-a owns index.js (distance 4).
    const res = await app.inject({
      method: 'GET',
      url: '/graph/blast-radius/database:payments-db',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.origin).toBe('database:payments-db')
    expect(body.totalAffected).toBe(4)
    // path + confidence land per §affectedNodes payload. Property-style
    // assertions so this test doesn't pin every BFS path detail — the contract
    // tests in contracts.test.ts pin the per-node invariants tightly.
    for (const n of body.affectedNodes) {
      expect(n.path[0]).toBe('database:payments-db')
      expect(n.path[n.path.length - 1]).toBe(n.nodeId)
      expect(n.path.length).toBe(n.distance + 1)
      expect(n.confidence).toBeGreaterThan(0)
      expect(n.confidence).toBeLessThanOrEqual(1)
    }
    const ids = body.affectedNodes.map((n: { nodeId: string }) => n.nodeId).sort()
    expect(ids).toEqual([
      'file:service-a:index.js',
      'file:service-b:db-config.yaml',
      'service:service-a',
      'service:service-b',
    ])
  })

  it('GET /graph/blast-radius/:nodeId returns 404 for an unknown node', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/graph/blast-radius/service:nope',
    })
    expect(res.statusCode).toBe(404)
  })

  it('GET /graph/blast-radius/:nodeId rejects a negative depth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/graph/blast-radius/service:service-a?depth=-1',
    })
    expect(res.statusCode).toBe(400)
  })

  it('GET /stale-events returns a wrapped empty list when no log is configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/stale-events' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ count: 0, total: 0, events: [] })
  })

  it('GET /graph/blast-radius/:nodeId honours a custom depth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/graph/blast-radius/database:payments-db?depth=1',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Depth 1 from the db reaches only its direct dependent — the config file
    // that connects to it. service-b, which owns that file, sits at distance 2
    // and so falls outside the depth-1 cutoff.
    expect(body.totalAffected).toBe(1)
    expect(body.affectedNodes.map((n: { nodeId: string }) => n.nodeId).sort()).toEqual([
      'file:service-b:db-config.yaml',
    ])
  })

  it('GET /graph/diff returns 400 when `against` is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/graph/diff' })
    expect(res.statusCode).toBe(400)
  })

  // #693 — `against` used to be handed straight to `loadSnapshotForDiff`,
  // which fetch()es any http(s) URL and otherwise reads whatever filesystem
  // path it's given. In public-read mode this route needs no auth at all, so
  // an arbitrary path/URL there was a live SSRF/LFI vector. `against` now
  // only resolves through the project registry (`self`, or a known project
  // name) — a filesystem path or a URL never reaches fetch()/fs.readFile()
  // and is rejected outright.
  it('GET /graph/diff rejects a filesystem path — never reads it off disk', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/graph/diff?against=/etc/passwd',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/unknown snapshot id/)
  })

  it('GET /graph/diff rejects an http(s) URL — never fetches it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/graph/diff?against=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/unknown snapshot id/)
  })
})

describe('GET /graph/diff', () => {
  let app: FastifyInstance
  let tmpDir: string
  let snapshotPath: string

  beforeEach(async () => {
    const { promises: fs } = await import('node:fs')
    const os = await import('node:os')
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-api-diff-'))

    resetGraph()
    const graph = getGraph()
    await extractFromDirectory(graph, DEMO_PATH)

    const { Projects, pathsForProject } = await import('../src/projects.js')
    const { DEFAULT_PROJECT } = await import('../src/graph.js')
    const paths = pathsForProject(DEFAULT_PROJECT, tmpDir)
    snapshotPath = paths.snapshotPath

    const { saveGraphToDisk } = await import('../src/persist.js')
    await saveGraphToDisk(graph, snapshotPath)

    // Drop one node from the live graph so the diff has something to report.
    graph.dropNode('config:service-b/db-config.yaml')

    const registry = new Projects()
    registry.set(DEFAULT_PROJECT, { graph, paths })
    app = await buildApi({ projects: registry })
  })

  afterEach(async () => {
    await app.close()
    const { promises: fs } = await import('node:fs')
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('`against=self` diffs against this project\'s own managed snapshot and reports the dropped node as removed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/graph/diff?against=self',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.base.exportedAt).toBeTruthy()
    expect(body.current.exportedAt).toBeTruthy()
    expect(body.removed.nodes.map((n: { id: string }) => n.id)).toContain(
      'config:service-b/db-config.yaml',
    )
    expect(body.added.nodes).toEqual([])
  })

  it('`against=<project name>` resolves the same managed snapshot as `self`', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/graph/diff?against=default',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().removed.nodes.map((n: { id: string }) => n.id)).toContain(
      'config:service-b/db-config.yaml',
    )
  })

  it('rejects an arbitrary path even when it happens to point at the real snapshot file on disk', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/graph/diff?against=${encodeURIComponent(snapshotPath)}`,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/unknown snapshot id/)
  })
})

// #693 — the push/sync route only checked schemaVersion before merging;
// ingest.ts cast every node/edge straight to GraphNode/GraphEdge with no shape
// validation ahead of graph.addNode()/addEdgeWithKey(). A malformed or
// hostile sync payload could land on the live graph as-is.
describe('POST /snapshot — schema validation (#693)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    resetGraph()
    app = await buildApi({ graph: getGraph() })
  })

  afterEach(async () => {
    await app.close()
  })

  it('rejects a snapshot carrying a node with a bogus `type` and does not merge any of it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/snapshot',
      payload: {
        snapshot: {
          schemaVersion: 4,
          exportedAt: new Date().toISOString(),
          graph: {
            nodes: [
              {
                key: 'service:legit',
                attributes: {
                  id: 'service:legit',
                  type: 'ServiceNode',
                  name: 'legit',
                  language: 'javascript',
                },
              },
              {
                key: 'service:evil',
                // Not a real NodeType — the shape a hostile or corrupted
                // sync payload would carry.
                attributes: { id: 'service:evil', type: 'DropAllTables', name: 'evil' },
              },
            ],
            edges: [],
          },
        },
      },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toBe('snapshot merge failed')
    expect(Array.isArray(body.issues)).toBe(true)
    expect(body.issues.length).toBeGreaterThan(0)

    // Whole-snapshot rejection: the well-formed sibling node must not have
    // merged either.
    const graphRes = await app.inject({ method: 'GET', url: '/graph' })
    const nodeIds = (graphRes.json().nodes as Array<{ id: string }>).map((n) => n.id)
    expect(nodeIds).not.toContain('service:legit')
    expect(nodeIds).not.toContain('service:evil')
  })
})

describe('GET /stale-events (with log)', () => {
  let app: FastifyInstance
  let tmpDir: string
  let staleEventsPath: string

  beforeEach(async () => {
    const { promises: fs } = await import('node:fs')
    const os = await import('node:os')
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-stale-api-'))
    staleEventsPath = path.join(tmpDir, 'stale-events.ndjson')

    const events = [
      {
        edgeId: 'CALLS:OBSERVED:service:a->service:b',
        source: 'service:a',
        target: 'service:b',
        edgeType: 'CALLS',
        thresholdMs: 3600000,
        ageMs: 5400000,
        lastObserved: '2026-05-02T10:00:00.000Z',
        transitionedAt: '2026-05-02T11:30:00.000Z',
      },
      {
        edgeId: 'CONNECTS_TO:OBSERVED:service:b->database:c',
        source: 'service:b',
        target: 'database:c',
        edgeType: 'CONNECTS_TO',
        thresholdMs: 14400000,
        ageMs: 15000000,
        lastObserved: '2026-05-02T07:00:00.000Z',
        transitionedAt: '2026-05-02T11:10:00.000Z',
      },
    ]
    await fs.writeFile(
      staleEventsPath,
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    )

    resetGraph()
    app = await buildApi({ graph: getGraph(), staleEventsPath })
  })

  afterEach(async () => {
    await app.close()
    const { promises: fs } = await import('node:fs')
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns the events newest-first', async () => {
    const res = await app.inject({ method: 'GET', url: '/stale-events' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(2)
    expect(body.events).toHaveLength(2)
    expect(body.events[0].edgeType).toBe('CONNECTS_TO')
    expect(body.events[1].edgeType).toBe('CALLS')
  })

  it('filters by edgeType', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/stale-events?edgeType=CALLS',
    })
    const body = res.json()
    expect(body.events).toHaveLength(1)
    expect(body.events[0].edgeType).toBe('CALLS')
  })

  it('honours limit', async () => {
    const res = await app.inject({ method: 'GET', url: '/stale-events?limit=1' })
    expect(res.json().events).toHaveLength(1)
  })
})
