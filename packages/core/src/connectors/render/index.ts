// Render connector (ADR-166, docs/connectors/render.md) — a pull provider on
// the connectors plane (ADR-124, connectors/index.ts). Render is a hosting
// platform, so like Railway (ADR-127) it names nothing in application code:
// the signal comes entirely from Render's own edge-layer HTTP request logs
// (`GET /v1/logs?type=request`), and fusion binds onto the RouteNode
// `extract/routes.ts` already builds — the same node an OBSERVED server span
// would fuse onto if the app were OTel-instrumented. This is the second
// route-fusion connector, after Railway's `httpLogs`.

import type { RouteNode } from '@neat.is/types'
import { EdgeType, NodeType } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { normalizePathTemplate } from '../../extract/routes.js'
import type {
  ConnectorCallSite,
  ConnectorContext,
  ObservedConnector,
  ObservedSignal,
  ResolveConnectorTarget,
} from '../index.js'
import type { RenderConnectorConfig, RenderLogEntry } from './types.js'
import { readRenderToken, renderLabelValue } from './types.js'
import {
  DEFAULT_MAX_LOOKBACK_MS,
  boundedRenderStartTime,
  fetchRenderRequestLogs,
} from './client.js'

export type { RenderConnectorConfig, RenderLogEntry, RenderLogLabel, RenderLogsResponse } from './types.js'
export { DEFAULT_RENDER_API_URL } from './client.js'

// A signal's `targetKind` for this provider (connectors/index.ts never inspects
// these strings itself):
//
// - 'route'           — the log's (method, path) normalised onto an existing
//                        RouteNode (extract/routes.ts). targetName already
//                        carries that RouteNode's own graph id.
// - 'unmatched-route' — no RouteNode resolved. createRenderResolveTarget drops
//                        it honestly rather than fabricating a target (a
//                        RouteNode's `path` is a required real source location,
//                        packages/types/src/nodes.ts).
const ROUTE_TARGET_KIND = 'route'
const UNMATCHED_ROUTE_TARGET_KIND = 'unmatched-route'

// ── route index (read-only graph query) ────────────────────────────────────
//
// Mirrors railway/index.ts's own buildRailwayRouteIndex/findRailwayRoute,
// which in turn mirrors extract/calls/route-match.ts — none is imported, since
// none is exported for reuse; each connector rolls the same (method,
// normalised-path) match against its polled service's RouteNodes. Only
// normalizePathTemplate is shared (from routes.ts) so the path-template
// normalisation rules can't drift between the two sides.

interface RenderRouteIndexEntry {
  method: string
  normalizedPath: string
  routeNodeId: string
  path: string
  line?: number
}

export function buildRenderRouteIndex(graph: NeatGraph, serviceName: string): RenderRouteIndexEntry[] {
  const out: RenderRouteIndexEntry[] = []
  graph.forEachNode((_id, attrs) => {
    const node = attrs as unknown as { type?: string }
    if (node.type !== NodeType.RouteNode) return
    const route = attrs as unknown as RouteNode
    if (route.service !== serviceName) return
    out.push({
      method: route.method.toUpperCase(),
      normalizedPath: normalizePathTemplate(route.pathTemplate),
      routeNodeId: route.id,
      path: route.path,
      line: route.line,
    })
  })
  return out
}

// A request log always carries a concrete method — so, like Railway's
// findRailwayRoute (and unlike route-match.ts's client-call-site case), there's
// no "caller method unknown" passthrough, only the route's own `ALL` wildcard.
function findRenderRoute(
  entries: RenderRouteIndexEntry[],
  method: string,
  normalizedPath: string,
): RenderRouteIndexEntry | undefined {
  return entries.find(
    (e) => e.normalizedPath === normalizedPath && (e.method === 'ALL' || e.method === method),
  )
}

function bucketKey(method: string, normalizedPath: string): string {
  return `${method} ${normalizedPath}`
}

function isHttpErrorStatus(status: number): boolean {
  return status >= 400
}

interface SignalBucket {
  callCount: number
  errorCount: number
  lastObservedIso: string
  targetKind: string
  targetName: string
  callSite?: ConnectorCallSite
}

function upsertBucket(
  buckets: Map<string, SignalBucket>,
  key: string,
  isError: boolean,
  timestamp: string,
  build: () => Omit<SignalBucket, 'callCount' | 'errorCount' | 'lastObservedIso'>,
): void {
  const existing = buckets.get(key)
  if (existing) {
    existing.callCount += 1
    if (isError) existing.errorCount += 1
    if (timestamp > existing.lastObservedIso) existing.lastObservedIso = timestamp
    return
  }
  buckets.set(key, { callCount: 1, errorCount: isError ? 1 : 0, lastObservedIso: timestamp, ...build() })
}

// ── request logs → ObservedSignal[] ─────────────────────────────────────────
//
// Route-grain fusion (docs/connectors/render.md §Fusion): read each request
// log's method/path/statusCode from its `labels` (Render's log object shape),
// normalise the path the same way route-match.ts normalises a client call
// site's URL path, and match against the polled service's own RouteNodes. A
// match carries the matched RouteNode's own `path`/`line` as this signal's
// callSite — reconciled onto the EXTRACTED service-relative path by the shared
// fuse step (connectors/index.ts) the same way every other OBSERVED surface
// lands file-grained, because that path IS the extracted path routes.ts walked.
export function mapRenderRequestLogsToSignals(
  entries: RenderLogEntry[],
  routeIndex: RenderRouteIndexEntry[],
): ObservedSignal[] {
  const buckets = new Map<string, SignalBucket>()
  if (!Array.isArray(entries)) return []

  for (const entry of entries) {
    // Drop a null/garbage slot, or a row missing the timestamp/method/path a
    // signal needs, honestly rather than throwing (connectors.md §4). The
    // request attributes live in `labels`; a request log with none isn't one
    // this connector can place on a route.
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.timestamp !== 'string') continue
    const method = renderLabelValue(entry, 'method')
    const rawPath = renderLabelValue(entry, 'path')
    if (typeof method !== 'string' || method.length === 0) continue
    if (typeof rawPath !== 'string' || rawPath.length === 0) continue

    const methodUpper = method.toUpperCase()
    // Strip any query string — the route template is a path, never `?...`.
    const pathOnly = rawPath.split('?')[0]
    const normalizedPath = normalizePathTemplate(pathOnly)
    const statusCode = Number.parseInt(renderLabelValue(entry, 'statusCode') ?? '', 10)
    // A missing/garbage statusCode is not an error signal — treat it as a
    // non-error observation rather than fabricating a 4xx/5xx.
    const isError = Number.isFinite(statusCode) && isHttpErrorStatus(statusCode)
    const match = findRenderRoute(routeIndex, methodUpper, normalizedPath)

    if (match) {
      upsertBucket(buckets, `route:${match.routeNodeId}`, isError, entry.timestamp, () => ({
        targetKind: ROUTE_TARGET_KIND,
        targetName: match.routeNodeId,
        // RouteNode.line is optional in the schema (packages/types/src/
        // nodes.ts) even though routes.ts always sets it today — skip the
        // callSite rather than fabricate a line when it's ever absent
        // (file-awareness.md §6).
        ...(match.line !== undefined ? { callSite: { file: match.path, line: match.line } } : {}),
      }))
    } else {
      // No RouteNode resolves — the app's framework/router isn't one routes.ts
      // recognises yet, or the path matches no declared template. This drops
      // honestly (createRenderResolveTarget returns null for it) rather than
      // fabricating a route target.
      upsertBucket(
        buckets,
        `unmatched:${bucketKey(methodUpper, normalizedPath)}`,
        isError,
        entry.timestamp,
        () => ({
          targetKind: UNMATCHED_ROUTE_TARGET_KIND,
          targetName: bucketKey(methodUpper, normalizedPath),
        }),
      )
    }
  }

  return [...buckets.values()].map((b) => ({
    targetKind: b.targetKind,
    targetName: b.targetName,
    callCount: b.callCount,
    errorCount: b.errorCount,
    lastObservedIso: b.lastObservedIso,
    ...(b.callSite ? { callSite: b.callSite } : {}),
  }))
}

// ── target resolution (provider-specific id-shape mapping) ──────────────────
//
// A pure function of the signal — the route matching already happened in
// poll()/the route index above; resolveTarget's job here is only the
// id-shape mapping (targetKind/targetName → NEAT node id).
export function createRenderResolveTarget(config: RenderConnectorConfig): ResolveConnectorTarget {
  return (signal: ObservedSignal) => {
    if (signal.targetKind === ROUTE_TARGET_KIND) {
      // targetName is already the exact RouteNode graph id the route index
      // resolved — the OBSERVED half of the two-sided divergence, landing on
      // the same node the EXTRACTED client↔route CALLS edge (route-match.ts)
      // and a future OBSERVED server span would.
      return { targetNodeId: signal.targetName, serviceName: config.serviceName, edgeType: EdgeType.CALLS }
    }

    // UNMATCHED_ROUTE_TARGET_KIND (and anything unrecognised): no RouteNode
    // resolved. The shared pipeline (connectors/index.ts) has no primitive to
    // auto-vivify a RouteNode — and RouteNode.path is a required field naming a
    // real source location (packages/types/src/nodes.ts), so minting one here
    // would fabricate provenance (file-awareness.md §6). Returning null routes
    // this through the scaffold's honest-miss path
    // (ConnectorPollResult.unresolved). The gap it leaves — a route Render
    // observes but no static extractor recognises today — belongs to routes.ts's
    // framework coverage, and shrinks as routes.ts grows, the same as Railway.
    return null
  }
}

// ── connector ────────────────────────────────────────────────────────────────
//
// Constructed with a `graph` reference so poll() can read (never mutate, per
// ADR-030 — every write flows back through connectors/index.ts's ingest.ts
// primitives) the polled service's existing RouteNodes to match request logs
// against, the same read-only access extract/calls/route-match.ts has for the
// identical purpose on the static-extraction side.
export function createRenderConnector(graph: NeatGraph, config: RenderConnectorConfig): ObservedConnector {
  return {
    provider: 'render',
    async poll(ctx: ConnectorContext): Promise<ObservedSignal[]> {
      const token = readRenderToken(ctx.credentials)
      const now = new Date()
      const maxLookbackMs = config.maxLookbackMs ?? DEFAULT_MAX_LOOKBACK_MS
      const startTime = boundedRenderStartTime(ctx.since, now, maxLookbackMs)
      const endTime = now.toISOString()

      const logs = await fetchRenderRequestLogs(config, token, startTime, endTime)
      const routeIndex = buildRenderRouteIndex(graph, config.serviceName)
      return mapRenderRequestLogsToSignals(logs, routeIndex)
    },
  }
}
