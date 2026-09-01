export const Provenance = {
  EXTRACTED: 'EXTRACTED',
  INFERRED: 'INFERRED',
  OBSERVED: 'OBSERVED',
  STALE: 'STALE',
  // The staged-surface tense (ADR-094 / ADR-226): a claim outside the settled
  // graph — an edge NEAT reached toward but cannot yet observe (a hop whose far
  // end hung), or a proposed relationship not yet enacted. "Provenance is
  // everything outside the graph." A FRONTIER edge is a real, persisted surface,
  // but it is NEVER ranked: it stays out of `PROV_RANK` and is skipped by settled
  // traversal (Rule 3, edge level). It graduates to OBSERVED (promotion) when its
  // real twin arrives, or is culled. Restores the value ADR-068 froze out.
  FRONTIER: 'FRONTIER',
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
  // Static heritage between two SymbolNodes (ADR-158 §3). `INHERITS` records a
  // class's `extends` clause (`class ──INHERITS──▶ superclass`); `IMPLEMENTS`
  // records an `implements` clause (`class ──IMPLEMENTS──▶ implemented`). Both
  // are symbol→symbol, EXTRACTED, minted only when the parent name resolves to
  // exactly one known SymbolNode — same-file or through the import graph — never
  // fuzzy-matched. A parent that resolves to nothing (external package,
  // re-export chain, an interface, which is not a SymbolNode) emits no edge.
  INHERITS: 'INHERITS',
  IMPLEMENTS: 'IMPLEMENTS',
  // Static foreign-key reference between two table InfraNodes (ADR-161).
  // `infra:sql-table:<child> ──REFERENCES──▶ infra:sql-table:<parent>` records
  // that the child table declares a foreign key into the parent — the data-axis
  // sibling of INHERITS/IMPLEMENTS. Both endpoints resolve to the DATABASE table
  // name via `infraId('sql-table', name)` — the same node the column/table
  // extractors and OTLP already target — reproduced verbatim per ORM, so the FK
  // edge lands on the fused table node rather than a code-model twin. EXTRACTED,
  // minted only when the parent resolves to a real declared table without
  // guessing; a computed/unresolved reference emits no edge.
  REFERENCES: 'REFERENCES',
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
  // A live WebSocket channel — the path/channel a client connects to — at
  // (service, channel) granularity (ADR-125). A WebSocket app used to produce no
  // OBSERVED topology at all: only message-handler errors surfaced, as incidents,
  // and the channels themselves stayed invisible. This node recovers the
  // channel-level topology from the HTTP upgrade span that opens the connection —
  // a SERVER `GET` carrying the WebSocket path. It is minted OBSERVED-only: a
  // WebSocket channel is known from observation, never from static extraction, so
  // there is no declared twin to fuse with. The edge onto it reuses the existing
  // `CONNECTS_TO` (`service ──CONNECTS_TO──▶ ws-channel`) as an observed-liveness
  // edge that carries `lastObserved` and decays OBSERVED → STALE on CONNECTS_TO's
  // own staleness threshold when the channel goes quiet. See
  // docs/contracts/otel-ingest.md.
  WebSocketChannelNode: 'WebSocketChannelNode',
  // A symbol under a file — a function, method, constructor, or class
  // definition — at definition-span granularity (ADR-158). Static-first: the
  // extractor mints one per definition and the file owns it through a
  // `file ──CONTAINS──▶ symbol` edge, one containment level below
  // `service ──CONTAINS──▶ file`. It carries its `{ startLine, endLine }`
  // definition span, which is the fusion key ingest joins a span's `code.line`
  // against to land an OBSERVED edge on the calling symbol rather than only its
  // file (observed-first edges, one grain finer than §4 file grain). The node is
  // language-neutral; the per-language tree-sitter extractor is the adapter. See
  // docs/contracts/static-extraction.md and docs/contracts/file-awareness.md §1.
  SymbolNode: 'SymbolNode',
  // A Next.js Server Action at (service, module, exportName) granularity
  // (ADR-168). A Server Action is the RPC boundary of an App Router app: the
  // client posts to it, Next serialises the call to an opaque `Next-Action`
  // hash, and it runs on the server. At HTTP grain the whole surface collapses
  // onto one POST edge — like a GraphQL operation — so this node recovers the
  // per-action topology the client actually names. It is EXTRACTED-first: the
  // static extractor mints one per exported action from a `"use server"`
  // directive (module-level or in-body) and the file owns it through a
  // `file ──CONTAINS──▶ action` edge; a client reference to the imported action
  // binding lands a `file ──CALLS──▶ action` edge, so the client→action call
  // path is a real edge the reasoning core walks like any other. OBSERVED
  // fusion is deferred (the `Next-Action` hash carries no action name), the
  // same posture GraphQLOperationNode took before its static extractor. See
  // docs/contracts/static-extraction.md and docs/contracts/file-awareness.md.
  ServerActionNode: 'ServerActionNode',
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
  NodeType.WebSocketChannelNode,
  NodeType.SymbolNode,
  NodeType.ServerActionNode,
])
