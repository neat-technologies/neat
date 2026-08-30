---
name: incident-card
description: The incident card — one self-sufficient work order composed on every incident. A pure assembler fuses the ErrorEvent with the root-cause chain, blast radius, governing policies, and node divergence, each claim provenance-stamped. One composed REST read (GET /graph/incident-card/:nodeId) backs both the get_incident_card pull tool and the monitor's push. A ninth SSE event type (incident) triggers the push; its payload is a lean trigger, the card is the read.
governs:
  - "packages/core/src/goodybag.ts"
  - "packages/types/src/incident-card.ts"
adr: [ADR-221, ADR-189, ADR-038, ADR-108, ADR-060, ADR-215, ADR-216, ADR-051, ADR-159]
enforcement: [lint, review]
---

# Incident-card contract

The card is the agent's work order for one incident: where the cause is, what a fix reaches, what governs the file, and how much each claim can be trusted — assembled once so the agent reads instead of grepping (ADR-221).

## 1. The card is pure composition — it computes nothing new

`buildIncidentCard` in `goodybag.ts` composes surface that already ships. It calls, and only calls, the governed queries:

- `getRootCause(graph, affectedNode, errorEvent, incidents)` — the causal chain (traversal.md, ADR-189/190).
- `getBlastRadius(graph, affectedNode)` — what a fix reaches (get-blast-radius.md, ADR-038).
- `selectApplicablePolicies(graph, policies, affectedNode)` — the rules that govern the node (policy overlay, ADR-108).
- `computeDivergences(graph, { node: affectedNode, incidents })` — code↔runtime disagreement at the node (divergence-query.md, ADR-060/215).
- the recovered locus, read off `errorEvent.attributes['code.filepath']` / `['code.lineno']` (ADR-215/216) — never re-derived; and, on a victim-surfaced incident that carries none, promoted from the resolved root cause's own declared file:line (§2, #1111).

It is a **pure function** over the graph and the incident set: no I/O, no mutation, no async of its own. The read of the append-only incident sidecar stays at the REST call site (the same discipline `computeDivergences` keeps), so the assembler never touches disk. It introduces no new graph computation and no driver-specific logic — if a claim isn't already computable by a governed query, it isn't on the card.

## 2. Zero fabrication, calibrated provenance — never "100% fact"

The card's trust model is the graph's: every claim is stamped, nothing is invented.

- **`locus` is `null`, never a guessed `file:line`.** Present as **OBSERVED** when the incident carried `code.filepath`/`code.lineno` or a stacktrace frame resolved to a real FileNode (ADR-216). When a victim-surfaced incident carries none but the resolved root cause does, the cause's locus is **promoted onto the card as `INFERRED`** — it names the cause, not the observed surface (#1111) — and only ever a locus the root-cause node, or a native incident recorded at it, actually carries. Otherwise the card lands at the coarsest grain it can stand behind (service).
- **Each chain hop carries its own `provenance` and `carriesSignal`.** An OBSERVED link and an INFERRED stitch are never flattened into one number. The agent sees which links to trust and which to verify.
- **`rootCause` is `null` when no cause is reachable** (e.g. a STALE-only upstream); the incident still ships, the diagnosis is absent, not fabricated.
- **A saturated downstream victim is classified `symptom-only`,** not dressed as a cause (ADR-189). The card degrades honestly — a recall bound, never a false claim.

## 3. The ninth event is a lean trigger; the card is a REST read

Incidents earn a bus type because they are append-only, point-in-time facts — not reconstructable from current graph state, so no structural trigger stands in for them (ADR-221, contrast divergence's re-derivable query, ADR-060). The `incident` SSE payload is a trigger only:

```
IncidentEventPayload = { incidentId, affectedNode, service, incidentKind, at }
```

The full card is fetched over REST, keeping the monitor's "trigger thin, context fat" shape (ADR-159). The producer emits the event from the incident write path (`ingest.ts`, where the `ErrorEvent` is appended) via `emitNeatEvent`, the same way `stale-transition` is emitted — not through the graph-mutation re-emitter.

## 4. One composed read backs both surfaces

`GET /graph/incident-card/:nodeId` (dual-mounted per ADR-026; optional `?errorId=` pins one incident, default is the node's most recent) returns exactly one `IncidentCard`. It backs:

- the **pull path** — the `get_incident_card` MCP tool (mcp-tools.md), read-only over this REST route like every tool;
- the **push path** — the monitor's `incident` fact kind reads this route for the id its `incident` event carried (cli-surface.md).

The endpoint's incident read is **bounded** the same way `get_incident_history` is (a busy node accumulates far more incidents than a card needs — never serialize the whole store).

## 5. The card shape (the build spec)

`IncidentCardSchema` in `packages/types/src/incident-card.ts` — additive schema growth (schema.md, ADR-031), a new exported schema with no shape change to any existing one:

```ts
IncidentKind = 'exception' | '5xx' | '4xx-burst' | 'status-error' | 'connector'

IncidentChainHop = {
  node: string
  grain: string                 // 'service' | 'file' | 'symbol' | 'table' | 'column' | …
  edgeType?: string             // the edge INTO this hop from the previous one
  provenance: Provenance
  carriesSignal?: boolean
}

IncidentLocus = {
  file: string
  lineStart?: number
  lineEnd?: number
  symbol?: string
  service?: string
  provenance: Provenance
}

IncidentCard = {
  kind: 'incident'
  id: string
  at: string                    // ISO8601 — the incident's own time
  incidentKind: IncidentKind
  service: string
  affectedNode: string
  message: string
  exceptionType?: string
  httpStatusCode?: number
  count?: number                // coalesced burst size (ErrorEvent.incidentCount)
  window?: { first: string; last: string }
  traceId?: string
  spanId?: string
  locus: IncidentLocus | null
  rootCause: {
    node: string
    classification?: string     // 'cause' | 'symptom-only' | …
    reason: string
    confidence: number          // 0..1
    fix?: string | null
    chain: IncidentChainHop[]
  } | null
  blastRadius?: { totalAffected: number; nearest: { node: string; distance: number; provenance: Provenance }[] }
  policies?: { policyName: string; severity: string; message?: string }[]
  divergence?: { type: string; summary: string }[]
  headline: string              // the rendered sentence
}

IncidentEventPayload = { incidentId: string; affectedNode: string; service: string; incidentKind: IncidentKind; at: string }
```

The `headline` renders the one-line sentence — e.g. `SYMBOL validateSession at LINES 42-58 in auth.ts (SERVICE api) raised TypeError at 14:03Z → caused 500 in getUser (SERVICE web) reading SUPABASE users` — a human/loose-LLM read over the structured body, never the wire format.

## Enforcement

`enforcement: [lint, review]`. **Lint:** a `contracts.test.ts` assertion holds the assembler's purity (§1) statically — `goodybag.ts` does no disk I/O and `buildIncidentCard` is synchronous. **Review:** the zero-fabrication rules (§2) are asserted behaviorally by unit tests over `buildIncidentCard` — a missing-locus incident yields `locus: null`, an affected node absent from the graph yields `rootCause: null` and no blast radius — and the pillar-matching judgement is a human call. The event/tool/monitor wiring is covered by the frontend-api, mcp-tools, and cli-surface contracts respectively.
