// SPIKE (R-R.3, research only — not for merge). Two Recon detectors measured
// against today's ingest:
//   1. "declared endpoint never exercised": a RouteNode the extractor declared
//      that no request ever reached, on a service that IS receiving traffic.
//      divergences.ts skips CONTAINS buckets (line ~276), so this never surfaces.
//   2. OBSERVED-first RouteNode minting for shadow endpoints: a SERVER span whose
//      templated `http.route` names no declared route. findRouteNodeByHttpRoute
//      mints nothing on a miss (ingest.ts ~2661), so the endpoint is invisible.
// The prototypes below live in this file on purpose; nothing in src/ changes.

import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  extractedEdgeId,
  routeId,
  serviceId,
  type GraphEdge,
  type GraphNode,
  type RouteNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { ensureServiceNode, handleSpan, type IngestContext } from '../src/ingest.js'
import { parseOtlpRequest, type ParsedSpan } from '../src/otel.js'

const SVC = 'api'

function declare(graph: NeatGraph, method: string, template: string): string {
  const id = routeId(SVC, method, template)
  const node: RouteNode = {
    id,
    type: NodeType.RouteNode,
    name: `${method} ${template}`,
    service: SVC,
    method,
    pathTemplate: template,
    path: 'src/routes.ts',
    framework: 'express',
    discoveredVia: 'static',
  }
  graph.addNode(id, node)
  const eid = extractedEdgeId(serviceId(SVC), id, EdgeType.CONTAINS)
  graph.addEdgeWithKey(eid, serviceId(SVC), id, {
    id: eid,
    source: serviceId(SVC),
    target: id,
    type: EdgeType.CONTAINS,
    provenance: Provenance.EXTRACTED,
    confidence: confidenceForExtracted('structural'),
  } as GraphEdge)
  return id
}

function serverSpan(method: string, attrs: Record<string, string>) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: SVC } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: '0af7651916cd43dd8448eb211c80319c',
                spanId: Math.random().toString(16).slice(2, 18).padEnd(16, '0'),
                name: `${method} ${attrs['http.route'] ?? attrs['url.path']}`,
                kind: 2,
                startTimeUnixNano: '1760648000000000000',
                endTimeUnixNano: '1760648000004000000',
                attributes: [
                  { key: 'http.request.method', value: { stringValue: method } },
                  ...Object.entries(attrs).map(([key, v]) => ({ key, value: { stringValue: v } })),
                  { key: 'http.response.status_code', value: { intValue: '200' } },
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

function observedContains(graph: NeatGraph, routeNode: string): boolean {
  return graph.inboundEdges(routeNode).some((e) => {
    const a = graph.getEdgeAttributes(e) as GraphEdge
    return a.type === EdgeType.CONTAINS && a.provenance === Provenance.OBSERVED
  })
}

// ── prototype 1: route-unexercised ───────────────────────────────────────────
// A declared route with no OBSERVED CONTAINS, on a service that has at least one
// route with one — so the service is instrumented and serving, and the silence
// is the route's, not the instrumentation's.
function unexercisedRoutes(graph: NeatGraph): string[] {
  const routesBySvc = new Map<string, string[]>()
  graph.forEachNode((id, a) => {
    const r = a as RouteNode & { type?: string }
    if (r.type !== NodeType.RouteNode || r.discoveredVia === 'otel') return
    routesBySvc.set(r.service, [...(routesBySvc.get(r.service) ?? []), id])
  })
  const out: string[] = []
  for (const routes of routesBySvc.values()) {
    if (!routes.some((r) => observedContains(graph, r))) continue // not instrumented / no traffic: say nothing
    for (const r of routes) if (!observedContains(graph, r)) out.push(r)
  }
  return out.sort()
}

// ── prototype 2: OBSERVED-first shadow route ─────────────────────────────────
// After ingest, a SERVER span with a templated route that fused to nothing mints
// a RouteNode (`discoveredVia: 'otel'`) and its OBSERVED CONTAINS. A concrete
// path (no template) never mints: one node per URL would be unbounded.
function mintShadowRoute(graph: NeatGraph, span: ParsedSpan): string | undefined {
  if (span.kind !== 2 || !span.httpRoute) return undefined
  const method = (span.httpMethod ?? 'ALL').toUpperCase()
  const id = routeId(span.service, method, span.httpRoute)
  if (graph.hasNode(id)) return undefined
  let declared = false
  graph.forEachNode((_id, a) => {
    const r = a as RouteNode & { type?: string }
    if (r.type === NodeType.RouteNode && r.service === span.service && r.pathTemplate === span.httpRoute) declared = true
  })
  if (declared) return undefined
  graph.addNode(id, {
    id,
    type: NodeType.RouteNode,
    name: `${method} ${span.httpRoute}`,
    service: span.service,
    method,
    pathTemplate: span.httpRoute,
    discoveredVia: 'otel',
  } as RouteNode)
  return id
}

async function ingest(ctx: IngestContext, req: unknown, mint = false): Promise<string[]> {
  const minted: string[] = []
  for (const span of parseOtlpRequest(req as never)) {
    await handleSpan(ctx, span)
    if (mint) {
      const id = mintShadowRoute(ctx.graph, span)
      if (id) minted.push(id)
    }
  }
  return minted
}

function fresh(): IngestContext {
  const graph: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  ensureServiceNode(graph, SVC)
  return { graph, writeErrorEventInline: false }
}

describe('R-R.3 spike — declared endpoint never exercised', () => {
  it('today: a declared route no request hit raises nothing; the prototype names it', async () => {
    const ctx = fresh()
    const users = declare(ctx.graph, 'GET', '/users/:id')
    const exp = declare(ctx.graph, 'POST', '/admin/export')
    await ingest(ctx, serverSpan('GET', { 'http.route': '/users/:id' }))
    expect(observedContains(ctx.graph, users)).toBe(true)
    expect(observedContains(ctx.graph, exp)).toBe(false)
    expect(unexercisedRoutes(ctx.graph)).toEqual([exp])
  })

  it('says nothing for a service with no observed route traffic at all', async () => {
    const ctx = fresh()
    declare(ctx.graph, 'GET', '/users/:id')
    declare(ctx.graph, 'POST', '/admin/export')
    expect(unexercisedRoutes(ctx.graph)).toEqual([])
  })
})

describe('R-R.3 spike — OBSERVED-first shadow routes', () => {
  it('today: a served route nobody declared leaves no RouteNode', async () => {
    const ctx = fresh()
    declare(ctx.graph, 'GET', '/users/:id')
    await ingest(ctx, serverSpan('POST', { 'http.route': '/internal/debug/:key' }))
    const routes = ctx.graph.filterNodes((_id, a) => (a as GraphNode).type === NodeType.RouteNode)
    expect(routes).toEqual([routeId(SVC, 'GET', '/users/:id')])
  })

  it('prototype: mints it from the template, once, and never from a bare URL', async () => {
    const ctx = fresh()
    declare(ctx.graph, 'GET', '/users/:id')
    const first = await ingest(ctx, serverSpan('POST', { 'http.route': '/internal/debug/:key' }), true)
    const again = await ingest(ctx, serverSpan('POST', { 'http.route': '/internal/debug/:key' }), true)
    const declaredHit = await ingest(ctx, serverSpan('GET', { 'http.route': '/users/:id' }), true)
    const bare = await ingest(ctx, serverSpan('GET', { 'url.path': '/orders/123/items/9' }), true)
    expect(first).toEqual([routeId(SVC, 'POST', '/internal/debug/:key')])
    expect(again).toEqual([])
    expect(declaredHit).toEqual([])
    expect(bare).toEqual([])
    // The shadow route then reads as observed-only, i.e. missing-extracted at route grain.
    const shadow = ctx.graph.getNodeAttributes(first[0]!) as RouteNode
    expect(shadow.discoveredVia).toBe('otel')
  })
})
