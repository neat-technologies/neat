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

The response has `Content-Type: text/event-stream` and `X-NEAT-Event-Scope: incident-only-v1`. The bridge must require both before parsing frames, and refuse the general `/events` stream even if it sees an `incident` frame there. This route checks its dedicated bearer even when ordinary graph reads are public or a proxy authenticates them; without a configured stream token it returns unavailable. A bridge holding only this token cannot authenticate to the graph/card routes. Requests for a project the daemon does not serve fail through the normal project resolver.

This is an in-process live stream. It begins with `:open`, sends heartbeats, and has no event IDs or replay. A disconnected bridge can receive future incidents after reconnecting but cannot infer or backfill missed ones from this stream. A Sniper run without a trusted recorded trigger remains unavailable. The confidential worker independently verifies the exact incident card and verified source commit before model calls.
