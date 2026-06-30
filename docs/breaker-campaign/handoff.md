# Breaker campaign — handoff & running log

Autonomous campaign run by Claude while Cem is away. Single source of truth: plan, decisions, running log, open items. Everything stays on `staging/*` branches — **nothing is merged to `main`** until Cem reviews.

## Mandate (2026-06-30)

Publish NEAT stable; hook the breaker + tart VMs + a local debug env; run the breaker loop (≤10 runs, or until "the water runs clear"); heavy multi-agent orchestration; file issues + parallel-fix NEAT bugs; publish each run's fixes to npm `latest`; leave everything on staging branches + this handoff + reports for review. Runs are: scaffold a backend, write a buggy codebase, give it to the breaker, have an agent fix it — surfacing bugs **in NEAT itself**. Use subscription Claude to drive the breaker.

## Locked decisions (my calls)

- **Semver:** next stable = **0.4.20** (patch from 0.4.19). Each run's fixes → 0.4.21, 0.4.22, …. Graduate to **0.5.0** at the end *iff* the water runs clear.
- **Branches:** all work on `staging/*`; NO merges to `main`. Bug-fix branches `staging/fix-<issue>-<slug>`. Campaign artifacts on `staging/breaker-campaign`.
- **Publishing:** local `npm` is unauthenticated (E401), so publishing = push a `vX.Y.Z` tag → `publish.yml` CI runs `npm publish` (default `latest` dist-tag). **Smoke gate:** advance `latest` only after that version's breaker smoke is clean (Cem's own rule). If a publish looks risky, I hold it for review rather than push a bad `latest`.
- **Breaker driver = subscription Claude:** my Agent/Workflow subagents (which run on the subscription) ARE the breaker's coding agent — they use NEAT's MCP to diagnose+fix a buggy codebase; NEAT's failures to help are the harvest. No API key needed.
- **VMs:** tart is installed (`tahoe-base` present). `neat-base` (e2e/tart) = the fresh-Mac install smoke / clean-room verification; the **local debug env** = the fast iteration loop. Local breaker (`scenario.mjs`, 9 flow checks) is the per-iteration smoke gate.

## The loop (per run)

scaffold a backend + inject bugs → install latest NEAT → run NEAT on it (init + instrument + drive traffic) → a fixer agent uses NEAT (MCP) to diagnose+fix → **harvest NEAT's own failures** (0 OBSERVED, wrong graph, missing/coarse edges, silent fails, bad RCA) → file issues → parallel fix agents on `staging/fix-*` → verify (tests + breaker smoke) → bump version + tag (smoke-gated → `latest`) → re-run.

## Running log

- **setup** — `staging/breaker-campaign` created off `main` (7722cfe). Recon: breaker repo ✓ (`~/github/neat-breaker`, deps installed); tart ✓ (2.32.1, `tahoe-base`); `publish.yml` publishes to `latest` on a `vX.Y.Z` tag; npm local unauth (publish via CI). Baseline breaker smoke kicked off on `neat.is@nightly` (= current main content).
- **baseline smoke — FAIL** (`0.4.20-dev.20260630`, report `reports/baseline-nightly.json`): 2/3 checks pass, but **flow setup FAILED — the per-project daemon never wrote `neat-out/daemon.json` within 60s** ("install → daemon → app" timeout). Verified NOT a path mismatch: the breaker waits for the exact path NEAT writes (`<project>/neat-out/daemon.json`, daemon.ts:1002 after binding REST+OTLP). So the daemon crashed / hung / was too slow before writing its record — the breaker discards the daemon's stderr, so the cause is invisible from the report.
- **RUN #1 = this** — diagnostic agent dispatched: reproduce in isolation, **capture the daemon's stdout+stderr**, root-cause why `writeDaemonRecord` (daemon.ts:1002) isn't reached in 60s, classify neat-bug / breaker-bug / env, propose the fix. → then file + parallel-fix (staging) + re-smoke.

## Open items / blockers

- **`0.4.20` stable publish is BLOCKED** until the daemon-spawn flow-setup failure is resolved (the smoke gate must go green first). This is a flow-blocker on the headline one-command UX — exactly what a launch needs caught.
- `neat-base` tart image not yet baked (only `tahoe-base` exists) — bake via `e2e/tart/base-image.sh` or repoint `BASE_VM`, for the fresh-Mac clean-room smoke.
- npm publish requires a tag-push → CI; I can't local-publish. Every `latest` advance is a real release — smoke-gated.

## PRs already open from the launch build wave (pre-campaign, for review)

- #571 enforcement-lint · #572 engine-honesty (worker/queue) · #573 policies-soft-guardrail — all CI-green, on their own branches, not merged.
