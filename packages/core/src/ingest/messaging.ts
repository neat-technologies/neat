import type {
  InfraNode,
} from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  infraId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import type { SpanIngest } from './context.js'
import { upsertObservedEdge } from './edges.js'
import { WIRE_SPAN_KIND_CONSUMER } from './span.js'

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

export function ingestMessagingSpan(s: SpanIngest): string | undefined {
  const { ctx, span, ts, isError, durationMs, errorDetail, callSiteEvidence, observedSource } = s
  if (!span.messagingSystem || !span.messagingDestination) return undefined
  let affectedNode: string | undefined
  // Messaging span. The semantic destination is the topic / queue / stream the
  // code talks to — not the broker host, which is transport. A PRODUCER span
  // publishes; a CONSUMER span consumes. Both mint an OBSERVED edge to the same
  // destination node the static extractor names (extract/calls/kafka.ts), so
  // the declared and observed queue edges fuse into one (→ divergence) instead
  // of twinning. File-grained through the same call-site path as any other
  // OBSERVED edge (file-awareness.md §4): when the span carries `code.*`, the
  // edge originates from the caller's FileNode at the exact call site,
  // reconciled onto the EXTRACTED service-relative path (`reconcileObservedRelPath`,
  // ADR-118); without a call site it stays service-level, honestly. This is the
  // consumer-side pair of the producer edge — the queue topology the OBSERVED
  // layer used to leave dark on the consumer side (issue #614).
  const targetId = ensureMessagingDestinationNode(
    ctx.graph,
    span.messagingSystem,
    span.messagingDestination,
  )
  const edgeType =
    span.kind === WIRE_SPAN_KIND_CONSUMER
      ? EdgeType.CONSUMES_FROM
      : EdgeType.PUBLISHES_TO
  const result = upsertObservedEdge(
    ctx.graph,
    edgeType,
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
