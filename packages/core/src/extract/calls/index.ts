import type { GraphEdge, InfraNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  passesExtractedFloor,
} from '@neat.is/types'
import { noteExtractedDropped } from '../errors.js'
import type { NeatGraph } from '../../graph.js'
import {
  isTestPath,
  makeEdgeId,
  maskCommentsInSource,
  type DiscoveredService,
} from '../shared.js'
import { addHttpCallEdges } from './http.js'
import { addRouteCallEdges } from './route-match.js'
import { ensureFileNode, loadSourceFiles, toPosix, type ExternalEndpoint, type SourceFile } from './shared.js'
import { kafkaEndpointsFromFile } from './kafka.js'
import { redisEndpointsFromFile } from './redis.js'
import { awsEndpointsFromFile } from './aws.js'
import { grpcEndpointsFromFile } from './grpc.js'
import { supabaseEndpointsFromFile } from './supabase.js'
import { mongooseEndpointsFromFile, mongooseCrossFileEndpoints } from './mongoose.js'
import { sqlalchemyEndpointsFromFile, pythonOrmCrossFileEndpoints } from './sqlalchemy.js'
import { djangoOrmEndpointsFromFile } from './django-orm.js'

export interface CallExtractResult {
  nodesAdded: number
  edgesAdded: number
}

function edgeTypeFromEndpoint(ep: ExternalEndpoint): (typeof EdgeType)[keyof typeof EdgeType] {
  switch (ep.edgeType) {
    case 'PUBLISHES_TO':
      return EdgeType.PUBLISHES_TO
    case 'CONSUMES_FROM':
      return EdgeType.CONSUMES_FROM
    default:
      return EdgeType.CALLS
  }
}

function isAwsKind(kind: string): boolean {
  return (
    kind.startsWith('aws-') ||
    kind.startsWith('s3') ||
    kind.startsWith('dynamodb')
  )
}

async function addExternalEndpointEdges(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<CallExtractResult> {
  let nodesAdded = 0
  let edgesAdded = 0

  for (const service of services) {
    const files = await loadSourceFiles(service.dir)
    const endpoints: ExternalEndpoint[] = []
    const maskedFiles: SourceFile[] = []
    for (const file of files) {
      // ADR-065 #1 — test-scope exclusion. Tests stay registered as
      // service-internal (via the file walk earlier); only outbound
      // endpoint inference from them is filtered.
      if (isTestPath(file.path)) continue
      // ADR-065 #2 — comment-body exclusion. The regex-based extractors
      // (redis / kafka / aws / grpc) scan raw file.content; URLs inside
      // JSDoc / line / block comments leaked through to the graph in the
      // v0.3.0 medusa run. Mask comments while preserving line/column for
      // evidence line-mapping.
      const masked = maskCommentsInSource(file.content)
      const maskedFile = { path: file.path, content: masked }
      maskedFiles.push(maskedFile)
      endpoints.push(...kafkaEndpointsFromFile(maskedFile, service.dir))
      endpoints.push(...redisEndpointsFromFile(maskedFile, service.dir))
      endpoints.push(...awsEndpointsFromFile(maskedFile, service.dir))
      endpoints.push(...grpcEndpointsFromFile(maskedFile, service.dir))
      endpoints.push(...supabaseEndpointsFromFile(maskedFile, service.dir))
      endpoints.push(...mongooseEndpointsFromFile(maskedFile, service.dir))
      endpoints.push(...sqlalchemyEndpointsFromFile(maskedFile, service.dir))
      endpoints.push(...djangoOrmEndpointsFromFile(maskedFile, service.dir))
    }
    // Cross-file mongoose resolution (ADR-149) — a whole-program pass over the
    // service's files, attributing a query in one file to a model defined in
    // another via the import graph.
    endpoints.push(...(await mongooseCrossFileEndpoints(maskedFiles, service.dir)))
    // Cross-file SQLAlchemy model→table query attribution (ADR-149 analog): a
    // query file gets the table edge for a model imported from another file.
    endpoints.push(...pythonOrmCrossFileEndpoints(maskedFiles, service.dir))
    if (endpoints.length === 0) continue

    const seenEdges = new Set<string>()
    for (const ep of endpoints) {
      if (!graph.hasNode(ep.infraId)) {
        const node: InfraNode = {
          id: ep.infraId,
          type: NodeType.InfraNode,
          name: ep.name,
          // #238 — `aws-*` covers AWS-SDK client kinds (aws-s3, aws-dynamodb,
          // aws-cognito-identity-provider, …); `s3-` / `dynamodb-` cover the
          // bucket / table kinds from aws.ts.
          provider: isAwsKind(ep.kind) ? 'aws' : 'self',
          kind: ep.kind,
        }
        graph.addNode(node.id, node)
        nodesAdded++
      }

      const edgeType = edgeTypeFromEndpoint(ep)
      const confidence = confidenceForExtracted(ep.confidenceKind)
      // File-first (file-awareness.md §1): the endpoint relationship originates
      // from the file the call site lives in, with the owning service
      // ──CONTAINS──▶ file edge alongside it (§2). File-node existence is
      // independent of edge-target precision (ADR-089 amendment) — a matched
      // call site is a parsed fact, so the FileNode + CONTAINS materialize
      // regardless of how confident we are about the resolved target.
      const relFile = toPosix(ep.evidence.file)
      const { fileNodeId, nodesAdded: n, edgesAdded: e } = ensureFileNode(
        graph,
        service.pkg.name,
        service.node.id,
        relFile,
      )
      nodesAdded += n
      edgesAdded += e
      // Precision floor (ADR-066 §3). Only the file→target edge is gated:
      // sub-threshold candidates are recorded as drops (banner accounting) and
      // never added to the graph; the file and its call site still surface.
      if (!passesExtractedFloor(confidence)) {
        noteExtractedDropped({
          source: fileNodeId,
          target: ep.infraId,
          type: edgeType,
          confidence,
          confidenceKind: ep.confidenceKind,
          evidence: ep.evidence,
        })
        continue
      }
      const edgeId = makeEdgeId(fileNodeId, ep.infraId, edgeType)
      if (seenEdges.has(edgeId)) continue
      seenEdges.add(edgeId)
      if (!graph.hasEdge(edgeId)) {
        const edge: GraphEdge = {
          id: edgeId,
          source: fileNodeId,
          target: ep.infraId,
          type: edgeType,
          provenance: Provenance.EXTRACTED,
          confidence,
          evidence: ep.evidence,
        }
        graph.addEdgeWithKey(edgeId, edge.source, edge.target, edge)
        edgesAdded++
      }
    }
  }
  return { nodesAdded, edgesAdded }
}

export async function addCallEdges(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<CallExtractResult> {
  const http = await addHttpCallEdges(graph, services)
  const ext = await addExternalEndpointEdges(graph, services)
  // Cross-service contract matching (ADR-119). Runs after the RouteNodes are in
  // the graph (addRoutes, a prior phase) so client call sites can be matched
  // against the full route table, minting route-grained CALLS edges.
  const routes = await addRouteCallEdges(graph, services)
  return {
    nodesAdded: http.nodesAdded + ext.nodesAdded + routes.nodesAdded,
    edgesAdded: http.edgesAdded + ext.edgesAdded + routes.edgesAdded,
  }
}
