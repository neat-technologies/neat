# Hosted daemon lifecycle fixes — plan (#1215, #1217)

**Status:** implemented (both fixes landed with tests) · **Branch:** `hosted-daemon-lifecycle` (off `firebase-hosted-delivery`)
**Issues:** neat#1215, neat#1217 · **Related:** neat#1207 (already fixed on the branch), neat-infra#70 (graph durability)
**Scope:** `packages/core/src/connectors/` only. No control-plane contract change, no `daemon.ts` wiring change.

## The shared root cause

Both bugs are the same shape: the hosted daemon's view of the control plane is a snapshot taken at boot, and it never refreshes it. On Cloud Run a tenant's graph lives on the instance's own disk, so any redeploy, crash, or scale-to-zero starts a fresh process whose boot-time snapshot is already wrong.

- #1215: a restarted daemon reads its bound repos' CP status as `synced` and skips them, so the graph stays at 0 nodes forever.
- #1217: a provider connected from the console after boot is never discovered, so it sits idle until the instance restarts.

The two files involved (`hosted-repos.ts`, `hosted.ts`) are deliberate structural siblings. The repo file already grew a boot-plus-interval loop; the connectors file never did. The fixes keep the two parallel rather than sharing a helper (see "Shared refactor" below).

Note on #1207: the `gcp` fan-out it asked for is already present on this branch (`HOSTED_CONNECTORS_FOR` in `hosted.ts`, plus the `gcp` cases in `credentialRecord` and `hostedOptions`). Do not touch it here. Once this branch merges, #1207 can be closed.

---

## #1215 — repo-sync first pass must re-extract every bound repo

File: `packages/core/src/connectors/hosted-repos.ts`

The gate is `needsSync()` (around line 165), called from `runRepoSyncPass` (around line 208). The loop in `startRepoSync` (around line 228) already does a boot `void tick()` plus an `intervalMs` `setInterval`, with a `running` non-overlap guard. The only bug is that the boot pass goes through the same terminal gate, so a fresh, empty process skips its `synced` repos.

Fix: the first pass after boot syncs every bound repo regardless of `syncStatus`; later passes keep today's rule, so the CP re-queue stays the way to force a refresh.

1. **`needsSync`** gains a `syncAll` parameter:
   `function needsSync(r: RepoToSync, syncAll: boolean): boolean` returning
   `syncAll || r.syncStatus === undefined || r.syncStatus === 'syncing'`.

2. **`runRepoSyncPass`** gains a pass-scoped option and returns whether the CP list was actually read:
   `export async function runRepoSyncPass(input: RepoSyncInput, opts: { syncAll?: boolean } = {}): Promise<boolean>`.
   The `cpGet` catch returns `false`; the non-array guard returns `false`; the loop calls `needsSync(r, opts.syncAll ?? false)`; the end returns `true`. The `syncAll: false` default preserves every existing call site and test.

3. **`startRepoSync`** tracks a one-shot flag and only clears it once a pass over a readable list has run:
   add `let firstPass = true`; in `tick`, `const listRead = await runRepoSyncPass(input, { syncAll: firstPass }); if (listRead) firstPass = false`. The boot `void tick()`, the interval, the `unref`, and the returned stop are untouched.

Why gate the flip on `listRead`: if the boot pass can't reach the CP, the process has still extracted nothing. Flipping `firstPass` unconditionally there would revert the next tick to the `needsSync` rule and re-introduce the "0 nodes forever" bug until the CP happens to re-queue. Keeping sync-all armed until one full pass over a readable list has run closes that window.

### Tests (`packages/core/test/hosted-repos.test.ts`)

Seams already present: `makeFetch`, `repo()`, `cloneRepo`, `extract`, `onSkip`, `now`.

- sync-all re-syncs a terminal repo: seed `repo({ syncStatus: 'synced' })`, call `runRepoSyncPass({...}, { syncAll: true })`, assert clone + extract ran and a `synced` status POST was sent. Mirror with `failed`.
- default pass still skips terminal (existing test, kept as the `syncAll: false` regression guard).
- return-value contract: `true` on a readable list, `false` when the `/repos` GET fails.
- boot pass syncs-all then reverts: fake timers, boot pass clones the `synced` repo once, advance one interval, assert the second tick does not clone again.
- list-read failure keeps sync-all armed: first `/repos` GET fails then succeeds, assert the second tick still clones the `synced` repo.

---

## #1217 — hosted connections must be re-listed on a cadence

File: `packages/core/src/connectors/hosted.ts`

Today `startHostedConnectors` (around line 224) lists connections once, starts loops in a single pass, and returns a combined stop. There is no re-list. Split it into a reconcile pass over a persistent running map plus a boot-plus-interval driver, mirroring `hosted-repos.ts`.

1. **Constant:** `const DEFAULT_RELIST_INTERVAL_MS = 60_000` (one authed GET per minute).

2. **Running-set state:**
   `interface RunningConnection { signature: string; stop: () => void }` and
   `connectionSignature(c)` = `${c.projectRef ?? ''}|${c.needsProjectSelection ? 1 : 0}`. Keyed by provider (CP is one grant per provider, INFRA-ADR-010), so provider is the map key, not part of the signature.

3. **Extract the per-connection body** (currently the inner block of the for-loop) into
   `startConnectionLoops(c, input): () => void`, moving it verbatim: credential source, the `HOSTED_CONNECTORS_FOR` fan-out, dispatch lookup/skip, the project-selection skip, `hostedOptions`, the `dispatch.build` try/catch, and the `startLoop` calls pushed into a local `stops`. Returns a combined stop. A connection that starts zero loops (for example `needsProjectSelection`) still returns a no-op stop and is still recorded, so its skip fires once, not on every re-list, and a later project pick registers as a signature change.

4. **Reconcile pass** `runHostedConnectorsPass(input, running)`:
   - `cpGet` the connections in try/catch; on failure `onSkip('(all)', ...)` and return, leaving the running map intact so a transient CP blip does not tear down working loops. Non-array guard returns too.
   - `const seen = new Set<string>()`; for each connection: add provider to `seen`, compute signature, then start-fresh if new, leave alone if signature matches, or stop-and-restart if the signature changed (re-picked project or flipped `needsProjectSelection`).
   - After the loop, stop and delete any provider in `running` but not in `seen` (removed connections).

5. **Rewrite `startHostedConnectors`** as the driver: a `running` map, `stopped`/`inPass` guards, and a `tick` that runs the reconcile pass. The boot pass is `await tick()` (not `void tick()`) — the one deliberate asymmetry from `hosted-repos.ts`, because the existing hosted tests assert the started set synchronously right after the call. Then `setInterval` on `intervalMs`, `unref` it, and return a stop that sets `stopped`, clears the interval, and stops every running connection. This also removes the old "return a no-op stop when the boot list is unreadable" path, so a CP that is down at boot now recovers on the next re-list instead of staying dead until restart.

6. **Thread `intervalMs` for tests:** add `intervalMs?: number` to `StartHostedConnectorsInput` and `MaybeStartHostedConnectorsInput`, forwarded in `maybeStartHostedConnectors`. `daemon.ts` passes nothing, so production keeps the 60s default.

### Tests (`packages/core/test/connectors-hosted.test.ts`)

Seams present: `cpFetch`/`jsonResponse`, a `startLoop` double recording `connector.provider` and returning a stop, `onSkip`. Multi-pass tests use fake timers; make the `startLoop` stop a `vi.fn()` so teardown is assertable.

- re-list picks up a newly-connected provider (list empty, then one connection).
- re-list stops loops for a removed connection (one connection, then empty).
- unchanged connection is left alone (same list twice: `startLoop` called once, stop never called).
- re-picked project restarts the connection (`needsProjectSelection: true`, then a `projectRef`; second pass fans out to firebase + cloud-run + gcp-lb).
- `stop()` tears everything down and halts the interval.
- boot failure recovers (503 then success; skips contain `(all)`, loops start after the next interval).

---

## Implementation order

Do #1215 first: one flag threaded through three functions plus a boolean return, low blast radius. Then #1217: the diff map and the pass/driver split.

## Shared refactor: keep them parallel, do not extract a helper

The two files intentionally mirror each other while taking no dependency on one another, and their loops differ in ways a shared helper would have to be parameterised over: the repo loop fires the boot pass with `void tick()` and threads a `firstPass` boolean; the connectors loop must `await` the boot pass (test contract) and threads a `Map` of running connections. A generic loop helper would save around ten lines of boilerplate at the cost of indirection over two different state shapes. Note it as a possible future cleanup, not part of this work.

## Edge cases

- **Overlapping passes:** guarded in both files (`running` in the repo loop, `inPass` in the connectors loop); a slow pass skips the next tick rather than piling up. Both timers `unref`.
- **Re-picked project:** handled by the signature change, which stops and restarts that provider's loops. Cost is a brief flap plus one extra credential fetch on the next tick. Re-picks are rare, so this is acceptable.
- **Repo fails on the first (sync-all) pass:** it reports `failed`; later passes revert to the `needsSync` rule and skip it until the CP re-queues, as intended. If the whole first list read fails, the `listRead` boolean keeps sync-all armed for the next tick.
- **Idempotency:** re-extracting a populated graph is safe (upsert plus ghost-retire), so boot sync-all cannot corrupt an already-populated graph.
- **Interaction with neat-infra#70 (graph durability):** #1215's boot sync-all assumes a fresh instance starts empty. If #70 makes the graph durable across restarts, the boot sync-all becomes redundant but still safe (a wasted clone and extract). Land this fix as-is now; the #70 follow-up is to gate the boot sync-all on "graph is empty" rather than always. #1217 is unaffected by #70.
- **Control-plane contract:** no change. #1215 reuses `GET /internal/projects/:id/repos` and the existing status POST. #1217 reuses `GET /internal/projects/:id/connections` and `.../connections/:provider/credential`, just called on a cadence. No new route, no new field.

## Files

- `packages/core/src/connectors/hosted-repos.ts` (#1215)
- `packages/core/src/connectors/hosted.ts` (#1217)
- `packages/core/test/hosted-repos.test.ts`
- `packages/core/test/connectors-hosted.test.ts`
- `packages/core/src/connectors/index.ts` (`startConnectorPollLoop`, the loop each connection drives — reference only)
