---
name: incident-card
description: The incident card — one self-sufficient work order composed on every incident. A pure assembler fuses the ErrorEvent with the root-cause chain, blast radius, governing policies, and node divergence, each claim provenance-stamped. One composed REST read (GET /graph/incident-card/:nodeId) backs both the get_incident_card pull tool and the monitor's push; for a node with no recorded incident the same read composes the card from the graph alone, with the incident-only fields null and a reason (ADR-244). A ninth SSE event type (incident) triggers the push; its payload is a lean trigger, the card is the read.
governs:
  - "packages/core/src/goodybag.ts"
  - "packages/types/src/incident-card.ts"
adr: [ADR-221, ADR-189, ADR-038, ADR-108, ADR-060, ADR-215, ADR-216, ADR-051, ADR-159, ADR-238, ADR-244, ADR-270]
enforcement: [lint, review]
---

# Incident-card contract

The card is the agent's work order for one incident: where the cause is, what a fix reaches, what governs the file, and how much each claim can be trusted — assembled once so the agent reads instead of grepping (ADR-221).

## 1. The card is pure composition — it computes nothing new

`buildIncidentCard` in `goodybag.ts` composes surface that already ships. It calls, and only calls, the governed queries:

- `getRootCause(graph, affectedNode, errorEvent, incidents)` — the causal chain (traversal.md, ADR-189/190).
- `getBlastRadius(graph, affectedNode)` — what a fix reaches (get-blast-radius.md, ADR-038).
- `selectApplicablePolicies(graph, policies, affectedNode)` — the rules that govern the node (policy overlay, ADR-108).
- `computeDivergences(graph, { node: affectedNode, incidents })` — code↔runtime disagreement at the node (divergence-query.md, ADR-060/215). This includes a `config-mismatch` touching the node (ADR-265, divergence-query.md §5i), such as a caller's address naming a port this service doesn't expose. Its summary is `configMismatchPhrase`, which lists every side with its source and does not say which side is wrong.
- the recovered locus, read off `errorEvent.attributes['code.filepath']` / `['code.lineno']` (ADR-215/216) — never re-derived; and, on a victim-surfaced incident that carries none, promoted from the resolved root cause's own declared file:line (§2, #1111).

`composeNodeCard(graph, nodeId, incidents, policies)` is the same composition with no `ErrorEvent` (ADR-244): one internal composer serves both, so the two entry points cannot drift. With no event, `getRootCause` runs on the node alone and the locus comes only from the root-cause promotion below.

It is a **pure function** over the graph and the incident set: no I/O, no mutation, no async of its own. The read of the append-only incident sidecar stays at the REST call site (the same discipline `computeDivergences` keeps), so the assembler never touches disk. It introduces no new graph computation and no driver-specific logic — if a claim isn't already computable by a governed query, it isn't on the card.

**One derived field (ADR-238).** The card carries `grade`, computed by `gradeIncidentCard` in `goodybag.ts` from the card's own fields and nothing else. It's the only computed field, and it is held to the same purity rule. Each policy entry carries the `onViolation` the policy overlay already resolves, which the grade's policy gate reads.

## 2. Zero fabrication, calibrated provenance — never "100% fact"

The card's trust model is the graph's: every claim is stamped, nothing is invented.

- **`locus` is `null`, never a guessed `file:line`.** Present as **OBSERVED** when the incident carried `code.filepath`/`code.lineno` or a stacktrace frame resolved to a real FileNode (ADR-216). When a victim-surfaced incident carries none but the resolved root cause does, the cause's locus is **promoted onto the card as `INFERRED`** — it names the cause, not the observed surface (#1111) — and only ever a locus the root-cause node, or a native incident recorded at it, actually carries. Otherwise the card lands at the coarsest grain it can stand behind (service).
- **Each chain hop carries its own `provenance` and `carriesSignal`.** An OBSERVED link and an INFERRED stitch are never flattened into one number. The agent sees which links to trust and which to verify.
- **`rootCause` is `null` when no cause is reachable** (e.g. a STALE-only upstream); the incident still ships, the diagnosis is absent, not fabricated.
- **A card composed without an incident invents no failure (ADR-244).** `id`, `at`, `incidentKind` and `message` are `null`, `noIncident.reason` says why, and the event-only optional fields (`exceptionType`, `httpStatusCode`, `count`, `window`, `traceId`, `spanId`, `deployContext` while it is read off the event) are absent. `service` is the node's owning service, or `null` when the graph records none. The locus is the root cause's promoted locus or `null`, never the node's own file posed as a failure site. The grade's `kind` and `recur` factors are `null` with a reason, so with no locus the card grades `out` rather than fix-ready.
- **A saturated downstream victim is classified `symptom-only`,** not dressed as a cause (ADR-189). The card degrades honestly — a recall bound, never a false claim.

## 3. The ninth event is a lean trigger; the card is a REST read

Incidents earn a bus type because they are append-only, point-in-time facts — not reconstructable from current graph state, so no structural trigger stands in for them (ADR-221, contrast divergence's re-derivable query, ADR-060). The `incident` SSE payload is a trigger only:

```
IncidentEventPayload = { incidentId, affectedNode, service, incidentKind, at }
```

The full card is fetched over REST, keeping the monitor's "trigger thin, context fat" shape (ADR-159). The producer emits the event from the incident write path (`ingest.ts`, where the `ErrorEvent` is appended) via `emitNeatEvent`, the same way `stale-transition` is emitted — not through the graph-mutation re-emitter.

## 4. One composed read backs both surfaces

`GET /graph/incident-card/:nodeId` (dual-mounted per ADR-026; optional `?errorId=` pins one incident, default is the node's most recent) returns exactly one `IncidentCard`. A node with no recorded incident gets the card composed from the graph (`noIncident` set), not a 404 (ADR-244): the card is the shape of the answer, and a pull ("compose the incident for this node") and a push (on detection) return the same composed incident. An unknown node and an unknown `?errorId` still 404. There is no mode parameter; `noIncident` tells the caller which card it got. The default "now" selection, and the incident lead (ADR-264) that ranks what is failing now, skip a connector-sourced incident whose workload the connector observes Ready again (#1488, `isRecoveredK8sIncident`): it is over, so it leads neither the card nor the lead, while `get_incident_history` keeps it. An explicit `?errorId=` is exact and never filtered. It backs:

- the **pull path** — the `get_incident_card` MCP tool (mcp-tools.md), read-only over this REST route like every tool;
- the **push path** — the monitor's `incident` fact kind reads this route for the id its `incident` event carried (cli-surface.md).

The endpoint's incident read is **bounded** the same way `get_incident_history` is (a busy node accumulates far more incidents than a card needs — never serialize the whole store).

## 5. The card shape (the build spec)

`IncidentCardSchema` in `packages/types/src/incident-card.ts` — added as growth (schema.md, ADR-031); ADR-244 loosens `id`, `at`, `incidentKind`, `service` and `message` to nullable, a shape change with no persisted data to migrate (the card is composed on every read):

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
  id: string | null             // null only when composed without an incident (ADR-244)
  at: string | null             // ISO8601 — the incident's own time; null as id
  incidentKind: IncidentKind | null   // null as id
  service: string | null        // null only when composed without an incident and no service owns the node
  affectedNode: string
  message: string | null        // null as id
  noIncident?: { reason: string }     // present iff composed for a node with no recorded incident
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
  deployContext?: {              // the OBSERVED deploy/process/config "why" of a pre-span failure (ADR-237/239 ingest, ADR-240 surface), read off the workload node's `observedDeployContext` (ADR-243); present only on the k8s deploy-fault incident it was observed with
    fault?: string; waitingReason?: string; image?: string
    restartCount?: number; terminatedReason?: string; exitCode?: number
    containerEnv?: string[]      // redacted NAME=value descriptors (secret-keyed masked, valueFrom = reference)
    containerArgs?: string[]
    processLog?: string          // the last-terminated (or current) stdout tail, redacted
  }
  headline: string              // the rendered sentence
}

IncidentEventPayload = { incidentId: string; affectedNode: string; service: string; incidentKind: IncidentKind; at: string }
```

The `headline` renders the one-line sentence — e.g. `SYMBOL validateSession at LINES 42-58 in auth.ts (SERVICE api) raised TypeError at 14:03Z → caused 500 in getUser (SERVICE web) reading SUPABASE users` — a human/loose-LLM read over the structured body, never the wire format.

### Changed since healthy leads the card (ADR-270)

`changedSinceHealthy?: ChangesSinceHealthy` (`packages/types/src/results.ts`) is what changed since the system was last healthy:

```ts
ChangesSinceHealthy = {
  at: string                       // the failure's onset the base was chosen against
  base: { takenAt: string } | null // the healthy baseline diffed against
  from?: string                    // the card's affectedNode, for the ranking
  changes: HealthyChange[]         // nearest first
  provenance: 'OBSERVED'
}
HealthyChange = {
  id: string                       // `k8s:<kind>/<namespace>/<name>`, `flag:<store>/<key>`, or an edge id
  kind: 'object' | 'flag' | 'edge'
  node: string                     // the object's InfraNode, the flag store, the edge's source
  change: 'added' | 'removed' | 'modified' | 'started-erroring'
  fields: { path: string; before?: unknown; after?: unknown }[]   // by name: /template/containers/frontend/env/CART_ADDR
  distance?: number                // undirected hops from affectedNode
  hashBefore?: string; hashAfter?: string
}
```

- **Where it comes from.** The card route reads `GET /graph/changes?at=<onset>&from=<affectedNode>` and passes the result into the composer, which stays pure. `at` is the onset of the affected node's current run of incidents (its earliest incident with no gap over two minutes since). The base is the latest healthy baseline written before `at`, so a baseline written after the failure began is never the base.
- **When it is present.** Only when a base exists and at least one change is found; otherwise the field is absent and the card is exactly as it would be without a baseline.
- **Order.** When present, the card leads with it: renderers show it first, before the verdict or candidates, and the rest of this contract's order follows unchanged. The verdict slot after it is defined elsewhere in this contract.
- **Headline.** The headline gains ` — changed since healthy: <nearest change>`, one phrase from `healthyChangePhrase` (`incidents-render.ts`), for example `k8s-deployment frontend: containers/frontend/env/CART_ADDR removed (was cart:8080)`. A reader that rewrites the headline's verdict part keeps this suffix.
- **No verdict.** A change is a fact about the declared system, OBSERVED; the card does not say the change caused the failure. Changes are ranked by distance to the failing node, then modified/removed before added before newly erroring edges.
- **What it cannot see.** A fault that changes no declared object (state inside a process, a database, a node; a Chaos Mesh delay) leaves this section empty. That is about a quarter of SREGym's problems; the rest of the card covers them.

### The grade (ADR-238)

```ts
IncidentGradeFactor = { value: number | null; weight: number; evidence: string[]; reason?: string }
IncidentGrade = {
  G: number                     // Γ · C
  gamma: 0 | 1
  gates: { policyNotBlock, notSymptomOnly, locusResolves: { passed: boolean; evidence: string[] } }
  C: number                     // weighted mean of the non-null factors
  factors: { evidence, locus, tests, reach, kind, chain, recur, div: IncidentGradeFactor }
  band: 'full' | 'diagnose-only' | 'out'   // ≥0.75 · 0.5–0.75 · <0.5 or Γ = 0
  urgency: { value: number | null; reason?: string }   // orders within a band, never gates
  priorsVersion: string
}
IncidentCard.grade?: IncidentGrade
IncidentCard.policies[].onViolation?: 'log' | 'alert' | 'block'
```

Every factor names the card fields it read. A factor the card can't support is `null` with a `reason` and drops out of `C`; it is never estimated. The grade rides on the card's REST read, the MCP tool and the monitor line, never on the lean `incident` SSE payload. It informs; Sniper's gates and Jev decide (SNIPER-ADR-003).

## Enforcement

`enforcement: [lint, review]`. **Lint:** a `contracts.test.ts` assertion holds the assembler's purity (§1) statically — `goodybag.ts` does no disk I/O and `buildIncidentCard` is synchronous. **Review:** the zero-fabrication rules (§2) are asserted behaviorally by unit tests over `buildIncidentCard` — a missing-locus incident yields `locus: null`, an affected node absent from the graph yields `rootCause: null` and no blast radius, a node with no incident yields the incident-only fields `null` with `noIncident.reason` (`incident-card-node.test.ts`) — and the pillar-matching judgement is a human call. The event/tool/monitor wiring is covered by the frontend-api, mcp-tools, and cli-surface contracts respectively.
