import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { GraphEdge, InfraNode, ServiceNode } from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'infra')

describe('Railway service extraction (platform tag)', () => {
  beforeEach(() => resetGraph())

  it('tags the ServiceNode with platform: railway', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'railway'))
    const service = graph.getNodeAttributes('service:railway-api') as ServiceNode
    expect(service.platform).toBe('railway')
  })

  it('emits a railway runtime node + RUNS_ON edge from the service', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'railway'))
    const runtimeId = 'infra:railway:railway'
    expect(graph.hasNode(runtimeId)).toBe(true)
    expect((graph.getNodeAttributes(runtimeId) as InfraNode).provider).toBe('railway')

    const edgeId = `RUNS_ON:service:railway-api->${runtimeId}`
    expect(graph.hasEdge(edgeId)).toBe(true)
    expect((graph.getEdgeAttributes(edgeId) as GraphEdge).provenance).toBe('EXTRACTED')
  })

  it('healthcheck path becomes a railway-route CONNECTS_TO; cron becomes railway-cron DEPENDS_ON', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'railway'))

    const routeId = 'infra:railway-route:/healthz'
    expect(graph.hasNode(routeId)).toBe(true)
    expect(graph.hasEdge(`CONNECTS_TO:service:railway-api->${routeId}`)).toBe(true)

    const cronId = 'infra:railway-cron:0 2 * * *'
    expect(graph.hasNode(cronId)).toBe(true)
    expect(graph.hasEdge(`DEPENDS_ON:service:railway-api->${cronId}`)).toBe(true)
  })
})
