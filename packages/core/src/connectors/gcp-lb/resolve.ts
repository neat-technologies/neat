// Target resolution — the GCP-LB-specific half of the pull/map/fuse split
// (connectors.md §Authority): turning a signal's (backend_service_name, method,
// path) into a NEAT node id. Two tiers, in order (docs/connectors/gcp-lb.md
// §Fusion), mirroring Cloud Run's resolver exactly:
//
//   1. Route grain — map the GCP `backend_service_name` to a NEAT manifest
//      service via the config-time `backendServiceMap` (resolved once, never
//      guessed), then match (method, path) against a RouteNode that service
//      declares, using the same path-template normalisation extract/routes.ts
//      uses. A match lands the OBSERVED CALLS edge on that RouteNode; the shared
//      pipeline sharpens it to the route's own definition file/line (ADR-143).
//      This file precision is drawn from the STATIC route definition, not a
//      runtime code.* stamp (an LB fronts un-instrumented backends).
//   2. Backend grain, honestly — no static route resolves. The connector does
//      not fabricate a route. It declares an honest fallback via
//      `ensureInfraNode` (connectors.md §4a, ADR-133): the edge lands on
//      `infraId('gcp-lb-backend', backend_service_name)`, the LB backend service
//      the log's own `resource.labels.backend_service_name` names — a real
//      platform resource — surfacing as a `missing-extracted` divergence rather
//      than a silent drop. An unmapped backend sources the edge from that
//      backend's own name, so a connector added before the backendServiceMap is
//      filled stays coarse rather than silent.
//
// This module never mutates the graph (ADR-030) — it reads RouteNode attributes
// already there and declares the infra-node need for the shared pipeline to
// enact, matching every other file in packages/core/src/connectors/**.

import { EdgeType, NodeType, infraId, type RouteNode } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { normalizePathTemplate } from '../../extract/routes.js'
import type { ResolveConnectorTarget, ResolvedConnectorTarget } from '../index.js'
import {
  GCP_LB_TARGET_KIND,
  parseGcpLbTargetName,
  type GcpLbConnectorConfig,
} from './types.js'

// The InfraNode kind the tier-2 honest fallback lands on. A future GCP
// load-balancing / backend-service extractor (the analog of Cloudflare's
// extract/infra/cloudflare.ts) should mint the same `infraId('gcp-lb-backend',
// name)` so declared and observed fuse rather than twin.
const GCP_LB_BACKEND_INFRA_KIND = 'gcp-lb-backend'

// Scan the polled service's own RouteNodes for one whose normalised
// (method, path) matches this request — the same param-agnostic comparison
// route-match.ts uses for cross-service HTTP client↔route matching, and the
// same per-call graph scan Cloud Run's connector and ingest.ts's
// reconcileObservedRelPath already use (per-project route counts are small
// enough not to warrant a cache the live graph would have to invalidate on
// every re-extraction).
function findMatchingRouteNode(
  graph: NeatGraph,
  serviceName: string,
  method: string,
  normalizedPath: string,
): string | null {
  let found: string | null = null
  graph.forEachNode((_id, attrs) => {
    if (found) return
    const node = attrs as unknown as { type?: string }
    if (node.type !== NodeType.RouteNode) return
    const route = attrs as unknown as RouteNode
    if (route.service !== serviceName || !route.pathTemplate) return
    if (normalizePathTemplate(route.pathTemplate) !== normalizedPath) return
    const routeMethod = route.method.toUpperCase()
    if (routeMethod !== 'ALL' && routeMethod !== method) return
    found = route.id
  })
  return found
}

// Builds the resolveTarget callback runConnectorPoll (connectors/index.ts)
// calls once per signal. Closes over `graph` because ResolveConnectorTarget's
// own signature (connectors/types.ts) doesn't carry it — the same closure
// pattern every ConnectorRegistration's resolveTarget uses.
export function createGcpLbResolveTarget(
  graph: NeatGraph,
  config: GcpLbConnectorConfig,
): ResolveConnectorTarget {
  return (signal): ResolvedConnectorTarget | null => {
    if (signal.targetKind !== GCP_LB_TARGET_KIND) return null
    const identity = parseGcpLbTargetName(signal.targetName)
    if (!identity) return null
    const { backendServiceName, method, path } = identity

    const mappedService = config.backendServiceMap?.[backendServiceName]

    // Tier 1 — mapped service + a matching static route → route grain.
    if (mappedService) {
      const routeNodeId = findMatchingRouteNode(
        graph,
        mappedService,
        method,
        normalizePathTemplate(path),
      )
      if (routeNodeId) {
        return { targetNodeId: routeNodeId, serviceName: mappedService, edgeType: EdgeType.CALLS }
      }
    }

    // Tier 2 — no static route resolved (or the backend is unmapped). Land an
    // honest backend-grained edge on the LB backend service's own InfraNode
    // rather than fabricating a route or dropping the observation. The source is
    // the mapped NEAT service when known, else the backend service name itself
    // (auto-created by the shared pipeline the same way Cloud Run's own fallback
    // auto-creates its source).
    return {
      targetNodeId: infraId(GCP_LB_BACKEND_INFRA_KIND, backendServiceName),
      serviceName: mappedService ?? backendServiceName,
      edgeType: EdgeType.CALLS,
      ensureInfraNode: {
        kind: GCP_LB_BACKEND_INFRA_KIND,
        name: backendServiceName,
        provider: 'gcp-lb',
      },
    }
  }
}
