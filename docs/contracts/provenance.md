---
name: provenance
description: Edge ids and provenance ranking are constructed via @neat.is/types/identity helpers. Provenance is how the edge was learned; node-type is what sits at the endpoints. Coexistence of OBSERVED and EXTRACTED edges is structural, not policy. FRONTIER is the staged-proposal tense (ADR-094) — written only by the kernel proposal path, excluded from settled traversal.
governs:
  - "packages/core/src/ingest.ts"
  - "packages/core/src/traverse.ts"
  - "packages/core/src/persist.ts"
  - "packages/core/src/extract/**"
  - "packages/types/src/identity.ts"
  - "packages/types/src/edges.ts"
  - "packages/types/src/constants.ts"
adr: [ADR-029, ADR-024, ADR-027, ADR-066, ADR-068, ADR-094]
enforcement: [lint, review]
---

# Provenance contract

Every edge in NEAT carries a `provenance` field. The provenance value (`OBSERVED | INFERRED | EXTRACTED | STALE`) describes *how* the edge was learned. It is orthogonal to node-type — a FrontierNode (ADR-023) can sit at one endpoint of an OBSERVED, INFERRED, or EXTRACTED edge, and the edge's provenance reflects the producer, not the target's resolution status (ADR-068).

The provenance value determines:

1. The id wire format (each provenance has its own pattern).
2. The trust ranking when multiple edges between the same node pair coexist.
3. The set of required fields on the edge (`lastObserved`, `callCount`, `confidence`, `evidence`).
4. The lifecycle rules — when the edge can transition or be retired.

A fifth value, `FRONTIER`, is the **staged-proposal tense** (ADR-094): not *how an edge was learned* but a relationship a change *intends* to create and has not yet enacted. It is written only by the kernel's proposal path — never by `ingest.ts` or `extract/*` — and is detailed in [FRONTIER provenance](#frontier-provenance--the-staged-proposal-tense-adr-094) below.

## Edge id helpers

```ts
import { extractedEdgeId, observedEdgeId, inferredEdgeId, parseEdgeId, frontierId } from '@neat.is/types'

extractedEdgeId('service:a', 'service:b', 'CALLS')
// 'CALLS:service:a->service:b'

observedEdgeId('service:a', 'service:b', 'CALLS')
// 'CALLS:OBSERVED:service:a->service:b'

inferredEdgeId('service:a', 'service:b', 'CALLS')
// 'CALLS:INFERRED:service:a->service:b'

// Edge to a FrontierNode — provenance is OBSERVED (the span happened),
// target is the frontier-prefixed node id (the peer is unresolved).
observedEdgeId('service:a', frontierId('unknown:8080'), 'CALLS')
// 'CALLS:OBSERVED:service:a->frontier:unknown:8080'

parseEdgeId('CALLS:OBSERVED:service:a->service:b')
// { type: 'CALLS', provenance: 'OBSERVED', source: 'service:a', target: 'service:b' }
```

Hand-rolled template literals like `` `${type}:OBSERVED:${source}->${target}` `` are a contract violation. The wire format lives in exactly one file (`packages/types/src/identity.ts`).

STALE never appears in an edge id. STALE is a transition of an existing OBSERVED edge (ADR-024), not a creation pattern. The id stays at `${type}:OBSERVED:${source}->${target}` after the transition; only the `provenance` attribute changes.

A `frontierEdgeId` helper exists for staging proposals (ADR-094, see [FRONTIER provenance](#frontier-provenance--the-staged-proposal-tense-adr-094)). It is distinct from edges *to* a FrontierNode, which use the provenance-appropriate helper (`observedEdgeId` for span-derived edges, etc.) with the FrontierNode id as the target — a FrontierNode endpoint does not make an edge FRONTIER-provenance.

## Wire format (locked)

| Provenance | Pattern                                          | Confidence            | Created by                  |
|------------|--------------------------------------------------|-----------------------|-----------------------------|
| EXTRACTED  | `${type}:${source}->${target}`                   | graded per ADR-066    | static analyzers (extract/) |
| OBSERVED   | `${type}:OBSERVED:${source}->${target}`          | graded per ADR-066    | `upsertObservedEdge`        |
| INFERRED   | `${type}:INFERRED:${source}->${target}`          | ≤ 0.7, default 0.6    | trace stitcher              |
| STALE      | (id pattern stays at the OBSERVED id)            | ≤ 0.3                 | `markStaleEdges` transition |
| FRONTIER   | `${type}:FRONTIER:${source}->${target}`          | n/a (a proposal)      | kernel proposal path (ADR-093) |

Edges to FrontierNodes follow the same wire format — the target string carries the `frontier:` prefix, the provenance segment in the id reflects how the edge was learned. Example: `CALLS:OBSERVED:service:checkout->frontier:api.github.com`.

## Coexistence rule (binding)

OBSERVED and EXTRACTED edges between the same node pair coexist as **separate edges with distinct ids**, not a single edge upgraded in place. The id pattern is what makes coexistence mechanically possible: `extractedEdgeId('a', 'b', 'CALLS')` and `observedEdgeId('a', 'b', 'CALLS')` are different strings, so `graph.hasEdge(...)` doesn't conflate them.

This is intentional. The gap between declared intent (EXTRACTED) and observed reality (OBSERVED) is the load-bearing fact NEAT exists to surface (ADR-027). Stomping one with the other erases the gap.

## Provenance ranking — `PROV_RANK`

The canonical priority used by traversal and any consumer that needs to pick a single edge between two nodes when multiple provenance variants exist:

```ts
import { PROV_RANK } from '@neat.is/types'

PROV_RANK.OBSERVED   // 3
PROV_RANK.INFERRED   // 2
PROV_RANK.EXTRACTED  // 1
PROV_RANK.STALE      // 0
```

Frozen object with four entries. Consumers import it; nobody re-defines it locally. Traversal uses it to pick the highest-priority edge per `(source, target, type)` triplet at every hop.

Per ADR-068, the rank covers exactly the four **settled** provenance values. FRONTIER is not ranked — a proposal is not part of the real graph (see below). Node-type gating (e.g. "stop at FrontierNodes" per [contracts.md Rule 3](../contracts.md#3-frontier-edges-are-not-traversed)) is enforced at the node level by traversal, independent of edge rank.

## FRONTIER provenance — the staged-proposal tense (ADR-094)

The fifth provenance value, `FRONTIER`, is the **staged-proposal tense**: a relationship a change *intends* to create but has not enacted — an agent's proposed deploy, a PR's would-be edges, an experiment staged and watched. The other four describe the settled past or the parsed present; FRONTIER is the only provenance describing the future.

**Written only by the kernel's proposal path.** `ingest.ts` and `extract/*` never emit FRONTIER — a span or a parsed call is a settled fact, not a proposal. FRONTIER edges enter only through the kernel's proposal channel (ADR-093): a check primitive takes a delta and stages it as FRONTIER-tagged edges.

**Wire format.** `frontierEdgeId('service:a', 'service:b', 'CALLS')` → `CALLS:FRONTIER:service:a->service:b` — the same provenance-prefixed pattern as INFERRED/OBSERVED, in the one identity module.

**Lifecycle — enter, then exactly one exit:**
- **graduate** to OBSERVED — passed the gate, traffic confirmed. The id moves from the FRONTIER pattern to the OBSERVED pattern; the proposal became real.
- **refused** — a `block` violation at the gate (ADR-093); the edge never lands.
- **culled** — the observation window expired without confirming traffic; the staged edge is retired.

The policy gate (ADR-093) sits on the **FRONTIER→OBSERVED** transition: graduation is evaluated against the proposed final state (`real ∪ delta`, the gate path in [`policy-overlay.md`](./policy-overlay.md) / ADR-105). Positive OTel evidence cannot override a `block`; only a human overrides a block.

**Excluded from PROV_RANK and settled traversal.** A proposal is not part of the real graph, so FRONTIER edges are never ranked against settled edges and are skipped by `getRootCause` / `getBlastRadius` — the same way [Rule 3](../contracts.md#3-frontier-edges-are-not-traversed) keeps traversal inside the known graph. The kernel reads the FRONTIER delta separately, against `real ∪ delta`, to evaluate the gate.

**Required fields.** A FRONTIER edge carries the proposal context — minimally what proposed it and when, plus the observation window that bounds the cull. The exact field shape opens with the kernel build (ADR-093); this contract fixes that the edge is a staged proposal, gate-bound, and write-restricted to the proposal path.

**FrontierNode (node type) vs FRONTIER (provenance) stay distinct.** They share a root word on different axes — a node *type* (an unresolved external host, ADR-023/068) versus an edge *provenance* (a staged proposal). They never occupy the same slot: a FrontierNode is a node id with the `frontier:` prefix; FRONTIER provenance is an edge's `provenance` field and id segment. An edge *into* a FrontierNode is typically `OBSERVED` (the span happened, the peer is unresolved) — unchanged. Code touching both carries the comment convention to keep them unambiguous (ADR-094).

## Confidence semantics per provenance (ADR-066)

PROV_RANK locks tier ordering — OBSERVED outranks INFERRED outranks EXTRACTED outranks STALE. The grading below sits *within* each tier so the divergence query (ADR-060 / ADR-066) can reweight against honest values, not flat coarse ones.

- **OBSERVED** — graded by the `signal` block at ingest. `spanCount >= 100` plus `lastObservedAgeMs < 1h` grades `0.95–1.0`; `spanCount 10–99` recent grades `0.7–0.9`; `spanCount < 10` recent grades `0.4–0.6` (a single span could be a misconfig). `errorCount / spanCount > 0` subtracts up to `0.2` for degraded edges. The grading helper lives in `@neat.is/types/confidence.ts`; `upsertObservedEdge` calls it at the same point it writes `signal`. Edges with FrontierNode targets go through the same path — the OBSERVED grading is uniform regardless of target resolution status (ADR-068).
- **INFERRED** — `confidence ≤ 0.7`, default `0.6` (`INFERRED_CONFIDENCE` in `ingest.ts`). Set at creation by the trace stitcher; never exceeds `0.7`.
- **EXTRACTED** — graded at emit time per extractor. Structural file facts (imports, package.json deps, Dockerfile `RUNS_ON`, ConfigNode existence per ADR-016) and verified call sites (framework-aware recognizer matched) grade `0.85`. String-shaped candidates with structural support grade `0.5`. String-shaped candidates without structural support grade `0.2` and are dropped at emit by the precision floor (`NEAT_EXTRACTED_PRECISION_FLOOR`, default `0.7`) before they reach the graph. The grading helper in `@neat.is/types/confidence.ts` is the single source of truth; per-extractor code imports it rather than hand-rolling values.
- **STALE** — confidence drops to `≤ 0.3` on transition; original `lastObserved` preserved.
- **FRONTIER** — carries no settled confidence; it is a proposal, not a measured or parsed fact. The gate decides graduation; confidence is assigned (as OBSERVED) only if it graduates.

## Required fields per provenance

- **OBSERVED:** `lastObserved` (ISO8601), `callCount`, `signal: { spanCount, errorCount, lastObservedAgeMs }`, graded `confidence` in `[0, 1]` per the OBSERVED grading function.
- **INFERRED:** `confidence` (0.0–0.7).
- **EXTRACTED:** `evidence: { file, line?, snippet? }` for CALLS-family edges; broader evidence shapes for other edge types are pending the v0.2.1 tree-sitter rebuild (issue #140). Graded `confidence` in `[0, 1]` per the EXTRACTED grading function — flat-`0.5` emissions are a contract violation (ADR-066).
- **STALE:** `lastObserved` preserved from the OBSERVED state, `confidence ≤ 0.3`.
- **FRONTIER:** proposal context (what proposed it, when) + the observation window that bounds the cull; written only by the kernel proposal path. Exact shape opens with the kernel build (ADR-093/094).

## Enforcement

`packages/core/test/audits/contracts.test.ts` adds:
- A scan for hand-rolled `` `${type}:OBSERVED:` ``, `` `:INFERRED:` ``, `` `:FRONTIER:` ``, and `` `${type}:${source}->...` `` template literals in `packages/core/src/` and `packages/mcp/src/`. CI fails any future session that drifts.
- Round-trip assertions on the helpers and `parseEdgeId`, including a `frontierEdgeId` round-trip that parses back with `provenance === 'FRONTIER'`.
- An assertion that `PROV_RANK.OBSERVED > PROV_RANK.INFERRED > PROV_RANK.EXTRACTED > PROV_RANK.STALE`.
- An assertion that `PROV_RANK` has exactly four entries (the settled values; FRONTIER is excluded from ranking) and `ProvenanceSchema` has exactly five options (the four settled + FRONTIER, ADR-094).
- An assertion that `Provenance.FRONTIER` / `frontierEdgeId` are written only on the kernel proposal path — `packages/core/src/ingest.ts` and `packages/core/src/extract/**` never reference them (a settled fact is never staged as a proposal).
- An assertion that traversal (`getRootCause` / `getBlastRadius`) skips FRONTIER-provenance edges, the same as it excludes edges into FrontierNodes.
- An assertion that `observedEdgeId(source, frontierId(host), type)` round-trips through `parseEdgeId` with `provenance === 'OBSERVED'` and the FrontierNode target preserved.

## Rationale

If two producers disagree on the wire format of an OBSERVED edge id, the upsert function in `ingest.ts` won't find the existing edge and will create a duplicate. If two consumers disagree on PROV_RANK, traversal returns different paths from different call sites for the same query. Both failures are silent.

ADR-029 collapses four scattered helpers (`makeEdgeId` in `extract/shared.ts`, two locals in `ingest.ts`, one inline literal) into one canonical module so producers and consumers can't drift apart. ADR-094 adds FRONTIER as the staged-proposal tense without touching the settled four — the proposal channel is net-new surface (the kernel), so the high-volume ingest and extract paths are unchanged.

Full rationale and historical context: [ADR-029](../decisions.md#adr-029--edge-identity-and-provenance-ranking); the FRONTIER write semantics are [ADR-094](../decisions.md#adr-094--frontier-provenance-the-staged-proposal-tense).
