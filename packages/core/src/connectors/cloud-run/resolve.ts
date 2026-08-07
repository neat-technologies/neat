// Target resolution — the Cloud-Run-specific half of the pull/map/fuse split
// (connectors.md §Authority): turning a signal's (service_name, method, path)
// into a NEAT node id. Two tiers, in order (docs/connectors/cloud-run.md
// §Fusion):
//
//   1. Route grain — map the GCP `service_name` to a NEAT manifest service via
//      the config-time `serviceMap` (resolved once, never guessed), then match
//      (method, path) against a RouteNode that service declares, using the same
//      path-template normalisation extract/routes.ts uses. A match lands the
//      OBSERVED CALLS edge on that RouteNode; the shared pipeline sharpens it to
//      the route's own definition file/line (ADR-143). This file precision is
//      drawn from the STATIC route definition, not a runtime code.* stamp.
//   2. Service grain, honestly — no static route resolves. The connector does
//      not fabricate a route. It declares an honest fallback via
//      `ensureInfraNode` (connectors.md §4a, ADR-133): the edge lands on
//      `infraId('cloud-run-service', service_name)`, the Cloud Run service the
//      log's own `resource.labels.service_name` names — a real platform
//      resource — surfacing as a `missing-extracted` divergence rather than a
//      silent drop. An unmapped service sources the edge from that service's own
//      name, so a connector added before the serviceMap is filled stays coarse
//      rather than silent.
//
// This module never mutates the graph (ADR-030) — it reads RouteNode attributes
// already there and declares the infra-node need for the shared pipeline to
// enact, matching every other file in packages/core/src/connectors/**.

import { EdgeType, NodeType, infraId, type RouteNode } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { normalizePathTemplate } from '../../extract/routes.js'
import type { ResolveConnectorTarget, ResolvedConnectorTarget } from '../index.js'
import {
  CLOUD_RUN_TARGET_KIND,
  parseCloudRunTargetName,
  type CloudRunConnectorConfig,
} from './types.js'

// The InfraNode kind the tier-2 honest fallback lands on. A future Cloud Run
// service-manifest extractor (the analog of Cloudflare's
// extract/infra/cloudflare.ts) should mint the same `infraId('cloud-run-service',
// name)` so declared and observed fuse rather than twin.
const CLOUD_RUN_SERVICE_INFRA_KIND = 'cloud-run-service'

// Scan the polled service's own RouteNodes for one whose normalised
// (method, path) matches this request — the same param-agnostic comparison
// route-match.ts uses for cross-service HTTP client↔route matching, and the
// same per-call graph scan Firebase's connector and ingest.ts's
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
export function createCloudRunResolveTarget(
  graph: NeatGraph,
  config: CloudRunConnectorConfig,
): ResolveConnectorTarget {
  return (signal): ResolvedConnectorTarget | null => {
    if (signal.targetKind !== CLOUD_RUN_TARGET_KIND) return null
    const identity = parseCloudRunTargetName(signal.targetName)
    if (!identity) return null
    const { serviceName: gcpServiceName, method, path } = identity

    const mappedService = config.serviceMap?.[gcpServiceName]

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

    // Tier 2 — no static route resolved (or the service is unmapped). Land an
    // honest service-grained edge on the Cloud Run service's own InfraNode
    // rather than fabricating a route or dropping the observation. The source
    // is the mapped NEAT service when known, else the Cloud Run service name
    // itself (auto-created by the shared pipeline the same way Cloudflare's own
    // fallback auto-creates its source).
    return {
      targetNodeId: infraId(CLOUD_RUN_SERVICE_INFRA_KIND, gcpServiceName),
      serviceName: mappedService ?? gcpServiceName,
      edgeType: EdgeType.CALLS,
      ensureInfraNode: {
        kind: CLOUD_RUN_SERVICE_INFRA_KIND,
        name: gcpServiceName,
        provider: 'cloud-run',
      },
    }
  }
}
