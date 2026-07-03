export const Provenance = {
  EXTRACTED: 'EXTRACTED',
  INFERRED: 'INFERRED',
  OBSERVED: 'OBSERVED',
  STALE: 'STALE',
} as const

export type ProvenanceValue = (typeof Provenance)[keyof typeof Provenance]

export const EdgeType = {
  CALLS: 'CALLS',
  DEPENDS_ON: 'DEPENDS_ON',
  CONNECTS_TO: 'CONNECTS_TO',
  CONFIGURED_BY: 'CONFIGURED_BY',
  PUBLISHES_TO: 'PUBLISHES_TO',
  CONSUMES_FROM: 'CONSUMES_FROM',
  RUNS_ON: 'RUNS_ON',
  // A service owns its files (ADR-089 / docs/contracts/file-awareness.md §2):
  // `service ──CONTAINS──▶ file`. Structural ownership, not traffic — the
  // grouping that lets file-grained relationships roll up to a service only
  // as the honest fallback, never as a summary view.
  CONTAINS: 'CONTAINS',
  // Static module dependency between two FileNodes within a service (ADR-092,
  // file-awareness.md §10). Compile-time, not runtime — represents one file
  // importing another. Distinct from CALLS which records runtime invocations.
  IMPORTS: 'IMPORTS',
} as const

export type EdgeTypeValue = (typeof EdgeType)[keyof typeof EdgeType]

export const NodeType = {
  ServiceNode: 'ServiceNode',
  DatabaseNode: 'DatabaseNode',
  ConfigNode: 'ConfigNode',
  InfraNode: 'InfraNode',
  FrontierNode: 'FrontierNode',
  // The primary node of the file-first graph (ADR-089). A source file owned
  // by a service; relationships originate from it. See
  // docs/contracts/file-awareness.md §1.
  FileNode: 'FileNode',
  // A server route at (method, path-template) granularity (ADR-119). Extracted
  // from a mainstream router (Express / Fastify / Next.js) so a client call
  // site can be matched to the exact route it names, rather than only to the
  // owning service. The node an OBSERVED server span lands on too, which is
  // what makes a two-sided divergence possible at route grain. See
  // docs/contracts/static-extraction.md.
  RouteNode: 'RouteNode',
  // A named GraphQL operation — one query, mutation, or subscription — at
  // (service, operationType, operationName) granularity (ADR-122). Every
  // GraphQL request rides one HTTP endpoint (POST /graphql), so at HTTP grain
  // the whole API collapses to a single edge; this node recovers the
  // operation-level topology from the execution span's `graphql.operation.*`
  // semconv. Minted observed-first from OTel; a future static GraphQL extractor
  // fuses onto the same id. See docs/contracts/otel-ingest.md.
  GraphQLOperationNode: 'GraphQLOperationNode',
  // A single gRPC method — one `rpc` in a `.proto` service — at
  // (rpcService, rpcMethod) granularity (ADR-123). gRPC used to engage only at
  // service grain: every method collapsed onto one service→service edge, so the
  // per-method topology was invisible and one-sided. This node recovers the
  // method-level shape from both sides: the OBSERVED execution span's
  // `rpc.service` / `rpc.method` semconv and the static `.proto` service/method
  // definitions. It keys on the fully-qualified `rpc.service` — the wire
  // contract both sides carry verbatim — so a declared method and an observed
  // one fuse onto the same node into a two-sided divergence. See
  // docs/contracts/otel-ingest.md and docs/contracts/static-extraction.md.
  GrpcMethodNode: 'GrpcMethodNode',
} as const

export type NodeTypeValue = (typeof NodeType)[keyof typeof NodeType]

import { z } from 'zod'

// Zod-side mirror of NodeType, exported for schemas that need to discriminate
// or filter by node type at parse time (policy rules, traversal results, etc.).
// Adding a new node type means adding it to NodeType above and to this enum.
export const NodeTypeSchema = z.enum([
  NodeType.ServiceNode,
  NodeType.DatabaseNode,
  NodeType.ConfigNode,
  NodeType.InfraNode,
  NodeType.FrontierNode,
  NodeType.FileNode,
  NodeType.RouteNode,
  NodeType.GraphQLOperationNode,
  NodeType.GrpcMethodNode,
])
