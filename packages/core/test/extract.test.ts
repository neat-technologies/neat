import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { ConfigNode, DatabaseNode, ServiceNode } from '@neat.is/types'

// repoRoot/demo
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEMO_PATH = path.resolve(__dirname, '../../../demo')

describe('extractFromDirectory against demo/', () => {
  beforeEach(() => resetGraph())

  it('produces the M1 graph shape', async () => {
    const graph = getGraph()
    const result = await extractFromDirectory(graph, DEMO_PATH)

    expect(result.nodesAdded).toBeGreaterThanOrEqual(3)
    expect(result.edgesAdded).toBeGreaterThanOrEqual(2)
    expect(graph.order).toBeGreaterThanOrEqual(3)
    expect(graph.size).toBeGreaterThanOrEqual(2)
  })

  it('emits a service-b ServiceNode that declares pg 7.4.0 in its dependencies', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, DEMO_PATH)

    expect(graph.hasNode('service:service-b')).toBe(true)
    const serviceB = graph.getNodeAttributes('service:service-b') as ServiceNode
    expect(serviceB.dependencies?.pg).toBe('7.4.0')
  })

  it('emits a payments-db DatabaseNode with engineVersion = "15"', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, DEMO_PATH)

    expect(graph.hasNode('database:payments-db')).toBe(true)
    const db = graph.getNodeAttributes('database:payments-db') as DatabaseNode
    expect(db.engine).toBe('postgresql')
    expect(db.engineVersion).toBe('15')
    expect(db.compatibleDrivers.find((d) => d.name === 'pg')?.minVersion).toBe('8.0.0')
  })

  it('flags pg 7.4.0 as incompatible on service-b', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, DEMO_PATH)
    const serviceB = graph.getNodeAttributes('service:service-b') as ServiceNode
    expect(serviceB.incompatibilities).toBeDefined()
    expect(serviceB.incompatibilities?.[0]).toMatchObject({
      driver: 'pg',
      driverVersion: '7.4.0',
      engine: 'postgresql',
      engineVersion: '15',
    })
  })

  it('emits a CONNECTS_TO edge from service-b to payments-db', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, DEMO_PATH)

    const edges = graph.outboundEdges('service:service-b')
    const connectEdges = edges.filter(
      (e) => graph.getEdgeAttribute(e, 'type') === 'CONNECTS_TO',
    )
    expect(connectEdges).toHaveLength(1)
    expect(graph.target(connectEdges[0]!)).toBe('database:payments-db')
  })

  it('emits a CALLS edge from service-a to service-b (tree-sitter URL match)', async () => {
    // ADR-066 — the cross-service URL/hostname match grades at the
    // hostname-shape tier (0.2) and drops below the default precision floor
    // (0.7). The detector still runs; flip the floor off here so the test
    // exercises full recall and proves the matcher works.
    const prev = process.env.NEAT_EXTRACTED_PRECISION_FLOOR
    process.env.NEAT_EXTRACTED_PRECISION_FLOOR = '0'
    try {
      const graph = getGraph()
      await extractFromDirectory(graph, DEMO_PATH)

      // File-first (ADR-089): the CALLS edge originates from the file the call
      // site lives in, with service-a ──CONTAINS──▶ that file. The service
      // reaches service-b through its file, not directly.
      const callEdges = graph
        .edges()
        .filter((e) => graph.getEdgeAttribute(e, 'type') === 'CALLS')
      const aToB = callEdges.filter(
        (e) => graph.source(e).startsWith('file:service-a:') && graph.target(e) === 'service:service-b',
      )
      expect(aToB.length).toBeGreaterThanOrEqual(1)
      for (const e of aToB) {
        expect(graph.hasEdge(`CONTAINS:service:service-a->${graph.source(e)}`)).toBe(true)
      }
    } finally {
      if (prev === undefined) delete process.env.NEAT_EXTRACTED_PRECISION_FLOOR
      else process.env.NEAT_EXTRACTED_PRECISION_FLOOR = prev
    }
  })

  it('emits a ConfigNode for service-b/db-config.yaml with a CONFIGURED_BY edge', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, DEMO_PATH)

    const id = 'config:service-b/db-config.yaml'
    expect(graph.hasNode(id)).toBe(true)
    const node = graph.getNodeAttributes(id) as ConfigNode
    expect(node.type).toBe('ConfigNode')
    expect(node.fileType).toBe('yaml')
    expect(node.path).toBe('service-b/db-config.yaml')
    expect(node.name).toBe('db-config.yaml')

    const edges = graph.outboundEdges('service:service-b')
    const configuredBy = edges.filter(
      (e) => graph.getEdgeAttribute(e, 'type') === 'CONFIGURED_BY',
    )
    expect(configuredBy).toHaveLength(1)
    expect(graph.target(configuredBy[0]!)).toBe(id)
  })

  it('all extracted edges have provenance EXTRACTED', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, DEMO_PATH)
    graph.forEachEdge((_id, attrs) => {
      expect(attrs.provenance).toBe('EXTRACTED')
    })
  })

  it('is idempotent — running twice does not add duplicate nodes/edges', async () => {
    const graph = getGraph()
    const first = await extractFromDirectory(graph, DEMO_PATH)
    const orderBefore = graph.order
    const sizeBefore = graph.size
    const second = await extractFromDirectory(graph, DEMO_PATH)
    expect(second.nodesAdded).toBe(0)
    expect(second.edgesAdded).toBe(0)
    expect(graph.order).toBe(orderBefore)
    expect(graph.size).toBe(sizeBefore)
    expect(first.nodesAdded).toBeGreaterThan(0)
  })
})
