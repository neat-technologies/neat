---
name: get-root-cause
description: getRootCause walks incoming edges to depth 5, dispatches by origin node type to a shape-specific compat check, returns a human-readable reason and a derived fix recommendation, validates the result before returning.
governs:
  - "packages/core/src/traverse.ts"
  - "packages/core/src/compat.ts"
  - "packages/types/src/results.ts"
adr: [ADR-037, ADR-114, ADR-014, ADR-029, ADR-031, ADR-158, ADR-189, ADR-190, ADR-191, ADR-209, ADR-214]
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

**A failing outbound dependency outranks the load-origin move (ADR-214).** The saturated/stale reading above is drawn from the seed's **inbound** signal alone; it does not by itself prove the seed is a load victim, because a service can be saturated on the way in while failing because of its own **outbound** dependency. So the victim → load-origin promotion fires only when the seed has **no failing outbound of its own**. A seed has a failing outbound when any of its outbound edges — across **all** edge types, `CALLS` **and** `CONNECTS_TO` (a datastore connection/auth failure rides a `CONNECTS_TO` edge; the `CALLS`-only `isFailingCallEdge` filter must not be reused here), scanned over the node's own scope — recorded `signal.errorCount > 0`, or when an `'incident'`-sourced seed carries error text that reads as an outbound connection failure (a name-resolution failure, a refused/reset connection, an "unable to connect" — connection *semantics*, never a provider or datastore name, per traversal.md agnosticity). When the seed fails outbound, its own verdict stands — the real outbound dependency, or the seed's incident-localized cause, is the answer — and the load-origin verdict is suppressed. The check is on the **seed**, not the queried node: in a genuine cross-service overload the queried entry relays load down a failing `CALLS` chain to the starved callee, so its own outbound is failing by design; it is the victim seed at the end of that chain that must have no downstream fault for the load-origin move to be right. Genuine overloads (a starved victim with no outbound fault) still promote the load origin.

**The promoted origin has to persuade (#1010).** A correct verdict earns nothing if the consuming agent reads it as a weak guess and overrides it, so the promoted origin ships with a confidence and a reason that carry the evidence:

- **Confidence graded to the separated evidence.** The `primary-failure` origin's `confidence` reflects the strength of the signals the navigation already computed — the clean cause/symptom split (`errorsFromCallers` with no `errorsEmittedHere` at the victim), the victim gone STALE under load, its saturated inbound `latencyP95Ms` (ADR-190), and the outbound volume the origin drives — each corroborating signal lifting it toward an OBSERVED-grade ceiling (`LOAD_ORIGIN_CONFIDENCE_CEILING`), never a flat floor and never a claimed certainty. A weaker shape (fewer corroborating signals) grades lower; strong separated evidence grades high.
- **A causal reason, not a volume number.** The origin's `reason` — the headline `rootCauseReason` — states the **causal relation**: the named origin is the fault *because* it overloads the failing subgraph, and the alerting node is its downstream **symptom/victim** (errors arrive from its callers, none originate there, it has gone STALE/saturated under load). The driven-call volume trails as corroborating evidence, never the lead — a bare "highest-volume source" reads as ranking-by-traffic, not fault attribution.

**`Expand(node, up | down)`** — one bidirectional neighbourhood step. `up` walks inbound (callers/dependents, `bestEdgeBySource`), `down` walks outbound (callees/dependencies, `bestEdgeByTarget`), over the depth-bounded PROV_RANK-best primitives `traversal.md` governs. Returns the stepped node's own classification + context and its immediate runtime neighbours' (CONTAINS ownership excluded).

**`Relate(a, b)`** — pairwise directed link-confirmation. Searches both ways, labels the direction found (`a->b` / `b->a`, preferring cause→symptom), and returns each path with per-hop `provenance` + `grain` and a first-class **`carriesSignal`** — whether `errorCount` / `latencyMs` / `anomalous` runs end to end, i.e. whether the path carries the failure it is hypothesised to explain. It returns the finest path the real edges give and **flags `grainGap`** when only a coarser link is in evidence rather than synthesising a finer one (file-awareness.md §6). No path within `maxDepth` → `related: false` labelled **"no path within N hops,"** never "unrelated" — a depth-bounded absence is not proven independence.

**Non-breaking rollout.** The navigation shape is additive schema growth (ADR-031): the legacy verdict fields stay populated for one deprecation cycle, so every audited consumer (the MCP `get_root_cause` tool, the REST route, the web Inspector, the CLI) keeps working unchanged. `NEAT_RCA_NAVIGATION=0` (or `opts.navigation === false`) returns the pre-navigation single verdict verbatim — the escape hatch for the cycle. The verdict fields are removed only in a later change once consumers have moved.

## Stale-only causal chains — navigate, don't dead-end (ADR-209)

A stale snapshot is the case where the whole causal chain has transitioned to STALE (ADR-024) and lost the error signal the #589 failing-CALLS walk reads (`signal.errorCount`). The topology (`frontend → checkout → cart`) is still in the graph, but every hop reads as non-failing, so the failing chain walks nothing and the failure is known only through the incident store — which localizes it to the queried node. Naming that node with "no edges traversed" hands the agent the **symptom**. STALE is a *ranked* provenance (`PROV_RANK` 0, confidence ceiling ≤ 0.3, [provenance.md](./provenance.md)), not an absent one: a node whose only causal chain is stale still has a knowable last-observed origin.

So the single-verdict walk is **tagged** by which branch produced it — `'compat' | 'cross-service' | 'incident'`. When, and only when, the seed is an `'incident'`-sourced dead-end (the queried node itself, `traversalPath.length === 1`, no causal edge walked) **and** is not a load victim (`isVictimSeed` takes precedence), navigation follows the **STALE-only** outbound CALLS chain from the queried node:

- Each hop takes the dominant STALE CALLS edge, where "STALE-only" is a `PROV_RANK` gate: the best-provenance edge per callee is computed first, and a callee still reachable by any fresher (OBSERVED/INFERRED/EXTRACTED) edge is **never** walked stalely. That gate is what makes stale the *fallback* — nothing fresher is reachable — rather than a replacement. With no error signal to rank on (that is what went quiet), hops break ties on last-observed call volume, then id — deterministic like the failing chain.
- The deepest stale-only callee leads `candidates` as a `primary-failure` with `provenance: STALE` and a confidence from `confidenceFromMix` over the stale edges — the STALE ceiling caps it low, no hand-set floor. Its `reason` says outright that the live signal went quiet and this is a stale-topology hypothesis to confirm, not a signal-backed verdict. `traversalPath` is the walked chain with each hop's STALE provenance on `edgeProvenances`, so the path-ends-at-`rootCauseNode` invariant holds. The queried node stays in the set, demoted to `symptom-only`. `fixRecommendation` names the stale-derived cause as a recovery step (restore instrumentation / re-run with live traces), never the overload "throttle the load" wording.

Stale is the fallback, never a replacement: a `'compat'` or `'cross-service'` seed is never second-guessed; a fresh OBSERVED failing chain still names its culprit OBSERVED-preferred; a dead-end whose first reachable hop is a fresh healthy edge preserves the named-node behavior; and a genuinely isolated node (an incident but no outbound causal edge of any provenance) stays `primary-failure` — nothing to walk, nothing fabricated. The fix is read-side only; `ingest.ts` is untouched. Full rationale: [ADR-209](../decisions.md#adr-209--getrootcause-navigates-a-stale-only-causal-chain-instead-of-dead-ending-on-the-symptom).

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

**Tracks `rootCauseNode`.** Whatever navigation names as `rootCauseNode` (`candidates[0]`, the top cause) is the node `fixRecommendation` points at — the two halves of the result never contradict each other. When the seed is itself the primary failure, the seed's own recommendation carries through unchanged. When the victim → load-origin move promotes an upstream source, the recommendation is rebuilt to name that source (throttle or scale the load it drives), not the starved downstream victim the single-verdict walk targeted. A `symptom-only` node is never the fix site: if no load origin is found and the victim is all navigation can name, the recommendation points at that node's inbound load and upstream callers rather than its own handler.

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
- Persuasion (#1010): a live test that the promoted origin's `confidence` on a strong separated-evidence overload lands well above the old flat floor and stays below certainty, that a shape with one fewer corroborating signal grades lower, and that `rootCauseReason` names both the upstream cause and the downstream symptom/victim rather than only a call-volume number.

`root-cause-outbound-guard.test.ts` (ADR-214) pins the outbound-dependency precedence: a `CONNECTS_TO` datastore failure under an inbound-saturated seed does not return the load origin (the seed's cause wins); a self-config failure localized only by incident connection-failure text does not return the load origin; and a genuine starved victim with no outbound fault still promotes the load origin.

`root-cause-stale-navigation.test.ts` (ADR-209) pins the STALE-only fallback: a stale-snapshot chain surfaces a STALE-provenanced, ≤ 0.3-confidence deepest-callee cause with the full walked path instead of the queried symptom; the middle-node query reaches the same cause; `NEAT_RCA_NAVIGATION=0` returns the pre-navigation dead-end verbatim; a fresh OBSERVED cross-service verdict stays OBSERVED-preferred; a dead-end with a fresh first hop preserves the named node; and a genuinely isolated node stays `primary-failure` with no fabricated upstream.

## Rationale

Driver/engine mismatch is the demo's shape but not the only shape. Real codebases have node-version skew, peer-dependency conflicts, deprecated APIs that compile but fail at runtime. Generalizing the dispatcher means `getRootCause` stays useful as the compat matrix grows.

Full rationale: [ADR-037](../decisions.md#adr-037--getrootcause-contract).
