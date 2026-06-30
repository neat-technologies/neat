# Engine honesty (issue #570) — quirks and edge cases

Notes from the sprint that made worker/queue app shapes engage-or-loudly-warn,
building on PR #547. Read this if you're carrying the work forward or cleaning up.

## What this PR does and deliberately does not do

It closes the install-time half of "never a silent zero" for the four named
shapes:

- **bare node `server.js`** — engages (already covered by #547's root-entry
  resolution; now has an explicit no-false-warning test).
- **sqlite3 / better-sqlite3 CRUD server** — engages (http/fastify bundled) and
  the in-process driver gap is named (#546's warning), including the raw-http
  leaf case with no web framework.
- **bullmq worker** — `worker.js` / `src/worker.ts` now resolve, so it engages;
  the bullmq job-span gap is named. If no entry resolves at all, the lib-only
  branch now warns loudly instead of staying silent.
- **lib-only package** — a genuine library stays quiet; a lib-only package that
  declares a web- or worker-framework dep gets the loud "no entry point" line.

It does **not** add instrumentation for sqlite3 / bullmq (detection + guidance
only — a maintainer-scope decision, same boundary #547 drew).

## Quirks I hit

1. **Worktree resolves the registry to the parent repo's stale dist.** This
   worktree has no `node_modules` of its own; `@neat.is/instrumentation-registry`
   resolves up to the parent checkout's workspace package
   (`packages/instrumentation-registry/dist/index.cjs`). That dist was stale —
   its source carried `sqlite3` (added in #547) but the built `index.cjs` did
   not, so `resolve('sqlite3', …)` returned `null` and the *pre-existing* #546
   registry tests failed locally too. Fix was a force-rebuild of the parent's
   registry dist (`turbo build --filter=@neat.is/instrumentation-registry
   --force`); it's a build-artifact refresh, not a source change. CI is
   unaffected — a fresh install links the branch's own source. This is the same
   "shared node_modules / stale dist hides cross-package state" class already
   noted in the repo's env quirks.

2. **The sdk-install contract's entry-resolution list was already stale before
   I touched it.** #547 inserted the root-level `server`/`app`/`main` step but
   never updated `docs/contracts/sdk-install.md`, which still listed 7 steps
   ending at root `index.*`. I updated it to the real order (now 8 steps,
   including #570's `worker` addition) so code and contract agree again. Flagging
   the prior drift rather than silently absorbing it.

3. **Worker/queue app-framework signal lives in code, not the registry.** The
   `WORKER_FRAMEWORK_DEPS` list sits alongside #547's `WEB_FRAMEWORK_DEPS` in
   `javascript.ts`, not in `registry.json`. I considered a `role`/category field
   on registry entries, but the instrumentation-registry contract treats the
   schema as stable-from-launch with a closed coverage enum, and this is an
   app-shape heuristic ("is this a runnable app whose entry we missed?"), not
   instrumentation coverage. The registry stays the single source of truth for
   *what is observed*; this only answers *is this an app*. Kept it next to the
   existing precedent.

4. **"Traffic flowed but zero OBSERVED edges" is not built here.** Issue #546's
   third bullet — a live leaf service receiving traffic should be
   distinguishable from a dead one — is a runtime/daemon-side check (inbound
   SERVER spans seen, no outbound edges formed), not an install-time fact. This
   PR covers the install-time signal ("this library won't be observed"); the
   "service is live but produced no edges" signal needs the daemon's view of the
   OBSERVED layer and is out of scope. Built the buildable part, logged the rest
   here per the honesty guardrail.

5. **A lib-only package with a `gap` DB driver but no app-framework dep stays
   quiet.** A CLI/helper depending on `better-sqlite3` with no resolvable entry
   is genuinely ambiguous — it could be a real library. Only web/worker
   app-framework deps flip a lib-only classification into a loud warning, to keep
   the signal high and avoid nagging genuine libraries. If a concrete user story
   shows DB-only lib-only packages are usually missed apps, widen the signal
   then.

6. **Pre-existing lint warning left as-is.** `orchestrator.ts` carries an
   "Unused eslint-disable directive" warning in `spawnDaemonDetached` (the
   `require('node:fs')` block). It predates this work and is unrelated to it;
   `turbo lint` passes (0 errors). Not touched to avoid scope creep.

7. **`looksLikeWebApp` removed.** The orchestrator switched to
   `appFrameworkDependencies` (the richer form that names what it found), which
   left `looksLikeWebApp` as a thin alias imported by nothing — not the
   orchestrator, not the installer index, not the tests. It was dead code this
   change created, so it's gone rather than left as a back-compat stub; the
   contract already references `appFrameworkDependencies` as the signal.
