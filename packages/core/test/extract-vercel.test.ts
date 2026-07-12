import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { GraphEdge, InfraNode, ServiceNode } from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'infra')

describe('Vercel project extraction (platform tag)', () => {
  beforeEach(() => resetGraph())

  it('tags the ServiceNode with platform: vercel and platformName from .vercel/project.json', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'vercel'))

    const service = graph.getNodeAttributes('service:vercel-shop') as ServiceNode
    expect(service.platform).toBe('vercel')
    expect(service.platformName).toBe('shop-prod')
  })

  it('emits a shared vercel runtime node + RUNS_ON edge from the service', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'vercel'))

    const runtimeId = 'infra:vercel:vercel'
    expect(graph.hasNode(runtimeId)).toBe(true)
    expect((graph.getNodeAttributes(runtimeId) as InfraNode).provider).toBe('vercel')

    const edgeId = `RUNS_ON:service:vercel-shop->${runtimeId}`
    expect(graph.hasEdge(edgeId)).toBe(true)
    expect((graph.getEdgeAttributes(edgeId) as GraphEdge).provenance).toBe('EXTRACTED')
  })

  it('crons and env-var names become DEPENDS_ON InfraNodes; the value is never read', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'vercel'))

    const cronId = 'infra:vercel-cron:/api/cron/digest'
    expect(graph.hasNode(cronId)).toBe(true)
    expect(graph.hasEdge(`DEPENDS_ON:service:vercel-shop->${cronId}`)).toBe(true)

    const envId = 'infra:vercel-env-var:API_KEY'
    expect(graph.hasNode(envId)).toBe(true)
    // name only — the value "@api-key" is never a node.
    expect(graph.hasNode('infra:vercel-env-var:@api-key')).toBe(false)
  })

  it('rewrites become vercel-route InfraNodes wired CONNECTS_TO from the service', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'vercel'))

    const routeId = 'infra:vercel-route:/legacy/:path*'
    expect(graph.hasNode(routeId)).toBe(true)
    const edgeId = `CONNECTS_TO:service:vercel-shop->${routeId}`
    expect(graph.hasEdge(edgeId)).toBe(true)
    expect((graph.getEdgeAttributes(edgeId) as GraphEdge).type).toBe('CONNECTS_TO')
  })

  it('leaves a non-Vercel service untouched (no platform tag)', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'cloudflare'))

    // The cloudflare fixture's services must not pick up a vercel tag.
    const service = graph.getNodeAttributes('service:orders-worker') as ServiceNode
    expect(service.platform).not.toBe('vercel')
  })
})
