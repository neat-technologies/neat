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
adr: [ADR-029, ADR-024, ADR-027, ADR-066, ADR-068, ADR-094, ADR-157, ADR-213, ADR-219]
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

## Provenance at attribute grain — columns (ADR-157)

Provenance is not only an edge property. A column NEAT knows about is a provenanced **attribute** on the table node it belongs to — `columns: { name, provenances, confidence }[]` on the `sql-table` / `supabase-table` InfraNode (ADR-157 §1, [schema.md](./schema.md)) — never its own node. `provenances` is a deduped set of the same four settled values read one grain finer: a column carries `OBSERVED` once a production `db.statement` touches it, `EXTRACTED` once a schema/ORM declares it. A column records **both sides independently** — a declared column production also touches carries `[EXTRACTED, OBSERVED]`, not one clobbering the other — because column drift (ADR-157 §4) is exactly the question of which columns are declared-only, observed-only, or both, and a single scalar could not answer it. `PROV_RANK` (OBSERVED > EXTRACTED) still ranks the set where a surface needs one headline provenance; `confidence` is the strongest evidence's grade, in `[0, 1]` the same tiers ADR-066 locks — a column recovered from a real statement is a direct, unambiguous observation (the name is literally in the text, and the parser degrades rather than guess), so it lands high but not at the `1.0` an edge earns only from strong recent traffic (per-column volume grading is a future refinement). The folds live in `ingest.ts` — `mergeObservedColumns` for the OBSERVED read, `mergeDeclaredColumns` for the EXTRACTED read (which `extract/calls/*` drives through the shared `foldColumns` primitive in `columns.ts`) — per the lifecycle authority (ADR-030), and a name is never duplicated.

## FRONTIER provenance — the surface tense: what sits outside the settled graph (ADR-094 / ADR-226)

The fifth provenance value, `FRONTIER`, is the label for **what sits outside the settled graph** — a real, persisted edge (a *surface*) that is not part of the settled four. It faces two ways (ADR-226):
- the **unobservable present** — a relationship NEAT reached toward but cannot yet see: a hop whose far end **hung** and exported no span ("OTel into the universe"), or an external API beyond its instrumentation;
- the **not-yet-real future** — a relationship a change *intends* but has not enacted: an agent's proposed deploy, a PR's would-be edges, a staged feature env.

Both are outside the graph, both carry FRONTIER, and both resolve by **graduate** (it became observable/real) or **cull** (it never did). The other four provenances describe the settled past or the parsed present; FRONTIER is the graph's edge in both directions of the unsettled.

**Landed on the read/observe side first (ADR-226).** FRONTIER is a real, validatable, persisted edge provenance again (restoring the value ADR-068 froze out, on the terms ADR-094 reserved). Its first writer is the **hang sensor** — a post-ingest analysis pass (ADR-226), never the OTLP hot path — which stages a FRONTIER edge for the unobservable-present face. The **future** face is still written only by the kernel's proposal channel (ADR-093): `ingest.ts` and `extract/*` never emit a *future* proposal; a span or a parsed call is a settled fact. The two writers stage the same tense on different axes — one an unseen present, one an unenacted future.

**Wire format.** `frontierEdgeId('service:a', 'service:b', 'CALLS')` → `CALLS:FRONTIER:service:a->service:b` — the same provenance-prefixed pattern as INFERRED/OBSERVED, in the one identity module.

**Lifecycle — enter, then exactly one exit:**
- **graduate** to OBSERVED — passed the gate, traffic confirmed. The id moves from the FRONTIER pattern to the OBSERVED pattern; the proposal became real.
- **refused** — a `block` violation at the gate (ADR-093); the edge never lands.
- **culled** — the observation window expired without confirming traffic; the staged edge is retired.

**Two graduation mechanisms, one tense (ADR-226).** The exit path depends on the face. The **future** face is *preventable*, so it graduates through the policy **gate** (ADR-093): the gate sits on the **FRONTIER→OBSERVED** transition, evaluated against the proposed final state (`real ∪ delta`, the gate path in [`policy-overlay.md`](./policy-overlay.md) / ADR-105); positive OTel evidence cannot override a `block`, only a human can. The **present** face *cannot be prevented* — a hang is a fact NEAT could not see, not a change it might stop — so it graduates by **promotion**: the FRONTIER surface is replaced when its OBSERVED twin arrives, the same mechanism `FrontierNode` promotion already uses (ADR-044), never gated. Sharper than ADR-093's "FRONTIER → gate": **proposed-change FRONTIER gates; unseen-reality FRONTIER promotes-on-observe.**

**Excluded from PROV_RANK and settled traversal (implemented, ADR-226).** A FRONTIER edge is not part of the settled graph, so it is never ranked against settled edges — it is **absent from `PROV_RANK`** (which keeps its four settled entries) and floors below `STALE` (PROVENANCE.md's `STALE ≥ FRONTIER`) if ever compared — and it is **skipped** by `getRootCause` / `getBlastRadius` / `getTransitiveDependencies` / node-context, the edge-level twin of [Rule 3](../contracts.md#3-frontier-edges-are-not-traversed)'s node-level "stop at FrontierNodes." The kernel reads the FRONTIER delta separately, against `real ∪ delta`, to evaluate the gate.

**Required fields.** A FRONTIER edge carries the proposal context — minimally what proposed it and when, plus the observation window that bounds the cull. The exact field shape opens with the kernel build (ADR-093); this contract fixes that the edge is a staged proposal, gate-bound, and write-restricted to the proposal path.

**FrontierNode (node type) vs FRONTIER (provenance) stay distinct.** They share a root word on different axes — a node *type* (an unresolved external host, ADR-023/068) versus an edge *provenance* (a staged proposal). They never occupy the same slot: a FrontierNode is a node id with the `frontier:` prefix; FRONTIER provenance is an edge's `provenance` field and id segment. An edge *into* a FrontierNode is typically `OBSERVED` (the span happened, the peer is unresolved) — unchanged. Code touching both carries the comment convention to keep them unambiguous (ADR-094).

## Confidence semantics per provenance (ADR-066)

PROV_RANK locks tier ordering — OBSERVED outranks INFERRED outranks EXTRACTED outranks STALE. The grading below sits *within* each tier so the divergence query (ADR-060 / ADR-066) can reweight against honest values, not flat coarse ones.

- **OBSERVED** — graded by the `signal` block at ingest. `spanCount >= 100` plus `lastObservedAgeMs < 1h` grades `0.95–1.0`; `spanCount 10–99` recent grades `0.7–0.9`; `spanCount < 10` recent grades `0.4–0.6` (a single span could be a misconfig). `errorCount / spanCount > 0` subtracts up to `0.2` for degraded edges. The grading helper lives in `@neat.is/types/confidence.ts`; `upsertObservedEdge` calls it at the same point it writes `signal`. Edges with FrontierNode targets go through the same path — the OBSERVED grading is uniform regardless of target resolution status (ADR-068).
- **INFERRED** — `confidence ≤ 0.7`, default `0.6` (`INFERRED_CONFIDENCE` in `ingest.ts`). Set at creation by the trace stitcher; never exceeds `0.7`.
- **EXTRACTED** — graded at emit time per extractor. Structural file facts (imports, package.json deps, Dockerfile `RUNS_ON`, ConfigNode existence per ADR-016) and verified call sites (framework-aware recognizer matched) grade `0.85`. String-shaped candidates with structural support grade `0.5`. String-shaped candidates without structural support grade `0.2` and are dropped at emit by the precision floor (`NEAT_EXTRACTED_PRECISION_FLOOR`, default `0.7`) before they reach the graph. A client↔route match whose URL couldn't be faithfully reconstructed — a load-bearing interpolation left the host or the whole path un-anchored — grades `reconstructed-approximate` (`0.15`, ADR-219): the reconstruction-fidelity axis orthogonal to which recognizer fired, below the floor so an approximated target refuses under the default rather than grading identically to a literal match. The grading helper in `@neat.is/types/confidence.ts` is the single source of truth; per-extractor code imports it rather than hand-rolling values.
- **STALE** — confidence drops to `≤ 0.3` on transition; original `lastObserved` preserved.
- **FRONTIER** — carries no settled confidence; it is a proposal, not a measured or parsed fact. The gate decides graduation; confidence is assigned (as OBSERVED) only if it graduates.

## Required fields per provenance

- **OBSERVED:** `lastObserved` (ISO8601), `callCount`, `signal: { spanCount, errorCount, lastObservedAgeMs }`, graded `confidence` in `[0, 1]` per the OBSERVED grading function.
- **INFERRED:** `confidence` (0.0–0.7).
- **EXTRACTED:** `evidence: { file, line?, snippet? }` for CALLS-family edges; broader evidence shapes for other edge types are pending the v0.2.1 tree-sitter rebuild (issue #140). A datastore `CONNECTS_TO` edge may also carry `evidence.hostSource` (`'literal' | 'config'`, ADR-213) — how the recogniser recovered the peer host, `config` for an env var / config-key read (the deployment's real target) and `literal` for a hardcoded string literal. It is optional and read by the divergence ranker to tell a real declared store from a hardcoded fault-injection / flag-gated probe ([`divergence-query.md`](./divergence-query.md) §5e); a recogniser that does not distinguish the two leaves it unset. Graded `confidence` in `[0, 1]` per the EXTRACTED grading function — flat-`0.5` emissions are a contract violation (ADR-066).
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
