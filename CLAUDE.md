# CLAUDE.md

This is the agent guide for the NEAT repo. If you're a fresh Claude session (or a human picking this up cold), read this first.

**Binding rules:** @docs/contracts.md — short list, auto-loaded with this file. Per-topic contracts live under `docs/contracts/` and are surfaced automatically when you edit a file the contract governs (PreToolUse hook at `docs/contracts/_hook.sh`, wired in `.claude/settings.json`). If you're about to write code that conflicts with anything in there, stop. The conflict is the bug.

## What NEAT is

NEAT keeps a live semantic graph of a software system — code, infrastructure, runtime — and exposes it to AI agents over MCP. The core demo: a service running `pg` 7.4.0 against PostgreSQL 15 fails at runtime, and NEAT traces that failure back to the version mismatch two hops away through the graph. The extraction pipeline reads static code (tree-sitter) and live OTel traces to build and maintain that graph.

## What success looks like (read this first)

**MVP success = closing a real PR on an open-source codebase NEAT was not engineered for.** Not running the pg demo. The demo proves the stack works in a controlled environment we built to fail in a specific shape; the MVP earns its keep when NEAT finds a real bug in a real repo, where the OBSERVED layer was load-bearing — not just static analysis a Graphify fork could match.

ADR-027 records this reframe. The trace stitcher (γ #75 INFERRED edges bridging missing OTel coverage for pg 7.4.0) is evidence — not a workaround — that the gap between declared intent and observed reality is the load-bearing problem NEAT addresses. Policies (v0.2.1) are the formalisation of that gap.

## Where you are in the build

**v0.3.8 ships:** the one-command DX surface — `npx neat.is <path>` (orchestrator + Next.js installer + summary + gitignore automation), `neat deploy` for hosted targets, delegated auth at the daemon boundary, container images to `ghcr.io/neat-technologies/neat`. ADR-073 governs. v0.3.9 follows with `neat sync`, env-dimension at ingest, and the Remix / SvelteKit / Nuxt / Astro installer paths.

**v0.1.2 "Ubiquity" was the first tagged release.** https://github.com/NEAT-Technologies/Neat/releases/tag/v0.1.2. **v0.1.3** added a basic Cytoscape graph viewer on top. The MVP sprint (M0–M6) before all of that is also complete.

Sub-milestones in v0.1.2, all merged on `main`:

- **α** — schema cleanup + extract module split + OTLP/gRPC opt-in (#67/#68/#80)
- **β** — recursive discovery, generalised DB extraction, polyglot calls, Python services, infra-as-nodes (#69/#70/#71/#72/#73)
- **γ** — compat beyond drivers, FrontierNode + alias resolution, per-edge confidence, snapshot diffing, per-edge-type staleness (#74/#75/#76/#77/#78)
- **δ** — `neat watch`, MCP Resources, embedding `semantic_search`, multi-project (#79/#81/#82/#83)

A generic `Dockerfile` at the repo root builds the demo-free image. Mount your codebase at `/workspace`, optional volume at `/neat-out`, default CMD runs the REST + OTLP daemon. CMD overrides: `neat init /workspace --project <name>`, `neat watch /workspace`, `neat-mcp`. (`packages/core/Dockerfile` is the older demo-flavored variant for the local docker-compose stack.)

**Two parallel tracks now share `main`:**

- **Track 1 — v0.3.0 Frontend (Jed).** Builds against the stable v0.1.2 API. Doesn't gate the MVP success criterion; this track delivers investor-legibility. Issues #28-#31 + #106-#108.
- **Track 2 — v0.2.x Engineering (Cem + Kurt).** Seven milestones, sequential (v0.2.0 through v0.2.5 plus v0.2.8). Each opens with the contract batch governing its layer, then ships the rebuild + cleanup against the locked contract. Closed at v0.2.8 (2026-05-09); ADR-027 MVP-success-PR experiment is the next gate.

`docs/milestones.md` has the full verification gates and the "Pick up here" handoff. Always check it before starting any work — it's the source of truth for what's done and what's next.

## What's next on each track

### Track 2 — v0.2.x Engineering

**The v0.2.x sequence is rebuild-against-locked-contract.** Each minor version owns one layer: it opens with the contract batch that governs that layer (ADRs + per-topic markdown under `docs/contracts/` + regression tests), then the rebuild + cleanup against the locked contract. **Don't ship cleanup work against an unlocked contract** — that's what produced the v0.1.x drift the verification pass surfaced.

The full per-milestone breakdown lives in `docs/plans/2026-05-04-v0.2.x-sequencing.md`. Current state lives in `docs/plans/<date>-v0.2.0-status.md` (the most recent file in `docs/plans/`).

**v0.2.0 — Sunrise (data-layer foundation).** Closes when:
- Audit verification pass is shipped (`docs/audits/verification.md`) ✅
- AUDIT-DRIFT amendments are applied to audit text ✅
- Data-layer contracts are locked: ADR-028 (node identity), ADR-029 (edge identity + provenance), ADR-030 (lifecycle), ADR-031 (schema growth vs shape) ✅
- Contract framework is live: index, per-topic files, PreToolUse hook, regression tests, schema-snapshot guard ✅

The 15 cleanup issues (#131-#145) are open against this milestone today **but belong to later milestones** — see the status doc for the redistribution.

**v0.2.1 — Tree-sitter rebuild.** Opens with contract #5 (static extraction). Then ships #140 ghost-edge cleanup, #141 source-level DB/import detection, #142 framework field, #145 drop unused graphology deps.

**v0.2.2 — OTel ingest rebuild.** Opens with contracts #6-#8 (OTel ingest, trace stitcher, FrontierNode promotion). Then ships #131 non-blocking ingest, #132 span-time `lastObserved`, #133 parent-span cache, #134 auto-create services/DBs, #135 exception event parsing.

v0.2.2 closed on 2026-05-06 — see `docs/plans/2026-05-06-v0.2.2-close.md` for the closing snapshot. All ADR-033/034/035 contract assertions are live in `contracts.test.ts`. The eight implementation PRs (#155, #156, #157, #158, #159, #161, #163) landed in sequence; the contract amendment for non-blocking error-event durability landed alongside #163.

**v0.2.3 — Traversal rebuild.** Opens with contracts #9-#11 (traversal, getRootCause, getBlastRadius). Then ships #136 FRONTIER exclusion, #137 BlastRadius schema fields, #138 distance positive, #139 schema validation, #123 generalize getRootCause.

**v0.2.4 — Policies + MCP refresh.** Opens with contracts #12-#18 (MCP, REST, persistence, policy schema/eval/actions/tools). Then ships #115-#118 + #143 three-part response, #144 transitive `get_dependencies`.

**v0.2.5 — `neat init` + SDK install + Claude skill.** Opens with contracts #19-#22 (init, SDK install, machine registry, daemon). Then ships #119.

v0.2.5 closed on 2026-05-07 — see `docs/plans/2026-05-07-v0.2.5-close.md` for the closing snapshot. Six implementation PRs landed in sequence (#185 registry, #186 init mechanics, #187 Node installer, #188 Python installer, #189 daemon, #190 Claude Code skill). Contract scoreboard: 28 / 28 v0.2.5 assertions live in `contracts.test.ts` (25 ADR-046/047/048/049 + 3 Claude-skill packaging). The four remaining `it.todo`s are v0.2.1 cleanup (#141, #142, #145), rolled forward to v0.3.0 prep.

**v0.2.8 — CLI parity + frontend-API surface.** Opens with contracts #23-#24 (CLI surface, frontend-facing API). Ships CLI verbs that mirror the nine MCP tools (so a human at a terminal has the same reach as an agent), plus the SSE event stream + `/projects` switcher endpoint Jed's v0.3.0 frontend needs. Plus contracts #25 (publish system) and ADR-053 (milestone naming) which landed alongside.

v0.2.8 closed on 2026-05-09 — see `docs/plans/2026-05-09-v0.2.8-close.md` for the closing snapshot. Nine implementation PRs landed (#199 contracts batch, #200/#202/#203/#204 publish-system rebuild, #205 milestone rename, #206 API reference, #207 frontend-API SSE, #208 CLI surface). Contract scoreboard: 33 / 33 v0.2.8 assertions live (15 ADR-050 + 18 ADR-051) plus 7 / 7 ADR-052 publish-system assertions. Four remaining `it.todo`s are v0.2.1 cleanup (#140, #141, #142, #145), rolled forward to v0.3.0 prep.

This milestone was originally named v0.2.6 when its contract batch opened on 2026-05-08; rolled forward to v0.2.8 per ADR-053 after publish-fix releases consumed the 0.2.6 and 0.2.7 npm slots. ADR + contract numbers retain their originals.

After v0.2.8: the MVP-success PR experiment (ADR-027) — point NEAT at an open-source codebase. **This is the actual thesis test, not engineering work.** Track 2 engineering ends at v0.2.8 until either ADR-027 succeeds (and v0.3.x prep can begin from a position of validation) or fails (and the failure mode shapes the next iteration). Self-hosting on the NEAT codebase activates only after that PR closes.

### Track 1 — v0.3.0 Frontend (Jed)

`packages/web/` was a shell through v0.1.2 (ADR-004); v0.1.3 added a basic Cytoscape canvas; v0.3.0 fills the rest in. Builds against the stable v0.1.2 API.

Open issues on the v0.3.0 milestone:

- **#31** — Apply NEAT branding (recommended first — shapes visual decisions)
- **#28** — Graph explorer (richer than the v0.1.3 viewer)
- **#29** — Node inspector panel
- **#106** — Multi-project switcher
- **#107** — `semantic_search` bar
- **#30** — Incident log page
- **#108** — Live graph updates via SSE / WebSocket from `neat watch`

This track is independent of v0.2.x — Jed should not block on engineering work.

### Closing gate — the MVP-success PR

After v0.2.x lands: point NEAT at an open-source codebase, identify a real divergence-shaped bug (OBSERVED layer load-bearing, not static-only), propose a fix, get the PR merged. ADR-027 sets the bar.

The Railway gates from M6 are still informational. AWS is the more likely production target; `docs/railway.md` is one option, not canonical.

## Decisions already made

`docs/decisions.md` is the ADR log. `docs/adr/README.md` is the process — when to write one, the template, supersession, ratification. Read decisions.md before reopening any of these:

- pnpm → npm (ADR-007)
- `tree-sitter` native bindings, not `web-tree-sitter` (ADR-002)
- Dual ESM/CJS via `tsup` for every `@neat.is/*` package (ADR-003)
- No dashboard in this release — `packages/web/` is a shell (ADR-004)
- Branch-per-issue, manual issue close after verifying (ADR-005)
- ConfigNodes record file existence, not contents (ADR-016)
- `neat init` writes snapshot to `<path>/neat-out/graph.json` by default (ADR-017)
- Railway deployment is documented in `docs/railway.md`, not codified as IaC (ADR-018)
- `pgDriverVersion` removed from `ServiceNodeSchema`; snapshot v1→v2 migrates on load (ADR-019)
- OTLP `.proto` files bundled in-tree; gRPC receiver is opt-in (ADR-020)
- Python extraction reads source via `tree-sitter-python`; NEAT's runtime stays Node-only (ADR-021)
- `infra:<kind>:<name>` id format; one `InfraNode` type, free-string `kind` for sub-typing (ADR-022)
- `FrontierNode` is a fifth node type for unresolved span peers; promoted away once an alias matches (ADR-023)
- Per-edge-type stale thresholds + `stale-events.ndjson` transition log (ADR-024)
- `semantic_search` uses an Ollama → Transformers.js → substring fallback chain; flat in-memory cosine, sidecar `embeddings.json` cache (ADR-025)
- Multi-project lives behind `Map<string, NeatGraph>`; routes dual-mount at `/X` and `/projects/:project/X`; default project keeps the legacy filenames; OTel ingest stays single-project (ADR-026)
- MVP success is closing a real PR on an unfamiliar open-source codebase, not running the pg demo; OBSERVED layer must be load-bearing (ADR-027)
- Node ids come from `@neat.is/types/identity` helpers (`serviceId`, `databaseId`, `configId`, `infraId`, `frontierId`); hand-rolled template literals are a contract violation (ADR-028)
- Edge ids per provenance variant come from `@neat.is/types/identity` helpers (`extractedEdgeId`, `observedEdgeId`, `inferredEdgeId`, `frontierEdgeId`, `parseEdgeId`); `PROV_RANK` lives there too (ADR-029)
- Mutation authority on the graph is locked to `ingest.ts` and `extract/*`; OBSERVED↔STALE and FRONTIER→OBSERVED transitions are owned by `ingest.ts` (ADR-030)
- Schema additions in `@neat.is/types` are growth (snapshot diff is the audit trail); renames/removals/type-changes are shape changes (require ADR + `persist.ts` migration); enforced via `packages/core/test/audits/schema-snapshot.test.ts` (ADR-031)

## Conventions

- One issue → one branch named `<num>-<slug>` → one PR.
- PR body says `Refs #N`, **not** `Closes #N`. The user closes issues by hand after verifying.
- Commits and PRs read like a colleague wrote them. No "this commit introduces" or release-notes-y bullets. See ADR-008.
- Stack γ PRs on top of merged β work, not on each other. `main` rebase is the easier merge story.
- Every package emits ESM + CJS + DTS via tsup. Don't ship ESM-only.
- npm publishes go through CI on tag push (`.github/workflows/publish.yml`). Process + troubleshooting in [`docs/runbook-publish.md`](docs/runbook-publish.md). Local publishes via `bash scripts/publish.sh` are a fallback, not the default.

## Don't do

- Don't add dashboard work — `packages/web/` is a shell. Graph rendering, node inspector, incident log are post-MVP.
- Don't hardcode driver-specific logic outside `compat.json`. Everything in `compat.ts` reads from data.
- Don't introduce mocks in production paths. Tests can mock; runtime cannot.
- Don't add Python to the NEAT toolchain itself. Node 20.x, TypeScript only. (Python *extraction* — reading Python service code — is a v0.1.2 feature, but the extractor is still TypeScript.)
- Don't write snapshot file contents for `.env` files. ConfigNodes record existence only (ADR-016).

## Common commands

```bash
npm install                              # one-shot for the whole workspace
npx turbo build                          # build everything
npx turbo test                           # run vitest across packages
npx turbo lint                           # eslint
npm run build --workspace @neat.is/core     # one package
NEAT_SCAN_PATH=./demo \
  npm run dev --workspace @neat.is/core     # core dev server
node packages/core/dist/cli.cjs init ./demo   # neat init CLI
node packages/mcp/dist/index.cjs         # MCP stdio server (after build)
```
