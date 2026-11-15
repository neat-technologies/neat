import type {
  GraphQLOperationNode,
  GrpcMethodNode,
  WebSocketChannelNode,
} from '@neat.is/types'
import {
  NodeType,
  graphqlOperationId,
  grpcMethodId,
  websocketChannelId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'

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
