---
name: contract-enforcement
description: How NEAT's contracts are enforced — four pillars matched to clause type (lint/CI, the breaker, the NEAT-on-NEAT policy overlay, review). Every contract carries an `enforcement:` tag; new contracts ship with a tag and ≥1 active pillar (lint or breaker) or an explicit review-only. NEAT-on-NEAT (contracts as graph-pattern policies over the self-graph, gated by the kernel) is the destination.
governs:
  - "docs/contracts/*.md"
  - "packages/core/test/audits/contracts.test.ts"
adr: [ADR-104]
enforcement: [lint, review]
---

# Contract enforcement contract

A meta-contract: it governs how the per-topic contracts are enforced. Stored prose is a suggestion; enforcement matches the *kind* of clause (ADR-104). The contract system asking an agent to read prose and self-comply is the brute-force pattern NEAT exists to replace — so the destination is NEAT enforcing its own rules.

## 1. Four pillars

| Pillar | Enforces | Mechanism | Active today? |
|--------|----------|-----------|----------------|
| **lint** | syntactic / structural — ids via helpers, no raw provenance strings, single-sourced manifests | `contracts.test.ts` grep/AST assertions, fail the build | ✅ |
| **breaker** | behavioral / runtime — reads route, resolution never throws, the flow works end to end | the outsider e2e harness drives the real system | ✅ |
| **policy** | architectural / topological — MCP read-only, no daemon reads the client profile store, shared REST helper | graph patterns over NEAT's own graph, gated by the governance kernel (ADR-093/094/095) | 🟡 opens with the kernel arc |
| **review** | semantic / intent — forward-looking framing, provenance-as-load-bearing | human + LLM review | ✅ (honest fallback) |

## 2. Every contract carries an `enforcement:` tag

A contract's frontmatter gains `enforcement: [lint | breaker | policy | review]`, naming which pillar(s) hold it. An untagged contract is treated as `review` until tagged. The tag makes the unenforced surface visible rather than discovered late.

## 3. New contracts ship enforced

A new contract ships with its `enforcement:` tag and **at least one active pillar** (`lint` or `breaker`) — or, if genuinely unmechanizable, an explicit `review` with a one-line reason. No new prose-only contracts.

## 4. Existing contracts: tag in a backlog pass

The contracts predating this model get their `enforcement:` tag in a backlog pass; until tagged, each is `review`. Tagging is cleanup, not blocking.

## 5. NEAT-on-NEAT is the destination

The end state for the `policy` pillar is NEAT enforcing its own architectural contracts — each compiled to a graph-pattern policy over the self-graph, evaluated deterministically and gated by the kernel. `divergences.ts` already evaluates graph patterns over the graph, so the mechanism is proven; it lands partial (file/import grain today, ADR-092) and grows as the self-graph sharpens. Turning the rules into graph queries applies NEAT's thesis to itself.

## Authority

`contracts.test.ts` (lint pillar), the neat-breaker repo (breaker pillar), the governance-kernel arc (policy pillar, ADR-093/094/095). The `enforcement:` frontmatter field on every `docs/contracts/*.md`.

## Enforcement

`enforcement: [lint, review]`. **Lint:** a `contracts.test.ts` assertion that every file under `docs/contracts/` carries an `enforcement:` field — a new contract without one fails CI. **Review:** the pillar-matching judgement — whether a clause is genuinely lint-able / breaker-able versus review-only — is a human call.

Full rationale: [ADR-104](../decisions.md#adr-104--the-contract-enforcement-model-four-pillars-one-enforcement-tag-per-clause).
