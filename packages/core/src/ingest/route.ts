import {
  EdgeType,
  NodeType,
  routeId,
  serviceId,
  type RouteNode,
} from '@neat.is/types'
import { normalizePathTemplate, observedRouteTemplate } from '../identity/route.js'
import type { NeatGraph } from '../graph.js'
import type { ParsedSpan } from '../otel.js'
import { pickAttr } from './span.js'
import type { SpanIngest } from './context.js'
import { upsertObservedEdge } from './edges.js'

// Inbound route fusion: SERVER spans onto declared RouteNodes, and
// observed-first RouteNodes (ADR-204, ADR-253, ADR-275).
// Moved out of ingest.ts; ingest.ts re-exports the public names.

// Next.js API-route serving spans name the matched route in `next.span_name`
// (mirrored on the span's own name), NOT in `http.route`: the Pages Router emits
// `executing api route (pages) /api/products/[productId]` and the App Router
// `executing api route (app) /api/products/[productId]`. That phrase carries the
// *templated* route — `[productId]` brackets and all — which is what fuses onto a
// declared RouteNode; the same request's `http.target` carries only the concrete
// path (`/api/products/L9ECAV7KIM`), which no param template ever matches. Pull
// the template out of that phrase so a Next route earns its OBSERVED twin the way
// an Express `http.route` already does (ADR-204). Returns undefined for any span
// without the phrase, so the caller falls back to `http.route` and every other
// framework fuses exactly as before — the source is additive, never a swap.
export const NEXT_API_ROUTE_SPAN_NAME = /^executing api route \((?:pages|app)\) (\/\S*)$/

export function nextApiRouteTemplate(span: ParsedSpan): string | undefined {
  const raw = pickAttr(span, 'next.span_name') ?? span.name
  const match = raw ? NEXT_API_ROUTE_SPAN_NAME.exec(raw) : null
  return match ? match[1] : undefined
}

// Match a SERVER span's `http.route` to the RouteNode the static extractor
// minted, by normalized (method, template) so param-syntax differences
// (`{id}` vs `:id` vs `<int:id>`) don't block the fusion. Returns the node id or
// undefined. An unmatched template mints an observed-first route in handleSpan
// (ADR-275).
export function findRouteNodeByHttpRoute(
  graph: NeatGraph,
  serviceName: string,
  method: string | undefined,
  httpRoute: string,
): string | undefined {
  const target = normalizePathTemplate(httpRoute)
  const m = method?.toUpperCase()
  let found: string | undefined
  graph.forEachNode((id, attrs) => {
    if (found) return
    const a = attrs as RouteNode & { type?: string }
    if (a.type !== NodeType.RouteNode || a.service !== serviceName) return
    if (m && a.method !== 'ALL' && a.method !== m) return
    if (normalizePathTemplate(a.pathTemplate) === target) found = id
  })
  return found
}

// The request path of a SERVER span that names no route template (ADR-253, #1420):
// `url.path`, else `http.target`, else the path of `url.full` / `http.url`, with
// the query and fragment dropped. Jaeger-era and OpenTracing HTTP instrumentation
// records the concrete request and never the matched template.
export function serverRequestPath(span: ParsedSpan): string | undefined {
  let raw = pickAttr(span, 'url.path', 'http.target')
  if (!raw) {
    const url = pickAttr(span, 'url.full', 'http.url')
    if (!url) return undefined
    try {
      raw = new URL(url).pathname
    } catch {
      return undefined
    }
  }
  const path = raw.split('?')[0]!.split('#')[0]!
  return path.startsWith('/') ? path : undefined
}

// A declared template segment that names a parameter: `:id`, `{id}`, `<id>` /
// `<int:id>`, `[id]`.
export function isTemplateParam(seg: string): boolean {
  return seg.startsWith(':') || seg.startsWith('{') || seg.startsWith('<') || seg.startsWith('[')
}

// Match a SERVER span's concrete request path against the RouteNodes the static
// extractor minted for its service. A param segment matches exactly one path
// segment, a literal matches itself (case-insensitive), and the method must agree
// when the span names one. Exactly one matching route joins; none or several join
// nothing, so a request that two declared routes could serve is never guessed at.
// A concrete URL never mints a RouteNode; only a template does (ADR-275).
export function findRouteNodeByRequestPath(
  graph: NeatGraph,
  serviceName: string,
  method: string | undefined,
  requestPath: string,
): string | undefined {
  const segs = requestPath.split('/').filter((x) => x.length > 0)
  const m = method?.toUpperCase()
  const matches: string[] = []
  graph.forEachNode((id, attrs) => {
    const a = attrs as RouteNode & { type?: string }
    if (a.type !== NodeType.RouteNode || a.service !== serviceName) return
    if (m && a.method !== 'ALL' && a.method !== m) return
    const tpl = a.pathTemplate.split('?')[0]!.split('/').filter((x) => x.length > 0)
    if (tpl.length !== segs.length) return
    for (let i = 0; i < tpl.length; i++) {
      if (isTemplateParam(tpl[i]!)) continue
      if (tpl[i]!.toLowerCase() !== segs[i]!.toLowerCase()) return
    }
    matches.push(id)
  })
  return matches.length === 1 ? matches[0] : undefined
}

// The HTTP methods a route can be keyed on. A span whose method falls outside
// them (semconv's `_OTHER`, a custom verb) still fuses onto a declared route but
// never mints one.
export const ROUTE_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE'])

// Mint a RouteNode from a served route no extractor declared (ADR-275), the
// observed-first shape gRPC methods, GraphQL operations and WebSocket channels
// already have. Keyed on `routeId(service, method, template)`, the id a static
// extractor gives the same route, so a later extraction lands on this node and
// flips it to `merged`. `path` / `line` come from the span's `code.*` (the
// route's registration frame NEAT's instrumentation stamps) when present, and are
// otherwise absent, never fabricated (file-awareness.md §6).
export function ensureObservedRouteNode(
  graph: NeatGraph,
  service: string,
  method: string,
  template: string,
  callSite: { file: string; line?: number } | undefined,
): string {
  const id = routeId(service, method, template)
  if (graph.hasNode(id)) return id
  const node: RouteNode = {
    id,
    type: NodeType.RouteNode,
    name: `${method} ${template}`,
    service,
    method,
    pathTemplate: template,
    ...(callSite ? { path: callSite.file } : {}),
    ...(callSite?.line !== undefined ? { line: callSite.line } : {}),
    discoveredVia: 'otel',
  }
  graph.addNode(id, node)
  return id
}

export function ingestServerRoute(s: SpanIngest): void {
  const { ctx, span, ts, isError, durationMs, errorDetail, callSiteEvidence } = s
  // A SERVER span's route fuses onto the declared RouteNode, giving an inbound
  // route its OBSERVED twin the way GraphQL/gRPC serving spans do (#576). Matched
  // by normalized (method, template) so a route NEAT extracted gets its observed
  // counterpart. Next.js names
  // the template in `next.span_name` rather than `http.route`, so prefer that
  // templated form over the concrete path when it's present (ADR-204); a span
  // carrying neither falls through with no edge, as before.
  // With no template at all, the concrete request path joins a declared route only
  // when exactly one route of this service matches it (ADR-253).
  // A template that matches no declared route mints an observed-first RouteNode
  // (ADR-275), like a gRPC method or GraphQL operation; a bare path never does.
  const fusionRoute = nextApiRouteTemplate(span) ?? span.httpRoute
  const requestPath = fusionRoute ? undefined : serverRequestPath(span)
  if (
    (fusionRoute || requestPath) &&
    (span.kind === 2 || span.kind === 1 || span.kind === 0 || span.kind === undefined)
  ) {
    let routeNodeId = fusionRoute
      ? findRouteNodeByHttpRoute(ctx.graph, span.service, span.httpMethod, fusionRoute)
      : findRouteNodeByRequestPath(ctx.graph, span.service, span.httpMethod, requestPath!)
    // A template no extractor declared mints its own RouteNode (ADR-275). A bare
    // request path never does: only a template names a route. A gRPC call served
    // over HTTP (C# Grpc.AspNetCore's `/pkg.Service/Method` route) is a method,
    // not a route, and its node is minted above.
    const method = span.httpMethod?.toUpperCase()
    const template = fusionRoute ? observedRouteTemplate(fusionRoute) : undefined
    if (!routeNodeId && template && method && ROUTE_METHODS.has(method) && !span.rpcService) {
      routeNodeId = ensureObservedRouteNode(ctx.graph, span.service, method, template, callSiteEvidence)
    }
    if (routeNodeId) {
      const routeSvc = (ctx.graph.getNodeAttributes(routeNodeId) as RouteNode).service
      upsertObservedEdge(ctx.graph, EdgeType.CONTAINS, serviceId(routeSvc), routeNodeId, ts, isError, undefined, durationMs, errorDetail, s.env)
    }
  }
}
