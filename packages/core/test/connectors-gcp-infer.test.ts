import { describe, it, expect, vi, afterEach } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  infraId,
  routeId,
  serviceId,
  type GraphEdge,
  type GraphNode,
  type RouteNode,
  type ServiceNode,
} from '@neat.is/types'
import { inferServiceName } from '../src/connectors/infer-service.js'
import { createCloudRunResolveTarget } from '../src/connectors/cloud-run/resolve.js'
import { packCloudRunTargetName, CLOUD_RUN_TARGET_KIND } from '../src/connectors/cloud-run/types.js'
import { createGcpLbResolveTarget } from '../src/connectors/gcp-lb/resolve.js'
import { packGcpLbTargetName, GCP_LB_TARGET_KIND } from '../src/connectors/gcp-lb/types.js'
import { createFirebaseConnector } from '../src/connectors/firebase/index.js'
import type { NeatGraph } from '../src/graph.js'

function graphWith(...services: { name: string; routes: [string, string][] }[]): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  for (const s of services) {
    const svc: ServiceNode = { id: serviceId(s.name), type: NodeType.ServiceNode, name: s.name, language: 'typescript' }
    g.addNode(svc.id, svc)
    for (const [method, pathTemplate] of s.routes) {
      const route: RouteNode = {
        id: routeId(s.name, method, pathTemplate),
        type: NodeType.RouteNode,
        name: `${method} ${pathTemplate}`,
        service: s.name,
        method,
        pathTemplate,
        path: 'src/index.ts',
        line: 1,
        framework: 'express',
        discoveredVia: 'static',
      }
      g.addNode(route.id, route)
    }
  }
  return g
}

const ctx = {} as never

describe('inferServiceName (shared GCP inference)', () => {
  it('matches a service by name, ignoring case and separators', () => {
    const g = graphWith({ name: 'Orders_API', routes: [] })
    expect(inferServiceName(g, 'orders-api', 'GET', '/x')).toBe('Orders_API')
  })

  it('falls back to the one service that declares the route', () => {
    const g = graphWith({ name: 'orders', routes: [['GET', '/orders/:id']] }, { name: 'billing', routes: [] })
    expect(inferServiceName(g, 'generate-post', 'get', '/orders/42')).toBe('orders')
  })

  it('treats an ALL route as matching any method', () => {
    const g = graphWith({ name: 'orders', routes: [['ALL', '/orders/:id']] })
    expect(inferServiceName(g, 'x', 'POST', '/orders/9')).toBe('orders')
  })

  it('returns null when two services declare the route, or none does', () => {
    const g = graphWith({ name: 'a', routes: [['GET', '/orders/:id']] }, { name: 'b', routes: [['GET', '/orders/:id']] })
    expect(inferServiceName(g, 'x', 'GET', '/orders/1')).toBeNull()
    expect(inferServiceName(g, 'x', 'GET', '/nope')).toBeNull()
  })
})

describe('Cloud Run and gcp-lb inferServices', () => {
  const g = () => graphWith({ name: 'rheos-backend', routes: [['GET', '/posts/:id']] })

  it('cloud-run resolves an unmapped service to a route when inferServices is on', () => {
    const resolve = createCloudRunResolveTarget(g(), { inferServices: true })
    const out = resolve(
      { targetKind: CLOUD_RUN_TARGET_KIND, targetName: packCloudRunTargetName({ serviceName: 'generatepost', method: 'GET', path: '/posts/7' }) } as never,
      ctx,
    )
    expect(out).toMatchObject({ targetNodeId: routeId('rheos-backend', 'GET', '/posts/:id'), serviceName: 'rheos-backend' })
  })

  it('cloud-run stays coarse for an unmapped service when inferServices is off (local behaviour)', () => {
    const resolve = createCloudRunResolveTarget(g(), {})
    const out = resolve(
      { targetKind: CLOUD_RUN_TARGET_KIND, targetName: packCloudRunTargetName({ serviceName: 'generatepost', method: 'GET', path: '/posts/7' }) } as never,
      ctx,
    )
    expect(out).toMatchObject({ targetNodeId: infraId('cloud-run-service', 'generatepost'), edgeType: EdgeType.CALLS })
  })

  it('cloud-run keeps an explicit map entry over inference', () => {
    const graph = graphWith({ name: 'rheos-backend', routes: [['GET', '/posts/:id']] }, { name: 'other', routes: [] })
    const resolve = createCloudRunResolveTarget(graph, { inferServices: true, serviceMap: { generatepost: 'other' } })
    const out = resolve(
      { targetKind: CLOUD_RUN_TARGET_KIND, targetName: packCloudRunTargetName({ serviceName: 'generatepost', method: 'GET', path: '/posts/7' }) } as never,
      ctx,
    )
    // Mapped to 'other', which has no such route, so it lands service-grained from 'other', not rheos-backend.
    expect(out).toMatchObject({ serviceName: 'other' })
  })

  it('gcp-lb resolves an unmapped backend to a route when inferServices is on, and stays coarse when off', () => {
    const signal = {
      targetKind: GCP_LB_TARGET_KIND,
      targetName: packGcpLbTargetName({ backendServiceName: 'be-1', method: 'GET', path: '/posts/7' }),
    } as never
    expect(createGcpLbResolveTarget(g(), { inferServices: true })(signal, ctx)).toMatchObject({
      targetNodeId: routeId('rheos-backend', 'GET', '/posts/:id'),
    })
    expect(createGcpLbResolveTarget(g(), {})(signal, ctx)).toMatchObject({
      targetNodeId: infraId('gcp-lb-backend', 'be-1'),
    })
  })
})

describe('Firebase excludeCloudRun', () => {
  afterEach(() => vi.unstubAllGlobals())

  async function filterFor(serviceMap: Parameters<typeof createFirebaseConnector>[1]): Promise<string> {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)
    const { connector } = createFirebaseConnector(graphWith(), serviceMap)
    await connector.poll({ projectDir: '/repo', credentials: { projectId: 'p', accessToken: 't' } } as never)
    return JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).filter as string
  }

  it('polls all three resource types by default', async () => {
    const filter = await filterFor({})
    expect(filter).toContain('"cloud_function" OR "cloud_run_revision" OR "firebase_domain"')
  })

  it('leaves cloud_run_revision to the Cloud Run connector when excludeCloudRun is set', async () => {
    const filter = await filterFor({ excludeCloudRun: true })
    expect(filter).not.toContain('cloud_run_revision')
    expect(filter).toContain('"cloud_function" OR "firebase_domain"')
  })
})
