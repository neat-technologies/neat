import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { GraphEdge, RouteNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  extractedEdgeId,
  fileId,
  routeId,
  serviceId,
} from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'routes')

// ADR-119 — server-route extraction + HTTP client↔route cross-service matching.
// The fixture is a real two-service shape: an Express `api-server` defining
// routes and a `web-client` calling them through fetch / axios, plus Fastify
// and Next.js servers for router-coverage. Everything parses like real source.
describe('route extraction + client↔route matching (ADR-119)', () => {
  beforeEach(() => resetGraph())

  it('materialises Express route nodes with method + path-template + file:line', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const getUser = routeId('api-server', 'GET', '/users/:id')
    expect(graph.hasNode(getUser)).toBe(true)
    const node = graph.getNodeAttributes(getUser) as RouteNode
    expect(node.type).toBe(NodeType.RouteNode)
    expect(node.method).toBe('GET')
    expect(node.pathTemplate).toBe('/users/:id')
    expect(node.service).toBe('api-server')
    expect(node.path).toBe('index.js')
    expect(node.line).toBeGreaterThan(0)
    expect(node.framework).toBe('express')

    expect(graph.hasNode(routeId('api-server', 'POST', '/users'))).toBe(true)
    expect(graph.hasNode(routeId('api-server', 'GET', '/health'))).toBe(true)

    // The service owns its routes through a CONTAINS edge, carrying file:line.
    const containsId = extractedEdgeId(serviceId('api-server'), getUser, EdgeType.CONTAINS)
    expect(graph.hasEdge(containsId)).toBe(true)
    const contains = graph.getEdgeAttributes(containsId) as GraphEdge
    expect(contains.provenance).toBe(Provenance.EXTRACTED)
    expect(contains.evidence?.file).toBe('index.js')
    expect(contains.evidence?.line).toBeGreaterThan(0)
  })

  it('extracts Fastify routes (method call + fastify.route object form)', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    expect(graph.hasNode(routeId('fastify-server', 'GET', '/ping'))).toBe(true)
    const del = routeId('fastify-server', 'DELETE', '/items/:itemId')
    expect(graph.hasNode(del)).toBe(true)
    expect((graph.getNodeAttributes(del) as RouteNode).framework).toBe('fastify')
  })

  it('extracts Next.js app-router and pages-api routes from file convention', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // app/orders/[orderId]/route.ts exports GET + POST → two routes at /orders/:orderId.
    expect(graph.hasNode(routeId('next-app', 'GET', '/orders/:orderId'))).toBe(true)
    expect(graph.hasNode(routeId('next-app', 'POST', '/orders/:orderId'))).toBe(true)
    // pages/api/legacy/[id].ts → a method-agnostic route.
    const legacy = routeId('next-app', 'ALL', '/api/legacy/:id')
    expect(graph.hasNode(legacy)).toBe(true)
    expect((graph.getNodeAttributes(legacy) as RouteNode).framework).toBe('next')
  })

  it('mints a matched cross-service CALLS edge at route granularity', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const clientFile = fileId('web-client', 'index.js')
    const route = routeId('api-server', 'GET', '/users/:id')
    const edgeId = extractedEdgeId(clientFile, route, EdgeType.CALLS)

    expect(graph.hasEdge(edgeId)).toBe(true)
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.type).toBe(EdgeType.CALLS)
    expect(edge.provenance).toBe(Provenance.EXTRACTED)
    // verified-call-site grade — a recognised client shape matched to a parsed
    // route on both ends.
    expect(edge.confidence).toBeCloseTo(0.85, 2)

    // The client call-site edge carries the method + path-template it named.
    expect(edge.evidence?.file).toBe('index.js')
    expect(edge.evidence?.line).toBeGreaterThan(0)
    expect(edge.evidence?.method).toBe('GET')
    expect(edge.evidence?.pathTemplate).toBe('/users/:param')
  })

  it('matches the POST body-method call and the axios method-call form', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const clientFile = fileId('web-client', 'index.js')

    const post = extractedEdgeId(
      clientFile,
      routeId('api-server', 'POST', '/users'),
      EdgeType.CALLS,
    )
    expect(graph.hasEdge(post)).toBe(true)
    expect((graph.getEdgeAttributes(post) as GraphEdge).evidence?.method).toBe('POST')

    const health = extractedEdgeId(
      clientFile,
      routeId('api-server', 'GET', '/health'),
      EdgeType.CALLS,
    )
    expect(graph.hasEdge(health)).toBe(true)
    expect((graph.getEdgeAttributes(health) as GraphEdge).evidence?.method).toBe('GET')
  })

  it('is idempotent — a second pass adds no nodes or edges', async () => {
    const graph = getGraph()
    const first = await extractFromDirectory(graph, FIXTURES)
    const second = await extractFromDirectory(graph, FIXTURES)
    expect(second.nodesAdded).toBe(0)
    expect(second.edgesAdded).toBe(0)
    expect(first.nodesAdded).toBeGreaterThan(0)
  })
})
