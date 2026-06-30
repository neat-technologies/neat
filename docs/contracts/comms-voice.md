---
name: comms-voice
description: Repo-visible artifacts use forward-looking framing only. Plan files and conversation can name drift; commits, PRs, ADRs, contracts, README, runbooks, and release notes cannot.
governs:
  - "docs/contracts/*.md"
  - "docs/decisions.md"
  - "README.md"
  - "CLAUDE.md"
  - "docs/runbook-publish.md"
  - "docs/api-reference.md"
  - "docs/architecture.md"
adr: [ADR-027, ADR-053]
enforcement: [lint, review]
---

# Comms-voice contract

Every repo-visible artifact NEAT publishes uses **forward-looking framing**. Plan files (`~/.claude/plans/`) and direct conversation with the maintainer can name drift, walk-backs, and past-tense self-correction accurately. Repo artifacts cannot.

This contract is documentation that the PreToolUse hook surfaces at edit time. It is not enforced by code — the agent reads the rule when editing a governed file and applies discipline before writing.

## What forward-looking framing means

The structural change is identical either way; only the narrative wrapper differs. Past tense becomes a milestone, not an admission. When a change internally feels like correction, reframe as graduation or maturation of the existing design before writing the public text.

If the only honest framing you can find is "we drifted, we're fixing it," that is a signal to revise the design intent itself in a new ADR or contract so the change reads as the natural next step rather than a fix.

## Use (repo / public)

- "OBSERVED has reached the maturity to lead the divergence query"
- "Weighting `get_divergences` toward OBSERVED-led findings"
- "ADR-066 — OBSERVED-led divergence query weighting"
- "EXTRACTED continues to provide declared-intent enrichment; OBSERVED is now the primary signal source"
- "NEAT graphs your runtime; declared intent enriches it"

## Never use (repo / public)

- "Drift" / "correcting drift" / "drifted from original intent"
- "Symmetric framing was wrong"
- "EXTRACTED was over-relied on"
- "We're walking back ADR-XXX's framing"
- Any past-tense self-correction language

## Where the rule applies

- **Commit messages** — every commit on every branch destined for `main`.
- **PR bodies** — including the verification dry-run blocks pasted in.
- **ADR text** — both new ADRs and amendments to existing ones in `docs/decisions.md`.
- **Contract docs** — every per-topic file under `docs/contracts/`, plus the index `docs/contracts.md`.
- **README** — repo root and any package READMEs published to npm.
- **Runbooks** — `docs/runbook-publish.md` and any future operational docs.
- **API / architecture docs** — `docs/api-reference.md`, `docs/architecture.md`, and anything similar that ships in the repo tree.
- **Release notes** — GitHub release bodies, npm changelog entries.

## Where the rule does not apply

- **Plan files** under `~/.claude/plans/` (machine-local; not in the repo).
- **Conversation** between agent and maintainer.
- **Scratch notes** and `.local.md` files git-ignored from the repo.

In those surfaces, drift framing is allowed and often clearer than the forward-looking equivalent. The discipline only applies once text reaches a path that ships.

## Coverage boundary

The PreToolUse hook surfaces this contract when an agent edits a file the `governs:` list matches. That covers contracts, ADRs, README, CLAUDE.md, runbooks, and the listed docs.

It does **not** cover:

- PR body text drafted via `gh pr create --body ...` (Bash, not Edit).
- Release notes drafted via `gh release create --notes ...` (Bash, not Edit).
- Commit messages drafted via `git commit -m ...` (Bash, not Edit).

For those surfaces, the rule still binds — but the hook cannot enforce surfacing. The agent applies the discipline from session-start context (`CLAUDE.md` § Conventions and the comms-voice memory) instead of from edit-time hook output.

## Why

External reputation and narrative hygiene. NEAT is pre-Show-HN, pre-investor, pre-external-users. The repo is the public artifact; first impressions of "this product is being actively corrected" weaken positioning even when the corrections are honest engineering. Forward-looking framing is true (the next layer reasserts the original intent) without flagging implementation drift to readers who do not need that context.

## References

- Source rule: `~/.claude/plans/lazy-moseying-island.md`, the "Comms rule — strict, applies to all repo artifacts" section near the bottom.
- Session-start memory: `~/.claude/projects/-Users-cem-Documents-GitHub-Untitled-Neat/memory/feedback_neat_repo_comms_voice.md`.
- Adjacent ADRs: [ADR-027](../decisions.md#adr-027--mvp-success-is-closing-a-real-pr-on-an-unfamiliar-open-source-codebase) (thesis framing for the MVP) and [ADR-053](../decisions.md#adr-053--milestone-naming-rolls-forward-past-consumed-npm-slots) (forward-looking milestone naming convention).
