// Railway connector (ADR-127, docs/connectors/railway.md) — the second
// connectors-plane provider after the shared pull/map/fuse scaffold
// (ADR-124, connectors/index.ts). Railway names nothing in application code:
// the signal comes entirely from Railway's own edge/ingress layer (httpLogs)
// and L4 flow records (networkFlowLogs), so fusion binds onto the RouteNode
// `extract/routes.ts` already builds — the same node an OBSERVED server span
// would fuse onto if the app were OTel-instrumented — rather than a
// client-SDK call site the way the Supabase connector design does.

import type { RouteNode } from '@neat.is/types'
import { EdgeType, NodeType, serviceId } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { normalizePathTemplate } from '../../extract/routes.js'
import type {
  ConnectorCallSite,
  ConnectorContext,
  ObservedConnector,
  ObservedSignal,
  ResolveConnectorTarget,
} from '../index.js'
import type { RailwayConnectorConfig, RailwayHttpLogEntry, RailwayNetworkFlowLogEntry } from './types.js'
import {
  DEFAULT_MAX_LOOKBACK_MS,
  boundedRailwayStartDate,
  fetchRailwayHttpLogs,
  fetchRailwayNetworkFlowLogs,
  readRailwayToken,
  resolveLatestRailwayDeploymentId,
} from './client.js'

export type { RailwayConnectorConfig, RailwayHttpLogEntry, RailwayNetworkFlowLogEntry } from './types.js'
export { DEFAULT_RAILWAY_API_URL, resolveLatestRailwayDeploymentId } from './client.js'

// A signal's `targetKind` for this provider (README.md's "provider's own
// vocabulary" — connectors/index.ts never inspects these strings itself):
//
// - 'route'           — the record's (method, path) normalised onto an
//                        existing RouteNode (extract/routes.ts). targetName
//                        already carries that RouteNode's own graph id.
// - 'unmatched-route' — no RouteNode resolved. See createRailwayResolveTarget
//                        below for why this drops honestly rather than
//                        fabricating a target.
// - 'peer-service'    — a networkFlowLogs record naming another Railway
//                        service. targetName carries the raw Railway
//                        peerServiceId, resolved through config.serviceNameById.
const ROUTE_TARGET_KIND = 'route'
const UNMATCHED_ROUTE_TARGET_KIND = 'unmatched-route'
const PEER_SERVICE_TARGET_KIND = 'peer-service'

// ── route index (read-only graph query) ────────────────────────────────────
//
// Mirrors extract/calls/route-match.ts's own buildRouteIndex/findRoute — not
// imported, since neither is exported from that module (only
// normalizePathTemplate is, which this file reuses directly rather than
// re-deriving the path-template normalisation rules). This is the
// connectors-plane side of the same (method, normalised-path) matching
// route-match.ts already does for a client call site, applied here to
// Railway's own edge-observed (method, path) pairs instead of a parsed HTTP
// client call (docs/connectors/railway.md §Fusion).

interface RailwayRouteIndexEntry {
  method: string
  normalizedPath: string
  routeNodeId: string
  path: string
  line?: number
}

export function buildRailwayRouteIndex(graph: NeatGraph, serviceName: string): RailwayRouteIndexEntry[] {
  const out: RailwayRouteIndexEntry[] = []
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

// httpLogs always carries a concrete method (unlike a statically parsed
// client call site, which sometimes can't determine one) — so unlike
// route-match.ts's findRoute, there's no "caller method unknown" passthrough
// case, only the route's own `ALL` wildcard.
function findRailwayRoute(
  entries: RailwayRouteIndexEntry[],
  method: string,
  normalizedPath: string,
): RailwayRouteIndexEntry | undefined {
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

// ── httpLogs → ObservedSignal[] ─────────────────────────────────────────────
//
// Route-grain fusion (docs/connectors/railway.md §Fusion): normalise each
// record's `path` the same way route-match.ts normalises a client call
// site's URL path, then match against the polled service's own RouteNodes.
// A match carries the matched RouteNode's own `path`/`line` as this signal's
// callSite — reconciled onto the EXTRACTED service-relative path
// (connectors/index.ts's shared fuse step) the same way every other OBSERVED
// surface in NEAT lands file-grained, because that path IS the extracted
// path a static pass already walked (routes.ts's own file:line).
export function mapRailwayHttpLogsToSignals(
  entries: RailwayHttpLogEntry[],
  routeIndex: RailwayRouteIndexEntry[],
): ObservedSignal[] {
  const buckets = new Map<string, SignalBucket>()

  for (const entry of entries) {
    const method = entry.method.toUpperCase()
    const normalizedPath = normalizePathTemplate(entry.path)
    const match = findRailwayRoute(routeIndex, method, normalizedPath)
    const isError = isHttpErrorStatus(entry.httpStatus)

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
      // No RouteNode resolves — the app's framework/router isn't one
      // routes.ts recognises yet, or the path doesn't match any declared
      // template. See createRailwayResolveTarget below for why this
      // targetKind always resolves to null (an honest "unresolved" miss)
      // rather than a fabricated target.
      upsertBucket(
        buckets,
        `unmatched:${bucketKey(method, normalizedPath)}`,
        isError,
        entry.timestamp,
        () => ({
          targetKind: UNMATCHED_ROUTE_TARGET_KIND,
          targetName: bucketKey(method, normalizedPath),
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

// ── networkFlowLogs → ObservedSignal[] ──────────────────────────────────────
//
// Service-dependency signal, independent of any route (docs/connectors/
// railway.md §Fusion — "independent of whether any route resolves for the
// traffic that produced the flow"). A record with no `peerServiceId` names
// no Railway-internal peer (public internet egress, say) and is dropped
// honestly — never guessed at.
export function mapRailwayNetworkFlowLogsToSignals(
  entries: RailwayNetworkFlowLogEntry[],
): ObservedSignal[] {
  const buckets = new Map<string, SignalBucket>()

  for (const entry of entries) {
    if (!entry.peerServiceId) continue
    const isError = entry.dropCause !== null && entry.dropCause !== ''
    upsertBucket(buckets, entry.peerServiceId, isError, entry.timestamp, () => ({
      targetKind: PEER_SERVICE_TARGET_KIND,
      targetName: entry.peerServiceId as string,
    }))
  }

  return [...buckets.values()].map((b) => ({
    targetKind: b.targetKind,
    targetName: b.targetName,
    callCount: b.callCount,
    errorCount: b.errorCount,
    lastObservedIso: b.lastObservedIso,
  }))
}

// ── target resolution (README.md pipeline step 2 — provider-specific) ──────
//
// A pure function of (signal, ctx, config) — no graph access, unlike
// poll()/the route index above, which need a read-only graph query to match
// against existing RouteNodes. That matching already happened in poll();
// resolveTarget's job here is only the id-shape mapping README.md describes
// ("targetKind/targetName → NEAT node id").
export function createRailwayResolveTarget(config: RailwayConnectorConfig): ResolveConnectorTarget {
  return (signal: ObservedSignal) => {
    const serviceName = config.serviceNameById[config.serviceId]
    // This connector's own polled service has no configured mapping — a
    // config error, not something to guess past (docs/connectors/railway.md
    // §Fusion, "resolved once, never guessed").
    if (!serviceName) return null

    if (signal.targetKind === ROUTE_TARGET_KIND) {
      // targetName is already the exact RouteNode graph id poll()'s route
      // index resolved — this is the two-sided divergence's OBSERVED half,
      // landing on the same node the EXTRACTED client↔route CALLS edge
      // (route-match.ts, ADR-119) and a future OBSERVED server span (#576)
      // would.
      return { targetNodeId: signal.targetName, serviceName, edgeType: EdgeType.CALLS }
    }

    if (signal.targetKind === PEER_SERVICE_TARGET_KIND) {
      const peerName = config.serviceNameById[signal.targetName]
      // Unmapped peer serviceId — dropped honestly rather than guessed
      // (docs/connectors/railway.md §Fusion). A future config update adding
      // the mapping picks this traffic up on the next poll; it never
      // fabricates a peer identity in the meantime.
      if (!peerName) return null
      return { targetNodeId: serviceId(peerName), serviceName, edgeType: EdgeType.CONNECTS_TO }
    }

    // UNMATCHED_ROUTE_TARGET_KIND (and anything else unrecognised): no
    // RouteNode resolved for this traffic, and the scaffold's shared pipeline
    // (connectors/index.ts) has no primitive to auto-vivify one the way
    // ensureGraphqlOperationNode/ensureGrpcMethodNode do for an OTel span
    // (ingest.ts) — those exist on the OTLP-ingest path, not on
    // ResolveConnectorTarget's (signal, ctx) => ResolvedConnectorTarget
    // shape, which only names an id, never creates one. Even if it could:
    // RouteNode.path is a required field (packages/types/src/nodes.ts)
    // naming the real source location a static extractor found — a
    // Railway-observed route with no static match has no honest value to
    // put there, so minting one here would fabricate provenance
    // (file-awareness.md §6). Returning null routes this through the
    // scaffold's own honest-miss path (ConnectorPollResult.unresolved)
    // instead of forcing an edge. See this PR's description for the gap
    // this leaves open: a route Railway observes but no static extractor
    // recognises today produces no missing-extracted divergence via this
    // connector, pending either a scaffold extension (observed-first target
    // creation, mirroring the OTel-ingest pattern) or a product decision on
    // how to represent it without fabricating a path.
    return null
  }
}

// ── connector ────────────────────────────────────────────────────────────────
//
// Constructed with a `graph` reference so poll() can read (never mutate,
// per ADR-030 mutation authority — every write this connector's signals
// eventually cause flows back through connectors/index.ts's ingest.ts
// primitives, not through this module) the polled service's existing
// RouteNodes to match httpLogs against, the same read-only access
// extract/calls/route-match.ts already has to the graph for the identical
// purpose on the static-extraction side.
export function createRailwayConnector(graph: NeatGraph, config: RailwayConnectorConfig): ObservedConnector {
  return {
    provider: 'railway',
    async poll(ctx: ConnectorContext): Promise<ObservedSignal[]> {
      const token = readRailwayToken(ctx.credentials)
      const now = new Date()
      const maxLookbackMs = config.maxLookbackMs ?? DEFAULT_MAX_LOOKBACK_MS
      const startDate = boundedRailwayStartDate(ctx.since, now, maxLookbackMs)
      const endDate = now.toISOString()

      // httpLogs is scoped by deploymentId, which is minted fresh on every
      // redeploy — resolved here, every poll, from the stable
      // (environmentId, serviceId) pair (client.ts). A service with no
      // deployment yet (or none this token can see) gets an honest empty
      // httpLogs result rather than a thrown error — the same "empty window,
      // not a failure" treatment an empty startDate..endDate range gets.
      const deploymentId = await resolveLatestRailwayDeploymentId(config, token)
      // allSettled, not all: httpLogs and networkFlowLogs are independent
      // surfaces (docs/connectors/railway.md §Surfaces) — a transient failure
      // on one (a flaky upstream 400, a timeout) shouldn't discard a
      // perfectly good result from the other. Each failure is reported
      // through ctx's own onError path (connectors/index.ts's
      // startConnectorPollLoop), not swallowed — it just doesn't cost the
      // other surface's signals too.
      const [httpLogsResult, flowLogsResult] = await Promise.allSettled([
        deploymentId ? fetchRailwayHttpLogs(config, token, deploymentId, startDate, endDate) : Promise.resolve([]),
        fetchRailwayNetworkFlowLogs(config, token),
      ])
      if (httpLogsResult.status === 'rejected') {
        console.error('[neat connector] railway httpLogs poll failed', httpLogsResult.reason)
      }
      if (flowLogsResult.status === 'rejected') {
        console.error('[neat connector] railway networkFlowLogs poll failed', flowLogsResult.reason)
      }
      const httpLogs = httpLogsResult.status === 'fulfilled' ? httpLogsResult.value : []
      const flowLogs = flowLogsResult.status === 'fulfilled' ? flowLogsResult.value : []

      const serviceName = config.serviceNameById[config.serviceId]
      const routeIndex = serviceName ? buildRailwayRouteIndex(graph, serviceName) : []

      return [
        ...mapRailwayHttpLogsToSignals(httpLogs, routeIndex),
        ...mapRailwayNetworkFlowLogsToSignals(flowLogs),
      ]
    },
  }
}
