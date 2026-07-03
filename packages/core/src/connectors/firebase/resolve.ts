// Target resolution — the Firebase-specific half of the pull/map/fuse split
// (connectors.md §Authority): turning a signal's (resourceName, method,
// path) into a NEAT node id. Two independent lookups happen here, in order:
//
//   1. resourceName -> NEAT manifest service name, via an explicit config-time
//      mapping (FirebaseServiceMap below) — GCP resource names won't
//      generally match `package.json#name`, the same gap ADR-127 documents
//      for Railway's own `serviceId` and resolves the same way: supplied
//      once at connector setup, never guessed at poll time.
//   2. (service, method, path) -> a statically-extracted RouteNode, via the
//      same path-template normalisation extract/calls/route-match.ts already
//      uses to match a client call site against a server's declared route.
//
// A miss at either step returns null — an honest, documented gap (firebase.md
// §Fusion's "raw handler, no Express app" case), never a fabricated edge.
//
// This module never mutates the graph (ADR-030) — it only reads RouteNode /
// ServiceNode attributes already there, matching every other file in
// packages/core/src/connectors/**.

import { NodeType, EdgeType, type RouteNode } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { normalizePathTemplate } from '../../extract/routes.js'
import type { ConnectorContext, ObservedSignal } from '../types.js'
import type { ResolveConnectorTarget, ResolvedConnectorTarget } from '../index.js'
import type { FirebaseResourceType } from './logging-api.js'
import { parseFirebaseTargetName } from './map.js'

// Explicit config-time mapping from a GCP hosting-platform resource name to
// the NEAT manifest service name that resolves `serviceId(name)`
// (packages/types/src/identity.ts) — the same "resolved once, never guessed"
// discipline ADR-127 states for Railway's serviceId mapping. Keyed by
// resource type because the same literal name could coincidentally collide
// across a Cloud Function, a Cloud Run service, and a Hosting site.
export interface FirebaseServiceMap {
  // Cloud Functions (2nd gen) surfaced under the `cloud_function` monitored
  // resource — function_name -> NEAT service name.
  functions?: Record<string, string>
  // Cloud Run services, including 2nd-gen Functions surfaced under
  // `cloud_run_revision` instead — service_name -> NEAT service name.
  cloudRun?: Record<string, string>
  // Firebase Hosting sites (`firebase_domain`) — site_name -> NEAT service
  // name.
  hosting?: Record<string, string>
}

function neatServiceNameFor(
  resourceType: FirebaseResourceType,
  resourceName: string,
  serviceMap: FirebaseServiceMap,
): string | null {
  switch (resourceType) {
    case 'cloud_function':
      return serviceMap.functions?.[resourceName] ?? null
    case 'cloud_run_revision':
      return serviceMap.cloudRun?.[resourceName] ?? null
    case 'firebase_domain':
      return serviceMap.hosting?.[resourceName] ?? null
  }
}

interface RouteEntry {
  method: string
  normalizedPath: string
  routeNodeId: string
}

// Every RouteNode owned by one NEAT service, normalised for matching — the
// same reduction extract/calls/route-match.ts's buildRouteIndex applies,
// scoped here to a single service since resolveTarget already knows which
// service a signal maps to. Rebuilt per call rather than cached: a connector
// poll tick runs at most once a minute (DEFAULT_POLL_INTERVAL_MS,
// connectors/index.ts) against a project-sized graph, so a fresh scan per
// signal is cheap relative to the network round-trip poll() already made,
// and it never risks matching against a stale route table if static
// extraction re-ran mid-poll.
function routeEntriesFor(graph: NeatGraph, serviceName: string): RouteEntry[] {
  const entries: RouteEntry[] = []
  graph.forEachNode((_id, attrs) => {
    const node = attrs as unknown as { type?: string }
    if (node.type !== NodeType.RouteNode) return
    const route = attrs as unknown as RouteNode
    if (route.service !== serviceName) return
    entries.push({
      method: route.method.toUpperCase(),
      normalizedPath: normalizePathTemplate(route.pathTemplate),
      routeNodeId: route.id,
    })
  })
  return entries
}

// Same compatibility rule route-match.ts's findRoute uses: exact normalised-
// path match, and a method match unless the route is method-agnostic (`ALL`)
// — a connector signal's method is always known (Cloud Logging's
// httpRequest.requestMethod), unlike a statically-parsed client call site
// where the method can be unresolvable, so there's no "method undetermined"
// branch to mirror here.
function findRoute(entries: RouteEntry[], method: string, normalizedPath: string): RouteEntry | undefined {
  return entries.find(
    (e) => e.normalizedPath === normalizedPath && (e.method === 'ALL' || e.method === method),
  )
}

// Builds the resolveTarget callback runConnectorPoll (connectors/index.ts)
// calls once per signal. Closes over `graph` because ResolveConnectorTarget's
// own signature (types.ts) doesn't carry it — the same closure pattern every
// ConnectorRegistration's resolveTarget is expected to use.
export function createFirebaseResolveTarget(
  graph: NeatGraph,
  serviceMap: FirebaseServiceMap,
): ResolveConnectorTarget {
  return (signal: ObservedSignal, _ctx: ConnectorContext): ResolvedConnectorTarget | null => {
    const resourceType = signal.targetKind
    if (resourceType !== 'cloud_function' && resourceType !== 'cloud_run_revision' && resourceType !== 'firebase_domain') {
      return null
    }
    const identity = parseFirebaseTargetName(signal.targetName)
    if (!identity) return null

    const serviceName = neatServiceNameFor(resourceType, identity.resourceName, serviceMap)
    // No configured mapping for this resource — a setup gap (an unconfigured
    // FirebaseServiceMap entry), honestly unresolved rather than guessed.
    if (!serviceName) return null

    const normalizedPath = normalizePathTemplate(identity.path)
    const match = findRoute(routeEntriesFor(graph, serviceName), identity.method, normalizedPath)
    // No static route recognises this path — the "raw handler, no Express
    // app" gap firebase.md §Fusion documents explicitly as an accepted,
    // honest gap rather than something to route around. Landing this on the
    // service's own ServiceNode as both source and target would be a
    // self-loop (the graph disallows them, graph.ts's
    // `allowSelfLoops: false`), so it's left unresolved rather than forcing
    // a meaningless edge or inventing a new node type firebase.md's "no new
    // NodeType" explicitly rules out.
    if (!match) return null

    return {
      targetNodeId: match.routeNodeId,
      serviceName,
      edgeType: EdgeType.CALLS,
    }
  }
}
