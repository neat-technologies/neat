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
- **RUN #1 diagnosed → real NEAT bug.** Root cause: **port-allocator / bind-host mismatch.** `isPortFree` (orchestrator.ts:529) probes `127.0.0.1`, but the daemon binds `0.0.0.0` on the token path — the common case (`resolveHost`, daemon.ts:503). A wildcard-held port reads as free → allocated → daemon dies on `EADDRINUSE` at daemon.ts:805 *before* `writeDaemonRecord` (daemon.ts:1002) → silent "daemon.json timeout". Trigger on this box: a leftover wildcard daemon (`PID 90262 on *:8081`). Riders: misleading bind-host log (daemon.ts:806); env — this box is Node 26.4.0 (NEAT targets Node 20.x), so the fixture's `better-sqlite3` can't build. Filed **#574**.
- **RUN #1 fixed (parallel, on staging):**
  - **NEAT — PR #575** (branch `574-port-bind-host`): allocator now probes the same host the daemon binds (`resolveHost` threaded through `isPortFree`/`tripleFree`/`allocatePorts`), + the misleading log fixed, + `port-bind-host.test.ts`. `turbo test --filter=@neat.is/core` → **1125 passed**. (Test deliberately avoids the macOS-only SO_REUSEADDR blind spot to stay green on Linux CI.) CI pending.
  - **Breaker — PR #12** (neat-breaker, `surface-daemon-errors-on-timeout`): attaches the daemon's stderr tail to a `daemon.json` timeout (cause no longer invisible) + canonical-port pre-flight. **Caveat:** the pre-flight hard-fails on held canonical ports — correct for a clean tart VM, too strict for this box (live demo holds 8080/4318, and NEAT is designed to step past). Reconcile to a *warning* for local; the VM is the real smoke surface.
  - **Env:** `node@20` (v20.20.2) installed via brew for the re-smoke / fixture builds.
- **RUN #1 status:** real bug found → fixed → on a reviewable PR. Flow-blocker closed. **Next:** (1) `0.4.20` = `origin/main` + #574 fix on `staging/release-0.4.20`, publish gated on #575 CI green; (2) bake tart `neat-base` for the clean-room smoke (this box is too dirty to be the smoke surface); (3) then the scaffold-a-buggy-backend harvest runs (NEAT's MCP is now reachable — dogfood `get_divergences`/`get_root_cause` on the bugs).

## Open items / blockers

- **`0.4.20` publish:** the flow-blocker (#574) is FIXED on PR #575 — now gated on (a) #575 CI green and (b) a clean breaker smoke. Because this box can't host a clean smoke (live demo + Node-version friction), the legitimate smoke surface is the tart `neat-base` VM. Conservative stance: I advance npm `latest` only on a genuinely clean smoke; anything I can't cleanly verify I leave staged + documented for review rather than ship.
- `neat-base` tart image not yet baked (only `tahoe-base` exists) — bake via `e2e/tart/base-image.sh` or repoint `BASE_VM`, for the fresh-Mac clean-room smoke.
- npm publish requires a tag-push → CI; I can't local-publish. Every `latest` advance is a real release — smoke-gated.

## PRs already open from the launch build wave (pre-campaign, for review)

- #571 enforcement-lint · #572 engine-honesty (worker/queue) · #573 policies-soft-guardrail — all CI-green, on their own branches, not merged.
