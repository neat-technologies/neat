// Frontend-facing event bus (ADR-051). The single in-process EventEmitter
// every producer (ingest / extract / watch / policy) emits through and the
// only thing the SSE handler in streaming.ts subscribes to.
//
// Direct producer-to-handler coupling is a contract violation — every event
// goes through `eventBus.emit('event', envelope)` so the SSE layer is the
// only consumer that has to know the wire taxonomy.
//
// The taxonomy was locked at eight types (ADR-051 #2) and grew by one —
// `incident` — under ADR-221, on the principle that only an append-only,
// non-reconstructable fact earns a type (a re-derivable query like divergence
// stays off the bus). A tenth type requires a further successor ADR.

import { EventEmitter } from 'node:events'
import type {
  GraphEdge,
  GraphNode,
  IncidentEventPayload,
  PolicyViolation,
  Provenance,
} from '@neat.is/types'
import type { NeatGraph } from './graph.js'

// Locked event taxonomy. Nine values. Tests assert the array shape
// directly, so adding here without updating the contract is a regression.
export const NEAT_EVENT_TYPES = [
  'node-added',
  'node-updated',
  'node-removed',
  'edge-added',
  'edge-removed',
  'extraction-complete',
  'policy-violation',
  'stale-transition',
  'incident',
] as const

export type NeatEventType = (typeof NEAT_EVENT_TYPES)[number]

// Per-type payload shapes. The wire layer (SSE) writes the payload as the
// `data` field; producers use `emit*` helpers below for type safety.
export interface NodeAddedPayload {
  node: GraphNode
}
export interface NodeUpdatedPayload {
  id: string
  changes: Partial<GraphNode>
}
export interface NodeRemovedPayload {
  id: string
}
export interface EdgeAddedPayload {
  edge: GraphEdge
}
export interface EdgeRemovedPayload {
  id: string
}
export interface ExtractionCompletePayload {
  project: string
  fileCount: number
  nodesAdded: number
  edgesAdded: number
}
export interface PolicyViolationPayload {
  violation: PolicyViolation
}
export interface StaleTransitionPayload {
  edgeId: string
  from: typeof Provenance.OBSERVED
  to: typeof Provenance.STALE
}

export type NeatEventPayload = {
  'node-added': NodeAddedPayload
  'node-updated': NodeUpdatedPayload
  'node-removed': NodeRemovedPayload
  'edge-added': EdgeAddedPayload
  'edge-removed': EdgeRemovedPayload
  'extraction-complete': ExtractionCompletePayload
  'policy-violation': PolicyViolationPayload
  'stale-transition': StaleTransitionPayload
  // A lean trigger (ADR-221) — the full incident card is a REST read. Emitted
  // directly by ingest.ts when an ErrorEvent is appended, not via the
  // graph-mutation re-emitter.
  incident: IncidentEventPayload
}

// What the bus carries internally. Project is metadata used by the SSE
// handler to route between /events and /projects/:project/events; it never
// lands in the wire payload.
export interface NeatEventEnvelope<T extends NeatEventType = NeatEventType> {
  type: T
  project: string
  payload: NeatEventPayload[T]
}

// Single event channel — listeners filter by `envelope.type` and
// `envelope.project`. Using one channel keeps the contract surface narrow
// and matches the SSE handler's needs (one subscription, fan out).
export const EVENT_BUS_CHANNEL = 'event'

class NeatEventBus extends EventEmitter {}

// Singleton. Process-wide so producers in ingest / extract / watch / policy
// can emit without threading a bus instance through every call site.
export const eventBus: NeatEventBus = new NeatEventBus()

// EventEmitter defaults to 10 listeners; SSE clients add up quickly under a
// browser refresh storm, so lift the cap.
eventBus.setMaxListeners(0)

export function emitNeatEvent<T extends NeatEventType>(envelope: NeatEventEnvelope<T>): void {
  eventBus.emit(EVENT_BUS_CHANNEL, envelope)
}

// ──────────────────────────────────────────────────────────────────────────
// Graph subscription — one place to wire graphology mutation events into
// the bus so producers don't have to instrument every addNode/addEdge.
// ──────────────────────────────────────────────────────────────────────────

export interface AttachOptions {
  project: string
}

// Subscribes to a NeatGraph and re-emits node/edge add/remove + node/edge
// attribute updates as bus envelopes scoped to `project`. Returns a detach
// fn that removes every listener it installed.
//
// Stale-transition is NOT routed through here — a provenance flip is just an
// attribute update from graphology's view, and we'd lose the OBSERVED→STALE
// semantic. ingest.ts emits stale-transition itself.
export function attachGraphToEventBus(graph: NeatGraph, opts: AttachOptions): () => void {
  const { project } = opts

  const onNodeAdded = (payload: { key: string; attributes: GraphNode }): void => {
    emitNeatEvent({
      type: 'node-added',
      project,
      payload: { node: payload.attributes },
    })
  }
  const onNodeDropped = (payload: { key: string }): void => {
    emitNeatEvent({
      type: 'node-removed',
      project,
      payload: { id: payload.key },
    })
  }
  const onEdgeAdded = (payload: { key: string; attributes: GraphEdge }): void => {
    emitNeatEvent({
      type: 'edge-added',
      project,
      payload: { edge: payload.attributes },
    })
  }
  const onEdgeDropped = (payload: { key: string }): void => {
    emitNeatEvent({
      type: 'edge-removed',
      project,
      payload: { id: payload.key },
    })
  }
  const onNodeAttrsUpdated = (payload: { key: string; attributes: GraphNode }): void => {
    emitNeatEvent({
      type: 'node-updated',
      project,
      payload: { id: payload.key, changes: payload.attributes },
    })
  }

  graph.on('nodeAdded', onNodeAdded)
  graph.on('nodeDropped', onNodeDropped)
  graph.on('edgeAdded', onEdgeAdded)
  graph.on('edgeDropped', onEdgeDropped)
  graph.on('nodeAttributesUpdated', onNodeAttrsUpdated)

  return () => {
    graph.off('nodeAdded', onNodeAdded)
    graph.off('nodeDropped', onNodeDropped)
    graph.off('edgeAdded', onEdgeAdded)
    graph.off('edgeDropped', onEdgeDropped)
    graph.off('nodeAttributesUpdated', onNodeAttrsUpdated)
  }
}
