---
name: policy-evaluation
description: evaluateAllPolicies is pure. Triggers post-ingest, post-extract, post-stale-transition. Per-type evaluator dispatch. Violations append to policy-violations.ndjson; ids are deterministic.
governs:
  - "packages/core/src/policy.ts"
  - "packages/core/src/ingest.ts"
  - "packages/core/src/extract/index.ts"
  - "packages/core/src/persist.ts"
adr: [ADR-043, ADR-042, ADR-030, ADR-093, ADR-095, ADR-105]
enforcement: [lint, review]
---

# Policy evaluation contract

The second of four policy contracts. Sibling contracts: [`policy-schema.md`](./policy-schema.md), [`policy-actions.md`](./policy-actions.md), [`policy-tools.md`](./policy-tools.md).

## Entry point

```ts
evaluateAllPolicies(
  graph: NeatGraph,
  policies: Policy[],
  context: EvaluationContext
): PolicyViolation[]
```

Pure function. Walks the policy list, dispatches each by `policy.rule.type` to a per-type evaluator, accumulates violations.

## Triggers

- **Post-ingest** — after `handleSpan` completes.
- **Post-extract** — after `extractFromDirectory` completes.
- **Post-stale-transition** — after `markStaleEdges` ticks.

Other call sites (REST `POST /policies/check`, MCP `check_policies`) call the same function; not separate triggers.

## `PolicyViolation` shape

```ts
{
  id: string,                  // ${policy.id}:${violation-context}
  policyId: string,
  policyName: string,
  severity: Policy['severity'],
  onViolation: Policy['onViolation'],
  ruleType: PolicyRule['type'],
  subject: { nodeId?: string; edgeId?: string; path?: string[] },
  message: string,
  observedAt: ISO8601
}
```

## Deterministic ids

Same graph + same policies → same violation ids. Append-only `policy-violations.ndjson` keys on `id`; duplicates skipped at write time.

## Per-type dispatch

```ts
const policyEvaluators: Record<RuleType, Evaluator> = {
  structural,
  compatibility,
  provenance,
  ownership,
  'blast-radius': blastRadius,
}
```

Adding a rule type means one new entry plus the schema entry from `policy-schema.md`.

## Idempotency

Stateless. Same inputs → same violations.

## Synchronous gate path (ADR-093) and the built-in divergence bundle (ADR-095)

The triggers above are the **flag path** — settled provenance lands, then policies evaluate, then a violation surfaces. The kernel (ADR-093) adds a second, **synchronous gate path** for proposals:

- **Settled provenance (OBSERVED / EXTRACTED / INFERRED / STALE) → flag (async, retrospective).** Unchanged. A fact is already real; blocking it is meaningless (ADR-093). The post-ingest / post-extract / post-stale triggers stay the flag path, and no blocking check enters the high-volume ingest path.
- **FRONTIER provenance → gate (sync, prospective).** `evaluateAllPolicies` runs **first**, against the proposed state `real ∪ delta`, before a FRONTIER edge graduates (ADR-094). The evaluation surface is the policy overlay's gate (ADR-105) — the same per-type dispatch, evaluated over the proposed graph. A `block` refuses graduation ([`policy-actions.md`](./policy-actions.md), as widened); a pass graduates FRONTIER→OBSERVED.

Hypothetical evaluation stays **pure and read-only** over the proposed graph: `evaluateAllPolicies` already takes its `graph` argument, so the gate evaluates a `graph.copy()` with the delta applied (ADR-093 rung 1) — no observer leak. The evaluator set is unchanged; only the graph it reads is the proposed one.

**The built-in divergence bundle (ADR-095).** The five divergence types are a standard policy bundle shipped by default — `missing-observed` is "an EXTRACTED edge with no OBSERVED twin," a `provenance` policy; the version/host/compat cases map to `compatibility` rules; structural cases to `structural` rules. The divergence engine is a built-in bundle over this evaluator, not a separate primitive (see [`divergence-query.md`](./divergence-query.md)); `get_divergences` stays a convenience view over the bundle's violations on settled provenance (the flag path).

## Authority

Lives in `packages/core/src/policy.ts`. Reads the live graph; calls `compat.ts`; never mutates the graph. The gate path reads a proposed-state copy; it is still read-only over the graph it evaluates.

Full rationale: [ADR-043](../decisions.md#adr-043--policy-evaluation-contract).
