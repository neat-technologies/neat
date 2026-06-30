import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { computeDivergences } from '../src/divergences.js'
import {
  EdgeType,
  NodeType,
  Provenance,
  databaseId,
  type DatabaseNode,
  type GraphEdge,
  type ServiceNode,
} from '@neat.is/types'

// A plain DB connection string in config is the most common shape there is.
// Before #586 the extractor parsed it into a DatabaseNode but never recorded
// where the service was pointed (`dbConnectionTarget`) nor a service-level
// CONFIGURED_BY edge, so the `host-mismatch` divergence could never fire.
describe('declared DB connection target (#586)', () => {
  let dir: string

  beforeEach(async () => {
    resetGraph()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-dbtarget-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function writeService(): Promise<void> {
    const svc = path.join(dir, 'svc')
    await fs.mkdir(svc, { recursive: true })
    await fs.writeFile(
      path.join(svc, 'package.json'),
      JSON.stringify({ name: 'orders', version: '1.0.0', dependencies: { pg: '8.11.0' } }),
    )
    await fs.writeFile(
      path.join(svc, '.env'),
      'DATABASE_URL=postgres://user:pw@host.x:5432/orders\n',
    )
  }

  it('parses a postgres:// connection string into a DatabaseNode plus a declared target on the service', async () => {
    await writeService()
    const graph = getGraph()
    await extractFromDirectory(graph, dir)

    const dbId = databaseId('host.x')
    expect(graph.hasNode(dbId)).toBe(true)
    const db = graph.getNodeAttributes(dbId) as DatabaseNode
    expect(db.engine).toBe('postgresql')
    expect(db.host).toBe('host.x')
    expect(db.port).toBe(5432)

    const svc = graph.getNodeAttributes('service:orders') as ServiceNode
    expect(svc.dbConnectionTarget).toBe('host.x:5432')

    // A service-grained EXTRACTED CONFIGURED_BY edge backs the declared target
    // so the host-mismatch detector's gate is satisfiable.
    const configuredBy = graph
      .outboundEdges('service:orders')
      .map((e) => graph.getEdgeAttributes(e) as GraphEdge)
      .filter(
        (e) =>
          e.type === EdgeType.CONFIGURED_BY && e.provenance === Provenance.EXTRACTED,
      )
    expect(configuredBy).toHaveLength(1)
    expect(configuredBy[0]!.evidence?.file).toMatch(/\.env$/)
  })

  it('surfaces host-mismatch when production connects to a different host than config declares', async () => {
    await writeService()
    const graph = getGraph()
    await extractFromDirectory(graph, dir)

    // Production was OBSERVED connecting to host.y, not the declared host.x.
    const observedDbId = databaseId('host.y')
    graph.addNode(observedDbId, {
      id: observedDbId,
      type: NodeType.DatabaseNode,
      name: 'host.y',
      engine: 'postgresql',
      engineVersion: 'unknown',
      compatibleDrivers: [],
      host: 'host.y',
      discoveredVia: 'otel',
    } as DatabaseNode)
    const obsEdge = `${EdgeType.CONNECTS_TO}:OBSERVED:service:orders->${observedDbId}`
    graph.addEdgeWithKey(obsEdge, 'service:orders', observedDbId, {
      id: obsEdge,
      source: 'service:orders',
      target: observedDbId,
      type: EdgeType.CONNECTS_TO,
      provenance: Provenance.OBSERVED,
    })

    const result = computeDivergences(graph)
    const hit = result.divergences.find((d) => d.type === 'host-mismatch')
    expect(hit).toBeDefined()
    if (hit?.type === 'host-mismatch') {
      expect(hit.extractedHost).toBe('host.x')
      expect(hit.observedHost).toBe('host.y')
    }
  })
})
