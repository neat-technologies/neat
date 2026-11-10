import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  databaseId,
  observedEdgeId,
  serviceId,
  type DatabaseNode,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import { resetGraph, getGraph, type NeatGraph } from '../src/graph.js'
import { parseOtlpRequest, type OtlpTracesRequest } from '../src/otel.js'
import { handleSpan, resetParentSpanCache, type IngestContext } from '../src/ingest.js'
import { extractFromDirectory } from '../src/extract.js'
import { canonicalEngine } from '../src/compat.js'
import { migrateSnapshot, SCHEMA_VERSION, type PersistedGraph } from '../src/persist.js'

// A networked DatabaseNode is keyed on (engine, host) (ADR-276), so two stores on
// one host stay two nodes, and static extraction and OTel ingest still compute
// the same id for one store.

function dbSpan(service: string, system: string, host: string, port: number): OtlpTracesRequest {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'aabbccddeeff00112233445566778899',
                spanId: Math.random().toString(16).slice(2, 18).padEnd(16, '0'),
                name: `${system} op`,
                kind: 3,
                startTimeUnixNano: '1000000000000000000',
                endTimeUnixNano: '1000000000050000000',
                attributes: [
                  { key: 'db.system', value: { stringValue: system } },
                  { key: 'server.address', value: { stringValue: host } },
                  { key: 'server.port', value: { intValue: port } },
                ],
                status: { code: 0 },
              },
            ],
          },
        ],
      },
    ],
  }
}

describe('DatabaseNode identity (ADR-276)', () => {
  let ctx: IngestContext
  beforeEach(() => {
    resetGraph()
    resetParentSpanCache()
    ctx = { graph: getGraph() }
  })
  const ingest = async (req: OtlpTracesRequest) => {
    for (const s of parseOtlpRequest(req)) await handleSpan(ctx, s)
  }

  it('keeps Postgres and Redis on one host as two nodes, each with its own engine', async () => {
    await ingest(dbSpan('api', 'postgresql', '127.0.0.1', 5433))
    await ingest(dbSpan('api', 'redis', '127.0.0.1', 6380))
    await ingest(dbSpan('api', 'postgresql', '127.0.0.1', 5433))
    const pg = getGraph().getNodeAttributes(databaseId('postgresql', '127.0.0.1')) as DatabaseNode
    const redis = getGraph().getNodeAttributes(databaseId('redis', '127.0.0.1')) as DatabaseNode
    expect(pg.engine).toBe('postgresql')
    expect(redis.engine).toBe('redis')
    const dbs = getGraph().filterNodes((_id, a) => (a as GraphNode).type === NodeType.DatabaseNode)
    expect(dbs.sort()).toEqual([databaseId('postgresql', '127.0.0.1'), databaseId('redis', '127.0.0.1')])
  })

  it('canonicalizes the engine, so spellings of one engine land on one node', async () => {
    expect(canonicalEngine('Postgres')).toBe('postgresql')
    expect(canonicalEngine('mariadb')).toBe('mysql')
    expect(canonicalEngine('mongoose')).toBe('mongodb')
    expect(canonicalEngine('cassandra')).toBe('cassandra')
    expect(canonicalEngine('')).toBe('unknown')
    await ingest(dbSpan('api', 'mariadb', 'db.internal', 3306))
    expect(getGraph().hasNode(databaseId('mysql', 'db.internal'))).toBe(true)
  })

  it('fuses a declared store with its observed traffic on one id', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-1608-'))
    try {
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'api', main: 'index.js', dependencies: { pg: '8.11.0', redis: '4.6.0' } }))
      await fs.writeFile(path.join(dir, 'index.js'), "require('pg')\n")
      await fs.writeFile(
        path.join(dir, '.env'),
        'DATABASE_URL=postgres://u:p@127.0.0.1:5433/app\nREDIS_URL=redis://127.0.0.1:6380\n',
      )
      await extractFromDirectory(getGraph(), dir, { announce: false })
      const pgId = databaseId('postgresql', '127.0.0.1')
      const redisId = databaseId('redis', '127.0.0.1')
      expect(getGraph().hasNode(pgId)).toBe(true)
      expect(getGraph().hasNode(redisId)).toBe(true)
      await ingest(dbSpan('api', 'postgresql', '127.0.0.1', 5433))
      // The span landed on the declared node, not a twin.
      const dbs = getGraph().filterNodes((_id, a) => (a as GraphNode).type === NodeType.DatabaseNode)
      expect(dbs.sort()).toEqual([pgId, redisId])
      const observed = getGraph()
        .inEdges(pgId)
        .map((e) => getGraph().getEdgeAttributes(e) as GraphEdge)
        .filter((e) => e.provenance === Provenance.OBSERVED)
      expect(observed).toHaveLength(1)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('v8 → v9 snapshot migration (ADR-276)', () => {
  function v8(): PersistedGraph {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:api', { id: 'service:api', type: NodeType.ServiceNode, name: 'api', language: 'javascript' } as GraphNode)
    g.addNode('database:payments-db', {
      id: 'database:payments-db',
      type: NodeType.DatabaseNode,
      name: 'payments-db',
      engine: 'postgres',
      engineVersion: '15',
      compatibleDrivers: [],
      host: 'payments-db',
    } as GraphNode)
    g.addNode('database:api/app.db', {
      id: 'database:api/app.db',
      type: NodeType.DatabaseNode,
      name: 'app.db',
      engine: 'sqlite',
      engineVersion: 'unknown',
      compatibleDrivers: [],
    } as GraphNode)
    const e = observedEdgeId('service:api', 'database:payments-db', EdgeType.CONNECTS_TO)
    g.addEdgeWithKey(e, 'service:api', 'database:payments-db', {
      id: e,
      source: 'service:api',
      target: 'database:payments-db',
      type: EdgeType.CONNECTS_TO,
      provenance: Provenance.OBSERVED,
    } as GraphEdge)
    return { schemaVersion: 8, exportedAt: '2026-11-10T00:00:00.000Z', graph: g.export() }
  }

  it('re-keys a host-only node and every edge on it, using the node engine', () => {
    const out = migrateSnapshot(v8())
    expect(out.schemaVersion).toBe(SCHEMA_VERSION)
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.import(out.graph)
    const id = databaseId('postgresql', 'payments-db')
    expect(g.hasNode('database:payments-db')).toBe(false)
    expect(g.getNodeAttributes(id)).toMatchObject({ id, engine: 'postgresql', host: 'payments-db' })
    const e = observedEdgeId(serviceId('api'), id, EdgeType.CONNECTS_TO)
    expect(g.hasEdge(e)).toBe(true)
    expect(g.getEdgeAttributes(e)).toMatchObject({ id: e, source: 'service:api', target: id })
    // A service-local node is not networked and keeps its id.
    expect(g.hasNode('database:api/app.db')).toBe(true)
  })

  it('is idempotent', () => {
    const once = migrateSnapshot(v8())
    const twice = migrateSnapshot(JSON.parse(JSON.stringify(once)))
    expect(twice).toEqual(once)
  })
})
