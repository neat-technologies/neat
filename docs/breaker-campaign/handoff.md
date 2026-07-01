# Breaker campaign — handoff & running log

Autonomous campaign run by Claude while Cem is away. Single source of truth: plan, decisions, running log, open items. Everything stays on `staging/*` branches — **nothing is merged to `main`** until Cem reviews.

## Executive summary (read this first)

**10 runs · 1 flow-blocker + ~60 NEAT defects surfaced · 10 fixes on CI-green staging PRs · 0 published.** A breaker harness driven by subscription Claude (my subagents) scaffolded buggy backends across 10 shapes and ran NEAT on them — finding what HN would find, first.

**Fixed → CI-green `staging/*` PRs (10):** #575 (port bind-host flow-blocker), #583 / #585 / #587 / #588 (divergence precision · root-cause↔incidents · DB extraction · orchestrator DX), **#600 (OTLP decoder — real OTel telemetry now decodes)**, **#603 (FUSION restored — the layers merge again)**, #605 (ingest hygiene), #601 (Python imports). Integrated candidate `staging/release-0.4.21` carries the runs-#1-2 fixes; the final four (#600/#601/#603/#605) still need folding into a `0.4.22`.

**Filed, NOT fixed — architectural / contract, your call:** #576 (OBSERVED inbound coverage), #589 (cross-service root-cause), #594 (blast-radius runs backwards — needs an ADR), #595 (static extraction is file-level only), #596 (infra), #597 (daemon lifecycle), + #577-580 / #590-593.

**Verdict: NOT HN-ready — but precisely mapped and substantially de-risked.** The engine + determinism/provenance are real; the two *existential* bugs (fusion, OTLP) are fixed. Before HN: blast-radius direction (a prose-first ADR call), real call-graph extraction (#595), OBSERVED coverage (#576), and — the deepest lesson — a **test strategy that uses real-SDK-shaped inputs** (see the META-FINDING in the log; green CI was validating a world real OTel SDKs don't produce).

**Held for you:** the npm-`latest` publish — correctly, the smoke is red. Runbooks below.

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
- **RUN #1 status:** real bug found → fixed → on a reviewable PR. Flow-blocker closed.
- **RUN #2 (HARVEST) — a goldmine.** Scaffolded a 2-service Express + better-sqlite3 app with 4 planted bugs, ran NEAT (built w/ the #574 fix, Node 20), drove 225 requests. Full report: [`reports/run2-harvest.md`](./reports/run2-harvest.md). NEAT caught **1 of 4** planted bugs (the dynamic-dispatch `missing-extracted` — its clean fusion win) and surfaced **~13 real NEAT defects**. Headlines: divergence flood (structural edges as `missing-observed`, 13 false positives), root-cause blind to the incident store, OBSERVED near-zero for inbound/in-process work, DB connection strings unextracted. The honest verdict: **precision and OBSERVED coverage are NEAT's headline problems** — an agent acting on today's divergence surface chases phantoms.
- **RUN #2 issues filed:** #576 (OBSERVED inbound coverage), #577 (frontier dup), #578 (observed-deps), #579 (CLI daemon resolution), #580 (IPv6 bind) — tracked, architectural / next-wave.
- **RUN #2 fix wave — landed, all CI-green:**
  - #581 → **PR #583** — divergence precision: `missing-observed` now gates on a runtime-observable allowlist (CALLS/CONNECTS_TO/PUBLISHES_TO/CONSUMES_FROM), so IMPORTS/CONFIGURED_BY stop flooding.
  - #584 → **PR #588** — root-cause now consults the incident store + attributes to file:line/route + real "500 on GET …" messages.
  - #586 → **PR #587** — service `dbConnectionTarget` populated + service-level CONFIGURED_BY → `host-mismatch` reachable. (Root cause was structural, not a parse gap — the gate required an edge file-grained extraction never emits.)
  - #582 → **PR #585** — readiness gate scoped to the just-started project (a broken sibling no longer poisons every run) + grammar fix.
- **Env quirk (folded into repo-env-quirks):** worktrees share root `node_modules` whose `@neat.is/types` dist is stale (missing `ApplicablePolicy` from the unmerged #573) → `turbo` DTS build fails locally; agents ran `vitest` directly. CI (fresh install) is unaffected — all four PRs pass.
- **RUN #3 (integration + verification) — DONE.** `staging/release-0.4.21` (on GitHub, head `5194c85`, **v0.4.21**) = `main` + #574 + the 4 run-#2 fixes, merged cleanly (ORT auto-merged orchestrator.ts; hand-verified, no markers). Node 20 build green, **1136 core tests pass.** E2e re-harvest verdict:
  - **A divergence precision — PASS** (15 → 2 divergences; the IMPORTS/CONFIGURED_BY flood is gone, a real `missing-extracted` still surfaces).
  - **B/D/F root-cause + incidents — PASS** (root-cause localizes the 500 to `server.js:14` with a fix rec; message "500 on GET /users/:id").
  - **J readiness — PASS** (broken sibling registry entry no longer blocks the bare run).
  - **E DB extraction — PARTIAL but sound** (`dbConnectionTarget` live-verified; `host-mismatch` can't *fire* against a sqlite app — no OTel DB instrumentation — but is unit-verified; a fixture property, not a fix defect).
  - Agent verdict: **publish-ready as 0.4.21.** New notes: sqlite leaves no OBSERVED DB layer; bare-run latency on native-dep apps >3 min ("feels like a hang" — it's the install step, not the gate).
- **RUN #4 (HARVEST) — real OBSERVED layer, high value.** Express + real Postgres (`pg`, Docker) + cross-service. **The thesis works on real data:** OBSERVED `CONNECTS_TO` DB edge formed (conf 0.951, real host), A→B service edge resolved, and **`host-mismatch` FIRED at conf 1.0** — first live confirmation, validating the run-#2 DB fix. 5 new bugs filed:
  - **#589 (HIGH)** — cross-service root-cause confidently WRONG: asked why the entry service 500s, it blames the entry service itself (+ a route it doesn't serve) instead of crossing the CALLS edge to the real downstream culprit. Thesis-critical.
  - #590 (loopback peer mints a phantom `frontier:localhost` duplicating the resolved edge), #591 (one host drift → 3 overlapping divergences, no cross-pass dedup), #592 (dead URL-literal HTTP dep dropped below the precision floor → invisible to `missing-observed`), #593 (REST/MCP parity: `/graph/observed-dependencies` + `/graph/incident-history` 404).
- **RUNS #5-10 (HARVEST) — DONE, the decisive harvest.** 5 of 6 returned (#6 queue worker failed structured-output); **~45 defects (23 HIGH).** Full report: [`reports/run5-10-harvest.md`](./reports/run5-10-harvest.md). The bugs collapse into systemic, thesis-level failures:
  - **(1) The fusion doesn't happen** — EXTRACTED + OBSERVED FileNodes for the same file never fuse (node-id mismatch: span absolute path vs extractor repo-relative). NEAT's core claim.
  - **(2) The OTLP decoder 400s on real OTel SDK output** — OBSERVED layer dead for standard exporters (fixed32/64 wire-type bug; synthetic tests masked it).
  - **(3) blast-radius runs backwards** (outbound → returns 0 for the DBs/shared-libs/configs you'd query; #594, contract-level).
  - **(4) static extraction is file-level only** (no call/route/symbol edges; #595) · **(5) cross-project span contamination** · **(6) Python path largely broken** · infra near-absent (#596) · daemon lifecycle crashes (#597). Filed #594-597 + the fix-wave issues.
- **FINAL FIX WAVE — DONE, both existential bugs fixed:**
  - **PR #603** (#602) — **FUSION restored.** `reconcileObservedRelPath` (ingest.ts): when a runtime absolute path (container `/app`, Lambda `/var/task`, relocated clone) doesn't anchor against `scanPath`, it reuses the longest EXTRACTED FileNode path that's a trailing suffix of the runtime path → OBSERVED keys the **same** node id → the layers fuse. OTel-only files keep their honest path (nothing fabricated). Capstone test added; CI green.
  - **PR #600** (#598) — **real OTel SDK telemetry decodes.** Refined root cause: *not* hand-rolled — the bundled `trace.proto` typed `Span.flags`/`Link.flags` as `uint32` while OTel emits `fixed32`; the moment the SDK sets the W3C sampled bit, protobufjs misread the wire type and overran → 400. Fix: retype to `fixed32`; real-SDK-shaped test. CI green.
  - **PR #605** (#604) — ingest hygiene: `.env.neat` self-pollution excluded, cross-project span contamination gated (+ contract-first amendment to otel-ingest.md/ADR-096), incident dedup on `(traceId,spanId)`.
  - **PR #601** (#599) — Python `from PKG import NAME` resolves to the module file, not `__init__.py`.
- **META-FINDING (the deepest lesson):** the two most critical bugs were INVISIBLE to CI because the tests fed synthetic happy-path inputs — ingest tests only ever passed **relative** `code.filepath` (real SpanProcessors emit **absolute** → the fusion fork); the OTLP e2e fixture used `flags=0` (never set the sampled bit → never hit the fixed32 path). And the `.env.neat` self-pollution was **baked into the `demo/` CI fixture**, with tests asserting the polluted graph as correct. **NEAT's green CI was validating a world that doesn't match real OTel SDKs.** Closing that gap — real-SDK-shaped test inputs + a clean demo fixture — is the single highest-value change to the test strategy, and the reason the breaker found what CI couldn't.
- **CAMPAIGN VERDICT: NOT HN-ready — now precisely mapped, partly fixed.** The engine + determinism/provenance are real, but the two claims that matter most (we fuse static+runtime; OBSERVED carries the load) fail on unfamiliar code, over a few fixable root causes + real architectural gaps. The breaker did exactly its job: it found what HN would find, first.

---

## Post-campaign (Cem back, directing the work)

- **STABILITY PATCHES MERGED TO `main`** — PR **#606** (`d0af651`), squash-merged, **main CI green.** The nine campaign fixes consolidated into one forward-looking PR (no "drift" framing); the nine rolled-up PRs closed. Main now carries: port bind-host, scoped readiness, divergence precision, root-cause↔incidents, DB-connection-target, OTLP `fixed32` decode, Python imports, **the fusion fix**, ingest hygiene.
- **ISSUE WAVE — DONE (after a session-limit retry).** 6 bounded fix PRs, all CI-green, each with contract-first amendments where needed:
  - **#610** — precision cluster (#577/#590/#591/#592): loopback-frontier guard, host-mismatch cross-pass dedup, URL-literal dead-dependency recovery (new `url-literal-service-target` grade at the floor).
  - **#608** — cross-service root-cause (#589): follows the failing OBSERVED CALLS chain to the real downstream culprit instead of self-attributing the caller's client span.
  - **#611** — query surfaces (#578/#593/#579): file-grained observed-dependencies + REST parity routes + registry-based CLI daemon resolution.
  - **#607** — daemon robustness (#597/#580): unsupervised-crash guard on ingest + IPv6/dual-stack port awareness.
  - **#609** — infra topology (#596): terraform/Dockerfile resources connect to the services that use them.
  - **#612** — **blast-radius flipped to inbound-dependents (#594), superseding ADR-038** — the correct "what breaks if X changes" semantics. ⚠️ Genuine product/contract call — Cem should sanity-check.
  - Design proposals posted to **#576** (OBSERVED coverage; Tier-A safe first cut ~1 day) and **#595** (real call-graph extraction; phased, foundational slice ~1 wk).
- **STABILITY-PATCHES-2 — MERGED to `main`** — PR **#613** (`3478e50`), squash-merged, **main CI green**, six PRs rolled up + closed. One real conflict (the blast-radius test) resolved to the inbound version; the direction flip is isolated to blast-radius (dependencies + RCA stay outbound). Main now carries **all 15 fixes** across both rounds. (CI sidebar: GitHub deprecating Node-20 runners — housekeeping, not a failure.)
- **BREAKER ROUND 2 — DONE.** 10 shapes against hardened `main`. Full report: [`reports/round2-harvest.md`](./reports/round2-harvest.md). **Headline: every round-1 fix VERIFIED e2e on real backends** — OTLP decode, fusion, host-mismatch, Python imports, cross-service RCA, blast-radius-inbound, loopback frontier, host-drift dedup, plus cross-language Node↔Python fusion. Unit-green translated to real-backend-correct. New defects: 7 high / 19 med / 9 low, themed — trace-stitcher corrupts provenance (rewrites structural EXTRACTED as INFERRED on any 500), async/queue dark (#614), GraphQL/WS zero-OBSERVED (#615/#617), gRPC coarse (#616), `watch` re-extract crash, fusion incident-reconciliation gap, daemon OTLP-port crash + `daemon.json`/otel-init resolution, incident quality.
- **ROUND-3 FIX WAVE (in flight):** 5 bounded fixes — stitcher provenance, watch crash, fusion incident reconciliation, daemon OTLP port + `daemon.json`, incident quality — each → `staging/fix-*` PR. → then merge (stability-patches-3) + optionally a round-3 breaker.
- **CAMPAIGN STATE:** the fixes are real and hold under real load; the road to HN-ready is now the OBSERVED-coverage frontier (#576/#595 + #614-617) — the architectural work — plus the round-3 polish.

## Open items / blockers

- **`0.4.20` publish:** the flow-blocker (#574) is FIXED on PR #575 — now gated on (a) #575 CI green and (b) a clean breaker smoke. Because this box can't host a clean smoke (live demo + Node-version friction), the legitimate smoke surface is the tart `neat-base` VM. Conservative stance: I advance npm `latest` only on a genuinely clean smoke; anything I can't cleanly verify I leave staged + documented for review rather than ship.
- `neat-base` tart image not yet baked (only `tahoe-base` exists) — bake via `e2e/tart/base-image.sh` or repoint `BASE_VM`, for the fresh-Mac clean-room smoke.
- npm publish requires a tag-push → CI; I can't local-publish. Every `latest` advance is a real release — smoke-gated.

## Runbooks (prepared, held for your go — deliberately NOT executed autonomously)

The irreversible / heavy-infra steps. Each is ready; run when you want, or tell me to.

### A. Publish `0.4.20` stable (= `main` + the #574 fix)
1. Merge PR #575 (or cherry-pick the fix) → assemble `staging/release-0.4.20` off `origin/main` + the #574 fix.
2. Bump all six publishable packages to `0.4.20` in lockstep (`publish.yml` verifies lockstep).
3. `git tag v0.4.20 && git push origin v0.4.20` → `publish.yml` runs `npm publish` → npm `latest`.
4. **Gate:** only after #575 CI green **and** a clean breaker smoke (§C). npm versions are immutable — a bad `latest` needs a follow-up patch, not a rollback.

### B. Bake the tart `neat-base` VM (the clean-room smoke surface)
`base-image.sh` automates the host side; the in-VM provisioning is manual SSH:
1. `tart clone ghcr.io/cirruslabs/macos-sequoia-base:latest neat-base` (or repoint to the local `tahoe-base`).
2. Boot headless, SSH in (admin/admin), install Node 20 + git + Playwright chromium (the copy-paste blocks in `e2e/tart/base-image.sh`), stop.
3. Thereafter `e2e/tart/run.sh` clones a virgin `neat-base` per run.

### C. Breaker clean-room smoke (the publish gate)
- Local (this box): blocked by the live demo holding 8080/4318 + the Node-26 fixture-build friction — not a valid smoke surface.
- VM: `BASE_VM=neat-base e2e/tart/run.sh`, or `node scenario.mjs --sut <version>` inside the VM. A clean PASS here is the gate to advance npm `latest`.
- Reconcile breaker PR #12's port pre-flight to a **warning** before relying on it locally (today it hard-fails when the live demo holds the canonical ports).

## PRs already open from the launch build wave (pre-campaign, for review)

- #571 enforcement-lint · #572 engine-honesty (worker/queue) · #573 policies-soft-guardrail — all CI-green, on their own branches, not merged.
