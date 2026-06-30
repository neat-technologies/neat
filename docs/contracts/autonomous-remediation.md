---
name: autonomous-remediation
description: The autonomous-remediation runner — the propose→assess→gate→graduate loop on top of the governance kernel. An agent proposes a change as FRONTIER edges, the runner checks blast radius + the policy gate against real∪delta, a block refuses, a pass graduates, an unconfirmed proposal is culled. Local ("run agents in your code") + hosted ("remediation by us"). The agent proposes; the deterministic gate decides.
governs:
  - "packages/core/src/policy.ts"
adr: [ADR-106, ADR-093, ADR-094, ADR-105, ADR-038, ADR-102, ADR-103]
enforcement: [review]
---

# Autonomous-remediation runner contract

🟡 **Contract-only — opens with the build.** This fixes the *loop and the invariants* at seam-altitude; the mechanics (the agent harness, the sandbox environment, the apply mechanism, the watch-window policy) open with the build (ADR-106). It is the "for new features, by sandbox" / "remediation by us" story, and it introduces **no new enforcement primitive** — every step delegates to a layer already governed.

## 1. The loop

A remediation runs as four steps, each delegating to an existing layer:

1. **Propose.** Stage the intended change as `FRONTIER` edges — a proposal, not yet real ([`provenance.md`](./provenance.md), ADR-094).
2. **Assess.** Compute blast radius (ADR-038) and evaluate the policy gate against the proposed state `real ∪ delta` ([`policy-evaluation.md`](./policy-evaluation.md) gate path, ADR-093 / ADR-105).
3. **Gate.** A `block` violation **refuses** the proposal — nothing lands. A pass **graduates** the FRONTIER edges to OBSERVED.
4. **Watch.** An observation window confirms the change in production; an unconfirmed proposal is **culled**. Graduate / refuse / cull are the three FRONTIER exits (ADR-094).

## 2. The agent proposes; the gate decides

The runner orchestrates; it does not relax the gate. The LLM/agent (and any vector reach upstream of it) only ever *proposes* — the deterministic policy-overlay gate is the sole decider (ADR-105). A `block` is final: positive OTel evidence cannot override it at graduation, and **only a human** can (ADR-094). NEAT never auto-applies past a block.

## 3. Two faces, one loop

- **Local — "run agents in your code."** The runner drives against the local daemon and graph; the agent works in the developer's repo.
- **Hosted — "remediation by us."** NEAT runs the loop as the **execution venue** ([`hosted-platform.md`](./hosted-platform.md), ADR-107). The runner is the same; the venue differs, reached through the client profile seam (ADR-102) over the hosted substrate (ADR-103).

## 4. Determinism and safety boundaries

- The trust comes from layers already governed (FRONTIER staging, the gate, blast-radius); the runner adds orchestration only.
- The vector/LLM is strictly upstream of the gate (ADR-105 §3); a constraint never fires on a similarity score.
- No settled state is mutated by a remediation that fails the gate — a refused proposal leaves the graph untouched.

## Authority

The runner is orchestration over `packages/core/src/policy.ts` (the gate), the blast-radius traversal (ADR-038), and the FRONTIER lifecycle in `ingest.ts` (ADR-094). The agent harness and sandbox/apply mechanics land in their own modules when the build opens.

## Enforcement

`enforcement: [review]` while contract-only — the runner is unbuilt, so the active check is review. As it lands it gains **breaker** (the propose→gate→graduate loop driven end to end, asserting a `block` refuses and only a human overrides) and **policy** (the runner itself governed by the overlay it sits on). Tagged per ADR-104.

Full rationale: [ADR-106](../decisions.md#adr-106--the-autonomous-remediation-runner-run-agents-in-your-code).
