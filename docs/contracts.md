# NEAT contracts

Binding rules. Auto-loaded into every Claude Code session via `@docs/contracts.md` in `CLAUDE.md`.

If you (Claude or human) are about to write code that conflicts with anything below, stop. The conflict is the bug. Either the rule is wrong (open an ADR superseding it) or the code is wrong. Don't quietly drift.

This file is the index. Each rule has a short summary and a link to its full per-topic contract under `docs/contracts/`. The PreToolUse hook at `docs/contracts/_hook.sh` automatically surfaces the relevant contract when you edit a file the contract governs — so the binding rules load at the moment of writing, not just on session start.

## Per-topic contracts

| # | Contract | File | Governs | Status |
|---|----------|------|---------|--------|
| 1 | Node identity | [`contracts/identity.md`](./contracts/identity.md) | Node ids constructed via `@neat.is/types/identity` helpers, never literals (ADR-028) | ✅ landed |
| 2 | Edge identity + provenance | [`contracts/provenance.md`](./contracts/provenance.md) | Edge id wire format per provenance, `PROV_RANK` ordering, coexistence, graded confidence per tier, five-value enum — four settled + FRONTIER as the staged-proposal tense, distinct from the FrontierNode node-type (ADR-029 + ADR-066 + ADR-068 + ADR-094) | ✅ landed (graded confidence v0.3.4; FrontierNode orthogonality v0.3.5; FRONTIER write semantics open with the kernel arc) |
| 3 | Node + edge lifecycle | [`contracts/lifecycle.md`](./contracts/lifecycle.md) | Creation, transition, retirement. Mutation authority locked to `ingest.ts` and `extract/*` (ADR-030) | ✅ landed |
| 4 | Schema growth vs shape | [`contracts/schema.md`](./contracts/schema.md) | Growth = commit-and-go (snapshot diff). Shape change = ADR + `persist.ts` migration (ADR-031) | ✅ landed |
| 5 | Static extraction | [`contracts/static-extraction.md`](./contracts/static-extraction.md) | Producer interface, evidence on every EXTRACTED edge, ghost-edge cleanup keyed on `evidence.file`, language dispatch, idempotency, five precision filters (test-scope / comment-body / JSX-link / .env.template / no-substring-matching), loud failure mode via errors.ndjson + banner + NEAT_STRICT_EXTRACTION (ADR-032 + ADR-065) | ✅ landed (v0.2.1 opens; precision + loud-failure amended v0.3.3) |
| 6 | OTel ingest | [`contracts/otel-ingest.md`](./contracts/otel-ingest.md) | Non-blocking receiver, span-time `lastObserved`, parent-span cache, exception-event parsing, auto-creation of unseen services/DBs (ADR-033) | ✅ landed (v0.2.2 opens) |
| 7 | Trace stitcher | [`contracts/trace-stitcher.md`](./contracts/trace-stitcher.md) | ERROR-only trigger, depth-2 limit, EXTRACTED-only walk, OBSERVED-twin-skip rule, default confidence 0.6 (ADR-034) | ✅ landed (v0.2.2 opens) |
| 8 | FrontierNode promotion | [`contracts/frontier-promotion.md`](./contracts/frontier-promotion.md) | Post-extract trigger, alias-match precedence, atomic per-node, FRONTIER→OBSERVED upgrade, canonical edge-id helpers required (ADR-035) | ✅ landed (v0.2.2 opens) |
| 9 | Traversal | [`contracts/traversal.md`](./contracts/traversal.md) | PROV_RANK at every hop, FRONTIER excluded entirely, multiplicative confidence cascading, no mutation, schema-validated results (ADR-036) | ✅ landed (v0.2.3 opens) |
| 10 | `getRootCause` | [`contracts/get-root-cause.md`](./contracts/get-root-cause.md) | Walks incoming edges to depth 5, dispatches by origin node type, human-readable reason, derived fix recommendation (ADR-037) | ✅ landed (v0.2.3 opens) |
| 11 | `getBlastRadius` | [`contracts/get-blast-radius.md`](./contracts/get-blast-radius.md) | BFS outbound default depth 10, distance positive, per-node path + cascaded confidence, schema-validated (ADR-038) | ✅ landed (v0.2.3 opens) |
| 12 | MCP tool surface | [`contracts/mcp-tools.md`](./contracts/mcp-tools.md) | Manifest-driven tool surface, three-part response, transitive `get_dependencies`, REST-only data path (ADR-039 + ADR-091) | ✅ landed (v0.2.4 opens) |
| 13 | REST API | [`contracts/rest-api.md`](./contracts/rest-api.md) | Dual-mount per ADR-026, locked endpoint set, JSON errors, Zod-validated bodies (ADR-040) | ✅ landed (v0.2.4 opens) |
| 14 | Persistence | [`contracts/persistence.md`](./contracts/persistence.md) | Snapshot at `<projectDir>/neat-out/graph.json`, `SCHEMA_VERSION` bumps on shape change only, append-only ndjson sidecars (ADR-041) | ✅ landed (v0.2.4 opens) |
| 15 | Policy schema | [`contracts/policy-schema.md`](./contracts/policy-schema.md) | `policy.json` at project root, version 1, five rule types (ADR-042) | ✅ landed (v0.2.4 opens) |
| 16 | Policy evaluation | [`contracts/policy-evaluation.md`](./contracts/policy-evaluation.md) | Pure `evaluateAllPolicies`, three triggers, per-type dispatch, deterministic violation ids (ADR-043) | ✅ landed (v0.2.4 opens) |
| 17 | Policy onViolation actions | [`contracts/policy-actions.md`](./contracts/policy-actions.md) | `log` / `alert` / `block`; severity-driven defaults; block applies to FrontierNode promotion gating only in MVP (ADR-044) | ✅ landed (v0.2.4 opens) |
| 18 | Policy tool surface | [`contracts/policy-tools.md`](./contracts/policy-tools.md) | Single `check_policies` tool, REST under `/policies`, resource at `neat://policies/violations` (ADR-045) | ✅ landed (v0.2.4 opens) |
| 19 | `neat init` | [`contracts/init.md`](./contracts/init.md) | One-time registration. Discovery before mutation. Patch-by-default; `--apply` opt-in. Lockfiles never touched (ADR-046) | ✅ landed (v0.2.5 opens) |
| 20 | SDK install | [`contracts/sdk-install.md`](./contracts/sdk-install.md) | Per-language installer modules (Node + Python in MVP). Plan/apply decoupled. Manifests touched, lockfiles never. Node apply phase writes generated `otel-init` + injects entry-point require/import + per-package `.env.neat` with `OTEL_SERVICE_NAME`. Entry detection: `pkg.main` → `bin` → `scripts.start/dev` → `src/…` (ADR-047 + ADR-069 + ADR-070) | ✅ landed (entry detection extends to src/ in v0.3.6) |
| 21 | Machine-level project registry | [`contracts/project-registry.md`](./contracts/project-registry.md) | `~/.neat/projects.json` per-user, atomic writes via tmp+rename, flock during writes, path-normalized (ADR-048) | ✅ landed (v0.2.5 opens) |
| 22 | Daemon | [`contracts/daemon.md`](./contracts/daemon.md) | Single long-lived process, per-project graph isolation, mtime + OTel + policy.json triggers, REST `:8080` + OTLP `:4318` binding within 30s of `startDaemon`, graceful per-project failure (ADR-049 + ADR-063) | ✅ landed (v0.2.5 opens; binding observability amended v0.3.1) |
| 23 | CLI surface | [`contracts/cli-surface.md`](./contracts/cli-surface.md) | Nine `neat <verb>` commands mirroring MCP tools, REST-only data path, `--json` output, exit-code branching (ADR-050) | ✅ landed (v0.2.8 opens) |
| 24 | Frontend-facing API | [`contracts/frontend-api.md`](./contracts/frontend-api.md) | SSE stream at `/events` with locked 8-type taxonomy, multi-project switcher at `/projects`, WebSocket and per-event filtering deferred (ADR-051) | ✅ landed (v0.2.8 opens) |
| 25 | Publish system | [`contracts/publish-system.md`](./contracts/publish-system.md) | Bin-wrapper subpath validity against dependency `exports`, version lockstep across six packages, tarball smoke-test gate with per-dep visibility wait + web-artifact presence + post-`neatd` liveness + fixture registry shape, dependency order, npm immutability acknowledged (ADR-052 + ADR-064) | ✅ landed (post-0.2.6 broken-publish; gate hardened post-0.3.0) |
| 26 | Web shell completeness | [`contracts/web-completeness.md`](./contracts/web-completeness.md) | No permanent stub UI; every interactive element wired or explicitly disabled; no duplicate components; audit doc is the canonical inventory (ADR-056) | ✅ landed (Track 1 frontend) |
| 27 | Web shell multi-project routing | [`contracts/web-multi-project.md`](./contracts/web-multi-project.md) | AppShell owns the per-daemon **profile** state; URL → localStorage → daemon-discovery resolution chain (amended under ADR-101, replacing the `/projects` step), null while unresolved and every data-fetching consumer gates on it (#461); URL/localStorage keys stay names that resolve to the matching reachable profile; profile change triggers data refresh; no hardcoded project names; AppShell mounts client-only via `dynamic({ ssr: false })` (ADR-057 + ADR-062 + ADR-101) | ✅ landed (Track 1 frontend; 'default' fallback removed 2026-06-07; profile re-key under ADR-101) |
| 28 | Web shell debugging surface | [`contracts/web-debugging.md`](./contracts/web-debugging.md) | StatusBar shows daemon + SSE connection state; no silent API failures; debug panel toggleable via Ctrl+Shift+D; read-only (ADR-058) | ✅ landed (Track 1 frontend) |
| 29 | Web UI bootstrap from neatd | [`contracts/web-bootstrap.md`](./contracts/web-bootstrap.md) | `neatd start` launches the web UI on port 6328 (T9 NEAT); `NEAT_WEB_PORT` overrides; fail-loud on collision; `@neat.is/web` joins the lockstep (ADR-059) | ✅ landed (Track 1 frontend) |
| 30 | Divergence query | [`contracts/divergence-query.md`](./contracts/divergence-query.md) | `get_divergences` as a first-class graph operation across REST + MCP + CLI; five divergence types; read-only; derived not persisted; OBSERVED-led weighting + graded EXTRACTED/OBSERVED confidence + precision floor at emit (ADR-060 + ADR-066) | ✅ landed (OBSERVED-led weighting amended v0.3.4) |
| 31 | Comms voice | [`contracts/comms-voice.md`](./contracts/comms-voice.md) | Forward-looking framing in repo artifacts; never name drift or past-tense self-correction in commits, PRs, ADRs, contracts, README, runbooks, release notes. Plan files and conversation are exempt. Hook surfaces at edit time; PR/commit/release-note flows rely on session-start context (ADR-027 + ADR-053) | ✅ landed (Refs #262) |
| 32 | One-command CLI + deployment + delegated auth | [`contracts/one-command-cli.md`](./contracts/one-command-cli.md) | Bare `neat <path>` orchestrator (discovery + extract + apply + daemon + browser + summary), `neat deploy` substrate-detection artifacts, `NEAT_AUTH_TOKEN` bearer on `/api/*` + `/events` with loopback-only refusal when unset, OTLP honors the same bearer with `NEAT_OTEL_TOKEN` rotation, `.env.neat` localhost default + OTel SDK env precedence in production, `neat-out/` appended to `.gitignore` automatically (ADR-073) | ✅ landed (v0.3.8 opens) |
| 33 | `neat sync` | [`contracts/sync.md`](./contracts/sync.md) | Third top-level verb; re-runs discovery + extract + SDK apply + daemon notify; skips registry register + browser open + first-run summary; daemon-down branch writes snapshot and exits soft-warning (code 2); flags mirror the orchestrator (ADR-074) | ✅ landed (v0.3.9 opens) |
| 34 | Env-dimension at ingest | [`contracts/env-dimension.md`](./contracts/env-dimension.md) | ServiceNode identity becomes `service:<env>:<name>`; `serviceId(name, env?)` defaults to `'unknown'`; `deployment.environment.name` parsing with span-attr → resource-attr → `'unknown'` fallback chain; snapshot migration v3 → v4 rewrites legacy ids idempotently; ServiceNodes carry a `framework:` field; FrontierNode / DatabaseNode / ConfigNode / InfraNode identity remain env-unscoped (ADR-074) | ✅ landed (v0.3.9 opens) |
| 35 | Framework installer paths | [`contracts/framework-installers.md`](./contracts/framework-installers.md) | JS installer extends Next.js dispatch to Remix / SvelteKit / Nuxt / Astro; detection precedence is Next → Remix → SvelteKit → Nuxt → Astro → vanilla Node; each branch records `framework:` on the install plan, skips package.json#main injection, writes its own runtime-hook surface; four-deps invariant + lockfiles-never rule hold for every branch; amends `sdk-install.md` (ADR-074) | ✅ landed (v0.3.9 opens) |
| 36 | OBSERVED e2e | [`contracts/observed-e2e.md`](./contracts/observed-e2e.md) | Brief is the canonical OBSERVED demonstrator; harness under `e2e/brief/` drives five journeys against Brief's API and asserts OBSERVED edges from `service:brief-api` materialize with non-zero `signal.spanCount` and a `lastObserved` inside the 60s freshness window; CI gated by `BRIEF_E2E_ENABLED` repo variable; pinned Brief SHA in `e2e/brief/.brief-sha` (ADR-075) | ✅ landed (v0.4.2 opens) |
| 37 | Instrumentation registry | [`contracts/instrumentation-registry.md`](./contracts/instrumentation-registry.md) | `@neat.is/instrumentation-registry` as a separately-versioned data package; flat-map + nested-versions schema (Option C); five-value coverage enum; range-matched loader as the only access path; offline maintainer-reviewed refresh; core pins it at ^1.0.0, outside the six-package lockstep (ADR-080 + ADR-086) | ✅ landed (v0.4.12 ships the package) |
| 38 | `/neat extend` skill | [`contracts/extend-skill.md`](./contracts/extend-skill.md) | Six MCP surgical tools (three diagnostic read-only, three operative); NEAT holds no LLM key, agent reasons; no standalone CLI; file-scope restricted; idempotent + reversible + observable; NEAT never auto-applies; explicit discovery — init/sync CLI hint + dashboard + `neat_list_uninstrumented`, all single-sourced from one registry-coverage classifier (ADR-081 + ADR-086 + ADR-080) | ✅ landed (v0.4.12) |
| 39 | Installer scope | [`contracts/installer-scope.md`](./contracts/installer-scope.md) | Bounded in-scope framework set (each with fixture + contract + CI smoke); active out-of-scope detection emits BYO-OTel escape hatch, never a broken hook; framework promotion is demand-and-test gated (ADR-082 + ADR-085) | ✅ landed (v0.4.12 ships detection + fixtures) |
| 40 | Package split | [`contracts/package-split.md`](./contracts/package-split.md) | Current batch splits the registry only; `@neat.is/core` stays unified; full core/instrumenter split deferred (#385) gated on a consumer needing substrate-without-installer; boundary held by directory + lint with acyclic dependency direction (ADR-083 + ADR-086 + ADR-080) | ✅ landed (registry split v0.4.12; full split deferred per #385) |
| 41 | LLM usage policy | [`contracts/llm-policy.md`](./contracts/llm-policy.md) | NEAT holds no LLM key and makes no LLM call on any user-facing or daemon path; two approved off-substrate use cases (offline maintainer-reviewed registry refresh; user's own agent over the extend tools); no LLM-authored code reaches a user repo without confirmation (ADR-084 + ADR-086) | ✅ landed (v0.4.12) |
| 42 | File-awareness | [`contracts/file-awareness.md`](./contracts/file-awareness.md) | File-first: `FileNode` is the primary node and relationships originate from files; a service is a root-dir grouping (`CONTAINS`) and the fallback where no call site exists — no service rollup, no service-level view. OBSERVED file from a call-site span processor (CLIENT/PRODUCER → `code.*` captured synchronously at span creation), EXTRACTED from the parse; synchronous stack capture, not profiling; evidence never fabricated; divergence compares at the shared grain; the service `CONTAINS`-grouping renders as a collapsible compound container, §3's hard lines reaffirmed at the rendering layer (ADR-087 + ADR-089 + ADR-100) | ✅ landed (model v0.4.7 → capture v0.4.11 → canvas v0.4.12; compound-container clause amended for the GUI redo) |
| 43 | Project daemon | [`contracts/project-daemon.md`](./contracts/project-daemon.md) | One daemon per project; each owns its graph/ports/OTLP/dashboard/MCP and self-describes in `neat-out/daemon.json`; ports allocated once and reused; project root carries one project (no dual-mount, no `default`); machine-wide running-list is append-only and lock-free; matches the hosted per-project shape (ADR-096) | 🟡 contract-only (daemon refactor) |
| 44 | Web shell IA | [`contracts/web-shell.md`](./contracts/web-shell.md) | Multi-page SaaS shell whose spine is the fused graph; sidebar page-nav, topbar per-daemon **profile** switcher (ADR-101: profiles discovered from `~/.neat/daemons/*.json` / the platform list, API base = the selected profile's `endpoint` at the daemon root, no `/projects/:name`, no `default`; status = `running\|stopped` liveness, reachability confirmed before auto-select) + ⌘K palette; canvas is one page among list/table views; divergence demoted to a peer query, blast-radius/dependencies/root-cause are node-scoped actions not pages; Policies violation view wires live, the enforcement layer renders as explicit `preview` per #26 until the governance kernel ships (ADR-097 + ADR-101) | 🟡 contract-only (GUI redo) |
| 45 | Live canvas layout | [`contracts/canvas-layout.md`](./contracts/canvas-layout.md) | Deterministic ELK `layered` for structure (load + explicit re-tidy only); incremental in-place for the SSE stream — pin existing positions, place only the new node near its neighbor, batch ~750ms, pulse-in, never auto-reflow; the two-mode observed-overlay (Mode A idle / Mode B didn't-engage with diagnosis + fix) framed as fusion/completion, incomplete → completing → complete; the overlay is escapable (always-visible close, backdrop-dismiss, per-project dismissal, capped height — never a full-canvas trap) and Mode B needs a real audit signal (`/api/instrumentation` `engaged?`), falling back to Mode A absent one (ADR-098 + ADR-101) | 🟡 contract-only (GUI redo) |
| 46 | Design system | [`contracts/design-system.md`](./contracts/design-system.md) | Adopt the vendored jedorini component system (shadcn/Base UI, DM Mono, hard corners `--radius: 0`, monochrome + the OBSERVED green `#5fcf9e`); `packages/web` migrates Tailwind v3→v4 (full-dashboard migration + visual-regression pass) and stays on `@base-ui/react` (`^1.6.0`, shared with the vendored jedorini source) with a 1.x compat pass; React 18 / Next 14 stay (ADR-099 + ADR-101) | 🟡 contract-only (GUI redo) |
| 47 | Client profiles | [`contracts/client-profiles.md`](./contracts/client-profiles.md) | One profile `{ endpoint, authToken? }` is how every client (GUI, CLI, MCP) reaches a daemon; talk to the daemon at its root (ADR-096); precedence explicit-profile → `NEAT_CORE_URL` → local `daemon.json` discovery → loopback; reads route to any endpoint including hosted, local mutations stay local; the profile source is the only local↔hosted swap point (ADR-102) | 🟡 contract-only (implementation deferred) |
| 48 | Hosted storage | [`contracts/hosted-storage.md`](./contracts/hosted-storage.md) | Hosted NEAT keeps the graph, embeddings, and bounded traversal in one Postgres — relational nodes/edges, a `pgvector` column for fuzzy retrieval, recursive CTEs for blast-radius/root-cause/dependencies/divergence at the local depth caps; vectors retrieve, never gate; no dedicated graph DB, search engine, or fork until CTE traversal strains; local (graphology + in-process embeddings) unchanged, the backend is the local↔hosted seam (ADR-103) | 🟡 contract-only (hosted arc) |
| 49 | Contract enforcement | [`contracts/contract-enforcement.md`](./contracts/contract-enforcement.md) | How contracts are enforced — four pillars matched to clause type (lint/CI · the breaker · the NEAT-on-NEAT policy overlay · review); every contract carries an `enforcement:` tag; new contracts ship with a tag + ≥1 active pillar or an explicit review-only; NEAT-on-NEAT (contracts as graph-pattern policies over the self-graph, gated by the kernel) is the destination (ADR-104) | 🟡 contract-only (lint assertion + backlog tagging) |
| 50 | Policy overlay | [`contracts/policy-overlay.md`](./contracts/policy-overlay.md) | L1 = constraints over the graph; a policy is a stored graph query in L2's vocabulary, typed by a schema, with a vector index for fuzzy reach; the graph gates (deterministic subgraph match), vectors only resolve bindings upstream and never enforce; retrieval two-mode (fuzzy recall + graph worst-case), graph-only at the gate; policies reach agents via blast-radius injection; local = graphology, hosted = pgvector + CTEs (ADR-105; frames ADR-093/094/095) | 🟡 contract-only (kernel arc) |
| 51 | Autonomous remediation | [`contracts/autonomous-remediation.md`](./contracts/autonomous-remediation.md) | The runner — propose→assess→gate→graduate on the kernel: stage a change as FRONTIER, check blast radius + the policy gate against `real ∪ delta`, block refuses / pass graduates / unconfirmed culls; the agent proposes, the deterministic gate decides; local ("run agents in your code") + hosted ("remediation by us"); adds no new enforcement primitive (ADR-106) | 🟡 contract-only (seam; mechanics open with the build) |
| 52 | Hosted platform | [`contracts/hosted-platform.md`](./contracts/hosted-platform.md) | The managed suite (Supabase-shape) — an outer layer wrapping the tenant-agnostic core; the only local↔hosted swap point is the profile source (platform list) + bearer; Postgres+pgvector storage; the remediation runner runs hosted as its execution venue; wraps, never forks (ADR-107) | 🟡 contract-only (seam; mechanics open with the build) |
| 53 | Policies soft guardrail | [`contracts/policies-soft-guardrail.md`](./contracts/policies-soft-guardrail.md) | The launch form of policies — context injection, not a gate: the reachable policies (blast-radius injection, ADR-105 §5) are surfaced into agent context via `check_policies` + a memory hook so the agent is aware; it informs, never blocks; the hard gate is the kernel (ADR-093), post-launch; authoring stays plain `policy.json`; graduates to the gate when the kernel lands (ADR-108) | 🟡 contract-only (launch MVP) |

### Future contracts — opened at the start of each milestone

The v0.3.x–v0.4.x run opened the contracts above #23: delegated auth and the one-command CLI (#32), `neat sync` (#33), the env dimension and framework installers (#34, #35), the OBSERVED e2e harness (#36), and the instrumentation-registry / `/neat extend` / installer-scope cluster (#37–#42). All have landed.

The GUI-redo arc opens three frontend contracts — the web shell IA (#44, ADR-097), the live canvas layout model (#45, ADR-098), and the jedorini design system (#46, ADR-099) — and amends file-awareness (#42) with the compound-container clause (ADR-100). ADR-101 then re-keys the shell to a per-daemon-profile model (supersedes ADR-096 §5): one GUI drives many daemons via profiles discovered from `~/.neat/daemons/*.json` (local) / the platform list (hosted), each served at the daemon root — so it amends the switcher in #44, the resolution chain in #27 (URL → localStorage → daemon discovery → null), and carries the Base UI version-bump correction into #46 and the overlay-escapability + Mode-resolution clauses into #45. They are contract-only today; the build lands behind them, foundation-first (design system → shell → canvas → sibling pages).

The governance kernel now carries its contracts: provenance-routed mutation gating (ADR-093, amending `policy-evaluation` #16 / `policy-actions` #17 / `lifecycle` #3), the FRONTIER staged-proposal provenance (ADR-094, amending `provenance` #2), and divergence-as-a-policy-bundle (ADR-095, amending `divergence-query` #30). The launch-sprint feature contracts open alongside it — the autonomous-remediation runner (#51, ADR-106), the hosted platform suite (#52, ADR-107), and policies-as-a-soft-guardrail (#53, ADR-108), the launch reading of "stays inside the lines." Time travel is deferred to "Soon" for launch (ADR-109 — a site-copy change, no build). The kernel and the runner/hosted contracts are contract-only; the build lands behind them, governed first. The Policies enforcement layer in the web shell (#44) graduates from `preview` to live behind the kernel gate when it lands. Successor frontend contracts (WebSocket transport, per-event filtering) and additional language SDK installers open as their gating work surfaces.

Per-milestone sequencing lives in the dated plan files under `docs/plans/`; the governance build ladder is in `docs/plans/2026-06-09-governance-kernel-build-ladder.md`.

## Cross-cutting rules (applied everywhere; not yet split out)

These still live inline pending split into per-topic files. Treat them as binding immediately.

### 1. Provenance is the load-bearing semantic contract

Every edge carries a `provenance` field from `@neat.is/types`. Valid values:

```
OBSERVED | INFERRED | EXTRACTED | STALE | FRONTIER
```

- **OBSERVED** — direct OTel span. Carries `lastObserved` (ISO8601) and `callCount`. `confidence: 1.0` (max-trust marker, not derived).
- **INFERRED** — trace stitcher output. Carries `confidence` ≤ 0.7. Never created from depth > 2 hops from the originating error span. Default confidence `0.6`.
- **EXTRACTED** — tree-sitter / config parsing. No timestamp. Does not decay on a clock. Carries `evidence: { file, line?, snippet? }`.
- **STALE** — transitioned from OBSERVED only. Never created directly. Preserves the original `lastObserved`. Confidence drops to ≤ 0.3.
- **FRONTIER** — the staged-proposal tense (ADR-094): a relationship a change intends to create but has not enacted. Written only by the kernel proposal path, excluded from settled traversal, gate-bound (graduate / refused / culled). Distinct from the *FrontierNode* node-type (an unresolved span peer, ADR-023/068) — same word, different axis. Detailed in [`provenance.md`](./contracts/provenance.md).

Raw provenance strings (`'OBSERVED'`, `'EXTRACTED'`, etc.) outside `@neat.is/types` are a contract violation. Use `Provenance.X` constants.

### 2. OBSERVED and EXTRACTED edges coexist by design

Same node pair, same edge type, different provenance — they live as **separate edges with distinct ids**, not as a single edge upgraded in place.

- EXTRACTED edge id: `${type}:${source}->${target}`
- OBSERVED edge id: `${type}:OBSERVED:${source}->${target}`
- INFERRED and FRONTIER edges follow the same provenance-prefixed pattern.

This is intentional. The gap between declared intent (EXTRACTED) and observed reality (OBSERVED) is the load-bearing fact NEAT exists to surface (ADR-027). Stomping one with the other erases the gap.

Traversal selects the highest-priority edge per node-pair via `PROV_RANK` (OBSERVED > INFERRED > EXTRACTED > STALE).

### 3. FRONTIER edges are not traversed

`getRootCause` and `getBlastRadius` must skip FRONTIER edges entirely — not deprioritize, not flag, **skip**. FRONTIER means unknown territory; traversal stays inside the known graph.

If a node's only edges in/out are FRONTIER, traversal stops at that node. Return `null` (root cause) or empty (blast radius) cleanly.

### 4. Per-edge-type staleness thresholds (ADR-024)

- `CALLS` → 1 hour
- `CONNECTS_TO` → 4 hours
- `DEPENDS_ON`, `CONFIGURED_BY`, `RUNS_ON` → 24 hours

Override via `NEAT_STALE_THRESHOLDS` env. Transitions appended to `stale-events.ndjson`. Background `setInterval` loop (default 60s tick), never read-time.

### 5. The graph is loaded from `@neat.is/types` schemas

All node and edge schemas live in `packages/types/src/`. Code in `packages/core/src/` and `packages/mcp/src/` must:

- Import types from `@neat.is/types`. No local `interface Service { ... }` redefinitions.
- Import `Provenance.X` and `EdgeType.X` constants. No raw string literals.
- For traversal results: validate against `RootCauseResultSchema` / `BlastRadiusResultSchema` before returning.

### 6. Live graphology, not graph.json

`GET /graph` and all MCP tools must read the **live** in-memory graphology instance. Never read `graph.json` at request time. The snapshot on disk is loaded once at startup (`server.ts`, `watch.ts`) and persisted on shutdown / interval. Nothing else reads it.

### 7. Multi-project isolation (ADR-026)

`Map<string, NeatGraph>` keyed by project name. Default project keeps legacy filenames; named projects scope to `~/.neat/projects/<name>/`. REST routes dual-mount at `/X` and `/projects/:project/X`. OTel ingest stays single-project for now.

### 8. No demo-name hardcoding

`service-a`, `service-b`, `payments-db`, `pg`, `postgresql` must not appear as literal strings in branching logic anywhere in `packages/core/src/` or `packages/mcp/src/`. Allowed only in:

- Zod `.describe()` example strings (documentation hints to LLMs).
- Test fixtures.
- `compat.json` (the data file driving compatibility checks).

Driver and engine names are read from node properties. Compat checks iterate `compatPairs()`.

### 9. PR body says `Refs #N`, not `Closes #N`

Issues are closed by the user manually after verifying. Branches are `<num>-<slug>`. One issue → one branch → one PR. See ADR-005.

### 10. Commits and PRs read like a colleague wrote them

No "this commit introduces" or release-notes-y bullets. Plain English. See ADR-008.

### 11. Don't add features beyond the task

Bug fixes don't need surrounding cleanup. One-shot operations don't need helpers. Three similar lines is better than a premature abstraction. No half-finished implementations.

### 12. Don't introduce mocks in production paths

Tests can mock. Runtime cannot. `compat.ts` reads `compat.json`; never inline a mock matrix.

### 13. ConfigNodes record file existence, not contents (ADR-016)

`.env` files in particular: never write file contents into the snapshot. ConfigNode records `{ name, path, fileType }` only.

### 14. Node 20.x, TypeScript only, in NEAT's own toolchain

Python *extraction* (reading Python service code) is supported via `tree-sitter-python`. NEAT's runtime stays Node-only. Don't add Python (or Rust, or Go) to the toolchain. Rust v1.0 is the next-language move and is its own milestone.

## 16. Node ids come from `@neat.is/types/identity` helpers, never literals (ADR-028)

Every node id in NEAT is constructed via the helpers in `packages/types/src/identity.ts`:

```ts
import { serviceId, databaseId, configId, infraId, frontierId } from '@neat.is/types'

serviceId('checkout')       // 'service:checkout'
databaseId('db.example.com') // 'database:db.example.com'
configId('apps/web/.env')   // 'config:apps/web/.env'
infraId('redis', 'cache.internal')  // 'infra:redis:cache.internal'
frontierId('payments-api:8080')     // 'frontier:payments-api:8080'
```

Hand-rolled template literals like `\`service:${name}\`` are a contract violation. The id wire format lives in exactly one file. Anywhere else that constructs a node id by string concatenation is a bug.

Rationale (ADR-028): if two producers disagree on what id a node gets, OBSERVED edges from one never match EXTRACTED edges from the other and the coexistence contract (Rule 2) silently fails. Twelve hand-rolled id sites across nine files have been kept consistent by good behavior; the contract makes that consistency mechanical.

---

## When this file is wrong

If you read a rule here that contradicts a ratified ADR or the reality of `main`, the file is stale. Open an ADR, update the rule, link the ADR. Don't ignore it silently — the next session will read the stale version.

If you write code that violates a rule and you believe the rule should change, **say so explicitly in the PR description** and propose the ADR change. Don't merge a quiet violation.

---

## How the contract loading works

Three layers, increasing in precision:

1. **Session start** — CLAUDE.md auto-loads this index file. You see the rule list before any tool call.
2. **On-read + pre-edit** — when you call `Read`, `Edit`, `Write`, or `MultiEdit`, the PreToolUse hook at `docs/contracts/_hook.sh` reads the target file path and finds every contract in `docs/contracts/*.md` whose `governs:` frontmatter matches. On `Read` it surfaces a concise pointer (contract name + one-line + path), so you know the file is governed while you're understanding it; on an edit it surfaces the full contract bodies as binding context for that write.
3. **CI** — `packages/core/test/audits/contracts.test.ts` encodes contract rules as test assertions. Any code that violates a rule fails the test on every PR.

Three points of contact, three different precision levels. The index is broad and always loaded. The hook is narrow and edit-scoped. The tests are mechanical and PR-gated.
