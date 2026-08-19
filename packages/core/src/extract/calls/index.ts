import type { GraphEdge, InfraNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  passesExtractedFloor,
} from '@neat.is/types'
import { noteExtractedDropped, recordExtractionError } from '../errors.js'
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
import { firestoreEndpointsFromFile } from './firestore.js'
import { mongooseEndpointsFromFile, mongooseCrossFileEndpoints } from './mongoose.js'
import { sqlalchemyEndpointsFromFile, pythonOrmCrossFileEndpoints } from './sqlalchemy.js'
import { djangoOrmEndpointsFromFile } from './django-orm.js'
import { drizzleEndpointsFromFile } from './drizzle.js'
import { prismaColumnEndpoints } from './prisma.js'
import { railsSchemaEndpointsFromFile, railsModelEndpointsFromFile } from './activerecord.js'
import { laravelMigrationEndpointsFromFile, laravelModelEndpointsFromFile } from './eloquent.js'
import { foldColumns, foldSdkWrites } from '../../columns.js'
import { goSqlEndpointsFromFile } from './go.js'
import { gormEndpointsFromFile } from './gorm.js'
import { efcoreEndpointsFromFile } from './efcore.js'

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
    const files = await loadSourceFiles(service.dir, service.excludeDirs)
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
      endpoints.push(...firestoreEndpointsFromFile(maskedFile, service.dir))
      endpoints.push(...mongooseEndpointsFromFile(maskedFile, service.dir))
      endpoints.push(...sqlalchemyEndpointsFromFile(maskedFile, service.dir))
      endpoints.push(...djangoOrmEndpointsFromFile(maskedFile, service.dir))
      endpoints.push(...drizzleEndpointsFromFile(maskedFile, service.dir))
      try {
        endpoints.push(...goSqlEndpointsFromFile(maskedFile, service.dir))
      } catch (err) {
        recordExtractionError('go SQL call extraction', file.path, err)
      }
      // Go/GORM data axis (ADR-180). Model structs → `sql-table` nodes + literal
      // columns. Parsed via tree-sitter-go from the raw file (not the JS-comment-
      // masked copy), so Go `//` comments are excluded structurally as `comment`
      // nodes. Wrapped because tree-sitter-go is a native module — a per-file
      // failure must not abort the phase (ADR-055).
      try {
        endpoints.push(...gormEndpointsFromFile(file, service.dir))
      } catch (err) {
        recordExtractionError('gorm data-axis extraction', file.path, err)
      }
      // Rails ActiveRecord data axis (ADR-174). `db/schema.rb` tables + columns
      // and the model→table link. Parsed via tree-sitter-ruby from the raw file
      // (not the JS-comment-masked copy), so Ruby `#` comments are excluded
      // structurally as `comment` nodes. Wrapped because tree-sitter-ruby is a
      // native module — a per-file failure must not abort the phase (ADR-055).
      try {
        endpoints.push(...railsSchemaEndpointsFromFile(file, service.dir))
        endpoints.push(...railsModelEndpointsFromFile(file, service.dir))
      } catch (err) {
        recordExtractionError('rails activerecord extraction', file.path, err)
      }
      // Laravel data axis (ADR-178). `database/migrations/*.php` Schema::create
      // blueprints (tables + literal columns) and the `app/Models/*.php`
      // Eloquent class→table link. Parsed via tree-sitter-php (`php_only`) from
      // the raw file — PHP `//` / `#` comments are excluded structurally as
      // `comment` nodes. Wrapped because tree-sitter-php is a native module — a
      // per-file failure must not abort the phase (ADR-055).
      try {
        endpoints.push(...laravelMigrationEndpointsFromFile(file, service.dir))
        endpoints.push(...laravelModelEndpointsFromFile(file, service.dir))
      } catch (err) {
        recordExtractionError('laravel eloquent extraction', file.path, err)
      }
      // C#/.NET EF Core data axis (ADR-203). `[Table("...")]` annotations and
      // `.ToTable("...")` fluent calls → `sql-table` nodes. Parsed via
      // tree-sitter-c-sharp from the raw file (not the JS-comment-masked copy), so
      // C# `//` / `/* */` comments are excluded structurally as `comment` nodes.
      // Wrapped because tree-sitter-c-sharp is a native module — a per-file failure
      // must not abort the phase (ADR-055).
      try {
        endpoints.push(...efcoreEndpointsFromFile(file, service.dir))
      } catch (err) {
        recordExtractionError('efcore data-axis extraction', file.path, err)
      }
    }
    // Cross-file mongoose resolution (ADR-149) — a whole-program pass over the
    // service's files, attributing a query in one file to a model defined in
    // another via the import graph.
    endpoints.push(...(await mongooseCrossFileEndpoints(maskedFiles, service.dir)))
    // Cross-file SQLAlchemy model→table query attribution (ADR-149 analog): a
    // query file gets the table edge for a model imported from another file.
    endpoints.push(...pythonOrmCrossFileEndpoints(maskedFiles, service.dir))
    // Prisma declared columns (ADR-157 §3): `schema.prisma` is read as text —
    // it isn't a source file the walker loads — so this runs once per service,
    // reading each model's scalar fields as EXTRACTED columns at DB-name fidelity.
    endpoints.push(...(await prismaColumnEndpoints(service.dir)))
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

      // Column grain (ADR-157 §3): a schema-column producer (Drizzle) carries the
      // declared columns at database-name fidelity. Fold them onto the table node
      // with EXTRACTED provenance — whether the node was just minted here or
      // already exists from an OBSERVED span, so the declared and observed columns
      // fuse on one node and column-drift (§4) can read both sides. The
      // definition's file:line rides the EXTRACTED edge minted below. Mutation is
      // allowed here — extract/* is a lifecycle authority (lifecycle.md §3).
      if (ep.columns && ep.columns.length > 0) {
        const node = graph.getNodeAttributes(ep.infraId) as InfraNode
        if (node.type === NodeType.InfraNode) {
          graph.replaceNodeAttributes(ep.infraId, {
            ...node,
            columns: foldColumns(
              node.columns,
              ep.columns,
              Provenance.EXTRACTED,
              confidenceForExtracted(ep.confidenceKind),
            ),
          })
        }
      }

      // Firestore write-SDK tags (ADR-167). A `firestore-collection` endpoint
      // carries, per written field, which SDK wrote it (client vs admin) — the
      // seam the field-guard policy (ADR-169) joins on. Fold it onto the columns
      // the block above just landed, via the parallel `foldSdkWrites` — a separate
      // firestore-gated pass so `foldColumns` and its fold block stay untouched.
      // Gated on `ep.sdkWrites`, which only calls/firestore.ts populates.
      if (ep.sdkWrites && Object.keys(ep.sdkWrites).length > 0) {
        const node = graph.getNodeAttributes(ep.infraId) as InfraNode
        if (node.type === NodeType.InfraNode) {
          graph.replaceNodeAttributes(ep.infraId, {
            ...node,
            columns: foldSdkWrites(node.columns, ep.sdkWrites),
          })
        }
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
