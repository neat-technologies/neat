import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { MultiDirectedGraph } from 'graphology'
import { EdgeType, NodeType, Provenance, routeId, type GraphEdge, type GraphNode } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract/index.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import { parseOtlpRequest } from '../src/otel.js'

// #1420 — hotel-reservation's frontend (Jaeger Go client via SREGym's collector)
// sends SERVER spans with `http.method` and `http.url` and no `http.route`:
// `HTTP GET /hotels`, url `http://localhost:5000/hotels?inDate=…`. Ingest joined a
// SERVER span to a RouteNode on `http.route` only, so the inbound half never
// reached a declared route. With no template on the span, the concrete request
// path now joins the service's one matching EXTRACTED route (ADR-253).

const GO_MOD = 'module example.com/frontend\n\ngo 1.22\n'
const MAIN_GO = `package main

import "net/http"

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /hotels", searchHandler)
	mux.HandleFunc("GET /hotels/{id}", hotelHandler)
	mux.HandleFunc("POST /reservation", reservationHandler)
	mux.HandleFunc("GET /users/{id}", userHandler)
	mux.HandleFunc("GET /users/me", meHandler)
	http.ListenAndServe(":5000", mux)
}
`

const TRACE = '6e0c63257de34c92bf9efcd03927272e'
let n = 0
function serverSpan(service: string, method: string, url: string, attrs: Record<string, string> = {}, kind = 2) {
  n++
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: TRACE,
                spanId: n.toString(16).padStart(16, '0'),
                name: `HTTP ${method} ${new URL(url).pathname}`,
                kind,
                startTimeUnixNano: '1760654454000000000',
                endTimeUnixNano: '1760654454003000000',
                attributes: [
                  { key: 'component', value: { stringValue: 'net/http' } },
                  { key: 'http.method', value: { stringValue: method } },
                  { key: 'http.url', value: { stringValue: url } },
                  { key: 'http.status_code', value: { intValue: '200' } },
                  ...Object.entries(attrs).map(([key, v]) => ({ key, value: { stringValue: v } })),
                ],
                status: {},
              },
            ],
          },
        ],
      },
    ],
  }
}

describe('a SERVER span with no route template joins its declared route by path (#1420)', () => {
  let dir: string
  let service: string

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-1420-'))
    await fs.mkdir(path.join(dir, 'frontend'))
    await fs.writeFile(path.join(dir, 'frontend', 'go.mod'), GO_MOD)
    await fs.writeFile(path.join(dir, 'frontend', 'main.go'), MAIN_GO)
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function fresh(): Promise<{ g: NeatGraph; ctx: IngestContext }> {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    await extractFromDirectory(g, dir)
    const services = g.filterNodes((_id, a) => (a as GraphNode).type === NodeType.ServiceNode)
    expect(services).toHaveLength(1)
    service = (g.getNodeAttributes(services[0]!) as { name: string }).name
    return { g, ctx: { graph: g, errorsPath: path.join(dir, 'errors.ndjson') } }
  }
  function observedRouteEdges(g: NeatGraph): string[] {
    return g
      .filterEdges(
        (_e, a) =>
          (a as GraphEdge).type === EdgeType.CONTAINS &&
          (a as GraphEdge).provenance === Provenance.OBSERVED &&
          g.getNodeAttributes((a as GraphEdge).target).type === NodeType.RouteNode,
      )
      .map((e) => (g.getEdgeAttributes(e) as GraphEdge).target)
      .sort()
  }
  async function ingest(ctx: IngestContext, req: ReturnType<typeof serverSpan>): Promise<void> {
    for (const s of parseOtlpRequest(req)) await handleSpan(ctx, s)
  }

  it('the extractor minted the routes the spans should join', async () => {
    const { g } = await fresh()
    expect(g.hasNode(routeId(service, 'GET', '/hotels'))).toBe(true)
    expect(g.hasNode(routeId(service, 'GET', '/hotels/{id}'))).toBe(true)
  })

  it('a literal path joins its route, query dropped', async () => {
    const { g, ctx } = await fresh()
    await ingest(ctx, serverSpan(service, 'GET', 'http://localhost:5000/hotels?inDate=2015-04-09&outDate=2015-04-10&lat=37.7&lon=-122.4'))
    expect(observedRouteEdges(g)).toEqual([routeId(service, 'GET', '/hotels')])
  })

  it('a param segment matches exactly one path segment', async () => {
    const { g, ctx } = await fresh()
    await ingest(ctx, serverSpan(service, 'GET', 'http://localhost:5000/hotels/42'))
    await ingest(ctx, serverSpan(service, 'GET', 'http://localhost:5000/hotels/42/rooms'))
    expect(observedRouteEdges(g)).toEqual([routeId(service, 'GET', '/hotels/{id}')])
  })

  it('the method has to agree', async () => {
    const { g, ctx } = await fresh()
    await ingest(ctx, serverSpan(service, 'GET', 'http://localhost:5000/reservation'))
    expect(observedRouteEdges(g)).toEqual([])
    await ingest(ctx, serverSpan(service, 'POST', 'http://localhost:5000/reservation'))
    expect(observedRouteEdges(g)).toEqual([routeId(service, 'POST', '/reservation')])
  })

  it('two matching routes join nothing', async () => {
    // /users/me matches both GET /users/me and GET /users/{id}.
    const { g, ctx } = await fresh()
    await ingest(ctx, serverSpan(service, 'GET', 'http://localhost:5000/users/me'))
    expect(observedRouteEdges(g)).toEqual([])
  })

  it('an undeclared path joins nothing and mints no route', async () => {
    const { g, ctx } = await fresh()
    const before = g.filterNodes((_id, a) => (a as GraphNode).type === NodeType.RouteNode).length
    await ingest(ctx, serverSpan(service, 'GET', 'http://localhost:5000/recommendations?require=rate'))
    expect(observedRouteEdges(g)).toEqual([])
    expect(g.filterNodes((_id, a) => (a as GraphNode).type === NodeType.RouteNode)).toHaveLength(before)
  })

  it('url.path / http.target are read when present', async () => {
    const { g, ctx } = await fresh()
    await ingest(ctx, serverSpan(service, 'GET', 'http://localhost:5000/ignored', { 'http.target': '/hotels/7?x=1' }))
    expect(observedRouteEdges(g)).toEqual([routeId(service, 'GET', '/hotels/{id}')])
  })

  it('http.route still wins when the span has one', async () => {
    const { g, ctx } = await fresh()
    await ingest(ctx, serverSpan(service, 'GET', 'http://localhost:5000/users/me', { 'http.route': '/users/{id}' }))
    expect(observedRouteEdges(g)).toEqual([routeId(service, 'GET', '/users/{id}')])
  })

  it('a CLIENT span never joins a route by its URL', async () => {
    const { g, ctx } = await fresh()
    await ingest(ctx, serverSpan(service, 'GET', 'http://localhost:5000/hotels', {}, 3))
    expect(observedRouteEdges(g)).toEqual([])
  })
})
