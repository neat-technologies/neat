---
name: candidate-assessment
description: The hidden `neat assess` verb Sniper runs inside its sandbox. It loads the run's baseline graph, extracts the candidate checkout, stages the candidate's change as FRONTIER on an in-memory copy under a candidate id, evaluates policies and blast radius on the surface that promotion would produce, prints a fixed JSON verdict and persists nothing. Daemon-side staging is not part of it.
governs:
  - "packages/core/src/extract/assess.ts"
  - "packages/core/src/assess-cli.ts"
  - "packages/core/test/assess*.test.ts"
adr: [ADR-093, ADR-094, ADR-226, ADR-030]
enforcement: [lint, review]
---

# Candidate assessment contract

Ruled by Deniz 2026-11-15, relayed by the orchestrator: **"`neat assess` runs inside Sniper's sandbox now: load baseline.json as the settled graph, extract the candidate checkout, stage the delta as FRONTIER on an in-memory copy tagged with a candidate id, evaluate policies and blast radius on the surface promotion would produce, print AssessmentSchema JSON, persist nothing. Daemon-side staging is later work."**

This is the core half of SNIPER-ADR-005 (neat-sniper) and of neat-core #1359. It supersedes the detached compare that #1305 proposed and that never merged. It is a confidence gate for a candidate patch, not proof that the patch fixes anything, and not the live governance kernel.

**Not in this contract:** staging a candidate on the tenant daemon's live graph. Nothing here reaches a daemon, so the daemon can't yet say what a candidate would change. That is #1359's later step and needs its own REST surface and contract.

## 1. The verb

```
neat assess --path <checkout> --baseline <graph.json> --policies <policy.json> \
  --origin <node-id> --max-files <N> --max-services <N>
```

- **Hidden.** `assess` is an internal Sniper seam, so it appears in no public help.
  - It is not in `usage()` or in `QUERY_VERBS`, and it is not among the verbs [`cli-surface.md`](./cli-surface.md) lists. `cli-surface.md` is deliberately left unchanged.
  - An audit test holds it out of `usage()` and `QUERY_VERBS`.
- **Required flags.** Every flag is required, and the bounds are positive integers.
- **Baseline.** `--baseline` accepts the daemon's `{nodes, edges}` wire shape (what Sniper writes from `GET /graph`'s native graph) or a graphology snapshot's `{graph}` shape. Every node and edge parses through the `@neat.is/types` schemas. A duplicate id, a dangling edge or a malformed entry refuses the input.
- **Policies.** `--policies` is the run's authoritative policy file, as read from the daemon. A policy file inside the patched checkout is never read.
- **Usage errors.** Missing or malformed flags exit 2.

## 2. Isolation

The verb never connects to a daemon, a connector or a network service, and never loads the project registry.

It writes nothing anywhere: no snapshot, no `errors.ndjson`, no registry entry, no cache, no source. Extraction runs into a fresh in-memory graph. Every graph this contract names (settled, candidate, staged, promoted) exists only in the process and is dropped when it exits. **Persisting nothing is the discard.**

Producer diagnostics are suppressed. Error text, which may quote source, is replaced by the fixed reason codes in §6.

## 3. Graphs and the delta

1. **Settled.** The baseline, loaded as-is: the four settled provenances, plus any FRONTIER edges the daemon had staged (for example hang surfaces). Those foreign FRONTIER edges are carried along untouched and never graduate here.
2. **Candidate.** `extractFromDirectory` over `--path` into a fresh graph. Any extraction error or skipped file refuses with `incomplete-extraction`; an extractor that throws refuses with `extraction-unavailable`.
3. **Scope.** The candidate only speaks for the services it extracted.
   - The scope is the set of `ServiceNode` ids present in the candidate graph.
   - A baseline node is **static-owned in scope** when it is a FileNode or SymbolNode whose `service` is in scope and is not `discoveredVia: 'otel'`, or when it is the endpoint of an EXTRACTED edge whose source belongs to a scoped service.
   - EXTRACTED edges whose source belongs to a scoped service are in scope.
   - Services from other repositories in the same project keep their static layer exactly as the baseline has it. (#1305 replaced the whole EXTRACTED layer, which would erase every other repository's declared graph.)
4. **Delta.** The in-scope static layer of the settled graph compared with the candidate graph:
   - **added:** nodes and EXTRACTED edges in the candidate and not in the settled scope;
   - **removed:** in-scope static nodes and EXTRACTED edges not in the candidate;
   - **changed:** ids present in both whose declared attributes differ.

## 4. Staging (FRONTIER on a copy, under a candidate id)

The **candidate id** is `candidate:<sha256>` of the delta's sorted ids. It is deterministic, so the same baseline and checkout always stage under the same id.

The **staged** graph is a `copy()` of the settled graph with the delta staged on it. All of these writes go through the proposal path [`lifecycle.md`](./lifecycle.md) names: FRONTIER through `ingest.ts`, never a direct write from the assessment.

- **Added edges** are staged with `stageFrontierEdge` as FRONTIER edges, using `frontierEdgeId(source, target, type)` ids (identity contract). They are invisible to settled traversal exactly as every FRONTIER edge is ([`provenance.md`](./provenance.md), `traverse.ts` FRONTIER skip). **`traverse.ts` is not changed.**
- **Added nodes.** FRONTIER is an edge provenance; nodes carry no provenance. A node the candidate adds is placed on the staged copy as a plain node and recorded in the candidate's staging ledger. It has no settled edge, only FRONTIER ones, so settled traversal can't reach it. **This contract does not give nodes a provenance and changes no node schema.**
- **Removed and changed elements** are recorded in the ledger only. Staging never deletes or rewrites a settled fact.
- **The staging ledger** is the assessment's in-memory record of every id staged under the candidate id. It is not a schema field and is never persisted. `graphDiff` (§6) is read from it.

## 5. The promoted surface

The **promoted surface** is the graph that promotion of this candidate would produce, built as a `copy()` of the staged graph. This is the gate path [`policy-evaluation.md`](./policy-evaluation.md) and [`policy-actions.md`](./policy-actions.md) already describe: `real ∪ delta`, evaluated read-only on a copy (ADR-093, ADR-094).

On the promoted copy:

- **Staged edges.** Each FRONTIER edge staged under the candidate id is replaced by the edge extraction will produce once the change merges: its EXTRACTED twin, with an `extractedEdgeId` id and the candidate's evidence.
  - These are the only FRONTIER edges that graduate.
  - Foreign FRONTIER edges stay FRONTIER and are still skipped.
- **Removed elements** are dropped.
  - If dropping one would leave an OBSERVED, INFERRED or STALE edge without an endpoint, the assessment refuses with `runtime-endpoint-removed`.
  - A static endpoint the patch deleted is never kept alive to preserve a runtime edge.
- **Changed nodes** take the candidate's declared fields. Runtime-observed attributes of a surviving node are kept: a ServiceNode's `env`, `observedImage`, `observedReadyReplicas` and `discoveredVia: 'merged'`, and an InfraNode's non-EXTRACTED column provenances.

Live queries are unaffected. `getBlastRadius`, `getRootCause` and every settled read still skip FRONTIER, because candidate edges reach traversal only on the promoted copy, as EXTRACTED edges. No query over a daemon's graph ever sees either copy.

## 6. Evaluation and output

- **Policies.** `evaluateAllPolicies(promoted, policies)`. Any violation with `onViolation: 'block'` fails the assessment, including one that was already present in the baseline; only a human changes policy.
- **Blast radius.** This is wider than #1305's origin-only radius, so it now sees callers of what the candidate removes. The blast set is the union of:
  - the origin;
  - every added or changed node, and every node reachable inbound from them, on the promoted surface;
  - every removed node, and every node reachable inbound from it, on the **settled** graph.

  Each traversal uses `getBlastRadius` with a depth covering the finite graph. The set's FileNode and ServiceNode counts must stay within `--max-files` and `--max-services`.
- **Origin.** `--origin` must exist in the settled graph. If it is a FileNode or SymbolNode, it must also exist in the candidate. Otherwise the assessment refuses with `missing-origin`.
- **Output.** One JSON object on stdout, in exactly the `AssessmentSchema` Sniper decodes (neat-sniper `src/wire.ts`):

  ```
  { passed, reason, violations, blastRadius: { nodes, files, services }, graphDiff: { added, removed, changed: { nodes, edges } } }
  ```

  - `reason` is one of `passed | invalid-input | extraction-unavailable | incomplete-extraction | missing-origin | runtime-endpoint-removed | policy-block | blast-radius-exceeded`.
  - Violations carry only `policyId`, `onViolation`, `ruleType` and the subject `nodeId` or `edgeId`.
  - All id lists are sorted.
  - No node attributes, evidence, snippets, policy messages, error text or source appear in the output.
  - The same baseline, policies and checkout give byte-identical output. Timestamps and absolute paths never enter it.
- **Exit codes.** 0 means passed. 1 means assessed and refused, or unavailable; a structured verdict is printed either way. 2 means malformed usage. A caller requires exit 0 **and** `passed: true`; missing evidence is never a pass.
