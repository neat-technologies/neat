import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { FileNode, GraphEdge, InfraNode, ServiceNode } from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'infra')

describe('Cloudflare Workers/Pages extraction (ADR-133)', () => {
  beforeEach(() => resetGraph())

  it('tags the ServiceNode and entry FileNode with platform: cloudflare', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'cloudflare'))

    const service = graph.getNodeAttributes('service:orders-worker') as ServiceNode
    expect(service.platform).toBe('cloudflare')

    const entryFileId = 'file:orders-worker:src/index.ts'
    expect(graph.hasNode(entryFileId)).toBe(true)
    const file = graph.getNodeAttributes(entryFileId) as FileNode
    expect(file.platform).toBe('cloudflare')
    expect(file.platformName).toBe('orders-api')
  })

  it('emits a shared workerd runtime node + RUNS_ON edge carrying compatibility_date as evidence', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'cloudflare'))

    const runtimeId = 'infra:workerd:cloudflare'
    expect(graph.hasNode(runtimeId)).toBe(true)
    const runtime = graph.getNodeAttributes(runtimeId) as InfraNode
    expect(runtime.provider).toBe('cloudflare')

    const entryFileId = 'file:orders-worker:src/index.ts'
    const edgeId = `RUNS_ON:${entryFileId}->${runtimeId}`
    expect(graph.hasEdge(edgeId)).toBe(true)
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.provenance).toBe('EXTRACTED')
    expect(edge.evidence?.snippet).toContain('2024-09-01')

    // Both fixture workers share the one runtime node — a single Cloudflare
    // "runs atop workerd" fact, not one per Worker.
    const notifEntryId = 'file:notifications-worker:src/index.ts'
    expect(graph.hasEdge(`RUNS_ON:${notifEntryId}->${runtimeId}`)).toBe(true)
  })

  it('routes/custom domains become cloudflare-route InfraNodes wired CONNECTS_TO from the entry file', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'cloudflare'))

    const routeId = 'infra:cloudflare-route:api.example.com/orders/*'
    expect(graph.hasNode(routeId)).toBe(true)
    const entryFileId = 'file:orders-worker:src/index.ts'
    const edgeId = `CONNECTS_TO:${entryFileId}->${routeId}`
    expect(graph.hasEdge(edgeId)).toBe(true)
    expect((graph.getEdgeAttributes(edgeId) as GraphEdge).type).toBe('CONNECTS_TO')
  })

  it('KV/D1/R2/Durable Object/Queue/cron bindings become InfraNodes wired DEPENDS_ON from the entry file', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'cloudflare'))

    const entryFileId = 'file:orders-worker:src/index.ts'
    const expected: [string, string][] = [
      ['infra:cloudflare-kv:SESSIONS', 'cloudflare-kv'],
      ['infra:cloudflare-d1:ORDERS_DB', 'cloudflare-d1'],
      ['infra:cloudflare-r2:UPLOADS', 'cloudflare-r2'],
      ['infra:cloudflare-durable-object:ORDER_COUNTER', 'cloudflare-durable-object'],
      ['infra:cloudflare-queue:order-events', 'cloudflare-queue'],
      ['infra:cloudflare-cron:0 0 * * *', 'cloudflare-cron'],
    ]
    for (const [nodeId, kind] of expected) {
      expect(graph.hasNode(nodeId)).toBe(true)
      expect((graph.getNodeAttributes(nodeId) as InfraNode).kind).toBe(kind)
      const edgeId = `DEPENDS_ON:${entryFileId}->${nodeId}`
      expect(graph.hasEdge(edgeId)).toBe(true)
    }
  })

  it('declares env-var existence only, never the value', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'cloudflare'))

    const varNodeId = 'infra:cloudflare-env-var:LOG_LEVEL'
    expect(graph.hasNode(varNodeId)).toBe(true)
    const varNode = graph.getNodeAttributes(varNodeId) as InfraNode
    expect(varNode.name).toBe('LOG_LEVEL')
    // No value anywhere on the node or its declaring edge.
    expect(JSON.stringify(varNode)).not.toContain('info')
    const entryFileId = 'file:orders-worker:src/index.ts'
    const edge = graph.getEdgeAttributes(`DEPENDS_ON:${entryFileId}->${varNodeId}`) as GraphEdge
    expect(JSON.stringify(edge)).not.toContain('info')
  })

  it('resolves a service binding directly onto the target Worker entry FileNode when tagged in the same scan (CALLS)', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'cloudflare'))

    const ordersEntry = 'file:orders-worker:src/index.ts'
    const notifEntry = 'file:notifications-worker:src/index.ts'
    const edgeId = `CALLS:${ordersEntry}->${notifEntry}`
    expect(graph.hasEdge(edgeId)).toBe(true)
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.provenance).toBe('EXTRACTED')

    // No cloudflare-service-binding InfraNode fallback — it resolved to a real node.
    expect(graph.hasNode('infra:cloudflare-service-binding:notifications-api')).toBe(false)
  })

  it('falls back to a cloudflare-service-binding InfraNode when the target Worker is not in this scan', async () => {
    const graph = getGraph()
    // notifications-worker alone: its own config has no service bindings, so
    // scan just orders-worker in isolation to exercise the honest fallback.
    await extractFromDirectory(graph, path.join(FIXTURES, 'cloudflare', 'orders-worker'))

    const fallbackId = 'infra:cloudflare-service-binding:notifications-api'
    expect(graph.hasNode(fallbackId)).toBe(true)
    const entryFileId = 'file:orders-worker:src/index.ts'
    expect(graph.hasEdge(`DEPENDS_ON:${entryFileId}->${fallbackId}`)).toBe(true)
  })

  it('reads wrangler.jsonc (comments stripped) the same as wrangler.toml', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'cloudflare-jsonc'))

    const service = graph.getNodeAttributes('service:pages-fn') as ServiceNode
    expect(service.platform).toBe('cloudflare')
    const entryFileId = 'file:pages-fn:src/index.ts'
    const file = graph.getNodeAttributes(entryFileId) as FileNode
    expect(file.platformName).toBe('pages-fn-api')
    expect(graph.hasNode('infra:cloudflare-env-var:LOG_LEVEL')).toBe(true)
  })

  it('is idempotent: running extraction twice produces the same node/edge counts', async () => {
    const graph = getGraph()
    const first = await extractFromDirectory(graph, path.join(FIXTURES, 'cloudflare'))
    const nodesAfterFirst = graph.order
    const edgesAfterFirst = graph.size

    const second = await extractFromDirectory(graph, path.join(FIXTURES, 'cloudflare'))
    expect(graph.order).toBe(nodesAfterFirst)
    expect(graph.size).toBe(edgesAfterFirst)
    expect(first.nodesAdded).toBeGreaterThan(0)
    expect(second).toBeDefined()
  })
})
