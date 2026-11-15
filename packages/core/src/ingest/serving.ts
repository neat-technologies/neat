import type {
  GraphQLOperationNode,
  GrpcMethodNode,
  WebSocketChannelNode,
} from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  graphqlOperationId,
  grpcMethodId,
  websocketChannelId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import type { SpanIngest } from './context.js'
import { upsertObservedEdge } from './edges.js'

// Serving-side operation nodes: GraphQL operations, gRPC methods and WebSocket
// channels.
// Moved out of ingest.ts; ingest.ts re-exports the public names.

// A GraphQL operation node keyed on (service, operationType, operationName) via
// graphqlOperationId (ADR-122). Minted observed-first from the execution span so
// operation-level topology is legible even before any static GraphQL extractor
// exists; a later static extractor fuses onto the same id. `operationType` is
// stored lower-cased to match the id's normalisation, so a `query` observed and a
// `Query` static resolver land on one node. Idempotent — a high-volume operation
// upserts, never grows the node set.
export function ensureGraphqlOperationNode(
  graph: NeatGraph,
  serviceName: string,
  operationType: string,
  operationName: string,
): string {
  const id = graphqlOperationId(serviceName, operationType, operationName)
  if (graph.hasNode(id)) return id
  const node: GraphQLOperationNode = {
    id,
    type: NodeType.GraphQLOperationNode,
    name: operationName,
    service: serviceName,
    operationType: operationType.toLowerCase(),
    operationName,
    discoveredVia: 'otel',
  }
  graph.addNode(id, node)
  return id
}

// A gRPC method node keyed on (rpcService, rpcMethod) via grpcMethodId (ADR-123).
// `rpcService` is the fully-qualified `rpc.service` the wire carries verbatim
// (`orders.OrderService`), so an OBSERVED span and a static `.proto` definition
// fuse onto one node rather than twinning. Idempotent — a high-volume method
// upserts, never grows the node set.
export function ensureGrpcMethodNode(
  graph: NeatGraph,
  rpcService: string,
  rpcMethod: string,
): string {
  const id = grpcMethodId(rpcService, rpcMethod)
  if (graph.hasNode(id)) return id
  const node: GrpcMethodNode = {
    id,
    type: NodeType.GrpcMethodNode,
    name: `${rpcService}/${rpcMethod}`,
    rpcService,
    rpcMethod,
    discoveredVia: 'otel',
  }
  graph.addNode(id, node)
  return id
}

// A WebSocket channel node keyed on (service, channel) via websocketChannelId
// (ADR-125). Minted OBSERVED-only from the upgrade span — a WebSocket channel is
// known from observation, never from static extraction, so there is no declared
// twin to fuse with and no static producer to fill in `path` / `line` (those stay
// absent, never fabricated — file-awareness.md §6). Idempotent — every reconnect
// on the same channel upserts, never grows the node set.
export function ensureWebsocketChannelNode(
  graph: NeatGraph,
  serviceName: string,
  channel: string,
): string {
  const id = websocketChannelId(serviceName, channel)
  if (graph.hasNode(id)) return id
  const node: WebSocketChannelNode = {
    id,
    type: NodeType.WebSocketChannelNode,
    name: channel,
    service: serviceName,
    channel,
    discoveredVia: 'otel',
  }
  graph.addNode(id, node)
  return id
}

export function ingestGraphqlOperationSpan(s: SpanIngest): string | undefined {
  const { ctx, span, ts, isError, durationMs, errorDetail, callSiteEvidence, observedSource } = s
  if (!span.graphqlOperationName || !span.graphqlOperationType) return undefined
  let affectedNode: string | undefined
  // GraphQL execution span (issue #615). Every GraphQL request rides one HTTP
  // endpoint (`POST /graphql`), so at HTTP grain the whole API collapses to a
  // single edge and the operation-level topology is invisible. The execution
  // span carries the operation the client actually named — `graphql.operation.name`
  // with `graphql.operation.type` — so mint an OBSERVED `CONTAINS` edge from the
  // serving service to a per-operation node, the same ownership shape a service
  // has over a route (ADR-119) and a file (file-awareness.md §2). OBSERVED-only:
  // the SDL / resolver map is not parsed statically in this cut; the node is
  // minted observed-first and a future static GraphQL extractor fuses onto the
  // same id (ADR-122). File-grained through the same call-site path as any other
  // OBSERVED edge (file-awareness.md §4): when the span carries `code.*` (the
  // resolver call site) the edge originates from that `FileNode` at the exact
  // `file:line`, reconciled onto the EXTRACTED service-relative path; without a
  // call site it stays service-level, honestly. Both operation name and type
  // must be present to key a stable id — a nameless/typeless execution span
  // falls through rather than minting a fabricated operation.
  const targetId = ensureGraphqlOperationNode(
    ctx.graph,
    span.service,
    span.graphqlOperationType,
    span.graphqlOperationName,
  )
  const result = upsertObservedEdge(
    ctx.graph,
    EdgeType.CONTAINS,
    observedSource(),
    targetId,
    ts,
    isError,
    callSiteEvidence,
    durationMs,
    errorDetail,
  )
  if (result) affectedNode = targetId
  return affectedNode
}

export function ingestGrpcMethodSpan(s: SpanIngest): string | undefined {
  const { ctx, span, ts, isError, durationMs, errorDetail, callSiteEvidence, observedSource } = s
  if (!span.rpcService || !span.rpcMethod) return undefined
  let affectedNode: string | undefined
  // gRPC execution span (issue #616). gRPC used to engage only at service
  // grain: every method collapsed onto one service→service edge, so the
  // per-method topology was invisible and one-sided. The serving span carries
  // the method the caller actually invoked — `rpc.service` (the fully-qualified
  // `orders.OrderService`) with `rpc.method` (`GetOrder`) — so mint an OBSERVED
  // `CONTAINS` edge from the serving service to a per-method node, the same
  // ownership shape a service has over a route (ADR-119), a GraphQL operation
  // (ADR-122), and a file (file-awareness.md §2). The node is keyed on the
  // fully-qualified `rpc.service` — the wire contract both the span and the
  // `.proto` carry verbatim — so the static `.proto` extractor's declared
  // method fuses onto this same id into a two-sided divergence (ADR-123).
  // File-grained through the same call-site path as any other OBSERVED edge
  // (file-awareness.md §4): when the span carries `code.*` (the handler call
  // site) the edge originates from that `FileNode` at the exact `file:line`,
  // reconciled onto the EXTRACTED service-relative path; without a call site it
  // stays service-level, honestly. The gate admits only the serving side —
  // SERVER / INTERNAL / unkinded — so a CLIENT span mints no ownership
  // (client→method attribution is deferred) and instead falls through to the
  // cross-service resolver, leaving the caller→callee edge intact. Both service
  // and method must be present to key a stable id.
  const targetId = ensureGrpcMethodNode(ctx.graph, span.rpcService, span.rpcMethod)
  const result = upsertObservedEdge(
    ctx.graph,
    EdgeType.CONTAINS,
    observedSource(),
    targetId,
    ts,
    isError,
    callSiteEvidence,
    durationMs,
    errorDetail,
  )
  if (result) affectedNode = targetId
  return affectedNode
}

export function ingestWebsocketChannelSpan(s: SpanIngest): string | undefined {
  const { ctx, span, ts, isError, durationMs, errorDetail, callSiteEvidence, observedSource } = s
  if (!span.websocketChannel) return undefined
  let affectedNode: string | undefined
  // WebSocket upgrade span (issue #617). A WebSocket app used to produce no
  // OBSERVED topology at all: only message-handler errors surfaced, as
  // incidents, and the channels themselves stayed invisible — the frames after
  // the handshake ride the socket, not more spans. The one span that reliably
  // marks a channel is the HTTP upgrade that opens it: a SERVER `GET` carrying
  // `Upgrade: websocket` and the connection path. So mint an OBSERVED
  // `CONNECTS_TO` edge from the serving service to a per-channel node —
  // reusing the same connection edge a service has to a datastore (#576), not a
  // new edge type. Unlike the structural `CONTAINS` a service has over a route /
  // operation / method — durably declared artifacts whose edge never goes
  // stale — a channel's whole meaning is liveness, so `CONNECTS_TO` is the right
  // shape: it carries `lastObserved` and decays OBSERVED → STALE on
  // CONNECTS_TO's own threshold when the channel goes quiet (the daemon
  // staleness loop, #532). OBSERVED-only: a WebSocket channel is known from
  // observation, never from static extraction, so the node has no declared twin
  // and is excluded from `missing-extracted` (divergences.ts). File-grained
  // through the same call-site path as any other OBSERVED edge
  // (file-awareness.md §4): when the span carries `code.*` the edge originates
  // from that `FileNode` at the exact `file:line`, reconciled onto the EXTRACTED
  // service-relative path; without a call site it stays service-level, honestly.
  // The gate admits only the serving side — SERVER / INTERNAL / unkinded — so a
  // CLIENT upgrade span mints no channel (client→channel attribution is
  // deferred, ADR-125).
  const targetId = ensureWebsocketChannelNode(
    ctx.graph,
    span.service,
    span.websocketChannel,
  )
  const result = upsertObservedEdge(
    ctx.graph,
    EdgeType.CONNECTS_TO,
    observedSource(),
    targetId,
    ts,
    isError,
    callSiteEvidence,
    durationMs,
    errorDetail,
  )
  if (result) affectedNode = targetId
  return affectedNode
}
