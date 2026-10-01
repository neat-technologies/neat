---
name: incident-trigger-stream
description: A source-free, authenticated SSE projection of incident triggers for hosted Sniper intake.
governs:
  - 'packages/core/src/api.ts'
  - 'packages/core/src/streaming.ts'
  - 'packages/core/test/incident-trigger-stream.test.ts'
adr: [ADR-051, ADR-073, ADR-221]
enforcement: [lint, review]
---

# Incident-only trigger stream

The hosted Sniper bridge reads `GET /projects/:project/incident-triggers` with a dedicated `NEAT_INCIDENT_STREAM_TOKEN`, not the daemon's general bearer. The token must be at least 32 UTF-8 bytes and differ from the general daemon token; a missing, weak, or reused token makes the route unavailable. The unscoped route resolves the daemon's default project. This stream is a separate projection of the existing `incident` bus event, not a new event type. It emits `event: incident` with only `{ incidentId, affectedNode, service, incidentKind, at }`. It never forwards node, edge, card, graph, source, prompt, or credential fields. Payload fields are bounded and unknown fields are dropped.

The response has `Content-Type: text/event-stream`, `X-NEAT-Event-Scope: incident-only-v1`, `X-NEAT-Project: <resolved project>`, and `X-NEAT-Replay-Complete: 1`. The bridge must require all four before parsing frames, and refuse the general `/events` stream even if it sees an `incident` frame there. This route checks its dedicated bearer even when ordinary graph reads are public or a proxy authenticates them; without a configured stream token it returns unavailable. A bridge holding only this token cannot authenticate to the graph/card routes. Requests for a project the daemon does not serve fail through the normal project resolver.

Every incident frame carries `id: <incidentId>`, including core's usual `traceId:spanId` identity. Before opening a stream, the daemon reads the append-ordered project `errors.ndjson` ledger and replays events after the exact `Last-Event-ID`. An unknown cursor, corrupt or incomplete ledger, or ledger above the fixed 16 MiB/10,000-event bound refuses the stream. With no cursor, it replays the bounded ledger from the start. Only the five lean trigger fields leave the daemon; source-bearing ErrorEvent fields stay inside it. The bridge advances its durable cursor only after the control plane accepts each trigger.

The route is unavailable by default. `NEAT_INCIDENT_REPLAY_DURABLE=1` (or the equivalent API option) is an operator assertion that the complete errors ledger was restored before boot and remains durable for the hosted stream. Without that verified substrate, it cannot attest replay completeness and returns unavailable. The proposed Cloud Run backup/restore and crash-recovery gate must cover the errors ledger as well as the graph snapshot before enabling this assertion. A Sniper run without a trusted recorded trigger remains unavailable. The confidential worker independently verifies the exact incident card and source commit before model calls.

On hosted Cloud Run, `NEAT_INCIDENT_DURABLE_TOKEN` enables the separate local
snapshot sidecar append path. Every runtime ErrorEvent write waits for its
encrypted GCS commit before the local ledger is updated and an incident bus
event is emitted. Failed commits fail the writer without a local fallback.
The production environment cannot enable replay attestation without both
the durable flag and a strong append token. The sidecar's restore-gated startup
probe is the substrate proof; it restores the ledger and claims a generation
before daemon boot. This covers recorded incidents, not spans still waiting in
the receiver's asynchronous processing queue.
