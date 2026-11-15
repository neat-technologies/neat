import type {
  InfraNode,
} from '@neat.is/types'
import {
  NodeType,
  infraId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'

// Messaging destination nodes for PRODUCER/CONSUMER spans.
// Moved out of ingest.ts; ingest.ts re-exports the public names.

// A messaging destination node (Kafka topic, queue, stream) keyed exactly the
// way the static extractor keys it, so the OBSERVED and EXTRACTED edges fuse
// onto one node instead of twinning. The Kafka static side names its topic
// `infra:kafka-topic:<topic>` (extract/calls/kafka.ts), so the kind is
// `<messaging.system>-topic` — `kafka` → `kafka-topic` — and the same shape
// generalises to every messaging system the semconv names. `provider: 'self'`
// mirrors the static extractor's non-AWS provider so an observed-first node
// merges cleanly when static analysis later reaches the same destination.
export function messagingDestinationKind(system: string): string {
  return `${system}-topic`
}

export function ensureMessagingDestinationNode(
  graph: NeatGraph,
  system: string,
  destination: string,
): string {
  const id = infraId(messagingDestinationKind(system), destination)
  if (graph.hasNode(id)) return id
  const node: InfraNode = {
    id,
    type: NodeType.InfraNode,
    name: destination,
    provider: 'self',
    kind: messagingDestinationKind(system),
  }
  graph.addNode(id, node)
  return id
}
