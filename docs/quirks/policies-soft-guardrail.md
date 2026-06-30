# Quirks — policies as a soft guardrail (MVP)

Issue #569. Branch `569-policies-soft-guardrail`. What I built, what I deliberately did not, and the edges I hit. The correction wave reads this.

## Partial gap — blast-radius now surfaces downstream; the general scope×distance injection is still one-hop

The contract (policies-soft-guardrail.md §1) wants the *reachable* policies surfaced via the policy overlay's blast-radius injection (ADR-105 §5): relevance = the policy's declared propagation scope × graph distance, so a downstream-breaking invariant several hops away still surfaces and a local rule three hops away does not. The **general** machinery for that — carrying scope×distance to *every* rule type — lives in the policy overlay, which is still contract-only / unbuilt.

What the MVP does:
- For structural / provenance / compatibility / ownership rules, `selectApplicablePolicies` matches by a **subject or one-hop region** match — the node's type is the rule's declared subject, or the node sits one hop inside the rule's region (the target end of a structural edge, the database one CONNECTS_TO from a service, a node on a governed provenance edge).
- For **blast-radius** rules it now does the real reverse-reachability walk: `getBlastRadius` from each subject-type node (to the rule's declared depth) surfaces the rule as a `region` match on *every node in that subject's downstream set*. A far-away downstream node sees the invariant that governs it. This is the buildable slice of ADR-105 §5 — the named case the contract calls the point — implemented for real with the existing traversal, not faked and not the general overlay.

**Remaining severity: medium.** The non-blast-radius rule types still stop at one hop; a structural or provenance invariant three hops away won't surface until the overlay's general scope×distance walk lands. `blastRadiusSubjectReaching` is the worked example of what that seam looks like; the overlay generalizes it across rule types. Don't read "blast-radius surfaces downstream" as "every rule type does."

## A node not yet in the graph returns an empty applicable set

The contract frames the guardrail around "a given node/edit." `selectApplicablePolicies` needs the node's `type` to match rules, so it reads attributes from the graph. A brand-new edit that creates a not-yet-extracted node returns `[]` — we can't type-match what isn't there. A real "edit" surface (match against a proposed node type before it lands) is FRONTIER/overlay territory (ADR-093/ADR-105), so I took node-id-in-graph as the MVP input and return empty rather than guess. `GET /policies/applicable?node=unknown` returns `200 { node, applicable: [] }`, not 404 — consistent with "informs," and it keeps the agent from special-casing a missing node. Low severity, but it's a real scope cut: the launch tool answers "policies for an existing node," not "policies for an arbitrary hypothetical edit."

## The applicable record shows `onViolation` (including `block`) for awareness only

An `ApplicablePolicy` carries the resolved `onViolation` — which for a critical policy is `block`. That is the action the **post-launch kernel gate** (ADR-093) would take, shown so the agent knows how seriously the project takes the rule. The soft guardrail itself never acts on it: there is no `allowed`/`blocked` field on the record, no verdict on the REST response, and the MCP block deliberately avoids the gate's "denied"/"refuse" vocabulary. Reviewers may find showing `[critical/block]` in an "informs, never blocks" surface confusing — it's intentional, and the summary text says so plainly. If it reads as a mixed message in practice, the fix is wording, not removing the field (the agent genuinely wants to know a rule is block-grade).

## `check_policies` is now a three-mode tool on one input object

`applicableTo` joins `scope` and `hypotheticalAction` on the same input. Precedence is `applicableTo` > `hypotheticalAction` > violation-read. Nothing stops a caller passing both `applicableTo` and `hypotheticalAction`; the applicable mode wins silently rather than erroring. Felt right for a soft, forgiving surface, but it's an unenforced precedence — a stricter version would reject the combination. Low severity.

## Region match for compatibility is driver-engine-only

`compatibility` rules run four shapes (driver-engine, node-engine, package-conflict, deprecated-api). Only `driver-engine` reaches across a CONNECTS_TO edge to a DatabaseNode, so only that shape gets a database **region** match. The other three operate purely on a service's own `dependencies`, so they only ever surface on the ServiceNode subject. Correct, but asymmetric — worth knowing when reasoning about why a database surfaces a compat policy but not, say, a deprecated-api one.

## Worktree resolution needed a real install

Cross-package imports (`@neat.is/types` → core/mcp) resolve up the directory tree to the **main** repo's `node_modules` when the worktree has none, so the worktree's type changes were invisible to the core/mcp builds until I ran `npm install` inside the worktree to create the workspace symlinks. Not a code quirk — an environment one — but it'll bite the next agent adding a cross-package type in a fresh worktree. (Matches the existing "worktree" note in repo memory.)
