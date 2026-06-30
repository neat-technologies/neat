# Quirks — enforcement lint (Refs #568)

Edge cases and judgement calls hit while making ADR-104 / `docs/contracts/contract-enforcement.md` real in CI. The correction wave reads this.

## Pre-existing red tests in contracts.test.ts (not mine)

`npx vitest run test/audits/contracts.test.ts` is already red on a clean `origin/main`, before any of my edits. Stashing my changes and running the file gives the same failures:

- `Runtime layer fails loud, never silent (#545 #546) > the registry classifies sqlite3 / better-sqlite3 as a coverage gap` — `resolve('sqlite3', '5.1.0')` / `better-sqlite3` returns null instead of a `gap`-coverage entry. Instrumentation-registry **data**, nothing to do with contract frontmatter.
- `Runtime layer fails loud, never silent (#545 #546) > warns about uninstrumented libraries on an instrumented service` — same registry root cause.
- `Daemon contract (ADR-049) > ADR-071 — span for a still-broken slot emits the rate-limited drop log once per minute` — timing-flaky; shows up in some runs and not others (run count flips between 2 and 3 failures).

My 107 added test rows all pass. I did **not** touch these — out of scope, and they predate this branch. Flagging so nobody blames the enforcement-lint PR for a red audit file.

**Correction-wave update:** these no longer reproduce. `npx vitest run test/audits/contracts.test.ts` on this branch is fully green (708 passed, 0 failed) — the registry-data gap (#546) and the rate-limit timing flake were resolved upstream and merged in before this branch's base. Left here as history; nothing to fix.

## Tag-honesty judgement calls

The backlog pass picks a pillar from each contract's nature. Where I could have over-claimed, I deliberately didn't:

- **The `policy` pillar is not active yet** (🟡 "opens with the kernel arc" per the contract table). Several contracts are architecturally *policy*-shaped — `client-profiles` ("no daemon reads the client profile store"), `mcp-tools` ("MCP read-only"), `llm-policy` ("no LLM call on any path"), `project-daemon` ("no machine-wide write-locked registry"). I did **not** tag any of them `policy`, because that would imply an enforcement mechanism that doesn't exist. They're tagged with what holds them today (`lint` where a structural assertion exists, else `review`). These are the prime migration candidates when the governance kernel lands — re-tag them `policy` then.

- **`llm-policy` → `[review]`, not `[lint]`.** Its rule ("NEAT holds no LLM key, makes no LLM call on any user-facing or daemon path") is genuinely grep-mechanizable — a lint that scans production `src` for LLM SDK imports would hold most of it. But that lint does not exist today, so claiming `lint` would be dishonest. Good follow-up: add the grep guard, then bump the tag to `[lint, review]`.

- **`package-split` → `[review]`.** Its body claims the substrate/installer boundary is "held by a directory boundary + lint rules." I could not find that boundary lint in `contracts.test.ts` (it may be an eslint rule elsewhere, or aspirational). Didn't claim `lint` on the strength of a body sentence I couldn't verify.

- **`comms-voice` → `[lint, review]`** (corrected from an earlier `[review]`). The `Comms-voice contract` describe block fails the build on structural violations — frontmatter shape, the `governs` list covering the four artifact classes, and the canary phrase. That is the lint pillar active, exactly like every other contract carrying a structural describe block. The substantive "forward-looking framing" rule stays a human/LLM call (`review`), but tagging the file `[review]`-only hid a surface that CI does enforce, which is the opposite of what the §2 tag is for. So `[lint, review]` matches the calibration of the other lint-backed contracts.

- **`canvas-layout`, `hosted-storage` → `[review]`.** `canvas-layout` is behavioral UI determinism (ELK layout, 750ms batch, never auto-reflow) — would need a browser e2e to mechanize, which isn't there. `hosted-storage` describes a Postgres backend that isn't built yet. Both are honest `review` (the default for "genuinely unmechanizable / not built").

- **`observed-e2e` → `[lint, breaker, review]`.** The live Brief e2e harness is the `breaker`-shaped enforcement; `lint` holds the structural file/workflow-existence checks the ADR-075 block already makes. Mirrors `divergence-query`'s shape.

Everything else with a dedicated describe block asserting its substantive rules got `[lint, review]`, matching the calibration of the already-tagged contracts (`provenance`, `lifecycle`, `policy-*`).

## Scope notes

- The lint walks `docs/contracts/` and skips `_*` (hook helpers) and `contracts.md`. The actual index is `docs/contracts.md`, one directory **up**, so it never appears in the walk — the `contracts.md` filter is defensive only, in case an index is ever co-located by mistake.
- Tags were inserted as the **last** frontmatter field (right after `adr:`, before the closing `---`). No contract **bodies** were touched, per the brief.
- The presence check is `it.each` per file, so a missing tag names the offending contract instead of failing as one opaque aggregate.
- I did **not** add an `enforcement` column to the `docs/contracts.md` index table — out of scope (the brief said frontmatter only), and the contract doesn't ask for it.
- I intentionally did **not** also enforce contract §3 ("new contracts ship with ≥1 active pillar or explicit review-only"). The brief specs exactly two assertions (field present + values subset); §4 says backlog tagging defaults to `review` and "is cleanup, not blocking," so a stricter "must have an active pillar" check would wrongly fail honest `review`-only tags. Left as a possible future tightening for *new* contracts only.
