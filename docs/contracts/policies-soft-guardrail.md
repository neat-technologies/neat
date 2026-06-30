---
name: policies-soft-guardrail
description: The launch form of policies — a soft guardrail delivered by context injection, not a gate. The policies reachable from where an agent is working are surfaced into its context via the policy overlay's blast-radius injection, so the agent is aware of the rules. It informs, it does not block; the hard gate is the kernel (ADR-093), post-launch. Authoring stays plain policy.json.
governs:
  - "packages/mcp/src/index.ts"
  - "packages/core/src/policy.ts"
adr: [ADR-108, ADR-105, ADR-042, ADR-043, ADR-045]
enforcement: [breaker, review]
---

# Policies as a soft guardrail contract

The launch reading of *"every agent stays inside the lines"* (ADR-108). The hard gate that *blocks* a violating change is the kernel ([`policy-evaluation.md`](./policy-evaluation.md) gate path, ADR-093), and it is post-v0.5. For launch, policies ship as a **soft guardrail**: the relevant policies are injected into the agent's working context so it is *aware* of the rules — not blocked by them.

## 1. Surfacing = policy-blast-radius injection

For the node or region an agent is working in, surface the **reachable** policies via the policy overlay's blast-radius injection (ADR-105 §5) — including the far-away ones a similarity search would miss. Relevance is the policy's declared propagation scope × graph distance (ADR-105 §5); a downstream-breaking invariant surfaces, a local rule three hops away does not.

## 2. Delivery — the MCP read surface + a memory hook

- **MCP read surface.** `check_policies` ([`policy-tools.md`](./policy-tools.md), ADR-045) returns the **applicable** policies for the agent's context — the soft guardrail's read path. Same tool, used to inform.
- **Memory/context hook.** The applicable set is delivered as a hook at the top of the agent's working context ("a hook to the top of agent memory"), so the rules ride along as the agent works.

## 3. It informs; it does not block

The soft guardrail **never refuses an action.** It is awareness, not enforcement. The only blocking surface is the kernel gate (ADR-093), which is post-launch and operates on FRONTIER proposals, not on a developer's live edits. Surfacing a policy is not evaluating a gate.

## 4. Authoring is unchanged

Policies are authored as plain `policy.json` ([`policy-schema.md`](./policy-schema.md), ADR-042) — no new authoring surface. The soft guardrail is a *delivery* mechanism over the existing policy model, not a new policy language.

## 5. It graduates to the hard gate

This is policy-blast-radius injection **minus the gate.** When the kernel lands (ADR-093), the gate is *added* — the injection stays, the same applicable-policy machinery now also gates FRONTIER proposals. The launch soft guardrail and the eventual hard gate are one overlay at two strengths.

## Authority

`packages/mcp/src/index.ts` (the `check_policies` read path returns applicable policies for context), `packages/core/src/policy.ts` (the applicable-policy selection over the overlay, ADR-105 §5). Injection delivery rides the existing MCP read surface and the agent context hook.

## Enforcement

`enforcement: [breaker, review]`. **Breaker:** the harness asserts that, working at a node with a reachable policy, `check_policies` surfaces it (including a far-away one), and that the soft guardrail never refuses an action — it informs only. **Review:** whether the injected set is the *right* relevance (scope × distance tuning) is a human call until the overlay's relevance is itself measurable.

Full rationale: [ADR-108](../decisions.md#adr-108--policies-as-a-soft-guardrail-the-launch-mvp).
