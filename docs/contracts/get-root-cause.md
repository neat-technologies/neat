---
name: get-root-cause
description: getRootCause walks incoming edges to depth 5, dispatches by origin node type to a shape-specific compat check, returns a human-readable reason and a derived fix recommendation, validates the result before returning.
governs:
  - "packages/core/src/traverse.ts"
  - "packages/core/src/compat.ts"
  - "packages/types/src/results.ts"
adr: [ADR-037, ADR-114, ADR-014, ADR-029, ADR-031, ADR-158, ADR-189, ADR-190, ADR-191]
enforcement: [lint, review]
---

# `getRootCause` contract

`getRootCause` walks incoming edges from an error-surfacing node looking for an upstream incompatibility that explains the failure. Sibling contracts: [`traversal.md`](./traversal.md) (shared mechanics), [`get-blast-radius.md`](./get-blast-radius.md).

## Origin generality

`getRootCause` accepts any origin node and dispatches by `node.type`:

| Origin type     | Shape                                                              |
|-----------------|--------------------------------------------------------------------|
| DatabaseNode    | driver/engine compat (today's behavior; unchanged)                 |
| ServiceNode     | node-engine + package-conflict shapes from `compat.ts`             |
| FileNode        | resolves the file to its owning service, then the service shape    |
| SymbolNode      | resolves the symbol to its owning service, then the service shape  |
| InfraNode       | returns null (no matrix shape today)                               |
| ConfigNode      | returns null (no matrix shape today)                               |
| FrontierNode    | returns null (excluded from traversal anyway per ADR-036)          |

The dispatch lives in a `rootCauseShapes` table keyed by `NodeType`. Adding a new shape is one entry, not a code restructure.

The `SymbolNode` shape (ADR-158 §7) is the file shape one grain finer: a failure can surface on a symbol (the function that holds the failing edge), but the incompatibility, if any, is still a property of the service that owns the symbol's declared dependencies. The shape resolves the origin up the inbound CONTAINS chain — `symbol ◀─CONTAINS─ file ◀─CONTAINS─ service` (`file-awareness.md §3`) — and runs the service shape against the resolved carrier. The symbol stays the origin on `traversalPath`; the service is only the named carrier, exactly as a `FileNode` origin resolves through one CONTAINS hop.

Issue #123.

## Walk

`longestIncomingWalk` — DFS backward from origin to depth 5. `ROOT_CAUSE_MAX_DEPTH = 5` is a hardcoded contract value.

The longest path produced becomes the candidate; the first incompatibility found along it is the root cause. If no incompatibility is found, the walk yields no shape match and `getRootCause` moves to the localization steps below.

The incoming walk is generic over edge type, so data-axis edges join it without a branch. A `REFERENCES` foreign key (`infra:sql-table:<child> ──▶ infra:sql-table:<parent>`, ADR-161) is walked inbound like any other edge — a table origin's incoming walk reaches the child tables that reference it. No new root-cause *shape* is added for it here (an `InfraNode` table origin has no compat shape and falls through to localization, as before); the edge simply widens what the shared walk can traverse, keeping the reasoning core agnostic (ADR-158 §6).

## Cross-service localization — follow the failing CALLS chain (#589)

An entry service surfaces a failure that actually originates downstream. Nothing calls the entry service, so `longestIncomingWalk` is empty and the incoming shapes find nothing — yet the service's own OBSERVED CALLS edge to the callee carries the failure (`signal.errorCount > 0`). Naive incident matching would self-attribute the caller's CLIENT-side 500 to the entry service and even name a route the entry service never serves.

So for a `ServiceNode` origin, before consulting the incident store against the origin itself, `getRootCause` follows the **outbound** failing CALLS chain to the real culprit:

- A CALLS edge counts as failing when `signal.errorCount > 0`. The chain steps to the callee at the other end of the dominant failing edge (most recorded errors, then highest `PROV_RANK`, then target id — deterministic).
- The caller's CALLS edge may be anchored on a FileNode the service `CONTAINS` (file-awareness §4), or one grain finer on a SymbolNode that file CONTAINS (ADR-158 §4 lands the OBSERVED call on the calling function) — not the service node itself. So the service, the files it owns, and the symbols those files own are all considered as edge sources; the callee at the far end resolves back to its owning service through the same inbound CONTAINS chain, whichever grain it lands on.
- The chain walks at most `ROOT_CAUSE_MAX_DEPTH` hops, skipping FrontierNode callees and already-visited services. The deepest still-failing callee — the service whose own downstream calls are clean — is the culprit whose handler actually threw.
- The culprit is then localized through the incident store exactly like the in-process case below (its handler `file:line` / `http.route`), and the failing CALLS edges become the leading hops of `traversalPath` (origin → … → culprit → handler file). Each hop's `provenance` enters `edgeProvenances` in order; the localizing incident hop is `OBSERVED`.
- When the culprit has no recorded incident, the result still names the culprit service (never the caller) with a reason derived from the failing edge that reached it.

Cross-service confidence cascades over the failing CALLS edges and the incident hop, so it sits below an edge-walked compat result. When no outbound call is failing the failure is in-process here and `getRootCause` falls through to the incident store against the origin (#584). Cross-service localization per [ADR-114](../decisions.md#adr-114--root-cause-follows-the-failing-calls-chain-across-services-amends-adr-037).

## Agent-driven navigation — candidates, classification, the two-way walk (ADR-189)

The single verdict above is the **seed**, not the last word. `getRootCause` classifies that seed and its neighbourhood and returns a **ranked candidate set** — `candidates: Array<{ node, classification, reason, context, confidence, provenance }>`, `candidates[0]` the top cause with the legacy `rootCauseNode` tracking it. This is NEAT's adaptation of PRAXIS's four-move traversal: `Expand` and `Relate` are explicit calls (below); the per-node classification realises *complete* (`primary-failure`) and *discard* (`unrelated`). It composes the traversal primitives above — no new engine.

**Per-node context — the classification inputs, pre-separated.** `nodeContext(node)` returns, from real edge + incident signal only (never synthesized, file-awareness.md §6): `errorsEmittedHere` (incidents localized here + the node's own failing outbound CALLS), `errorsFromCallers` (inbound edges' `errorCount`), `callCount` (inbound volume), `outboundVolume` (how hard the node drives its own dependencies), `lastObservedAgeMs` (staleness), `latencyP95Ms` (saturation, ADR-190), and `stale` (fed by STALE edges). A service's signals are read over the files it owns (file-awareness.md §4), the scope `getObservedDependencies` walks.

**Symbol grain (ADR-191).** `errorsEmittedHere` reads incidents at whatever grain they localized. An in-process throw localizes to the **symbol** the failing span named (`incidentAffectedNode` descends by span-containment, otel-ingest.md §What-records-an-incident), so `getRootCause(symbol)` names the function `primary-failure` rather than returning null, and `classifyNode(symbol)` reads its own emitted error. `incidentMatchesNode` is grain-aware — a `symbol:` incident also matches its owning file and service — so a query at any grain still hits, and `localizeFromIncidents` descends a coarser query (service / file) down to the symbol the incident named. Symbol-grain *divergence* stays deferred (ADR-158 §7); this is the failure-attribution half.

**Classification.** `primary-failure` — the node emits errors of its own and is not merely drowning in load. `symptom-only` — errors arrive from callers but none originate here, or the node is stale/saturated and absorbs at least as much failure as it emits. `unrelated` — no failure signal touches it.

**The victim → load-origin move.** When the seed is a **saturated/stale victim** — errors arrive, it emits no more than it receives, and it has gone STALE or crossed the absolute saturation p95 (`SATURATION_P95_MS`, a hardcoded contract constant like `ROOT_CAUSE_MAX_DEPTH`) — navigation does **not** name it. It classifies the seed `symptom-only` and walks **up** (the `get_blast_radius` inbound direction, ADR-110) to the **load origin**: the pure source (nothing observed drives it) that itself drives the most outbound volume, selected by graph shape and never by a provider/service name (traversal.md agnosticity). That origin becomes `candidates[0]` and `rootCauseNode`, and `traversalPath` retraces up to it so the invariant (path ends at `rootCauseNode`) holds. A live-throwing culprit — an incident of its own, not stale, not saturated — is **not** a victim and stays the named cause, so the cross-service (#589) and in-process (#584) verdicts are unchanged.

**`Expand(node, up | down)`** — one bidirectional neighbourhood step. `up` walks inbound (callers/dependents, `bestEdgeBySource`), `down` walks outbound (callees/dependencies, `bestEdgeByTarget`), over the depth-bounded PROV_RANK-best primitives `traversal.md` governs. Returns the stepped node's own classification + context and its immediate runtime neighbours' (CONTAINS ownership excluded).

**`Relate(a, b)`** — pairwise directed link-confirmation. Searches both ways, labels the direction found (`a->b` / `b->a`, preferring cause→symptom), and returns each path with per-hop `provenance` + `grain` and a first-class **`carriesSignal`** — whether `errorCount` / `latencyMs` / `anomalous` runs end to end, i.e. whether the path carries the failure it is hypothesised to explain. It returns the finest path the real edges give and **flags `grainGap`** when only a coarser link is in evidence rather than synthesising a finer one (file-awareness.md §6). No path within `maxDepth` → `related: false` labelled **"no path within N hops,"** never "unrelated" — a depth-bounded absence is not proven independence.

**Non-breaking rollout.** The navigation shape is additive schema growth (ADR-031): the legacy verdict fields stay populated for one deprecation cycle, so every audited consumer (the MCP `get_root_cause` tool, the REST route, the web Inspector, the CLI) keeps working unchanged. `NEAT_RCA_NAVIGATION=0` (or `opts.navigation === false`) returns the pre-navigation single verdict verbatim — the escape hatch for the cycle. The verdict fields are removed only in a later change once consumers have moved.

## Reason

`reason` is human-readable, built from the compat result's `reason` field. Example: `pg 7.4.0 cannot reach PostgreSQL 15 — driver does not support SCRAM-SHA-256 auth`.

When an `errorEvent` is provided, the observed error message is appended in parentheses:

```
${reason} (observed error: ${errorEvent.errorMessage})
```

Never a raw `compat.json` entry; always a sentence.

## Fix recommendation

Derived from the compat result. Today's pattern:

```
Upgrade ${svc.name} ${pair.driver} driver to >= ${result.minDriverVersion}
```

Each compat shape produces its own fix-recommendation string. The shape-specific check is the only place that knows what the fix is; the dispatcher just propagates it. Optional in the result.

## Result shape

```ts
{
  rootCauseNode:    string
  rootCauseReason:  string
  traversalPath:    string[]    // origin → ... → rootCauseNode
  edgeProvenances:  Provenance[]  // length = traversalPath.length - 1
  confidence:       number       // confidenceFromMix(walk.edges)
  fixRecommendation?: string
  // Agent-driven navigation (ADR-189). Additive optional growth; present by
  // default, absent under the NEAT_RCA_NAVIGATION=0 escape hatch. candidates[0]
  // is the top cause and rootCauseNode tracks it.
  candidates?: Array<{
    node:            string
    classification:  'primary-failure' | 'symptom-only' | 'unrelated'
    reason:          string
    context:         NodeContext   // the separated classification inputs above
    confidence:      number
    provenance?:     Provenance
  }>
}
```

`traversalPath[0]` is the origin. The last entry is `rootCauseNode`. `edgeProvenances` is one entry per edge along the path, in order. When navigation promotes a load origin over a starved victim, `rootCauseNode` is that origin and `traversalPath` retraces up to it, so the invariant holds either way.

## Schema validation

`RootCauseResultSchema.parse(result)` runs before return. Throws on violation; the API handler converts to 500. Issue #139.

## Returns null cleanly

When the origin doesn't exist, when no incompatibility is found, when the origin's node type has no registered shape — `getRootCause` returns `null`. Never throws.

## Compat ownership

`getRootCause` calls into `compat.ts` for the actual incompatibility checks; never duplicates that logic. Compat shape additions land in `compat.json` data, not in `traverse.ts` code.

## Enforcement

`contracts.test.ts` adds:

- A live test that `getRootCause` returns null cleanly when called with an origin whose `node.type` has no registered shape (e.g. ConfigNode).
- A live test that ServiceNode origins produce a result when an upstream service has a node-engine violation (the #123 generalization in action).
- A live test that a SymbolNode origin resolves up the CONTAINS chain to its owning service and produces that service's shape result, with the symbol still at `traversalPath[0]` (ADR-158 §7).
- A live test asserting `edgeProvenances.length === traversalPath.length - 1`.
- A live test asserting `RootCauseResultSchema.parse(result)` succeeds for every valid return.
- A live test that `traversalPath[0]` is the origin and the last entry is `rootCauseNode`.
- Navigation (ADR-189): a live test that an overload seed (a stale/saturated node with inbound errors but none emitted) classifies `symptom-only` and the result names the upstream load origin, not the victim; that a live-throwing culprit stays `primary-failure` (no false demotion); that `NEAT_RCA_NAVIGATION=0` returns the pre-navigation single verdict verbatim; and a `Relate` test (a directed signal-carrying path returns `carriesSignal`, a cross-grain pair flags `grainGap`, an unreachable pair returns the "no path within N hops" label).

## Rationale

Driver/engine mismatch is the demo's shape but not the only shape. Real codebases have node-version skew, peer-dependency conflicts, deprecated APIs that compile but fail at runtime. Generalizing the dispatcher means `getRootCause` stays useful as the compat matrix grows.

Full rationale: [ADR-037](../decisions.md#adr-037--getrootcause-contract).
