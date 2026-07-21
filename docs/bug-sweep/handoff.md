# NEAT bug sweep — control / handoff doc

**This file is the source of truth for a find→root-cause→fix sweep of NEAT's DX/usability/bugs backlog, ahead of the HN launch. It is designed so that if the driving agent's context dies, a fresh agent (Codex or otherwise) can read this file and continue with no other context.**

---

## 0. READ FIRST — how to resume (fresh agent / Codex)

You are continuing a bug sweep. Everything you need is in this file. Steps:

1. **Repo & branch discipline.** Work in `/Users/cem/Documents/GitHub/Untitled/neat-provider-wt` (a git worktree checked out on `main`). **Always branch off `origin/main`.** Do **NOT** work on `756-connector-status-view` — it is *stale* and re-surfaces already-fixed bugs (this has bitten two prior agents; verify any finding against `main` before acting). The primary repo `/Users/cem/Documents/GitHub/Untitled/Neat` is on that stale branch — don't use it.
2. **Pick up where the table left off.** In §3, each bug has a `status`. Process in severity order: **Critical → High → Medium**. For each bug:
   - `root-cause: TBD` → investigate (read the issue via `gh issue view <N>`, read the code, reproduce if a live daemon is needed — see §4), fill in the root cause + fix plan.
   - `root-cause` filled, `status: ready` → implement the fix on a fresh branch, add/adjust tests, run the suite, open a PR (`Refs #<N>`, never `Closes`).
   - Update the row's `status` + `PR` and the §5 progress log as you go.
3. **Verification gates (every fix):** `npm run build --workspace @neat.is/core` clean; `cd packages/core && npx vitest run` all green; eslint the changed files. **Read CI before merging** (`gh pr checks <PR> --watch`) — the `otlp-port-step` test (#818) is flaky; if *only* that fails, re-run, don't `--admin` over a real failure. Merge with `gh pr merge <PR> --squash --admin` (branch-protection check-name mismatch requires `--admin`).
4. **Commit/PR conventions:** plain English, `Refs #N`. Commit footers:
   `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and `Claude-Session: <session url>`. PR body ends with the 🤖 Generated line. (A Codex agent should substitute its own equivalent attribution.)
5. **Orchestration:** the user wants **one agent-orchestration per severity level**. Fix all Critical bugs in one wave (parallel agents, each in an isolated worktree — `isolation: 'worktree'`), then High, then Medium. Each fix agent implements + tests + opens its PR; the driver reviews the diff (don't trust the report — verify against main, see the stale-branch note), merges, updates this doc.

---

## 1. Method

The highest-risk class for HN is **"passes tests, breaks against a live daemon"** — the frontend and MCP use canned fixtures in tests, so shape mismatches and null-project paths never fire in CI. Root-causing these requires standing up a **live daemon on a real graph** and driving the frontend + MCP tools against it (see §4). Correctness bugs (ORM divergence, node-id routing) are root-cause-able by reading the code.

## 2. Severity buckets (orchestration units)

- **Critical** — breaks the live experience (a demo or a first user would hit it): #809, #745, #789, #801, #838.
- **High** — onboarding/robustness bugs on the first-run path: #831, #830, #826, #832.
- **Medium** — DX/polish: #835, #823, #818, #824.

Launch *tasks* (not bugs) tracked separately, out of this sweep: #820, #821, #822 (README/container/first-run hardening), #803/#804/#805/#806 (the launch-gate features).

## 3. Bug inventory (SOURCE OF TRUTH — update as you work)

| # | sev | symptom | root cause | fix plan / files | status | PR |
|---|-----|---------|-----------|------------------|--------|----|
| 809 | crit | frontend search + root-cause break vs live daemon | **ALREADY FIXED on main** — `ecbb1c1`/#811 (search proxy normalizes matches→results; Inspector reads `reason ?? rootCauseReason`). Verified ancestor of HEAD. Symptom only on stale 756. | none — close the issue | **VERIFIED-FIXED → close #809** | — |
| 801 | crit | ORM (Prisma/Drizzle/Knex) false missing-observed divergence | **ALREADY FIXED on main** — `c92be4b`/#802 (ADR-141) + `1716232`/#807 (env-URL resolve + host-less fusion). `db-orm-fusion.test.ts` 6/6 pass on main. Verified ancestors. | none — close the issue | **VERIFIED-FIXED → close #801** | — |
| 789 | crit | MCP tools never driven vs a live daemon — query-correctness gap | REAL but LATENT: `packages/mcp` wrappers tested only vs canned JSON (`tools.test.ts` stub client) + `stdio-smoke.test.ts` pins DEAD_CORE_URL; live REST paths (`/graph/root-cause`, `/search?q=`, divergences) never exercised. Not in-package-fixable (mcp deps = `@neat.is/types` only). Paths currently line up with core — no live break today, just no guard. | Add `e2e/capture/mcp-assertions.ts` (spawn `packages/mcp/dist/index.cjs` with `NEAT_CORE_URL`=live core, call get_dependencies/get_root_cause/get_divergences, assert real facts); wire into `e2e/capture/run.sh` + the capture CI job. Test-only, no core change. | **READY (test-only)** | — |
| 745 | crit | web graph pane stuck 'loading'; project=null → 502 | UNCERTAIN — auto-select logic already exists (`resolve-project.ts` #419/#461: "auto-select first running+reachable profile"). Root-cause agent returned garbage. Likely already addressed or a narrow edge case. | VERIFY the specific symptom against a live daemon (single reachable profile still → null?) before touching. May be a close. | **NEEDS-VERIFICATION** | — |
| 838 | crit | long file-grained node ids → misleading route-404 over REST | UNKNOWN — root-cause agent errored (schema cap). Likely: a long/`:`-bearing file node id breaks the `:nodeId` route-param match → framework-level 404 (looks like "no route" not "no node"). `api.ts` node routes 404 at :285/:298. | Re-investigate properly (repro with a real long node id), then likely URL-encode / a catch-all param. | **NEEDS-ROOT-CAUSE** | — |
| 831 | high | orchestrator prints "instrumented 1 … run your app, OBSERVED edges fill in" even when the dep install FAILED (exit code is honest, summary text isn't) | **REAL** — `orchestrator.ts` printSummary (1178-1185) prints the success/next line unconditionally; install failure only sets `exitCode=1` (996-999). `result.steps.apply.packageManagerInstalls` already carries per-install `exitCode`/`pm`/`cwd`. | Branch printSummary on `packageManagerInstalls.filter(exitCode!==0)`: if any failed, emit "not yet active — run `<pm> install` in `<cwd>`" instead of the clean next-line. Add a test. `orchestrator.ts`. no ADR. | **READY** | — |
| 823 | med | daemon serves no `/instrumentation` route → web ObservedOverlay never gets a real diagnosis (always generic copy) | **REAL** — web proxy `packages/web/app/api/instrumentation/route.ts:25` fetches `${endpoint}/instrumentation` but `api.ts` registers no such route → `upstream.ok` always false → `{engaged:null}`. | Add a dual-mounted GET `/instrumentation` in `api.ts` (~by `/extend/describe`:884) combining `describeProjectInstrumentation` + `listUninstrumented` → overlay contract `{engaged, diagnosis?}`. Touches `rest-api.md` (new route) → small contract note, maybe. `api.ts`. | **READY** | — |
| 818 | med | `otlp-port-step` tests flake under load (5s daemon-spawn timeout too tight) — the flaky CI red-x I hit | **REAL** (hit it directly this session) | Raise the spawn timeout and/or make the wait condition-based (poll for the port instead of a fixed 5s). `packages/core/test/otlp-port-step.test.ts`. no ADR. | **READY** | — |
| 826 | high | daemon advertises wrong web port when :6328 held | **ALREADY FIXED on main** — `cbefaef`/#508 + `fca5fe1`/#511 (allocatePorts steps the triple, threads `NEAT_WEB_PORT`, daemon.json authoritative). Both ancestors of HEAD; `project-daemon`/`web-spawn` tests green. Also **mislabeled** (issue body is a "run across 10 OSS repos" task). | none — close/relabel | **VERIFIED-FIXED → close #826** | — |
| 832 | high | OBSERVED Mongo twins the DB node instead of fusing | **ALREADY FIXED on main** — `029d13b`/#834 (MONGODB_URL → CONNECTION_KEYS); `db-parsers.test.ts` 9/9; issue author's own follow-up confirms end-to-end. (Plus ADR-141 host-fusion + ADR-150 mongoose-normalize.) | none — close the issue | **VERIFIED-FIXED → close #832** | — |
| 835 | med | MCP server gives no self-description on connect | **ALREADY FIXED on main** — `6d7de30`/#837 (`serverInstructions` passed to `new McpServer`, names the graph + provenance); `stdio-smoke.test.ts` asserts the handshake `instructions`. | none — close the issue | **VERIFIED-FIXED → close #835** | — |
| 789 | crit | (see above) MCP tools not driven vs a live daemon | — | Add `e2e/capture/mcp-assertions.ts` (built MCP server vs live core), wire into `e2e/capture/run.sh` + CI. test-only. | **READY** | — |
| 830 | high | ESM/TS otel-init doesn't survive missing `@opentelemetry` deps; verify ESM apps get spans (loader hook, not just `--require`) | **NEEDS-TRIAGE** — triage agent errored (schema cap). ADR-144 fixed the CJS runtime warning (`a71d7d5`); this is the ESM-flavor follow-up. Note: I confirmed *separately* this session that an ESM app instrumented via `--require` only gets connection spans — the loader-hook question is real. | Triage against main, then fix if real. | **NEEDS-TRIAGE** | — |
| 824 | med | orphan `/api/stale-events` route + #804 dead-code sweep | **NEEDS-TRIAGE** — triage truncated. | Verify the route is orphaned on main, then remove + sweep. | **NEEDS-TRIAGE** | — |

## 4. Standing up a live daemon (for #809, #745, #789)

Needed to reproduce the live-only bugs. Sketch (fill in exact commands once verified):
- Build: `npx turbo build`.
- Extract a real project: `node packages/core/dist/cli.cjs init <path>` then run the daemon (`neatd`) — check `packages/core/src/cli.ts` for the exact daemon-start verb and the web port (default 6328).
- Drive the frontend: Playwright (needs **chromium**, not chrome — repo quirk) against the web UI; watch for the graph-pane-loading (#745) and search/root-cause (#809) breaks.
- Drive MCP: `node packages/mcp/dist/index.cjs` (stdio) and call the tools (`get_root_cause`, `semantic_search`, `get_blast_radius`, …) against the live daemon; compare to fixture-backed results (#789).
- The Atlas mongoose sandbox from the connector work is a real graph source if needed (scratch dir has the app + Atlas URI).

## 5. Progress log

- **2026-07-21** — doc created. Bug inventory populated from open issues + the DX/usability audit.
- **2026-07-21** — **Critical bucket triaged (root-cause orchestration + hand verification).** MAJOR finding: **the backlog is inflated** — the open issues reflect the stale `756` branch, so several are already fixed on `main`. Critical results: **#809 already-fixed** (`ecbb1c1`, verified), **#801 already-fixed** (`c92be4b`+`1716232`, test 6/6), **#789 real** (MCP live-coverage gap, test-only fix ready), **#745 needs-verification** (auto-select already exists), **#838 needs-root-cause** (agent errored). → **STRATEGY PIVOT (below).**

## 6. STRATEGY — triage before fixing (read this)

The critical bucket proved **2 of 5 "bugs" were already fixed on `main`**. The open-issue backlog **overstates** the real work because issues were filed against, and the primary repo sits on, the stale `756` branch. **Therefore: TRIAGE every issue against `main` before writing any fix.** For each: is the fix already an ancestor of HEAD (grep the mechanism / `git log`), does its regression test pass? If yes → mark VERIFIED-FIXED, tell the user to close it, write no code. Only spend fix-agent effort on issues confirmed still-broken on `main`. The fix orchestration per severity runs **only over the confirmed-real subset.**

Confirmed-real critical work so far: **#789** (add e2e MCP assertions — test-only), **#838** (routing bug — needs real root-cause first), **#745** (verify, likely a close). Everything else needs the same triage.

### Final tally (after Critical + High/Medium triage)

- **ALREADY FIXED on main → tell the user to close (5):** #809, #801, #826 (also mislabeled), #832, #835. No code.
- **CONFIRMED REAL + ready to fix (4):** **#831** (orchestrator honest-summary), **#823** (`/instrumentation` route), **#818** (flaky-test timeout), **#789** (e2e MCP assertions — test-only). None needs an ADR.
- **NEEDS more before fixing (4):** **#838** (route-404 — needs root-cause), **#745** (verify — likely a close), **#830** (ESM otel-init loader-hook — triage), **#824** (orphan route — triage).

**So of 13 tracked "bugs," ~5 are already fixed and only ~4 are confirmed-real.** The per-severity fix split collapses — running **one fix orchestration over the 4 ready bugs**. The 4 needs-more get a second triage/rc pass (any agent can pick up from this doc).

- **2026-07-21** — High/Medium triaged. Fix orchestration ran over the 4 ready bugs. Outcome (each diff reviewed against main + CI-gated before merge):
  - **#831 → MERGED (#855)** — orchestrator now prints an honest "NOT yet active, run `<pm> install`" summary when a dep install failed; the clean next-step line only prints on success. +5 tests. CI green.
  - **#823 → MERGED (#856)** — new dual-mounted `GET /instrumentation` route fusing `describeProjectInstrumentation` + `listUninstrumented` into the ObservedOverlay's `{engaged, diagnosis}` shape; rest-api.md row added; +6 tests. CI green.
  - **#818 → MERGED (#858)** — otlp-port-step tests: 60s spawn timeout + condition-based `waitForHealthy` poll instead of a fixed 5s. Test-only. CI green.
  - **#789 → PR #857 OPEN, NOT merged.** The new `e2e/capture/mcp-assertions.ts` drives the built MCP server vs the live capture daemon and several assertions PASS (`get_observed_dependencies OK`), but `capture-observed` CI **fails on one wrong assertion**: it expects `get_dependencies(service:neat-capture-app)` to reach `frontier:sqs.us-east-1.amazonaws.com` — but that's an **OBSERVED-only** node, so `get_dependencies` (STATIC) correctly does NOT reach it; that's `get_observed_dependencies`' job (which passes). **FIX (one-liner):** in `e2e/capture/mcp-assertions.ts`, drop/correct the `get_dependencies`→sqs expectation — assert a real STATIC dependency of `neat-capture-app` instead (inspect `/projects/app/graph` EXTRACTED edges for a valid target), or just assert `get_dependencies` returns a non-empty EXTRACTED set. Then re-check `capture-observed` and merge. The guard itself is sound; only the fixture expectation is wrong.

### Remaining work (for the next agent / Codex)

1. **Fix + merge #857** (the one-liner above) — the last of the 4 real fixes.
2. **Second triage/rc pass** over the 4 needs-more: **#838** (route-404 — repro with a real long node id, likely URL-encode/catch-all), **#745** (verify the single-profile symptom on a live daemon — likely a close), **#830** (ESM otel-init loader-hook — I confirmed separately that ESM `--require` gets only connection spans; check if the installer registers the ESM loader hook), **#824** (verify `/api/stale-events` is orphaned, then remove).
3. **Tell the user to close the 5 already-fixed issues:** #809, #801, #826, #832, #835.
