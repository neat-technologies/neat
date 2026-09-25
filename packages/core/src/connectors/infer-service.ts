// Graph-derived service inference for the GCP connectors (Firebase, Cloud Run, GCP LB). Their resolvers
// map a GCP resource name (a function, a Cloud Run service, an LB backend) to the NEAT service that owns it,
// and GCP names rarely match `package.json#name`. A hosted tenant can't be asked to hand-write that map, so
// when a connector's config sets `inferServices`, an unmapped resource is worked out from the graph:
//
//   1. a service whose name matches the resource name, ignoring case and separators;
//   2. otherwise the one service that statically declares a route matching the request's method and path.
//
// Ambiguous or absent is a null — an honest miss, never a guess. Explicit config always wins because callers
// consult it first. This module only reads the graph.

import { NodeType, type RouteNode } from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import { normalizePathTemplate } from '../extract/routes.js'

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function inferServiceName(
  graph: NeatGraph,
  resourceName: string,
  method: string,
  path: string,
): string | null {
  const wantedMethod = method.toUpperCase()
  const wantedPath = normalizePathTemplate(path)
  const services: string[] = []
  const owners = new Set<string>()
  graph.forEachNode((_id, attrs) => {
    const node = attrs as unknown as { type?: string; name?: string }
    if (node.type === NodeType.ServiceNode && typeof node.name === 'string') {
      services.push(node.name)
      return
    }
    if (node.type !== NodeType.RouteNode) return
    const route = attrs as unknown as RouteNode
    if (!route.pathTemplate || normalizePathTemplate(route.pathTemplate) !== wantedPath) return
    const routeMethod = route.method.toUpperCase()
    if (routeMethod === 'ALL' || routeMethod === wantedMethod) owners.add(route.service)
  })
  const wanted = normalizeName(resourceName)
  const byName = services.find((s) => normalizeName(s) === wanted)
  if (byName) return byName
  return owners.size === 1 ? [...owners][0]! : null
}
