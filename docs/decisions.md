# NEAT — Architecture Decision Records

The durable record of the decisions behind NEAT. Per-topic contract files under `docs/contracts/` are the binding, enforced rules; this file is the fuller rationale behind them, for contributors who want the reasoning before touching a governed file.

Forward-looking framing applies (comms-voice contract).

---

## ADR-076 — OTLP routing via project-scoped URLs

**Status:** Accepted. Lands in v0.4.4.
**Contract:** `docs/contracts/otlp-routing.md`

### Context

The v0.4.x OTLP receiver dispatches spans to projects via a `service.name` heuristic that ADR-072 token-aware-matches against project basenames. The shape works for flat repositories where the project name and the single service name coincide. Multi-service monorepos and nested-app shapes ask routing decisions of `service.name` that the OTel data model does not promise — `service.name` describes the emitter, not the routing target.

### Decision

OTLP ingest gains a two-step routing model:

1. **URL identifies the project.** The receiver mounts `/projects/:project/v1/traces`. The `:project` path segment carries the routing decision explicitly.
2. **`service.name` identifies the ServiceNode.** Inside the URL-resolved project's graph, the span attaches to `service:<resource.service.name>`. Missing ServiceNodes auto-create per ADR-033.

The legacy `/v1/traces` route remains available for backwards-compatibility with v0.4.x deployments; first invocation per service.name logs a deprecation pointing operators at the project-scoped URL. Slated for retirement in v0.6.0.

`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is what generated templates write (not the base `OTEL_EXPORTER_OTLP_ENDPOINT`), so the trace exporter uses the project-scoped URL verbatim per OTel spec.

### Consequences

- Multi-service monorepos see every span attribute to the right ServiceNode within their project.
- Single-tenant hosted SaaS deployments inherit a clean per-tenant URL pattern matching Datadog / Honeycomb / Sentry conventions.
- The ADR-072 token-aware match becomes archival once the legacy route retires.
- Snapshots from v0.4.x containing project-name placeholder ServiceNodes age out via STALE per ADR-024; no schema migration needed.

---

## ADR-077 — Installer classification: hook-file detection, runtime-kind dispatch, lib-only-first ordering

**Status:** Accepted. Lands in v0.4.4.
**Contract:** Amends `docs/contracts/sdk-install.md` and `docs/contracts/framework-installers.md`.

### Context

The Node installer classifies each detected package into one of `instrumented`, `already-instrumented`, `lib-only`, plus the framework-specific buckets from ADR-074 (Next, Remix, SvelteKit, Nuxt, Astro, vanilla Node). The classification pipeline runs framework detection → runtime-kind inference → outcome.

Two refinements land in v0.4.4:

- The "already-instrumented" detection signal becomes the actual presence of an instrumentation hook file at the framework-expected path. Dependency presence in `package.json` is a side-effect, not the source of truth.
- Runtime-kind detection (Node / browser-bundle / React Native) runs as an explicit dispatch step. Packages whose runtime cannot execute a Node OTel SDK bucket as `browser-bundle` or `react-native`; no Node hooks land in those packages.
- Library classification (`lib-only`) runs first in the pipeline. A package with no resolvable runtime entry classifies as a library regardless of whether it carries a Vite config (common for UI-library bundles) or expo deps (documentation conventions).

### Decision

The installer's classification pipeline:

1. **Lib-only check** — no resolvable entry point → `lib-only`, halt
2. **Framework detection** — Next / Remix / SvelteKit / Nuxt / Astro / vanilla Node
3. **Runtime-kind detection** — Node / browser-bundle (Vite without server framework) / react-native (Expo or RN deps)
4. **Hook-file detection** — does the framework-expected hook file already exist?
5. **Outcome** — `instrumented` (write the hook) / `already-instrumented` (hook exists) / `browser-bundle` / `react-native` / `lib-only`

Browser-bundle and react-native packages bucket as their own outcome with no file writes. The orchestrator summary names every skipped package and the reason.

### Consequences

- Existing OTel deps from prior NEAT runs (or hand-added by users) no longer prevent the installer from emitting a missing hook file.
- Browser-only and React Native packages stay untouched; users see a clear log line naming the skip and the rationale.
- Library packages (no runtime entry) stay untouched even when they carry Vite config or RN-adjacent deps.
- Browser-OTel SDK support (separate from Node OTel) becomes a future feature, not a silent breakage.

---

## ADR-078 — Template architecture: inline env vars, explicit SDK construction

**Status:** Accepted. Lands in v0.4.4.
**Contract:** Amends `docs/contracts/sdk-install.md`.

### Context

The v0.4.x generated templates (`otel-init.cjs` for plain Node, `instrumentation.node.ts` for Next.js) carry two design choices that scope-narrow under modern bundlers and instrumentation needs:

- **Filesystem lookup for env values.** The templates load `.env.neat` via dotenv at runtime, anchored to `__dirname` (CJS) or `import.meta.url` (ESM). Modern bundlers (Turbopack, Vite, Webpack, esbuild) rewrite both anchors to bundler-output paths that no longer sit adjacent to `.env.neat`.
- **Magic `auto-instrumentations-node/register` shorthand.** The shorthand auto-registers the bundled instrumentations but offers no surface for adding non-bundled instrumentations (Prisma, OpenAI, etc.) in the same template.

### Decision

Templates inline OTel env vars via `process.env.X ||=` defaults and construct the SDK explicitly with an instrumentations array. Plain-Node template shape:

```js
process.env.OTEL_SERVICE_NAME ||= '__SERVICE_NAME__'
process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||= 'http://localhost:4318/projects/__PROJECT__/v1/traces'

const { NodeSDK } = require('@opentelemetry/sdk-node')
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node')

new NodeSDK({
  instrumentations: [getNodeAutoInstrumentations()],
}).start()
```

The Next.js variants follow the same shape inside `instrumentation.node.{ts,js}`. `OTEL_SERVICE_NAME` carries the ServiceNode id; `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` carries the project-scoped URL per ADR-076. Both are placeholder-substituted at apply time.

Non-bundled instrumentations (Prisma via `@prisma/instrumentation`, OpenAI via `@traceloop/instrumentation-openai`, etc.) compose into the `instrumentations: [...]` array. The `/neat extend` skill (ADR-081) is the canonical surface for adding them.

`dotenv` drops from the installer's added-deps list. The generated code no longer needs it.

### Consequences

- Templates survive every common JS bundler.
- Operator overrides via deploy-platform env vars work seamlessly (the `||=` idiom yields to a pre-set env value).
- Adding non-bundled instrumentations becomes a structural composition into the SDK construction, not a separate parallel file.
- `.env.neat` remains emitted as documentation but stops being runtime-load-bearing.

---

## ADR-079 — Orchestrator scoping: sibling auto-pause + port-collision probe

**Status:** Accepted. Lands in v0.4.4.
**Contract:** Amends `docs/contracts/daemon.md` and `docs/contracts/one-command-cli.md`.

### Context

The orchestrator and daemon together hold two assumptions whose first-touch implications surface as the registered project set grows:

- The daemon's project registry defaults every newly-touched or previously-touched project to `status: active`. `bootProject` walks every active entry on daemon start.
- The orchestrator's daemon-spawn step assumes the dashboard, REST, and OTLP ports are free.

Both assumptions hold cleanly on a fresh machine. Both meet friction when a developer's NEAT registry accumulates projects across sessions.

### Decision

Two orchestrator-side refinements:

1. **Auto-pause siblings on activation.** When the orchestrator activates a project (via `neat <path>` or `npx neat.is <path>`), every other `active` project in the registry transitions to `paused`. `broken` projects are not touched. Operators who want concurrent multi-project activation use the existing `neat resume <name>` verb explicitly.
2. **Port-availability probe before daemon spawn.** The orchestrator probes `:8080`, `:4318`, and `:6328` for availability before spawning `neatd`. On collision, the orchestrator emits a clear message naming the held port plus the recovery commands (`neatd stop`, `lsof -i :<port>`), and exits non-zero. No silent process leak; no opaque exit-1.

### Consequences

- Cold-boot cost scales with the active project surface (typically 1) rather than the total registered set.
- A broken sibling project no longer pollutes the orchestrator's first-touch experience.
- Operators running multiple terminals against the same machine see clear collision messages instead of stuck daemons.
- The deeper "paused = truly dormant" semantics ship in v0.5 per #365 (lazy activation). This ADR scopes the v0.4.4 cheap-fix.

---

## ADR-080 — Instrumentation registry as separately-versioned data product

**Status:** Accepted. Lands in v0.5.0.
**Contract:** `docs/contracts/instrumentation-registry.md`.

### Context

OTel's `@opentelemetry/auto-instrumentations-node` bundle covers ~30 libraries by curation. The long tail of useful instrumentation (Prisma, OpenAI, Stripe, Anthropic, LangChain, Drizzle, BetterAuth, BullMQ, and growing weekly) lives outside the bundle in first-party (`@prisma/instrumentation`) or community packages (`@traceloop/instrumentation-*`, `openinference-instrumentation-*`, `@opentelemetry/instrumentation-bullmq`). NEAT covers the bundle deterministically; the long tail asks a different shape of question — "for library X version Y, what's the current canonical instrumentation?" — that changes with the ecosystem.

### Decision

NEAT ships a curated instrumentation registry as a separately-versioned npm package: `@neat.is/instrumentation-registry`. Per-library entries describe coverage status (`bundled` / `first-party` / `third-party` / `http-only` / `gap`), the instrumentation package + version range, the registration pattern, and notes. The installer consumes the registry at init time to drive the gap-warning and the `/neat extend` skill's deterministic path.

The registry refreshes monthly via an offline batch job (ADR-084's use case 2) — LLM-curated, maintainer-reviewed, never auto-merged. Distribution via npm preserves the loopback-only privacy posture of `neat init`; no network calls during user installs.

### Consequences

- Library coverage grows on a weekly-to-monthly cadence independent of NEAT releases.
- New popular libraries (a new ORM, a new LLM SDK family) appear in the registry without bumping `neat.is`.
- The registry's value compounds: every refresh adds entries; the deterministic path widens.
- NEAT does not ship `@neat.is/instrumentation-X` packages. Genuine gaps surface as candidates for contribution to `opentelemetry-js-contrib`.

---

## ADR-081 — `/neat extend` agent skill for long-tail instrumentation

**Status:** Accepted. Lands in v0.5.0.
**Contract:** `docs/contracts/extend-skill.md`.

### Context

The instrumentation registry (ADR-080) provides deterministic coverage for known libraries. Two cases remain:

- Registered libraries that need installation + registration (the registry knows the answer; the installer wires it)
- Novel libraries the registry hasn't seen yet (the registry doesn't know; some agent has to reason about it)

The deterministic case wants automation. The novel case wants reasoning with maintainer-grade quality assurance.

### Decision

`/neat extend` becomes an MCP agent skill that:

1. Consults the registry first for every library detected
2. For registered libraries, generates the deterministic edit to the existing instrumentation file (adding the package to deps, composing the registration into the SDK array per ADR-078)
3. For novel libraries, queries the host LLM for a proposed instrumentation, presents the proposal + diff to the user for explicit confirmation, and writes only on accept
4. Verifies the resulting file syntactically and rolls back on failure

The skill lives inside `neat-mcp`. A standalone CLI fallback (`npx @neat.is/instrument <library>`) exposes the same logic for users without an MCP-capable agent; the LLM-reasoning path requires `NEAT_LLM_API_KEY` (operator-supplied).

### Consequences

- The long tail of OTel instrumentation graduates from "users debug it themselves" to "users invoke a skill that knows the registry."
- Determinism is preserved for known libraries; LLM non-determinism stays confined to the novel-library path with user consent.
- NEAT's MCP surface gains a load-bearing differentiator competitors structurally can't ship without rebuilding their installer model.

---

## ADR-082 — Installer scope narrowing + bring-your-own-OTel escape hatch

**Status:** Accepted. Lands in v0.5.0.
**Contract:** `docs/contracts/installer-scope.md`.

### Context

The OTel ecosystem's configuration space is combinatorial: ~20 bundled libraries × hundreds of long-tail libraries × ~10 runtimes × ~7 bundlers × ~15 frameworks × ~10 deployment platforms × async patterns × semconv versions. Even with the registry from ADR-080, NEAT's installer cannot deterministically cover every combination. The receiver-side substrate is bounded; the installer-side substrate is not.

### Decision

The installer's scope is explicit and bounded:

- **In-scope:** vanilla Node (Express, Fastify, Koa, raw HTTP), Next.js (all Router + bundler + layout variants), Remix, SvelteKit, Nuxt, Astro, Python (Flask, FastAPI, Django). Each in-scope target carries a baseline fixture, contract assertions, and the `/neat extend` skill recognizing the framework's hook file.
- **Out-of-scope:** Bun runtime, Deno, Cloudflare Workers, AWS Lambda layers (ADOT), Vercel Edge Functions, React Native / Expo, Electron. For each out-of-scope target, README + runbook documents the manual OTel setup pointing at NEAT's project-scoped URL.

On detecting an out-of-scope shape, the orchestrator emits a clear message naming the runtime and the manual setup path. The receiver works regardless of how spans got there.

Graduation from out-of-scope to in-scope requires (a) demand signal — 10+ users or top-20 npm framework rank, (b) stability — recommended OTel pattern stable across two minor versions, (c) test coverage — fixture + contract assertions + CI smoke landing alongside.

### Consequences

- The installer's bug surface stays bounded by the in-scope set.
- The receiver's value proposition holds for every codebase shape, including out-of-scope.
- "NEAT receives OpenTelemetry from your runtime" becomes a substrate-level claim independent of which installer NEAT shipped for that target.
- Framework support grows through demand-validated, test-gated promotion, not speculative breadth.

---

## ADR-083 — Package split: `@neat.is/core` (substrate) vs `@neat.is/instrumenter` (installer)

**Status:** Accepted. Lands in v0.5.0.
**Contract:** `docs/contracts/package-split.md`.

### Context

The substrate (receiver + graph + REST + MCP) and the installer (orchestrator + framework templates + registry consumer) change at different rates. Substrate is bounded and slow-changing; installer is broad and fast-iterating with the OTel ecosystem. The current `@neat.is/core` bundles both concerns into one release cadence.

### Decision

v0.5.0 separates the two concerns into two packages:

- **`@neat.is/core`** — OTLP receiver, graph engine, REST API, MCP tool surface, daemon lifecycle
- **`@neat.is/instrumenter`** — orchestrator, init / deploy / sync / extend verbs, framework detection, template emission, registry consumer

The `neat.is` umbrella depends on both at compatible ranges and ships the unified CLI experience. Direct dependents on `@neat.is/core` v0.4.x receive a deprecation pointing at the split in v0.5.0; v0.6.0 retires the deprecated installer surface from `@neat.is/core`.

The dependency direction is acyclic: `instrumenter → core's public types + CLI/HTTP surface`. No internal-module imports cross the boundary.

### Consequences

- Substrate releases ship on receiver-change cadence (slower, more rigorous).
- Installer releases ship on framework-ecosystem cadence (faster, fixture-tested).
- The hosted-SaaS tier ships `@neat.is/core` alone server-side; installers don't run in the hosted environment.
- Users who self-instrument adopt NEAT by installing `@neat.is/core` without inheriting installer opinions.

---

## ADR-084 — LLM usage policy: validator + offline curator, not author

**Status:** Accepted. Lands in v0.5.0.
**Contract:** `docs/contracts/llm-policy.md`.

### Context

The OTel installer surface is enumeration-heavy and the configuration space is unbounded (ADR-082). LLMs reason effectively over unbounded spaces. The temptation is to call an LLM at `neat init` time to generate per-project installer output. The countervailing concerns are determinism (two `neat init` runs must produce identical output), latency (LLM round-trips break the one-command sub-minute pitch), cost (every install hitting an API has a business model implication), privacy (user source code reaching third-party APIs), and debuggability (heuristic bugs are traceable; LLM hallucinations are not). Adjacent products (PostHog, Sentry, Datadog, Honeycomb, Graphify) all keep installers heuristic and route LLMs to analysis or in-product surfaces.

### Decision

LLMs operate in NEAT under three approved use cases, never as the primary author of code shipped to user repositories:

1. **Post-hoc installer validation.** After `neat init` writes templates, an optional LLM call reads the written files + project framework config and verifies template correctness. Advisory output only; the validation step is opt-out via `NEAT_DISABLE_INSTALL_VALIDATION=true` and never gates the install.
2. **Offline registry refresh.** The monthly batch job that updates `@neat.is/instrumentation-registry` queries an LLM with library + version metadata; maintainer reviews and accepts each proposed entry before publish.
3. **`/neat extend` skill's novel-library fallback.** Invoked inside the user's already-trusted agent session; LLM proposals are always shown to the user for confirmation before any file is written.

LLMs are never used at user-facing `neat init` time as a code generator, never on the daemon hot path (ingest, attribution, traversal, divergence), and never on user application code (only on configuration files and the just-written templates).

### Consequences

- The substrate stays deterministic, fast, privacy-clean, and reproducible.
- The long-tail instrumentation problem gains an LLM-assisted lever where the tradeoffs are positive (offline batch with human review) or appropriately consented (extend skill inside an already-trusted session).
- NEAT's product position as "architecture for AI agents" stays consistent: agents query NEAT, NEAT does not depend on agents to author its own substrate.

---

## ADR-085 — OTel substrate as dominant engineering surface

**Status:** Accepted. Process orientation.
**Contract:** Cross-cutting; no single per-topic file. Referenced by `docs/contracts/installer-scope.md` and `docs/contracts/package-split.md`.

### Context

Across NEAT's v0.4.x validation cycle, the bug load distributes asymmetrically across the codebase's layers. Two bugs surfaced in static extraction (tree-sitter walker behavior). Eleven bugs surfaced in OTel-adjacent layers: ingest routing, attribution, installer templates, framework detection, runtime-kind dispatch. The OTel substrate's bug surface dominates by a factor of ~5:1.

The asymmetry is structural, not transient. Static analysis operates on bounded input (the filesystem); OTel operates on unbounded input (every framework × every bundler × every runtime × every library combination the user picks). Each new codebase shape exercises a different point in the OTel matrix; each surfaces new edge cases.

### Decision

NEAT's engineering attention concentrates on the OTel substrate. Specifically:

1. **The receiver + attribution layer** is the durable engineering surface. New features (project-scoped routing per ADR-076, multi-service attribution, env-dimension per ADR-074) compound here.
2. **The installer surface** is bounded explicitly (ADR-082) and supplemented by the `/neat extend` skill (ADR-081). Coverage grows by validated promotion, not speculative breadth.
3. **The integration test corpus is the regression boundary.** Every supported codebase shape — Brief, northsea, the in-scope fixtures — runs in CI on every release. Static extraction's regression surface is unit-test-sized; OTel's regression surface is fixture-test-sized.
4. **Static extraction operates in steady-state.** Cosmetic improvements (noise reduction, venv walk-skipping per #344) ship via cleanup batches; no major architectural work is planned for the static layer in v0.5–v0.6.

### Consequences

- Engineering capital compounds on the OTel substrate, where every fix widens the substrate's correctness on a real codebase shape.
- Library-specific instrumentation work routes through the registry (ADR-080) and the extend skill (ADR-081), not into the substrate.
- The launch narrative aligns with where the work goes: "NEAT receives OpenTelemetry from your services and builds a live architecture model your AI agents can query." Static extraction enriches; OTel carries the load.
- v0.6+ planning anchors on OTel substrate features (new attribution shapes, semconv evolution, multi-environment graphing) rather than installer-breadth expansion.

---

## ADR-086 — Agent-driven extension: NEAT exposes surgical tools, the agent reasons

**Status:** Accepted. Supersedes the standalone-CLI and operator-LLM-key portions of ADR-081; supersedes use case 1 of ADR-084; sets ADR-083's full split to deferred. Lands across v0.4.7–v0.4.9.
**Contracts:** `docs/contracts/extend-skill.md`, `docs/contracts/llm-policy.md`, `docs/contracts/package-split.md`.

### Context

ADR-081 scoped `/neat extend` with a standalone CLI fallback and an operator-supplied `NEAT_LLM_API_KEY` for the novel-library path. ADR-084 scoped a post-hoc LLM validator running inside NEAT at init time. ADR-083 scoped the full `core` / `instrumenter` package split for v0.5.0. Working through the v0.5 surface clarified that NEAT's position is cleaner when intelligence lives entirely at the agent layer and packaging changes only where a structural reason demands it.

### Decision

1. **NEAT holds no LLM API key.** The user's MCP-capable agent (Claude Code / Codex / Cursor / Windsurf) supplies all reasoning. NEAT exposes data + scoped write primitives; the agent's own model decides what to invoke. There is no `NEAT_LLM_API_KEY` and no LLM call originating from NEAT during install or extend.

2. **`/neat extend` is a set of MCP surgical tools, not a CLI.** Three diagnostic (read-only) tools — `neat_list_uninstrumented`, `neat_lookup_instrumentation`, `neat_describe_project_instrumentation` — and three operative tools — `neat_apply_extension`, `neat_dry_run_extension`, `neat_rollback_extension`. Each is bounded, idempotent, reversible, file-scope-restricted, and observable. NEAT never auto-applies; every operative call is an explicit agent invocation. No standalone CLI variant — users without an MCP agent get the deterministic `npx neat.is` install; extension requires an agent.

3. **The internal post-hoc validator is dropped.** ADR-084 use case 1 is subsumed: the agent does the validation a built-in validator would have done, by reading `neat_describe_project_instrumentation` after an apply. The two remaining approved LLM use cases stand — offline registry refresh (maintainer-reviewed) and the agent's own reasoning over the tools.

4. **The full package split is deferred (#385).** Only `@neat.is/instrumentation-registry` splits out (ADR-080) because independent versioning is its structurally-unique benefit. `@neat.is/core` stays unified; a monorepo directory boundary plus lint rules carry the substrate/installer separation until a concrete consumer needs core without the installer.

5. **Discovery is explicit and single-sourced.** Extension is surfaced, never guessed. The orchestrator classifies every detected dependency against the registry at init/sync time and emits a closing hint naming the libraries that need more than the bundle or the HTTP fallback — distinguishing a registry hit (deterministic; run the skill) from a registry miss (the agent reasons). The dashboard renders the same set as a coverage view, and `neat_list_uninstrumented` returns it to the agent. All three derive from one registry-coverage classifier, so they never disagree. This is distinct from out-of-scope runtime detection (ADR-082), which fires on the runtime; this fires on libraries within an in-scope runtime.

### Consequences

- NEAT's privacy posture is absolute on the substrate: no user code or config reaches any LLM through NEAT itself.
- The user always knows when extension is needed and whether it's deterministic or agent-reasoned, so the long-tail path is discoverable on contact rather than buried in documentation.
- The differentiator becomes the MCP tool surface, not an embedded model. Competitors can't ship it without rebuilding their installer as an agent-operable surface.
- The corrected position is consistent end to end: agents query NEAT; NEAT does not depend on agents to author its substrate, and does not embed an agent to author user code.

---

## ADR-087 — File-native at the instrumentation source, then topology

**Status:** Accepted. Lands across v0.4.7 (source) → v0.4.8 (model + dashboard).
**Contract:** `docs/contracts/file-awareness.md`.

### Context

The graph is service-based: nodes are services/databases/configs/infra, edges connect services, traversal results carry node IDs, and the dashboard renders services. For an AI agent consuming NEAT, a service-level answer to "what's the root cause" still makes the agent reason about *where in the code* the relationship originates. File-level granularity removes that reasoning step.

The file-grained data must exist at the source on both layers. On EXTRACTED, the call extractors already compute `file:line:snippet` and then collapse it up to one evidence location per service edge (`extract/calls/http.ts` `seenTargets` is first-write-wins). On OBSERVED — the load-bearing layer — edges carry no file origin at all: OTel spans attribute to `service.name`, and the optional `code.*` semconv attributes that would carry file/line are not emitted by default. Surfacing evidence at the query layer alone is a decoration on a service-grained model; it does not make NEAT file-native, and it leaves the runtime layer (where the findings concentrate) with no file origin.

### Decision

NEAT becomes file-native by fixing the grain where the data is born, then building the model on it. The ordering is binding.

1. **Service-graph completeness precedes everything.** Multi-service attribution must be verified working end-to-end on a real codebase. Services remain the aggregation layer (a file belongs to a service), so attribution correctness is a prerequisite, not throwaway.

2. **File-native at the source (v0.4.7).**
   - **OBSERVED:** NEAT's injected instrumentation gains a call-site `SpanProcessor` that attaches `code.filepath`/`code.lineno`/`code.function` on CLIENT/PRODUCER spans; ingest parses those into file-grained `evidence` on OBSERVED edges. The injected template is version-stamped so re-runs upgrade existing installs onto it.
   - **EXTRACTED:** preserve per-call-site `file:line` instead of collapsing to one evidence location per service edge.

3. **File-native model + dashboard (v0.4.8).** `FileNode`/function nodes + `CONTAINS` edges; services become aggregation views; traversal + MCP results carry file grain natively (no separate "surface evidence" step — the model carries it once both layers emit it at the source); dashboard gains service→file drill-down.

The query-layer "surface existing evidence" idea is not a separate first step — it dissolves into step 3, because once the source emits file grain on both layers the model carries it natively rather than as a lossy per-edge annotation.

### Consequences

- The load-bearing OBSERVED layer gains file origin, not just the static layer — the determinism win lands where the findings actually are.
- The injected template reaches its file-native form once (v0.4.7), and re-runs migrate existing installs, so users aren't carried through intermediate templates.
- The dashboard's legibility (service-level top view) is preserved; file detail comes via drill-down, never a flat file hairball.
- The make-or-break uncertainty (does call-site capture land on the user frame?) is validated by v0.4.7's smoke before the model and dashboard build on it.

---

## ADR-088 — Subrelease-train release model

**Status:** Accepted. Process orientation.
**Contract:** amends `docs/contracts/publish-system.md`.

### Context

A milestone that bundles several breakage-prone changes into one publish couples their risk: a regression in any one change is hard to attribute, and the milestone artifact can't advance to `latest` until every change is proven together. Incremental delivery decouples that risk — one change per artifact makes each independently smoke-able and keeps the published `latest` always at least as good as its predecessor. The subrelease train formalizes this for the v0.5-bound work.

### Decision

A milestone that bundles 3+ substantial, breakage-prone changes ships as a subrelease train, not one batch publish:

1. Each meaningful change ships as its own patch subrelease (v0.4.7, v0.4.8, v0.4.9, …).
2. Each subrelease gets a focused smoke battery.
3. The npm `latest` dist-tag advances to a subrelease only when its smoke is clean. A dirty smoke leaves `latest` at the last-known-good version while the regression is fixed.
4. The milestone version (v0.5.0) is a graduation bump after the complete feature set passes a comprehensive smoke across every supported shape — a no-risk version bump, not a big risky ship.

### Consequences

- Regressions are attributable to a single change.
- `latest` is always at least as good as its predecessor.
- The milestone bump becomes a marketing moment rather than a risk event.

---

## ADR-089 — File-first graph: the file is the subject, the service is the rollup

**Status:** Accepted. Supersedes ADR-087's premise that "services remain the aggregation layer — a file belongs to a service," and folds its v0.4.7-source / v0.4.8-model staging into one file-first build. Lands in v0.4.7 (model + capture) → v0.4.8 (dashboard drill-down).
**Contract:** `docs/contracts/file-awareness.md` (rewritten).

### Context

ADR-087 made the graph file-aware while keeping services the atomic unit. Working the model through, the file is the truer subject: a relationship *originates* in a file, and a service exists only because the runtime hands NEAT a `service.name` and NEAT attributes down to files. The service is a grouping recovered from repo structure, not the irreducible thing. Inverting the model — file as subject, service as rollup — is more faithful to where findings actually live and removes the agent's "now reason about where in the code" step the file grain exists to delete.

A second clarification: capturing a call site is not the hard profiling problem it resembles. Attributing CPU *time* to a span needs a sampler correlated to span context across async hops (genuinely hard in Node, unshipped in OSS). NEAT needs only the *call site* of an outbound call — which sits on the synchronous stack at the moment the CLIENT/PRODUCER span is created, because the instrumentation patches the client method and the span is created inside the user's synchronous call. A stack capture at `onStart` reads it. No profiler, no sample-to-span correlation.

### Decision

1. **Files are first-class nodes.** `FileNode` joins service/database/config/infra. Function-level nodes are deferred — file grain now ("file-only where that's all that's available").
2. **A service is a grouping of files, not a layer above them.** A service is a repo root dir / monorepo package, recovered by static analysis (two packages → two services). It exists to own files — `service ──CONTAINS──▶ file` — and to be the fallback identity where a relationship cannot be attributed to a file. It is not an aggregation the graph rolls up to.
3. **The graph is file-first; there is no service rollup.** Relationships originate from files: a `CALLS` edge runs `file:<svc>:<path>` ──▶ target. `FileNode` is the primary node type and `CONTAINS` a new edge type. The graph, the queries, and the dashboard are file-grained — file edges are never collapsed into service edges and there is no service-level view. Service-level nodes and edges persist **only** as the honest fallback where a relationship genuinely cannot be attributed to a file (an inbound SERVER span, an un-instrumented service), never as an aggregation of file edges. Consumers — traversal, divergence, REST — walk this graph generically and return file-grained answers. `retire.ts` keys ghost-cleanup off `evidence.file`, now the originating file, and gains `FileNode` lifecycle.
4. **OBSERVED is file-first where `code.*` exists, service-fallback otherwise.** An injected call-site `SpanProcessor` captures the first user frame on CLIENT/PRODUCER spans (skipping `node_modules` / `@opentelemetry/*`) and sets `code.filepath` / `code.lineno` / `code.function`; ingest joins the runtime path against the service root to land it on a `FileNode`. Inbound SERVER spans, un-instrumented services, and the callee side of any edge stay service-level, honestly. Evidence is never fabricated.
5. **Mechanism is synchronous stack capture, not profiler correlation.** The profiler/CPU-sample-to-span approach (the Grafana/Pyroscope model, unshipped for Node) is explicitly out of scope — it solves a problem NEAT does not have.
6. **Risk ordering holds even though release ordering folds.** A throwaway capture spike validates that the user frame lands on real async Node code (the Brief harness) before the file-node model is built on it. The make-or-break is confirmed first; it is now a confidence check, not a high-risk gate.

Node id format follows `packages/types/src/identity.ts`: `fileId(service, relPath)` → `file:<service>:<relPath>` (service-scoped so a shared relative path across monorepo packages stays distinct), with a matching `parseFileId`.

### Consequences

- The load-bearing OBSERVED layer gains caller file origin for outbound calls; the static layer is fully file-grained.
- File-grained divergence becomes expressible: the declared call site (EXTRACTED) vs. the observed call site (OBSERVED) for the same pair — the divergence finding at street level.
- Service legibility is preserved — the top view rolls up to services; files surface on drill-down, never as a flat hairball.
- Node is not a blocker: NEAT captures the call site, it does not sample CPU time, so the async-correlation problem that stalls profiler-based attribution in Node does not apply.
- The deferred pieces (function nodes; service identity as a pure derived rollup) layer on later without re-cutting the file foundation.

---

## ADR-090 — Layered file-first OBSERVED capture; NEAT-instrumented spans are file-attributed

**Status:** Accepted. Amends ADR-087's capture mechanism (§2 OBSERVED) and ADR-089's decision items 4 and 5 (the OBSERVED file-first mechanism and the synchronous-stack framing). Validated by the context-capture spike (2026-05-28).
**Contract:** `docs/contracts/file-awareness.md` (§4–§6 amended).

### Context

ADR-087's capture mechanism reads the user call-site frame from `new Error().stack` at SpanProcessor `onStart` on CLIENT/PRODUCER spans. An ecosystem inventory of 24 common Node instrumentations (pinned to OTel JS contrib `03c6ed0`, `auto-instrumentations-node@0.76.0`) finds **22 follow the sync-wrapper pattern** — the patched library method creates the span synchronously in the caller's stack — and **2 are off-stack**:

- **`diagnostics_channel`-based** — `@opentelemetry/instrumentation-undici`, which instruments Node 18+'s built-in `fetch`. The span is created inside a `node:diagnostics_channel` subscriber (`undici.ts:308`), detached from the caller's stack.
- **Post-hoc backdated** — `@prisma/instrumentation` receives span data from Prisma's Rust engine after the query resolves and dispatches the DB CLIENT span from a separate loop (`dispatchEngineSpans`, `dist/index.js:167`), with no user frame on the dispatch stack. Prisma is the dominant Node ORM and is not in the auto-bundle.

A spike against undici validated the context-capture mechanism: when the caller pushes the user frame into the active OTel context via `context.with(activeCtx.setValue(USER_FRAME, frame), () => clientCall())`, the span created in the channel subscriber inherits the context, and the processor reads the frame at `onStart` from `parentContext.getValue(USER_FRAME) ?? context.active().getValue(USER_FRAME)`.

Second inventory observation: the framework instrumentations (express, koa, fastify, nestjs, connect, restify, hapi) already wrap the user's route handler in `context.with(...)` to scope request context. NEAT enriches that pre-existing context — no new boundary.

NEAT controls the instrumentation surface end-to-end. The bundled installer wires the in-scope frameworks (`installer-scope.md`); `/neat extend` (ADR-086, `extend-skill.md`) lets the user's agent wire instrumentation for libraries the bundle doesn't cover. Together they ensure every service in the graph runs NEAT-injected instrumentation — there is no design-level "BYO-OTel hole" within an in-scope runtime.

### Decision

Every CLIENT, PRODUCER, and SERVER span NEAT emits carries `code.filepath` / `code.lineno` / `code.function`. The layered capture mechanism guarantees it:

1. **Stack walk at `onStart`** — sync-wrapper CLIENT/PRODUCER instrumentations (the 22-of-24 majority across HTTP, DB, queues, cloud SDKs). The user frame is on the synchronous stack; the walk finds it; skip `node_modules` / `@opentelemetry` / `node:`.

2. **Handler-entry attribution.** At every framework route-handler entry, NEAT (a) stamps `code.*` on the active SERVER span — `trace.getActiveSpan()` is the framework's SERVER span at that point — and (b) enriches the framework's existing handler context with the same frame under a `neat.user-frame` context key. The SpanProcessor's `onStart` falls back to that context value on downstream CLIENT/PRODUCER spans when the synchronous stack yields no user frame, so every downstream span inherits at minimum the handler-file grain.

3. **Facade wrappers for off-stack patterns** — for instrumentations whose span creation is detached from the caller's stack, NEAT wraps the user-visible library facade and pushes the exact call-site frame into context for the inner call. The registry enumerates the set; current members are **undici / built-in `fetch`** and **`@prisma/instrumentation`** (Prisma's `<model>.<op>` entries). The set grows as new off-stack patterns are identified.

4. **Provider wiring.** On `@opentelemetry/sdk-node` 0.218+, `NodeSDK({ spanProcessors: [...] })` does not reliably attach custom processors to the TracerProvider the auto-instrumentations resolve. The injected `otel-init` uses manual `trace.setGlobalTracerProvider(provider)` + `registerInstrumentations({ tracerProvider: provider, ... })` and asserts post-init that the call-site processor is attached to the resolved provider.

5. **`dist→src` resolution.** Captured frames on built TS services point at `dist/...js`. The processor resolves to the original source via the file's source map (disk-adjacent `.map` at capture time, or ingest-time resolution if maps are shipped). `code.filepath` carries the resolved `src/...ts`; the raw dist frame is preserved as `code.original_filepath` for diagnostic.

A NEAT-emitted span without `code.*` is a capture-mechanism bug, not a permitted service-level state. Ingest treats it as such — observability + a loud audit, not silent acceptance. Spans from outside NEAT-controlled services (out-of-scope runtimes per `installer-scope.md` §3, where the operator runs their own SDK) are outside this contract's design surface.

The make-or-break validation evolves with the layered mechanism: the harness exercises **real auto-instrumentations** across all three tiers — a sync-wrapper case (`pg` or `http`), the floor (a request through an express/fastify handler with no facade-wrapped library), and both off-stack cases (`undici/fetch` + `@prisma/instrumentation`) — and asserts file-grained `code.filepath` on every resulting CLIENT/PRODUCER/SERVER span emitted by the production code path.

### Consequences

- Every NEAT-emitted span is file-attributed. The graph's file-first claim holds end-to-end across the real auto-instrumentations of supported services.
- Implementation surface is small: 7 handler-entry wrappers (seam already exposed by the frameworks), 2 facade wrappers today (registry-extensible), one-time provider-wiring + sourcemap-resolution.
- ADR-087's §2 mechanism holds for the sync-wrapper majority; this amendment names where stack-walk applies and adds the floor and facade tiers.
- One open empirical item: aws-sdk v3 is classified sync-wrapper from the Smithy middleware source but warrants a one-line live confirm in the new harness build.
- `@opentelemetry/instrumentation-fastify` was removed from contrib (Mar 2026); Fastify ships its own `@fastify/otel`. The Fastify handler-entry wrapper targets `@fastify/otel`'s exposed context seam, picked up with the v0.4.11 installer-scope work.

---

## ADR-091 — Manifest-driven MCP tool surface

**Status:** Accepted. Amends ADR-039 §1 (tool count). Lands in v0.4.12.
**Contract:** `docs/contracts/mcp-tools.md` (§ "Tool surface" amended).

### Context

ADR-039 locked the MCP tool surface at nine named tools. ADR-060 extended that count to ten when `get_divergences` landed. As the tool surface grows — v0.4.12 (#387) adds six extend tools — each extension requires a paired edit across three artifact sites: the `server.tool(...)` registrations in `packages/mcp/src/index.ts`, the allowlist in the contracts audit, and the count stated in the contract doc. A manifest approach consolidates this to a single edit point that every other surface derives from.

### Decision

`@neat.is/types` exports a single `MCP_TOOL_NAMES` const tuple and a derived `MCPToolName` type. The MCP server registers tools via a thin `registerTool(name: MCPToolName, ...)` wrapper — `tsc` rejects an unrecognized name at compile time. The contracts audit imports `MCP_TOOL_NAMES` and compares it to the `registerTool(` literals in `index.ts` both ways: registered-but-not-in-manifest and manifest-but-not-registered are both failures. The count is not stated in the contract; the manifest is the count.

Adding a tool is one edit in `MCP_TOOL_NAMES` plus the `registerTool(...)` call. Removing or renaming a tool requires the same paired edit. The audit catches any mismatch on every PR.

### Consequences

- One source of truth for the tool surface; the registration, the audit, and the manifest stay structurally in sync.
- `tsc` rejects an unrecognized tool name before the audit runs.
- The six extend tools from v0.4.12 (#387) extend `MCP_TOOL_NAMES` in the same change that registers them — no separate amendment needed.
- ADR-039's locked count is superseded; the tool surface grows and shrinks by manifest edit, not by ADR amendment.

---

## ADR-092 — File-span extraction: unconditional file enumeration and import graph

**Status:** Accepted. Lands in v0.5.x (post-LTW arc).
**Contract:** `docs/contracts/static-extraction.md` (new producers: file enumeration, import extraction). `docs/contracts/file-awareness.md` (§1 unconditional FileNode creation, §10 intra-service import graph).

### Context

NEAT builds `FileNode`s as a byproduct of finding an extractable external call — `ensureFileNode()` fires only when a call site parses successfully. Files with no detected HTTP, AWS, database, or queue calls are invisible. This makes NEAT structurally edge-first: the graph covers the network boundary of a service but misses the module structure inside it.

Running NEAT against Brief-env's API service (17 TypeScript source files) produces exactly one `FileNode`: `src/services/s3.ts`, because the S3 client call is the one pattern the extractor recognises. `src/routes/briefing.ts` — the file that orchestrates mongo, mistral, s3, wikipedia, auth, and jobStore — does not appear. Neither does `src/services/mongo.ts`, `src/services/mistral.ts`, `src/services/stripe.ts`, or any of the other 12 source files.

The intra-service module graph — how files depend on each other — is entirely absent. A question like "what breaks if `mongo.ts` changes?" has no graph answer, because the relationship between `briefing.ts → mongo.ts` doesn't exist in NEAT's model.

External-call precision and source-level coverage are separate concerns, and the extraction architecture matures by giving each its own phase. Today the extraction pipeline addresses both in one pass: scanning for known external patterns, creating `FileNode`s as a byproduct of matching them. A file that matches no pattern is invisible — which is precise for external calls but leaves the module interior unrepresented.

### Decision

Restructure static extraction into three ordered phases:

**Phase 1 — File enumeration (new).** Before any call extraction, walk every source file matching `SERVICE_FILE_EXTENSIONS` within each service directory and emit a `FileNode`. This runs unconditionally: a source file gets a node regardless of whether the later phases find anything in it. `FileNode` IDs are unchanged: `file:<service>:<relPath>`. The `service ──CONTAINS──▶ file` edge is emitted here too — previously it was a side effect of call extraction.

**Phase 2 — Import graph extraction (new).** Walk each source file's AST for import and require statements. For each import that resolves to another source file within the same service, emit an `IMPORTS` edge: `file:<svc>:<importer>` ──IMPORTS──▶ `file:<svc>:<importee>`. Cross-service imports remain out of scope for this phase; they surface as `CALLS` edges later where the external-call pattern matches.

Resolution rules:
- Relative imports (`./mongo`, `../utils/auth`) resolve relative to the importing file within the service directory.
- TypeScript path aliases (`@/services/mongo`) resolve via `tsconfig.json` `compilerOptions.paths` when a `tsconfig.json` is discoverable at the service root or `scanPath`.
- Python relative imports (`from .mongo import ...`) resolve relative to the module's package root.
- Unresolvable imports — Node built-ins, `node_modules` packages, env-dependent paths — are silently skipped.

**Phase 3 — External call annotation (unchanged).** Existing `CALLS` producers (`calls/http.ts`, `calls/aws.ts`, etc.) run after Phase 1 has emitted every `FileNode`. `ensureFileNode()` inside these producers becomes a no-op on the vast majority of files — the node already exists. The external call edges annotate a richer file graph rather than building it piecemeal.

**New edge type: `IMPORTS`.** Static module dependency between two `FileNode`s within a service. Provenance: `EXTRACTED`. Evidence: the import statement's file, line, and snippet (same shape as `CALLS` evidence). Ghost-edge cleanup keys on `evidence.file` exactly as it does for `CALLS` — when the importing file changes, its `IMPORTS` edges are retired before re-extraction. Blast-radius and transitive-dependency traversal walk `IMPORTS` edges as first-class members of the path. `IMPORTS` is a new value in the edge-type enum and follows ADR-031's schema-growth rules — an additive change, no migration of existing edges required.

### Consequences

- Every source file in every tracked service appears in the graph.
- The module graph inside a service is queryable: blast radius for a single file traverses `IMPORTS` edges to show intra-service dependents before crossing service boundaries.
- `get_divergences` gains a new comparison surface: declared import structure versus what the runtime actually exercises (via `OBSERVED` spans that carry `code.filepath`).
- Test-scope exclusion (precision filter §1 of the static-extraction contract) applies to `IMPORTS` edges — test files do not emit outbound `IMPORTS` edges.
- Import resolution is best-effort. Alias resolution failure degrades gracefully to missing edges, not extraction failure.
- Phase ordering is the guarantee: file enumeration precedes import extraction, which precedes external-call annotation. Callers that already call `ensureFileNode()` as a consistency guard do not need to change.
- The `IMPORTS` edge type is new schema — `packages/types/src/edges.ts` grows one value. Existing snapshots load cleanly; no existing edge needs migration.

## ADR-093 — Governance kernel: provenance-routed mutation gating

**Status:** Accepted. Lands in the post-v0.5 governance arc (toward v1.0). Build sequence in `docs/plans/2026-06-09-governance-kernel-build-ladder.md`.
**Contract:** `docs/contracts/policy-evaluation.md` (synchronous gate path), `docs/contracts/policy-actions.md` (widens `block` scope; amends ADR-044), `docs/contracts/lifecycle.md` (mutation path branches on provenance).

### Context

The policy engine evaluates assertions against the graph, but `block` gates one operation only — frontier-promotion (ADR-044) — and evaluation is async, post-lifecycle. The thesis is a governance kernel: policies that prevent violations, not just report them. The naive form ("evaluate every mutation, reject on violation") fails on a category distinction — a mutation describes something that already happened (an OBSERVED span, parsed code) or something that has not (a proposed change), and only the latter can be prevented. Rejecting an OBSERVED edge means discarding telemetry, which makes the graph lie about production to satisfy a rule reality already broke. A fact cannot be rejected; it can only go unrecorded, which is worse than recording it. The provenance of a mutation already encodes which case it is.

### Decision

The mutation path branches on the incoming provenance.

**Settled provenance (OBSERVED / EXTRACTED / INFERRED / STALE) → record-and-flag.** The write lands unconditionally; policies evaluate after; a violation surfaces as a divergence/incident. Retrospective. This is the existing async evaluate path, generalised — no blocking check enters the high-volume OTLP ingest path, because a fact is settled on arrival and blocking it is meaningless.

**FRONTIER provenance (not-yet-real, ADR-094) → gate.** Policies evaluate first, against `(live graph + the FRONTIER delta)`, before anything graduates. A `block` violation refuses the graduation; nothing lands. Synchronous. Foreign-key-constraint semantics. This widens ADR-044's `block` scope from frontier-promotion-only to the FRONTIER-graduation gate.

**Hypothetical evaluation — the clone → overlay → slice ladder.** `evaluateAllPolicies` is pure and the evaluators are read-only over a five-method graph surface (`forEachNode`, `forEachEdge`, `getNodeAttributes`, `getEdgeAttributes`, `outboundEdges`), so:
- *Rung 1 (ships first):* `graph.copy()`, apply the delta to the copy, evaluate the copy unchanged. No observer leak (the copy has no event bus attached). Cheap because proposal checks are rare.
- *Rung 2 (scale):* a five-method `ReadableGraph` interface plus an overlay answering reads over `(real ∪ delta)` with no copy. Built when per-check clone cost matters (the mandatory tier).
- *Rung 3 (optimization):* local-slice evaluation for local policies, if the overlay's whole-graph scan is too slow under load.

**Two enforcement tiers, one kernel.** Cooperative — an agent calls the kernel before acting and honors the verdict (ships with rung 1). Mandatory — the kernel wired as a required gate (CI check, deploy webhook, admission controller), built when an enterprise design partner asks. The strength of the guarantee is the gate's position, not a property of the kernel.

### Consequences

- `block` becomes a prevention primitive at the FRONTIER gate, not frontier-promotion-only. Amends ADR-044.
- The OTLP ingest path is untouched — settled facts keep their async flag path; only the new FRONTIER channel gates synchronously.
- The proposal channel is net-new surface (a check primitive: REST endpoint + MCP tool taking a delta, returning `{ allowed, violations }`); nothing in the current flow proposes mutations.
- Rung 1 ships the proof-of-thesis demo with the existing read-only evaluators unchanged.
- Post-v0.5 arc. v0.5.0 stays the graduation bump of what ships today; the kernel half-built under a graduation bump would violate the honesty the claim depends on.

## ADR-094 — FRONTIER provenance: the staged-proposal tense

**Status:** Accepted. Coupled to ADR-093. Post-v0.5 governance arc.
**Contract:** `docs/contracts/provenance.md` (FRONTIER gains write semantics), `PROVENANCE.md` (the reserved value gets its purpose).

### Context

The provenance enum carries five values; four describe settled state (EXTRACTED, OBSERVED, INFERRED, STALE) and `FRONTIER` is reserved-but-unwritten ("nothing writes FRONTIER today" — PROVENANCE.md). Separately, the node-type `FrontierNode` is a placeholder for an unresolved external host. The two share a root word on different axes — a node *type* versus an edge *provenance* — and the node type keeps its name (maintainer decision). The kernel (ADR-093) needs a provenance that means "proposed, not yet real" to route a mutation into the gate path.

### Decision

`FRONTIER` provenance is the staged-proposal tense: a relationship a change intends to create but has not enacted — an agent's proposed deploy, a PR's would-be edges, an experiment staged and watched. It is the only provenance describing the future; the other four describe the past or the parsed present.

Lifecycle: a proposal enters the graph as a FRONTIER-tagged edge and exits through exactly one of three transitions —
- **graduate** to OBSERVED (passed the gate, traffic confirmed),
- **refused** (a `block` violation at the gate; never lands),
- **culled** (the observation window expired unconfirmed).

The policy gate (ADR-093) sits on the FRONTIER→OBSERVED transition. Graduation is evaluated against the proposed final state; positive OTel evidence cannot override a `block`; only a human overrides a block.

### Consequences

- The reserved FRONTIER provenance value gets write semantics; PROVENANCE.md's "nothing writes FRONTIER today" is resolved.
- Proposals become graph-native staged state — the substrate for experiment graduation and autonomous remediation (VISION geometry).
- Provenance becomes the single signal the kernel routes on: settled → flag, FRONTIER → gate.
- The node-type/provenance name overlap is accepted, not renamed; the two never occupy the same slot, and code touching both carries a comment convention to keep them unambiguous.

## ADR-095 — Divergence as a standard policy bundle

**Status:** Accepted. Follows ADR-093. Post-v0.5.
**Contract:** `docs/contracts/divergence-query.md` (becomes a view over a policy bundle), `docs/contracts/policy-evaluation.md` (built-in bundle).

### Context

Divergence (declared-vs-observed mismatch, dead-dependency audit) is its own engine. Once the kernel (ADR-093) makes "a settled edge violating a policy" the flag path, a divergence is a policy violation on settled provenance. "Any EXTRACTED edge STALE >7 days with no OBSERVED twin" is a provenance policy; "every ServiceNode declares an owner" is an ownership policy; service-level dead code is a structural policy. Two engines is two mental models and two maintenance burdens for one operation.

### Decision

The divergence engine collapses into a standard, built-in policy bundle. The five divergence types are expressed as policies shipped by default. The policy engine is the general form; divergence is a built-in bundle, not a separate primitive. `get_divergences` (REST + MCP + CLI) stays as a convenience view over that bundle's violations — the consumer surface is unchanged; the implementation is unified underneath.

### Consequences

- One engine with a rich policy vocabulary, not two. Every future analysis feature is expressed as a policy rather than a new engine.
- The policy file becomes the complete expression of organisational health — structural, ownership, provenance, and data-quality constraints in one place.
- `get_divergences` keeps working; no consumer-visible change.
- Lower risk than it appears: ADR-093's flag path already makes "settled edge violating a policy" the divergence output, so this is re-expression of existing checks, not new mechanism.

## ADR-096 — Project-scoped daemons: one daemon per project, no shared coordination registry

**Status:** Accepted. Supersedes ADR-026 (single shared daemon + dual-mount routing) and the coordination role of ADR-048 (the machine registry as a write-locked coordination point). Resolves #366. Lands in a dedicated daemon-refactor arc.
**Contract:** new `docs/contracts/project-daemon.md`; amends `daemon.md`, `project-registry.md`, `init.md`, `web-bootstrap.md`, `rest-api.md`, `one-command-cli.md`.

### Context

The hosted architecture is per-project: each customer/project gets its own authoritative graph and daemon. Local NEAT graduates to the same shape, so one architecture serves both scales.

The current local model (ADR-026) is a machine-level control plane — one `neatd` on fixed ports (`8080`/`4318`/`6328`), a global `~/.neat/projects.json` that `neat` processes coordinate through under a write-lock, and the daemon bootstrapping every registered project into a slot, served via project-scoped URLs. That model centralizes coordination: a shared daemon, a shared registry, a shared write-lock, and a shared port set, all rendezvous points that multiple `neat` processes meet at. The per-project model distributes that coordination into each project's own daemon, so the centralized rendezvous surfaces — the write-locked machine registry, the fixed-port binding, the `default`-project root mount (#500) — are retired in favor of per-project self-description. As NEAT moves onto a hosted per-project substrate, the local model maturing to match it is the natural next step rather than a second model to maintain.

### Decision

**One daemon per project.** `neat init` / the orchestrator spawns a daemon scoped to that project; there is no shared coordination registry.

- **Per-project daemon lifecycle.** Each project's daemon owns only that project's graph, OTLP ingest, REST, dashboard, and MCP surface. It binds its own ports, holds its own state, and has no knowledge of other projects.
- **Self-description, not a coordination registry.** A project's daemon writes `<project>/neat-out/daemon.json` recording its allocated ports + pid + status. That file is the source of truth for "where is this project's daemon," read by the instrumentation (OTLP endpoint), the MCP config, the dashboard, and `neat list`/`neat ps`. No write-lock — each daemon owns its own file.
- **Stable port reuse.** On first spawn the daemon allocates free ports and persists them to `daemon.json`; subsequent spawns reuse the same ports (reallocating only on genuine conflict). This keeps the instrumented app's exporter endpoint stable across daemon restarts — critical, or the app's `.env.neat`/`NODE_OPTIONS` config would drift every restart.
- **The global `~/.neat/projects.json` is no longer a coordination point.** Optionally a thin, append-only, lock-free machine-wide "running daemons" index supports `neat ps`; but it is *not* a correctness dependency — losing it costs discovery convenience, not correctness.
- **No default-project routing.** Each daemon serves its own project at the root; no dual-mount, no `default` ambiguity. The #500 fix is subsumed — a project's daemon serves exactly one project.
- **Per-project dashboard** on the daemon's own port (from `daemon.json`); no local multi-project switcher (that belongs to the hosted dashboard).

### Consequences

- The machine-wide write-locked registry rendezvous is retired; coordination becomes per-project self-description, so there is no shared lock for processes to wait on.
- Bare-verb resolution simplifies to one-project-per-daemon; the `default`-project root mount (#500) is retired in favor of each daemon serving its own project at the root.
- **Port allocation + `daemon.json` self-description is the one real new surface to get right** — the complexity this trades the shared-coordination complexity for.
- N active projects = N daemons. Acceptable: daemons run only for projects under active work; idle projects have none. Lazy/auto-stop of idle daemons (#365) pairs naturally and gains value here.
- Local NEAT now matches the hosted per-project model — one architecture at two scales, simplifying the sync/onboarding/hosted path.
- Migration: existing single-daemon installs + the global registry need a one-time migration to per-project daemons; the global file is read-once for migration, then retired as a coordination surface.
- Supersedes ADR-026 (single daemon + dual-mount); amends ADR-048 (registry → self-description, not locked coordination), ADR-049/063 (daemon lifecycle), ADR-059 (per-project dashboard port), ADR-073 (orchestrator spawns a project daemon).

## ADR-097 — Web shell IA: the fused graph as the spine of a multi-page SaaS shell

**Status:** Accepted. Opens the GUI-redo arc. Builds on the four web-shell contracts (ADR-056/057/058/059) and stays compliant with the multi-project routing locked in ADR-057/062.
**Contract:** new `docs/contracts/web-shell.md`; governed alongside `web-completeness.md` (#26) and `web-multi-project.md` (#27).

### Context

NEAT has matured from a single canvas into a SaaS product whose graph is one view among several. The product is the fused graph — code and observed runtime in one file-grained model — and that model is what an agent reads as full-stack context. The shell has to make the fused graph the spine: what your system *is* and *does*, unified. Divergence is one query that falls out of that model, not the thing the product is; an IA that frames NEAT as a divergence detector reads the product at the wrong altitude and undersells the graph. The same applies to root-cause, blast-radius, and dependencies — they are questions you ask of a node, not destinations in the nav.

The product is now multi-project (hosted serves a project per customer), so the shell needs a project switcher that honors the resolution chain locked in ADR-057/062 without reintroducing the `default` fallback that was deliberately removed (#461). And the user wants a real policy *enforcement* surface, which lands directly on the web-completeness honesty line (#26): the enforcement kernel is unshipped (ADR-093/094/095; audit do-not-say #2; #533), so the GUI has to show the enforcement layer honestly rather than fake a working gate.

### Decision

1. **Spine = the fused graph as the agent's eyes.** The headline and onboarding story is the fused model — *what your system is and does, unified; accurate full-stack context for your agent.* The value is the graph being true and complete, not the delta between declared and observed.
2. **Multi-page shell.** A left page-nav sidebar (jedorini `sidebar`) carries the pages; a topbar carries the project switcher, the ⌘K command palette, and env/account; a status bar carries connection state (web-debugging #28). The canvas is one page among list/table views — the graph is the *spatial* view, not the only view.
3. **Divergence is a peer query, not the marquee.** It joins root-cause / blast-radius / dependencies as an "ask the graph" view. The graph carries the primary nav weight; the nav never reads "divergence detector."
4. **Node-scoped queries are actions, not pages.** Blast-radius, dependencies, and root-cause are reached by selecting a node — the inspector offers them and they focus the canvas (BFS highlight), they do not navigate to a dedicated page. The marketing "sandboxed-feature blast radius" framing is not a GUI surface.
5. **Project switcher complies with ADR-057/062.** AppShell owns project state as `useState<string | null>`; resolution is URL → localStorage → first active `/projects` entry → `null`. No `default` fallback, no invented name, every data-fetching consumer gates on `null`.
6. **Policies = a real violation view live, the enforcement layer as explicit preview.** The GUI is the shipped product governed by web-completeness #26 (unlike the marketing site). The violation *view* (`check_policies` / `evaluateAllPolicies` surfacing what currently flags) wires live and read-only. Everything that *acts* — the gate, block, approve/reject, would-violate-on-change simulation, and block-on-FrontierNode-promotion (dead in production: the gate at `ingest.ts:1278` only fires when policy opts are passed, but both production callers pass the graph only — `watch.ts:185` and `extract/index.ts:109`) — renders as explicit `preview` / disabled-with-intent per #26's "wired or explicitly disabled" clause. The preview→live flip is a future `policy-actions` contract change when the governance kernel (ADR-093/094/095) ships, so the enable is an ADR, never silent.
7. **No stub pages.** Each sidebar page maps to a shipped capability; the shell ships on graph + the two-mode overlay first, with sibling list pages progressive. STALE is a legend entry / edge style, not a live decay surface; there is no one-click deploy/sync hero.

### Consequences

- The fused graph leads the product narrative; divergence, root-cause, blast-radius, and dependencies are queries over the one model rather than separate destinations.
- The shell ships incrementally without violating #26 — unshipped surfaces render explicitly disabled or `preview`, so a sidebar page never promises a feature that is not there.
- The policy enforcement layer is build-ahead UI, designed now and honestly labeled, flipping preview→live behind an ADR when the kernel lands.
- The switcher inherits the multi-project routing contract intact, so the hosted multi-project shape and the local single-project shape share one resolution chain.

## ADR-098 — Live canvas layout: deterministic structure, incremental live placement

**Status:** Accepted. Part of the GUI-redo arc. Pairs with ADR-097 (the shell) and ADR-099 (the design system).
**Contract:** new `docs/contracts/canvas-layout.md`.

### Context

The canvas runs ELK `layered` for a deterministic, tiered dependency flow. The hard problem is the live layer: NEAT streams OBSERVED edges in over SSE, and re-running ELK on every `node-added` / `edge-added` reflows the whole graph and reads as a jarring reshuffle. The signature moment of the redo is the OBSERVED layer landing on top of the static EXTRACTED graph, so that motion has to be smooth and the static structure has to stay put under it.

The signature moment is also frequently the *absence* of that moment. On real apps the OBSERVED layer often does not engage — no entry point, an uninstrumented database, a leaf service with no outbound calls (#545/#546). The canvas needs a first-class state for that, and it needs to read as the model completing, not as an error or a gap.

### Decision

1. **Deterministic ELK for structure.** ELK `layered` runs on initial load and on an explicit user **re-tidy** only. Deterministic topology means a re-tidy produces the same positions, so it is safe and predictable when the user asks for it.
2. **Incremental in-place for the live stream.** On SSE `node-added` / `edge-added`: pin all existing positions, place only the new node near its connecting neighbor's existing position, never auto-reflow. SSE events batch/debounce into a ~750 ms window so a burst lands as one update, not a stutter. The new edge pulses in *in place* — highlight, don't relayout.
3. **The observed-overlay is one continuous completion story, two modes.** Framed as fusion / completion — incomplete → completing → complete — not contrast. **Mode A (healthy, idle):** instrumentation wired, no traffic yet → *"Your code's mapped — run your app to complete the picture with what it actually does."* **Mode B (didn't engage):** the #545/#546 cases → diagnosis + the one fix, surfacing the same signal as the CLI (#547) and `errors.ndjson` — *"No entry point — add a `start` script,"* *"sqlite3 isn't instrumented — run `neat extend`."* This is the GUI face of file-awareness §4's loud audit.
4. **Mode B gets equal design weight.** Until ecosystem coverage closes, Mode B is the common case, not the exception. It is designed to the same standard as the signature pulse; it is the moment a user would otherwise churn, turned into the most helpful screen.
5. **Designed states throughout.** Loading skeleton, empty-graph, daemon-down, and disconnected nodes parked deliberately — no clipped orphan row, no dead empty state.

### Consequences

- The static structure stays stable while the live layer arrives, so the OBSERVED layer reads as reality fusing into the model rather than the graph jumping.
- Re-tidy is deterministic and user-triggered, so the only layout motion the user sees is one they asked for or the pulse-in of a new live node.
- The observed-overlay unifies the observed=0 / didn't-engage / live states into one continuous "the picture completing" arc, which carries NEAT's runtime-led story even when the live layer is absent.
- The ~750 ms debounce trades a sub-second delay on live arrival for a calm canvas under a burst of spans — the right trade for legibility.

## ADR-099 — Design-system adoption: the jedorini component system

**Status:** Accepted. Part of the GUI-redo arc. The heaviest step of the redo (a full-dashboard Tailwind migration), sequenced first.
**Contract:** new `docs/contracts/design-system.md`.

### Context

The GUI redo adopts a vendored component system, "jedorini" — neatified shadcn / Base UI: DM Mono, hard corners (`--radius: 0`), monochrome black/white plus the one OBSERVED green (`#5fcf9e`). jedorini is built on Tailwind v4 and imports Base UI under its current official package name, `@base-ui-components/react`. `packages/web` today is React 18 / Next 14 on Tailwind v3 and imports the older `@base-ui/react` alias. Two reconciliations follow: the Tailwind v3→v4 migration, and the Base UI package consolidation. The redo is a *design* change, so it does not take the React 19 / Next 15 jump — that is risk and churn that does not serve the goal, and the dashboard already mounts client-only (ADR-062), so little of Next's SSR is in use.

### Decision

1. **Adopt jedorini.** Vendor the components; the look is DM Mono, hard corners (`--radius: 0`), monochrome black/white, and the single OBSERVED green `#5fcf9e`. The green is the runtime layer's color and is reserved for it.
2. **React 18 / Next 14 stay.** No React 19 / Next 15 jump in this redo. Vendored components are verified React-18-safe (no `use()` / server actions) as part of the vendor pass.
3. **Tailwind v3 → v4 is a full-dashboard migration, not a config swap.** v4's CSS-first config and breaking class/PostCSS changes touch every existing styled component in `packages/web`, so the migration carries a visual-regression pass over the existing dashboard. This is the heaviest step of the redo and is sequenced first.
4. **Base UI consolidates on `@base-ui-components/react` with a compat pass.** The dashboard's `@base-ui/react` imports migrate to the current official package jedorini uses. Base UI's API shifted across alphas (component names, prop shapes), so this is a migration with a compat pass, not a find-replace; the exact version delta is confirmed at build time.

### Consequences

- The whole product shares one coherent look — hard corners, DM Mono, monochrome plus the one green — that reads as deliberate, not generic.
- One framework jump (Tailwind), not three; React 18 / Next 14 stay, keeping the redo a design change rather than a platform migration.
- The Tailwind v4 and Base UI passes are real work with regression risk, budgeted and sequenced first so the rest of the redo builds on a stable foundation.
- The OBSERVED green is a system token reserved for the runtime layer, so the live layer reads consistently across the canvas and the list pages.

## ADR-100 — File-awareness: the service CONTAINS-grouping renders as a collapsible compound container

**Status:** Accepted. Part of the GUI-redo arc. A clarifying amendment to ADR-089's file-first model — it adds a canvas-rendering clause, it does not change the model.
**Contract:** `docs/contracts/file-awareness.md` (amended — new clause added; §3's hard lines reaffirmed, not rewritten).

### Context

The canvas needs to render services without reintroducing the hairball, and the file-first model already carries the structure to do it: every file hangs off its service through a `CONTAINS` edge (ADR-089 §2). Rendering that grouping as a collapsible compound container — the service as a box that nests its files — is grouping chrome over the existing `CONTAINS` hierarchy, not a rollup. ADR-089 §2 defines a service as "a grouping of files, not a layer above them," so this is compatible in spirit: files stay the primary visible nodes, and the service is a container over them. What the rendering must not do is cross any of §3's hard lines — those stay intact.

### Decision

The file-awareness contract gains a clause that blesses rendering the service `CONTAINS`-grouping as a collapsible compound container, and reaffirms (does not rewrite) §3's hard lines:

- **Bless the compound container.** A service renders as a collapsible compound node that nests its files via the existing `service ──CONTAINS──▶ file` hierarchy. Collapsed by default to keep the hairball dead; the selected service (and its one-hop neighbors) auto-expands; tiny services may render expanded.
- **Never collapse file edges into service-level edges.** Edges stay file→file / file→target. The compound container groups nodes; it never aggregates their edges.
- **Never render a service as a leaf node that hides its files.** Compound-grouping yes; service-blob-standing-in-for-its-files no.
- **Render service-coarse OBSERVED fallback edges honestly.** When an edge falls back to a service node (the parent-fallback case, #536), it renders as the honest coarse fallback — dashed into the service container with a marker — never as a confident file→file precision line.

### Consequences

- The canvas renders services as grouping chrome over the file-first graph, so the user sees service structure without the graph rolling up to services.
- §3's hard lines are reaffirmed at the rendering layer: the visible canvas honors the same file-grain the graph, queries, and REST reads already do.
- Service-coarse fallback edges are visibly distinct from file-grained edges, so the canvas never overstates the precision of a fallback.
- This is additive — the file-first model, traversal, divergence, and capture are unchanged; only the canvas-rendering clause is new.

## ADR-102 — One profile seam for every client (GUI · CLI · MCP), and remote mode

**Status:** Accepted. Wave 1 of the launch-readiness feature arc. Generalizes ADR-101's per-daemon web profile into the canonical client↔daemon seam, adds the CLI and the MCP server as consumers, and adds a remote (hosted-read) mode. Built on ADR-096 (per-project daemon, served at the REST root). It does not supersede ADR-101 — it lifts ADR-101's profile definition to the shared one, and the web becomes its first consumer. (ADR-101 lands with the GUI-redo contracts in #548; ADR-102 references it ahead of that merge.)
**Contract:** `docs/contracts/client-profiles.md` (new). Amends `docs/contracts/cli-surface.md` (ADR-050) and `docs/contracts/mcp-tools.md` (ADR-039 + ADR-091).

### Context

A NEAT client reaches a daemon three different ways today. The GUI resolves a project and calls its `/api/*` proxy routes. The CLI hits `NEAT_API_URL` (default `http://localhost:8080`) and prefixes `/projects/:name` for a named project. The MCP server resolves its base URL by honoring `NEAT_CORE_URL`/`NEAT_API_URL`, else walking up from the cwd to the nearest `neat-out/daemon.json` and using its REST port, else the loopback default. Three resolutions, three mental models, and no shared notion of *which* NEAT a client is pointed at.

That gap blocks two launch needs. First, hosted: the product launches local-first and hosted ~1–2 weeks later, and hosted must hook in **additively** — no client rewrite. Second, the developer story the marketing site sells — pointing an agent at NEAT during development — needs the CLI and MCP to reach a *hosted* daemon and run the read/OBSERVED query surface against it from the terminal, not just the local loopback daemon.

ADR-096 already made every daemon serve its one project at the REST root (no `/projects/:name`, no `default`); a daemon *is* a project. ADR-101 gave the GUI a **profile** — `{ endpoint, authToken? }` — and a switcher over many of them. The clean move is to make that profile the *one* seam every client uses.

### Decision

1. **Profile = `{ endpoint, authToken? }`.** The same shape for the GUI, the CLI, and the MCP server, local and hosted. A client's API base *is* the selected profile's `endpoint`; no client branches on local-vs-hosted.
2. **Talk to the daemon at its root (ADR-096).** A profile endpoint is a daemon root (`GET /graph`); the project is the daemon and its name is the profile's label. The CLI's current `/projects/:name` prefix is legacy — reconciled to root-addressing as the daemon refactor lands. This ADR fixes the target without requiring that reconciliation to ship first.
3. **Resolution precedence (CLI + MCP)** generalizes today's `NEAT_CORE_URL → daemon.json → loopback` chain by adding explicit profile selection on top, without removing the existing primitives: (1) `--profile <name>` / `NEAT_PROFILE` → a named profile from the per-user store; (2) `NEAT_CORE_URL` (+ `NEAT_AUTH_TOKEN`), kept verbatim — the unnamed ad-hoc pin the hosted/prod substrate already uses; (3) local project daemon discovery (`neat-out/daemon.json` → `http://localhost:<ports.rest>`, no token); (4) loopback default `http://localhost:8080`.
4. **Named profiles persist in a per-user client config, not a daemon registry.** They live in `~/.neat/profiles.json` — a client *address book* of remote NEATs. Daemons never read it and never coordinate through it; losing it costs convenience, not correctness. ADR-096's "no shared coordination registry" rule governs daemons; a client's list of endpoints does not touch it.
5. **Remote mode — reads are profile-routable; local mutations are local-only.** Every read/query verb and read MCP tool routes to any profile endpoint, including a hosted one with a bearer (the "OBSERVED queries against hosted from the CLI / point an agent at hosted" capability). `neat init`, `neat watch`, the bare-`<path>` orchestrator, and the `/neat extend` operative tools + SDK installers are local-only — they mutate the local filesystem / spawn a local daemon and never silently target a remote endpoint. `neat sync --to <url|profile>` stays the one deliberate remote *write* (ADR-074).
6. **Auth is per-profile, single-sourced.** The bearer travels as `Authorization: Bearer <token>` (ADR-073 §3's single-source rule holds). A loopback local profile omits the token; a hosted profile carries it. `NEAT_AUTH_TOKEN` remains the env primitive the named-profile token layer sits on.
7. **The profile *source* is the only local↔hosted swap point.** Local: per-project daemon discovery (`neat-out/daemon.json` for the cwd project; the machine-wide running-list for the GUI switcher). Hosted (additive, later): the platform's project list with `endpoint` + bearer. Same clients, same code path.

### Consequences

- One seam, three clients: "which NEAT am I talking to" has a single shared answer (the selected profile).
- Hosted hooks in additively — swap the profile source, add the bearer. This is the launch principle (local-first, hosted-additive) made concrete, and the foundation every later hosted feature (remote query, the autonomous-remediation runner, the managed suite) sits on.
- The developer/agent story works from the terminal: `neat --profile <hosted> blast-radius …` and an MCP server pinned at a hosted daemon both run the read surface against production data.
- Back-compat preserved: `NEAT_CORE_URL` / `NEAT_AUTH_TOKEN` keep working as the explicit override; named profiles are additive over them.
- ADR-096's no-shared-registry core is untouched; the client address book is not a coordination point.
- Implementation is deferred to a later wave; this ADR + `client-profiles.md` are the prose the code is written against.

## ADR-101 — One GUI over many daemons via per-daemon profiles (supersedes ADR-096 §5)

**Status:** Accepted. Part of the GUI-redo arc. Supersedes ADR-096 §5 (the local single-project web stance). ADR-096's core — independent per-project daemons, no shared coordination registry — is unchanged. Amends ADR-097 (the switcher clause), ADR-057/062 (the resolution chain in `web-multi-project.md`), and carries two corrections into ADR-098 (`canvas-layout.md`) and ADR-099 (`design-system.md`).
**Contract:** amends `docs/contracts/web-shell.md`, `web-multi-project.md`, `canvas-layout.md`, `design-system.md`.

### Context

ADR-096 moved NEAT to one daemon per project, each serving its single project at the REST root (no `/projects/:name` prefix, no `default`), self-describing in `~/.neat/daemons/<project>.json`, with no shared coordination registry. The GUI (#549), however, was built on the pre-ADR-096 model: a single `NEAT_CORE_URL` serving `/projects/:name/...` over the shared `~/.neat/projects.json` registry. The product is now primarily the multi-project SaaS experience, launching local first and hosted ~1–2 weeks later, with the launch constraint that hosted must hook in **additively** (no shell rewrite). One GUI must therefore drive many daemons — locally and hosted — through a single seam.

### Decision

The GUI drives many daemons via **profiles**.

1. **Profile = `{ endpoint, authToken? }`.** The same shape local and hosted. The GUI's API base is the *selected profile's* `endpoint`; the GUI never branches on local-vs-hosted.
2. **Talk to the daemon at its ROOT.** Per ADR-096, a daemon serves its one project at the root (`GET /graph`), so the GUI drops the `/projects/:name` prefix entirely. The project *is* the daemon; its name is a profile label.
3. **Profile source is discovery, not a registry — and it is the only local↔hosted swap point.**
   - **Local:** enumerate `~/.neat/daemons/*.json` → one profile per running daemon (`{ endpoint: http://localhost:<ports.rest>, project }`). The `~/.neat/projects.json` dependency is dropped.
   - **Hosted (additive, later):** profiles come from the platform's project list, each with its `endpoint` + bearer `authToken`. Same shell, same code path.
4. **ADR-096 per-project daemons only.** The GUI does not speak the legacy `/projects/:name` multi-mount. If only a legacy daemon is running, discovery finds no profiles → the empty state, not a compatibility path. Maintaining two resolution paths for a model we are leaving is explicitly rejected.
5. **The switcher is client-side aggregation** over independent per-daemon endpoints. No shared coordination registry is reintroduced; ADR-096's core holds.
6. **Status is liveness, and the discovery file is a hint.** Status-awareness derives from the daemon record's `running | stopped` liveness (`daemon.json`), not the dropped `projects.json` `active | paused | broken` health vocabulary (not surfaced by the GUI in v1). `resolveProfile` treats the discovery file as a hint and confirms **reachability** (a cheap health probe on the profile `endpoint`) before auto-selecting, so a stale `running` record never cold-opens onto a dead endpoint (#419). The no-`default` rule (#461) carries over, now sourced from liveness.
7. **URL / localStorage keys keep their shape.** `?project=<name>` and `neat:lastProject` remain names (the profile's label); only the resolution *target* changes — they resolve to the discovered, reachable profile whose `project` matches, and a stored name with no matching reachable daemon resolves to `null`, not an error.

### Consequences

- *Rework (#549), contained to the data/resolution/auth layer:* `lib/proxy.ts` (per-profile endpoint, drop prefix → root), `lib/resolve-project.ts` → profile discovery (`resolveProfile`), the ~13 `/api/*` proxy routes (drop prefix, target profile root), `/api/projects` → a daemon-discovery enumerator (`/api/profiles`), auth → per-profile (`authed-fetch.ts` / `use-auth-gate.ts` / `/login` read the profile's token, not a single `localStorage` token), `AppShell` `project`→`profile` state, and `?project=` identifier threading re-keyed to the profile.
- *Insulated:* the canvas (ELK / shapes / taxi / compound / no-reflow live model), the two-mode overlay, policies-preview, sidebar nav, ⌘K — they consume resolved data and are unaffected.
- *The seam:* hosted is reached by swapping the profile *source* + adding the bearer — no shell rewrite. This is the launch principle (local-first, hosted-additive) made concrete.
- *Operational:* the dev env must run projects as per-project daemons (orchestrator path) for the GUI to discover them.
- *Corrections folded in alongside this ADR:* the `design-system.md` Base UI clause is a `1.4.1` → `1.6.0` version bump of the same `@base-ui/react` package (handling the 1.4→1.6 API deltas), not a package swap; and `canvas-layout.md` gains two binding clauses — the observed-overlay is escapable (always-visible close, backdrop-dismiss, persistent per-project dismissal, capped card height; ref `297e081`), and Mode B requires a real audit signal (`/api/instrumentation` `engaged?`), with `resolveOverlayMode` falling back to Mode A when the signal is absent.

## ADR-103 — Hosted storage: one Postgres (relational graph + pgvector + recursive-CTE traversal)

**Status:** Accepted. Foundation of the hosted arc. The hosted counterpart to ADR-041 (local snapshot persistence); built on ADR-096 (per-project daemon shape) and the policy-overlay reasoning (L1/L2 — the graph gates, vectors reach).
**Contract:** `docs/contracts/hosted-storage.md` (new, 🟡 contract-only — opens with the hosted build).

### Context

Hosted NEAT needs a store for three jobs at once: the graph (nodes + typed, provenance-bearing edges), the embeddings behind fuzzy retrieval (`semantic_search` and the policy overlay's binding layer), and bounded-depth traversal (blast-radius, root-cause, dependencies, divergence). Local NEAT holds the graph in-memory (graphology) with a `neat-out/graph.json` snapshot (ADR-041) and embeds in-process (`search.ts`) — right for one small live graph per project. Hosted is many per-tenant graphs that must persist and be queried server-side.

The reflex options were a dedicated graph DB (Memgraph / Neo4j), a search engine (Elastic / OpenSearch), or a fork of one. Each is the wrong primitive or the wrong cost: a search engine cannot do the deterministic graph traversal that is the core; a dedicated graph server is an extra system per tenant; and Elastic (SSPL), Neo4j (GPL + Enterprise-gated multi-tenancy), and Memgraph (BSL) each carry a source-available license hostile to a managed-hosting business — which is NEAT's revenue model. Forking any of them means owning database infrastructure forever instead of building the graph product.

### Decision

Hosted NEAT stores the graph, the embeddings, and runs traversal in **one Postgres**:

1. **Relational graph.** Nodes and edges are rows; the property-graph model (type, provenance, confidence, evidence, signal) maps to typed columns / JSONB. The same node/edge/provenance model as the local graphology — Postgres is the durable form, not a different model.
2. **pgvector for the fuzzy-reach layer.** Node and policy embeddings live in a `pgvector` column; `semantic_search` and the policy overlay's binding step run as pgvector kNN — the same vector job `search.ts` does locally, at scale. Vectors retrieve; they never decide a constraint.
3. **Recursive CTEs for bounded traversal.** Blast-radius, root-cause, dependencies, and divergence run as recursive CTEs at the same depth caps as local (blast-radius ≤ 10, root-cause ≤ 5), with the same `PROV_RANK` selection and confidence cascading. Traversal stays exact and deterministic — a relational computation, not a similarity search.
4. **The policy overlay (L1/L2) runs on this store, wall intact.** Graph-pattern evaluation — the deterministic gate and the structural tail — is relational/CTE queries; the vector-reach is pgvector kNN; vectors resolve bindings upstream and never gate.
5. **No dedicated graph DB, no search engine, no fork — for launch and until recursive-CTE traversal demonstrably strains under multi-tenant load.** Postgres + pgvector are PostgreSQL-licensed: clean for a hosting business.
6. **Escape hatch, add-never-fork.** If CTE traversal strains: an **embedded** per-daemon graph engine (KùzuDB, Apache-2.0, fits the per-project-daemon shape) before an external server; a Bolt-compatible server (Memgraph) as the reversible fallback. Added behind the persistence layer, never forked.
7. **Local is unchanged.** graphology + in-process embeddings stay the local substrate (ADR-041). Hosted is an additive backend behind the same persistence seam — the storage backend is the local↔hosted swap point, consistent with the profile seam (ADR-102) and the per-project-daemon shape (ADR-096).

### Consequences

- One store, one ops surface for graph + vectors + traversal — matches the per-project-daemon shape (each tenant's graph is small and live) and avoids running a second datastore per tenant.
- The license landmine is sidestepped: PostgreSQL + pgvector carry no managed-hosting restriction, unlike Elastic / Neo4j-Enterprise / Memgraph-BSL.
- Determinism holds end to end: traversal is exact relational/CTE; vectors stay strictly upstream of the gate.
- The graph engine stays NEAT's; the database is a backend behind the persistence layer, swappable, never a fork we maintain.
- Local and hosted are one architecture at two scales: in-memory graphology locally, Postgres-backed graph hosted, the same node/edge/provenance model in both.

## ADR-104 — The contract enforcement model: four pillars, one enforcement tag per clause

**Status:** Accepted. Meta-governance — it governs how the contracts themselves are enforced. Frames the governance-kernel arc (ADR-093 / 094 / 095), which realizes its strongest pillar.
**Contract:** `docs/contracts/contract-enforcement.md` (new).

### Context

The contract system stores prose and surfaces it three ways: the session-start index, the PreToolUse hook at edit time, and a handful of assertions in `contracts.test.ts`. The first two are advisory — they show an agent the rule and trust it to comply. That is the exact failure mode NEAT exists to remove: an agent reading text and trying to remember it, instead of querying ground truth. Most contracts are held by discipline, not a mechanism, and nothing flags which ones.

Enforcement cannot be one mechanism, because a contract carries four different kinds of clause, each with a different right tool.

### Decision

1. **Enforcement matches the clause type — four pillars.**
   - **Syntactic / structural → lint + CI** (`contracts.test.ts`). "Ids via helpers, never literals," "no raw provenance strings," "single-source the MCP manifest." Grep/AST assertions that fail the build. The pillar exists; the work is widening coverage.
   - **Architectural / topological → NEAT-on-NEAT** (graph patterns over NEAT's own graph, gated by the governance kernel). "MCP is read-only," "no daemon code reads the client profile store," "the CLI and MCP share one REST helper." These are graph queries over the codebase's own topology. The strongest pillar and the north star — proven reachable because `divergences.ts` already evaluates graph patterns over the graph. Opens as ADR-093/094/095 build.
   - **Behavioral / runtime → the breaker** (the outsider e2e harness). "Reads route to the selected endpoint, never swap," "resolution never throws," "the flow works end to end." Static analysis cannot see these; the harness drives the real system. The pillar exists; it grows one assertion per contract.
   - **Semantic / intent → review** (human + LLM). "Forward-looking framing," "provenance is the load-bearing semantic." These resist mechanization; they stay review, and we stop calling them enforced.
2. **Every contract carries an `enforcement:` tag.** A frontmatter field `enforcement: [lint | breaker | policy | review]` names which pillar(s) hold each contract. The tag makes "this is unenforced prose" visible rather than discovered late. An untagged contract is treated as `review` until tagged.
3. **New contracts ship enforced.** A new contract ships with its `enforcement:` tag and at least one *active* pillar (`lint` or `breaker`) — or, if genuinely unmechanizable, an explicit `review` with a one-line reason. No new prose-only contracts. Existing contracts get tagged in a backlog pass; tagging is cleanup, not blocking.
4. **NEAT-on-NEAT is the destination.** The contract system asking an agent to read prose and self-comply is the brute-force pattern NEAT replaces. The end state for the `policy` pillar is NEAT enforcing its own architectural contracts — each compiled to a graph-pattern policy over the self-graph, evaluated deterministically and gated by the kernel. That is both enforcement and the strongest launch proof. It depends on the kernel and on the self-graph reaching the grain these rules need (ADR-092 gives file/import grain today; mutation grain is future), so the pillar lands partial and grows.

### Consequences

- Enforcement stops being one-size-fits-all: each clause routes to the tool that can actually decide it.
- The unenforced surface becomes visible (the tag) and shrinkable on purpose, instead of unknown.
- The breaker and `contracts.test.ts` are recognized as the two *active* pillars today; the policy overlay is the third, opening with the governance-kernel arc; review is the honest fallback, not a pretense.
- New contracts cannot quietly add prose-only rules — the binding rule forces a pillar or an explicit `review`.
- The governance-kernel work (ADR-093/094/095) is framed: that arc is not only a product feature, it is how NEAT enforces itself.

## ADR-105 — The policy overlay (L1): graph constraints over the graph, vectors for reach, a deterministic gate

**Status:** Accepted. Opens the governance-kernel arc — the representation the ADR-093 (gate) / ADR-094 (FRONTIER) / ADR-095 (divergence-as-bundle) contracts are written against. It is the machinery of the `policy` enforcement pillar (ADR-104) and sits on the hosted substrate (ADR-103). It generalizes the policy schema (ADR-042) rather than superseding it.
**Contract:** `docs/contracts/policy-overlay.md` (new, 🟡 contract-only — opens with the kernel build).

### Context

Policies, divergences, and the `policy` enforcement pillar all need one representation: how a rule is expressed, bound to graph elements, evaluated, gated, and explained. Derive it from function, not taste — the layer's decisive operation is **evaluate** (does the constraint hold against the graph), so judge each candidate representation by whether it can *evaluate a constraint*, not store one.

- **Vectors fail the decisive test.** A constraint is structural (the presence/absence of typed edges); similarity has no notion of satisfaction. Two graphs that differ by one edge — one violating, one not — can have arbitrarily close embeddings, so no function of similarity computes the predicate. A vector can say a policy is *about* some nodes; it cannot say it is *violated*.
- **A flat schema passes but rigidly.** The five-type `policy.json` (ADR-042) evaluates via per-type dispatch code, so a new constraint shape needs new code and flat records do not compose.
- **A graph pattern passes natively.** A policy expressed in L2's own node/edge vocabulary is a stored graph query — a forbidden or required subgraph. Evaluation is a subgraph match: deterministic, composable (multi-hop is free), and the matched subgraph *is* the explanation. `divergences.ts` already works this way (`missing-observed` = "an EXTRACTED edge with no OBSERVED twin"), so the representation is in use, not theoretical; ADR-095 makes user-authored policies the same kind of object.

### Decision

1. **L1 (the policy overlay) has the same recipe as L2 — graph + schema + vectors — but its content is constraints over L2, not facts about the world.**
   - **Graph = the gate.** A policy is a stored graph query / pattern in L2's vocabulary. Evaluation = subgraph match against L2 (current state, or the proposed `real ∪ delta` state for gating, ADR-093). Deterministic; the matched subgraph is the explanation.
   - **Schema = the grammar.** A policy's well-formedness — action (`log` / `alert` / `block`), severity, scope, provenance — generalizing ADR-042's flat form (which is the rigid per-type special case).
   - **Vectors = reach.** Resolve fuzzy predicates → concrete L2 ids ("billing data" → node ids), classify novel/FRONTIER nodes (ADR-094), power policy discovery. They run **strictly upstream** of the gate and are **frozen into the policy before evaluation**; they never enforce.
2. **The wall: graph gates, vectors reach.** Enforcement is the deterministic graph-pattern match; the vector layer only ever resolves bindings before the match runs. Determinism holds end to end (NEAT's load-bearing word) — a constraint never fires on a similarity threshold.
3. **A policy is a stored graph query plus an action**, evaluated continuously against current L2 (the flag path — facts) or against the proposed state (the gate path — proposals, ADR-093).
4. **Retrieval is two-mode, matched to objective.** Fuzzy search for recall over the obvious/semantic majority; graph traversal for the worst-case structural tail — the far-away, unique, codebase-breaking constraint that similarity ranks low *because* it is unique. Union for surfacing; **graph-only for the gate.** A guardrail needs worst-case coverage, so the graph is non-negotiable on the tail.
5. **Policy-blast-radius injection** is how the overlay reaches an agent. On an edit or read at node A, traverse the overlay from A's node(s) and inject the relevant policies — including far-away ones reachable through real edges. Relevance = the policy's declared **propagation scope × graph distance** (confidence-decayed), so a downstream-breaking invariant surfaces while a local style rule three hops away does not. Injection points: the PreToolUse hook (edit-time) and the MCP read surface (read-time). The far-away constraint surfaces because the graph knew `A → … → X`, not because the agent searched.
6. **Substrate.** Local: graphology + in-process embeddings. Hosted: Postgres — graph patterns as recursive CTEs, vector reach as `pgvector` kNN (ADR-103).
7. **Relation to the kernel ADRs.** ADR-093 (the gate: propose → evaluate-proposed → allow/refuse) runs L1 against `real ∪ delta`. ADR-094 (FRONTIER staged-proposal) is the lifecycle of a proposed node the vector classifier first-guesses policies for. ADR-095 (divergence-as-bundle) is L1's first built-in bundle — the five divergence patterns. Their contracts are written against this representation.

### Boundary (stated, not overclaimed)

Pure subgraph-existence covers **relational / architectural** constraints — the ones that matter for governance. Constraints that *count* ("≤ 3 services depend on X"), *threshold a signal* ("p99 < 200ms"), or reason over *time* are extensions to the query language (aggregation over L2) — still deterministic, still evaluated over L2, but beyond plain subgraph isomorphism. "Graph pattern" sometimes means "graph query with aggregation."

### Consequences

- One representation serves policies, divergences, and the `policy` enforcement pillar — they are all constraints over L2.
- Determinism is preserved: the gate is an exact graph match; vectors stay strictly upstream and frozen.
- `divergences.ts` is the working proof and the migration path for ADR-095.
- This governs the ADR-093/094/095 contracts and opens the kernel arc.
- It runs on ADR-103's substrate — graphology locally, `pgvector` + recursive CTEs hosted — so local and hosted evaluate the same way at two scales.

## ADR-106 — The autonomous-remediation runner ("run agents in your code")

**Status:** Accepted. The agent layer on the governance kernel. Built on the policy gate (ADR-093), FRONTIER staging (ADR-094), the policy overlay (ADR-105), blast-radius (ADR-038), the client profile seam (ADR-102), and hosted storage (ADR-103). Governs ahead of code (the "all prose first" call) at **seam-altitude** — the loop and the invariants are fixed; the mechanics open with the build.
**Contract:** `docs/contracts/autonomous-remediation.md` (new, 🟡 contract-only).

### Context

The live site's "for new features, by sandbox" card (Soon) — *an agent proposes a feature as a sandboxed experiment, checks its blast radius, and ships to main only when it's safe* — is the autonomous-remediation story. It needs a **runner** that executes propose → assess → gate → graduate on top of the kernel. "Run agents in your code" (local) and "remediation by us" (hosted) are the two faces of the same loop.

### Decision

The runner is a four-step loop, each step delegating to an existing layer — it adds orchestration, not new trust:
1. **Propose.** Stage the intended change as `FRONTIER` edges (ADR-094) — a proposal, not yet real.
2. **Assess.** Compute blast radius (ADR-038) and evaluate the policy gate against the proposed state `real ∪ delta` (ADR-093 / ADR-105 gate path).
3. **Gate.** A `block` violation **refuses** the proposal; nothing lands. A pass **graduates** the FRONTIER edges to OBSERVED. NEAT never auto-applies past a `block`; only a human overrides one (ADR-094).
4. **Watch.** An observation window confirms the change in production; unconfirmed proposals are **culled** (ADR-094).

- **Local form** ("run agents in your code"): the runner drives against the local daemon/graph.
- **Hosted form** ("remediation by us"): NEAT runs the loop as the **execution venue** (ADR-107).
- **Determinism holds:** the agent *proposes*; the deterministic policy-overlay gate *decides*. The vector/LLM is upstream of the gate, never the gate (ADR-105).
- Mechanics deferred to the build: the agent harness, the sandbox environment, the apply mechanism, the watch-window policy.

### Consequences

- The marketed "sandbox feature" / autonomous remediation is governed and sits *entirely* on the kernel — it introduces no new enforcement primitive.
- Hosted is its venue; the determinism wall keeps it safe; a human owns every `block` override.
- Net-new orchestration surface only; the trust comes from layers already governed.

## ADR-107 — Hosted platform: the managed NEAT suite (Supabase-shape)

**Status:** Accepted. The hosted arc's platform layer — the outer wrapper around the unchanged local core. Built on the client profile seam (ADR-102), hosted storage (ADR-103), and the remediation runner (ADR-106). Seam-altitude; mechanics open with the build.
**Contract:** `docs/contracts/hosted-platform.md` (new, 🟡 contract-only).

### Context

Hosted NEAT is the **full managed suite (Supabase-shape)** — graph, daemon, the remediation runner, dashboard, auth, and the CLI/MCP endpoints, managed — not a read replica. The business model is FOSS local + paid managed hosting; the launch is local-first, hosted ~1–2 weeks later, **additive** (no core rewrite).

### Decision

Hosted is an **outer layer wrapping the tenant-agnostic local core.**
1. **Auth + multi-tenancy** live in the outer layer: per-tenant isolation, bearer tokens. The GUI / CLI / MCP reach a tenant's daemon through the **profile** (ADR-102); the *only* difference from local is the profile **source** and the bearer.
2. **Profile source = the platform's project list** — the single local↔hosted swap point (ADR-102 §7). Local enumerates `~/.neat/daemons/*.json`; hosted enumerates the platform list. Same clients, same code path.
3. **Storage = Postgres + pgvector** per ADR-103.
4. **The remediation runner (ADR-106) runs hosted "by us"** — hosted is its execution venue.
5. **The core stays tenant-agnostic.** Graph engine, daemon, MCP know nothing of tenants; tenancy, billing, and auth are the outer layer. Hosted **wraps, never forks.**
- Mechanics (the control plane, tenant provisioning, billing, the auth provider) open with the build.

### Consequences

- Hosted hooks in additively — swap the profile source, add the bearer — so the local product stands alone and the hosted layer wraps it.
- One architecture at two scales; the seam is the profile source, exactly as ADR-102 fixed it.
- The runner has a managed venue; the FOSS core is unencumbered by tenancy concerns.

## ADR-108 — Policies as a soft guardrail (the launch MVP)

**Status:** Accepted. The launch form of policies — distinct from, and a precursor to, the hard kernel gate (ADR-093). Built on the policy overlay (ADR-105 §5 injection), policy schema/eval (ADR-042 / ADR-043).
**Contract:** `docs/contracts/policies-soft-guardrail.md` (new).

### Context

The live site promises *"every agent stays inside the lines… dynamic guardrails as plain JSON rules."* The hard enforcement — the kernel gate that *blocks* a violating change (ADR-093) — is post-v0.5. For a truthful launch, policies ship as a **soft guardrail**: the relevant policies are injected into the agent's working context so it is *aware* of the rules, not blocked by them. This is policy-blast-radius injection (ADR-105 §5) **without the gate**.

### Decision

At launch, policies are a soft guardrail delivered by **context injection, not a gate.**
1. **Surfacing** = the policy overlay's blast-radius injection (ADR-105 §5): for the node/region the agent is working in, surface the reachable policies — including the far-away ones a similarity search would miss.
2. **Delivery** = the MCP read surface (`check_policies` returns the applicable policies as context) plus a memory/context hook ("a hook to the top of agent memory").
3. **It informs, it does not block.** The hard gate is the kernel (ADR-093), post-launch; the soft guardrail never refuses an action.
4. **Authoring stays plain `policy.json`** (ADR-042) — no new authoring surface.
- The soft guardrail is the launch-truthful reading of "stays inside the lines"; it graduates to the hard gate when the kernel lands.

### Consequences

- The marketed "guardrails" claim is truthful at launch — soft and informative, honestly not a blocker.
- It is policy-blast-radius injection minus the gate, so the kernel upgrade is additive (add the gate, keep the injection).
- Cheap to ship; sits on the overlay already governed by ADR-105.

## ADR-109 — Time travel deferred to "Soon" for launch

**Status:** Accepted. A launch-scope + truthfulness decision. No build; it relabels a marketing claim. No contract (nothing is built).
**Contract:** none.

### Context

The live site states, present-tense, *"NEAT remembers every state of your code and your traffic. Walk them back… finds exactly when a bug began."* This is unbuilt — only `get_graph_diff` and snapshots (ADR-041) exist, which are partway but not the full temporal walk-back. For a sprint whose definition is *behavior matches claims*, an unlabeled present-tense claim that isn't built is exactly the divergence to close.

### Decision

Time travel is **deferred for launch and relabeled "Soon"** on the marketing site — the same treatment as the sandbox-feature card. No temporal-graph build for launch; the existing snapshot / `get_graph_diff` mechanisms stay as they are and are **not** marketed as time travel. When it is built later it gets its own ADR + contract (temporal snapshots + a walk-back query, leveraging the existing snapshot and graph-diff machinery). The launch action is a **site-copy change** (`neat.is` / `neat-web-v1`) — outside this repo — flagged as a separate task.

### Consequences

- The present-tense claim becomes truthful (labeled future); zero build risk under launch pressure.
- The launch NEAT's behavior matches its (relabeled) claims — the sprint's whole point.
- The eventual build is a clean future ADR, not a rushed launch feature.

## ADR-110 — Blast radius is the inbound-dependents traversal (supersedes ADR-038's direction)

**Status:** Accepted. Supersedes the walk *direction* of [ADR-038](#adr-038--getblastradius-contract); ADR-038's depth (10), positive-distance, per-path + cascaded-confidence, and schema validation all stand.
**Contract:** [`get-blast-radius.md`](contracts/get-blast-radius.md) (+ `policy-schema.md` blast-radius rule, `contracts.md` index row).

### Context

"What breaks if X changes, fails, or is removed?" is the set of nodes that **depend on** X — its dependents. An outbound walk (the origin's dependencies, the direction `get_dependencies` already serves) answers a different question, and returns an empty blast radius for every sink — databases, shared libraries, configs — which are exactly the nodes an agent asks "what depends on this?" about.

### Decision

`getBlastRadius` walks **inbound** edges (the origin's dependents) via `bestEdgeBySource`, to the same default depth 10, returning every transitive dependent with distance, path, and cascaded confidence. Upstream-dependency enumeration keeps its home in `getTransitiveDependencies` / `get_dependencies` (outbound). The `blast-radius` policy rule counts dependents. This reuses the same inbound edge-selection + FRONTIER-termination machinery `getRootCause` walks; blast radius differs only in enumerating every dependent rather than stopping at the first incompatibility.

### Consequences

- The headline "what breaks if I change this?" query returns real dependents for sinks instead of `[]`.
- `rest-api.md`, the `contracts.md` index, and `policy-schema.md` are reconciled to the inbound direction.

## ADR-111 — The trace stitcher is scoped to runtime dependency edge types (amends ADR-034)

**Status:** Accepted. Amends [ADR-034](#adr-034--trace-stitcher-contract) with a binding edge-type allowlist.
**Contract:** [`trace-stitcher.md`](contracts/trace-stitcher.md).

### Context

ADR-034's stitcher fires on ERROR spans and walks EXTRACTED outbound edges to depth 2, gated on `provenance === EXTRACTED` alone. Provenance is not a sufficient gate: an error span reaching a **structural** edge (`CONTAINS` / `IMPORTS` / `CONFIGURED_BY`) mints a low-confidence INFERRED twin of it, and since INFERRED outranks EXTRACTED in `PROV_RANK`, a consumer query then surfaces the 0.6 guess in place of the 0.85 ground-truth static fact. The trust signal is the point: an unrelated request erroring must not restate a static containment or import as a runtime inference.

### Decision

The stitcher considers an EXTRACTED edge only when its `type` is a **runtime dependency** type — `CALLS` / `CONNECTS_TO` / `DEPENDS_ON`. Structural types (`CONTAINS` / `IMPORTS` / `CONFIGURED_BY` / `RUNS_ON`) are never stitched and the BFS never recurses through them. Structural facts stay EXTRACTED until static extraction says otherwise; the stitcher gets no vote. `PUBLISHES_TO` / `CONSUMES_FROM` stay out of the allowlist pending their own ADR.

### Consequences

- A static containment/import edge keeps its EXTRACTED trust regardless of runtime errors.
- The stitcher's honest case — bridging a sync dependency OTel couldn't instrument (ADR-014) — is preserved.

## ADR-112 — Daemon fault model: OTLP-port stepping, ingest fault containment, crash reconciliation (amends ADR-049 / ADR-063 / ADR-096)

**Status:** Accepted. Amends the daemon binding + lifecycle contracts (ADR-049, ADR-063) and the per-project daemon record (ADR-096).
**Contract:** [`daemon.md`](contracts/daemon.md), [`project-daemon.md`](contracts/project-daemon.md).

### Context

ADR-049/063 make *any* failure to bind fatal, to hold shut the "supervisor up, nothing bound" mode. Real deployments need finer distinctions: a foreign collector commonly holds the default OTLP `:4318`; a single ingest fault should not dark the whole OBSERVED layer; a crashed daemon that leaves a `running` record misroutes the next client; `neat watch` binds an OTLP port an instrumented app must be able to resolve; and a same-port IPv6 listener shadows an IPv4-only bind.

### Decision

- **REST bind stays fatal** — it is the daemon's spawn-reuse `/health` identity and must never move silently under a client.
- **A held OTLP port steps** to the next free port and records the bound port in `daemon.json` (every consumer resolves `ports.otlp` dynamically). Only a non-`EADDRINUSE` failure or an exhausted step window aborts. A stepped-but-bound receiver is discoverable — distinct from the "nothing bound" failure the fatal clause holds shut.
- **Ingest fault containment is `unhandledRejection`-only.** A rejected promise that escapes the drain loop is logged and the daemon keeps serving. An **`uncaughtException` stays fatal** — the process is in an undefined state after one, so it exits loud rather than serve from corrupt state.
- **Crash reconciliation:** the daemon marks its `daemon.json` `stopped` and clears its discovery copy on exit — graceful `stop()` first, a process-exit handler as the backstop for the unsupervised case.
- **`neat watch` writes `daemon.json`** with its real REST + OTLP ports; the free-port probe checks **both IP families** of the bind interface.

### Consequences

- The OBSERVED layer survives a busy machine and a bad span, while an `uncaughtException` still fails loud.
- Dead daemons stop misrouting clients; watch-instrumented apps resolve the right OTLP port; dual-stack port collisions are caught.

## ADR-113 — OTLP ingest: single-project span-ownership scoping, richer incident messages, one-incident-per-request (amends ADR-033 / ADR-096)

**Status:** Accepted. Amends [ADR-033](#adr-033) (OTel ingest) and ADR-096 (single-project ownership).
**Contract:** [`otel-ingest.md`](contracts/otel-ingest.md).

### Context

The single-project daemon binds the shared default OTLP endpoint, which a sibling service of a *different* project reaches with default exporter settings — delivering its spans mints that service's ServiceNode + incidents into this project's graph. Separately, an incident reads `'unknown error'` when the failing span carries no exception event (an HTTP 5xx, a gRPC status, a connection refusal), and one failed request yields two records — the span that threw plus a synthesized HTTP echo.

### Decision

- **Ownership scoping:** single-project delivery is scoped to owned services — no `service.name` (routes to `service:unidentified`), a name matching the project the way the multi-project router matches, or an existing ServiceNode. A foreign span quarantines to the unrouted ledger instead of merging. ADR-096's per-project OTLP-port isolation stays the primary defense; this covers the shared-port fallback.
- **Incident messages:** the chain reads HTTP failure context ("500 on GET /users/:id"), then non-HTTP (gRPC status via the fixed `grpc/status.proto` enum kept as an `ingest.ts` constant, or a connection error) before the `'unknown error'` floor.
- **One incident per request:** a read-time collapse drops a synthesized HTTP echo that shares `(traceId, affectedNode)` with a real failure incident; the cross-service caller/callee split (different `affectedNode`s) is preserved. The sidecar stays append-only.

### Consequences

- No cross-project contamination on the shared port. Trade: a brand-new *owned* service NEAT can't read statically and whose name doesn't echo the project name has its first spans quarantined until an extraction round registers it — small and self-healing.
- Incidents carry real messages; a failed request counts once.

## ADR-114 — Root cause follows the failing CALLS chain across services (amends ADR-037)

**Status:** Accepted. Amends [ADR-037](#adr-037--getrootcause-contract) with a cross-service localization path.
**Contract:** [`get-root-cause.md`](contracts/get-root-cause.md).

### Context

ADR-037 walks incoming edges from the origin. An entry service surfaces a failure that originates downstream — nothing calls the entry service, so the incoming walk is empty and incident matching against the origin attributes the caller's CLIENT-side 500 to the entry service, naming a route it never serves.

### Decision

For a `ServiceNode` origin, before consulting its own incidents, `getRootCause` follows the **outbound failing CALLS chain** (`signal.errorCount > 0`, deterministic tie-break on error count → `PROV_RANK` → target id) to the deepest still-failing callee — the culprit — then localizes it through the incident store (handler `file:line` / `http.route`). The failing edges become the leading `traversalPath` hops. Cross-service confidence cascades over those edges + the incident hop, sitting below an edge-walked compat result. When no outbound call is failing, the failure is in-process and it falls through to the origin's incidents.

### Consequences

- Cross-service root-cause names the real downstream culprit instead of the entry service.

## ADR-115 — url-literal-service-target grade + infra CONNECTS_TO extraction (amends ADR-066 / ADR-032)

**Status:** Accepted. Amends [ADR-066](#adr-066) (confidence grading) and the static-extraction producer scope (ADR-032).
**Contract:** [`static-extraction.md`](contracts/static-extraction.md), [`divergence-query.md`](contracts/divergence-query.md).

### Context

A declared-but-never-driven in-mesh HTTP dependency — a scheme-qualified URL literal naming another service — grades below the precision floor as `hostname-shape-match` (0.2) and drops, so no EXTRACTED CALLS edge exists for `missing-observed` to measure and the dead dependency stays out of the graph (the OBSERVED-thesis blind spot). Infra producers (terraform / Dockerfile) emit orphan nodes, so declared-but-unused infra reads the same as in-use.

### Decision

A scheme-qualified URL literal (`http://service-c:3102`) whose hostname exactly matches a registered service's name/dir/alias (via `urlMatchesHost` — scheme + exact host + exact port when present) is a **declared HTTP dependency**, graded `url-literal-service-target` **at** the precision floor — below `verified-call-site` (0.85, since no call expression wraps it) and above `url-with-structural-support` (0.5). It enters the EXTRACTED layer so `missing-observed` can measure it; a bare hostname token still grades 0.2 and stays out. Infra producers emit `CONNECTS_TO` with populated evidence so declared infra connects to the services that use it. `divergence-query.md` §5a names this a third evidence class backing `missing-observed`.

### Consequences

- A declared-but-dead upstream surfaces as `missing-observed`; infra topology (declared-vs-in-use) is answerable.

## ADR-116 — Query-surface parity: observed-dependencies REST route, incident-history REST route, registry daemon resolution (amends ADR-039 / ADR-040 / ADR-050)

**Status:** Accepted. Amends the MCP allowlist (ADR-039), REST endpoint set (ADR-040), and CLI daemon resolution (ADR-050).
**Contract:** [`rest-api.md`](contracts/rest-api.md) (+ the `getObservedDependencies` behavior in `traverse.ts`).

### Context

`get_observed_dependencies` / `get_incident_history` exist as MCP tools with no REST equivalent (the graph-query names 404). `observed-dependencies` reads direct edges off the service node and so misses the file-grained OBSERVED edges the call-site processor lands on the files a service owns. CLI query verbs default to `:8080` and cannot reach a non-default project's daemon.

### Decision

Add `GET /graph/observed-dependencies/:nodeId` and `GET /graph/incident-history/:nodeId` mirroring the MCP tools. `observed-dependencies` walks one `CONTAINS` hop to a service's files and surfaces their OBSERVED edges file-grained (respecting file-awareness §3 — no synthesized service→target rollup), and distinguishes a pure receiver ("observed inbound, no outbound") from a never-observed node. `resolveDaemonUrl` resolves the requested project's REST port from `~/.neat/daemons/<project>.json`, with env-pin precedence and a loopback fallback.

### Consequences

- REST/MCP parity; `observed-dependencies` returns the real runtime dependency; CLI reaches any project's daemon.

## ADR-117 — Incident recording covers any failure span, not only HTTP status (amends ADR-033 / ADR-113)

**Status:** Accepted. Amends [ADR-033](#adr-033) (OTel ingest) and ADR-113 (incident messages). A bounded slice of the OBSERVED-coverage work; the queue/inbound *edge* coverage stays with #576.
**Contract:** [`otel-ingest.md`](contracts/otel-ingest.md).

### Context

An incident records when a span carries HTTP failure signal. An async worker's failure — a queue job (bullmq / Redis Streams) or a background task that throws — carries an ERROR span status and an `exception` event but no HTTP response context, so it produces no incident. A whole class of runtime failures (async / queue / worker) stays out of `/incidents` and out of root-cause.

### Decision

Incident recording triggers on **any failure span** — an ERROR span status (`statusCode === 2`) or an `exception` event — independent of HTTP context. An async/worker failure records an incident attributed to its service, and to the handler file/line when the span carries `code.filepath`. The message follows the ADR-113 chain (exception → HTTP context → non-HTTP → `'unknown error'` floor). The existing HTTP-status path is a subset of this; the `(traceId, spanId)` and one-incident-per-request collapses (ADR-113) apply unchanged.

### Consequences

- Async / queue / worker failures become visible to `/incidents` and `get_root_cause`.
- Edge coverage across the queue boundary — the consumer-side OBSERVED edge — remains #576's inbound/in-process work; this ADR covers incident visibility, not topology.

## ADR-118 — In-process database spans mint a file-grained CONNECTS_TO edge (amends ADR-033)

**Status:** Accepted. Amends [ADR-033](#adr-033) (OTel ingest). The first cut of #576's OBSERVED-coverage work; the inbound-server liveness edge and the queue / GraphQL / gRPC / WebSocket boundaries stay deferred to later cuts.
**Contract:** [`otel-ingest.md`](contracts/otel-ingest.md).

### Context

A database span mints its CONNECTS_TO OBSERVED edge by resolving the datastore host from the span's peer address (`server.address` / `net.peer.name`). A networked database — Postgres, a remote Redis — carries that address, so the edge lands. An in-process / embedded database — SQLite, better-sqlite3, an in-memory store — crosses no network boundary and carries no peer address, so host resolution finds nothing and the edge has no target to point at. A leaf service that serves requests and reads its own embedded database is the shape most of the OBSERVED thesis rides on, and its datastore reads are the edges that make that service legible.

### Decision

An in-process database span mints the same file-grained service→database CONNECTS_TO OBSERVED edge a networked one does. When a `db.system` span carries no resolvable peer address, ingest keys the DatabaseNode on a service-scoped local identity — `localDatabaseId(service, name)` → `database:<service>/<name>`, where `name` is `db.name` when present and the engine string otherwise. Service-scoping keeps two services that each read their own `app.db` on distinct nodes rather than collapsing onto one. The node records no host — an embedded database has no network host, and evidence is never fabricated (file-awareness.md §6), so host-mismatch divergence cleanly skips it.

The edge is file-grained through the existing call-site plumbing: the span processor stamps `code.*` on the synchronous DB CLIENT span (file-awareness.md §4), so the edge originates from the caller's FileNode at the exact file:line, reconciled onto the EXTRACTED path (`reconcileObservedRelPath`, #602) so the OBSERVED and EXTRACTED layers fuse into one node rather than a twin. This reuses the #526 / #536 call-site attribution work rather than inventing a new path.

### Consequences

- A leaf service reading an embedded database now carries a file-grained CONNECTS_TO edge to it — the coverage #546 (a silent sqlite3 CRUD server) named.
- The local-DB identity is service-scoped and env-unscoped, consistent with `databaseId` (env-dimension.md — DatabaseNode identity stays env-unscoped). `localDatabaseId` is a new identity helper; no schema field is added and no snapshot migration is needed (`DatabaseNode.host` was already optional).
- Inbound-server liveness edges, and the queue / GraphQL / gRPC / WebSocket and non-DB in-process boundaries, remain deferred to #576's later cuts.

## ADR-119 — HTTP client call-site + cross-service route matching

**Status:** Accepted. First slice of #595 (static extraction beyond file grain). Advances #592 (declared-vs-observed on the static half). Pairs with #576 (OBSERVED route-grained server edges), in parallel flight.
**Contracts:** [`static-extraction.md`](contracts/static-extraction.md), [`divergence-query.md`](contracts/divergence-query.md).

### Context

Static extraction stops at the file. An HTTP client call resolves to the *service* it names (`url-literal-service-target`, ADR-115) and no further; the server side has no route representation at all. So the two static halves of an HTTP call — the client that declares "I call service X" and the server that declares "I serve GET /users/:id" — never meet, and divergence is one-sided on the static tier: there is no declared route surface for an observed server span to be compared against. Closing that is what makes the OBSERVED thesis two-sided at the grain agents actually reason about — the specific endpoint, not the whole service.

### Decision

Extraction reaches route grain, scoped to HTTP client↔route matching for mainstream routers and clients. Three things ship together:

1. **Client call-site capture with method + path-template.** The HTTP client extractor recognizes real call expressions — `fetch`, `axios` (default instance, method calls, and `axios({url,method})`), and node `http`/`https` `.request`/`.get` — and captures the HTTP method and the URL path-template alongside the host, at file:line. Template-literal interpolations (`${id}`) are reconstructed as a `:param` segment. The pre-existing host-level `file ──CALLS──▶ service` edge is unchanged; method/path capture is additive.

2. **Server-route extraction.** A new producer (`extract/routes.ts`) reads a mainstream router's route table and materializes each route as a `RouteNode` at `(method, path-template)` grain, owned by its service through a `service ──CONTAINS──▶ route` edge (structural, evidence pinned to the defining file:line). Supported routers: Express (`app`/`router.<method>`), Fastify (`.get(...)` and `.route({method,url})`), and Next.js (app-router `route.*` handler exports, `pages/api` handlers). The node id is `routeId(service, method, pathTemplate)` → `route:<service>:<METHOD> <tmpl>`, holding the router's *declared* template verbatim so an OBSERVED server span carrying the same `http.route` lands on the same node.

3. **Cross-service matching.** A matcher (`extract/calls/route-match.ts`) resolves each client call site to the server route it names: the host through the existing `urlMatchesHost` / service-alias resolution (ADR-065 #5), and the path through a param-agnostic normalization (`normalizePathTemplate` — every dynamic segment, whether `:id`, `{id}`, `[id]`, a `${…}` interpolation, or a concrete id, collapses to `:param`; literals lowercase) so `/users/:id`, `/users/123`, and `/users/${id}` all agree. A match mints a route-grained `file ──CALLS──▶ route` EXTRACTED edge from the client's FileNode to the server's RouteNode, carrying the method + path-template on its evidence. This is the cross-service contract matching that bridges the two static islands.

Route extraction runs before the calls phase so the matcher sees the full route table. Coverage is a dependency-gated registry — a service is read for routes only when its manifest names a supported router — and the set grows one router at a time, the same way instrumentation coverage grows. Exhaustive router/client heuristics are a non-goal.

### Grading

A matched client↔route edge grades `verified-call-site` (0.85, ADR-066): both endpoints are recognized — a framework-aware client shape on one side, a parsed route definition on the other — which is tighter than the `url-literal-service-target` (0.7) host-only claim and clears the precision floor. No new confidence kind is introduced; the existing tier's meaning is extended to name the route match. The `RouteNode` is a graph node, not gated by the floor; its `CONTAINS` edge is `structural`.

### Schema

`RouteNode` joins `NodeType` and the `GraphNode` discriminated union (additive growth, ADR-031); `EdgeEvidence` gains optional `method` / `pathTemplate` (present only on client↔route edges). `routeId` / `parseRouteId` are the identity helpers. The schema snapshot is regenerated in the same change; no persist.ts migration is required, since old snapshots simply carry no route nodes and remain valid.

### Divergence

Because the `RouteNode` is the shared target an OBSERVED server-span edge lands on (#576), `get_divergences` compares declared against observed at route grain — the file-awareness §7 "shared grain" principle applied one level finer, same `(source, target, type)` triple with a route as the target. The five divergence types and their weighting are unchanged; a route-grained edge is an ordinary EXTRACTED CALLS edge to the query. What improves is precision: the target now names the specific endpoint both sides are talking about, not just the service.

### Scope / non-goals

Mainstream routers + clients only. Mount-prefix resolution (`app.use('/api', router)`), split base-URL + path across variables, Express `.route().get()` chaining, axios-instance (`axios.create`) tracking, and the general symbol/intra-file call graph are out of scope for this slice and left for later #595 work. The host and path must sit in the same URL literal for a match.

### Consequences

The static tier now carries a route surface that pairs with runtime for a file-precise, two-sided divergence — the cross-service contract check the divergence surface now gains. It costs a new node type, two new producers, and a registry that has to grow to keep pace with the router ecosystem; that growth is bounded and incremental by design. Amends the static-extraction and divergence-query contracts.

## ADR-120 — OTLP ingest signals when it rejects unauthenticated spans (extends ADR-073 §4)

**Status:** Accepted. Extends [ADR-073](#adr-073) §4 (bearer on `/v1/traces`). Applies the `otel-ingest` contract's standing "diagnostic visibility beats silent drop" position to the auth-rejection path; no contract behavior is amended, so this ADR records the activation for the ledger.
**Contract:** [`otel-ingest.md`](contracts/otel-ingest.md).

### Context

A token-secured daemon requires a valid bearer on `/v1/traces` and answers a request without one with a `401`. On that path there is no server-side signal, so an operator whose instrumented app is missing `NEAT_OTEL_TOKEN` (or carries the wrong one) sees an empty OBSERVED layer with no indication why. The `otel-ingest` contract holds that a diagnostic beats a silent drop; the auth-rejection path is where that principle applies, and a missing ingest token is the first footgun a real deployment meets.

### Decision

When the OTLP receiver rejects a request for a missing or invalid bearer, it emits a **rate-limited** server-side warning (one line per 60s) naming the cause and the remedy — set `NEAT_OTEL_TOKEN` on the instrumented app. The signal is scoped to the OTLP ingest path: the REST bearer gate stays quiet, because a human running `curl` against the API needs no nudge, whereas an app failing to deliver telemetry fails invisibly. The `401` response body and status and the bind-authority gate are unchanged — this is diagnostics, not a protocol change. It rides an optional reject hook on the shared bearer middleware that only the OTLP receiver wires.

### Consequences

- A misconfigured exporter surfaces on the daemon and gives the operator a lead rather than an empty graph.
- Rate-limiting keeps a chatty misconfigured client from flooding the log.
- Authenticated ingest is untouched; no behavior change on the happy path.

## ADR-121 — Queue producers and consumers mint file-grained OBSERVED messaging edges (extends ADR-118)

**Status:** Accepted. Extends [ADR-118](#adr-118) (in-process file-grained OBSERVED edges); refs #614. A further cut of #576's OBSERVED-coverage work — the queue boundary. The worker-failure incident half shipped in ADR-117.
**Contract:** [`otel-ingest.md`](contracts/otel-ingest.md).

### Context

The OBSERVED layer maps a span's caller/producer side to a graph edge. For queues that mapping is asymmetric: the caller-side gate (`spanMintsObservedEdge`) admits only CLIENT and PRODUCER wire kinds, so a queue **consumer** (CONSUMER, wire kind 5) mints nothing from its own side — its only observed trace is a possible service→service `CALLS` via the parent-span fallback, which reads decoupled async messaging as a synchronous call. A PRODUCER messaging span, routed through the generic cross-service branch, mints a `CALLS` edge to the **broker host** rather than the topic. Meanwhile the static extractor (`extract/calls/kafka.ts`) mints EXTRACTED `PUBLISHES_TO` (producer→topic) and `CONSUMES_FROM` (consumer→topic) edges to an `infra:kafka-topic:<topic>` node. Declared queue topology therefore has no observed counterpart to fuse with, and the divergence question queues make answerable — "is the topic we declared we consume actually being consumed?" — stays out of reach. The worker-failure incident path shipped in ADR-117; the topology edge is this cut.

### Decision

`handleSpan` reads the OTel messaging semantic conventions off a span — `messaging.system` and the destination (`messaging.destination.name`, with the legacy `messaging.destination` as fallback) — and mints an OBSERVED edge to the destination node, mirroring the static side:

1. A **PRODUCER** span (wire kind 4) mints `PUBLISHES_TO`; a **CONSUMER** span (wire kind 5) mints `CONSUMES_FROM`. A dedicated gate (`spanMintsMessagingEdge`) admits only these two kinds, and only when the span names a destination. The generic caller-side gate is unchanged, so CONSUMER spans still never mint a service-level `CALLS`.
2. The destination node is keyed identically to the static extractor: node kind `<messaging.system>-topic`, so `kafka` → `kafka-topic` and the id is exactly `infra:kafka-topic:<topic>`. The shape generalises to every messaging system the semconv names (Redis Streams and beyond). The node carries `provider: 'self'`, matching the static extractor, so an observed-first destination merges cleanly when static analysis later reaches the same topic.
3. The edge is file-grained through the same call-site path as any other OBSERVED edge (file-awareness §4, ADR-118): when the span carries `code.*`, the edge originates from the producer's/consumer's `FileNode` at the exact `file:line`, reconciled onto the EXTRACTED service-relative path (`reconcileObservedRelPath`) so the OBSERVED and EXTRACTED layers land on the same `(source, target, type)` grain and fuse into one edge. A messaging span with no call site stays service-level, honestly.

### Consequences

- Declared and observed queue topology fuse into one edge on both the producer and consumer sides, so a divergence between "declared we consume topic X" and "observed consuming topic X" is answerable, and a consumer that never runs surfaces as a missing-observed edge.
- The producer side moves off the broker-host `CALLS` twin onto the semantic topic node, aligning it with the static `PUBLISHES_TO`.
- The change is additive and provenance-preserving: observed-first topics merge with later static extraction, and the ADR-117 worker-incident path is untouched. GraphQL, gRPC, and WebSocket boundaries remain deferred to their own slices.
- End-to-end file-grain for NEAT-instrumented consumers depends on the SpanProcessor stamping `code.*` on CONSUMER spans (SDK kind 4), which the capture layer currently limits to CLIENT/PRODUCER — a follow-up under the capture-layers contract; ingest already reads `code.*` when any instrumentation supplies it.

## ADR-122 — GraphQL operations are observed at operation grain via the execution span

**Status:** Accepted. Extends [ADR-118](#adr-118) (file-grained OBSERVED edges) and follows the [ADR-119](#adr-119) node-type pattern (RouteNode); refs #615. A further cut of #576's OBSERVED-coverage work — the GraphQL boundary. Resolver/field grain, static schema extraction, and client-side attribution stay deferred.
**Contracts:** [`otel-ingest.md`](contracts/otel-ingest.md), [`identity.md`](contracts/identity.md).

### Context

A GraphQL API presents one HTTP surface: every query, mutation, and subscription is a `POST /graphql`. At HTTP grain the entire API is a single route, so the OBSERVED layer sees one edge for a service that may expose hundreds of distinct operations — the operation-level topology an agent needs to reason about a GraphQL service is absent. OpenTelemetry's GraphQL instrumentation emits an execution span that already carries the missing signal: `graphql.operation.name` (the client's operation name), `graphql.operation.type` (`query` / `mutation` / `subscription`), and `graphql.document`. NEAT has the file-grain OBSERVED plumbing (ADR-118, ADR-121) to turn that span into a graph edge, and a node-type pattern (RouteNode, ADR-119) for a server-side artifact that an OBSERVED span lands on and a later static extractor fuses onto.

### Decision

NEAT records GraphQL topology at **operation grain, OBSERVED-first**.

1. A new `GraphQLOperationNode` (the eighth `NodeType`) represents one named operation, identified by `graphqlOperationId(service, operationType, operationName)` → `graphql:<service>:<type> <name>`. The service segment scopes the operation to its serving package (matching the FileNode/RouteNode convention); the operation type is normalised lower-case so an observed `query` and a future static `Query` resolver land on one node. The id is env-unscoped like FileNode/RouteNode, so an OBSERVED execution span and a future EXTRACTED schema fuse on the same node — which is what makes an operation-grain two-sided divergence possible.

2. When `handleSpan` sees a serving-side span carrying both `graphql.operation.name` and `graphql.operation.type`, it mints an OBSERVED `CONTAINS` edge from the serving service to that operation node — the same structural-ownership verb a service has over a route (ADR-119) and a file (file-awareness.md §2). The edge is file-grained through the standard `code.*` call-site path (the resolver call site) when the span carries one, reconciled onto the EXTRACTED service-relative path (ADR-118); it stays service-level otherwise. Only the serving side (SERVER / INTERNAL / unkinded spans) mints; CLIENT / PRODUCER / CONSUMER spans mint nothing.

3. This cut is OBSERVED-only. NEAT does not parse the GraphQL SDL or resolver map statically here; the operation node is minted observed-first, with an identity chosen so a future static GraphQL extractor fuses onto the same node rather than twinning.

### Consequences

- A GraphQL service now surfaces the operations its clients actually invoke, each as a distinct node with graded OBSERVED confidence, instead of one flattened HTTP edge. Blast-radius and dependency queries gain operation-level resolution for GraphQL.
- The operation node's identity is stable across the observed/static boundary, so a later static GraphQL extractor and client-side attribution slot in without a snapshot migration.
- Deferred, by design: resolver / field-grain edges, static GraphQL schema extraction, and client-side operation attribution. A client-side operation span is intentionally inert until that slice lands.
- Schema growth only (ADR-031): one new node type and helper, additive snapshot regeneration, no shape change and no migration.

## ADR-123 — gRPC gains a method-grain, two-sided topology (OBSERVED spans + static `.proto`)

**Status:** Accepted. Extends [ADR-118](#adr-118) (file-grained OBSERVED edges) and follows the route (ADR-119) / GraphQL-operation (ADR-122) node-type pattern; refs #616. A further cut of #576's OBSERVED-coverage tier — the gRPC boundary. Error-detail, client-side attribution, message/field grain, and cross-file `.proto` imports stay deferred.
**Contracts:** [`otel-ingest.md`](contracts/otel-ingest.md), [`static-extraction.md`](contracts/static-extraction.md), [`identity.md`](contracts/identity.md).

### Context

gRPC engages only at service grain today. Every RPC method a service serves collapses onto one service→service edge, so the per-method shape of a gRPC API is invisible in the graph — a caller that hits `GetOrder` and one that hits `CancelOrder` are indistinguishable. It is also one-sided: the client-stub detector in `extract/calls/grpc.ts` maps a `new OrderServiceClient()` construction to a single `infra:grpc-service:*` node, and nothing reads the `.proto` service contract at all, so there is no declared surface for observed traffic to be measured against. This is the same gap routes (ADR-119) and GraphQL operations (ADR-122) closed for their protocols: a shared, finer-grained node that both a static reader and an OBSERVED span land on, turning a coarse service edge into a legible, two-sided relationship.

gRPC is well-suited to this because the OTel RPC semconv gives both sides a canonical key. A serving span and a calling span both carry `rpc.system=grpc`, `rpc.service` (the fully-qualified `<package>.<Service>`, e.g. `orders.OrderService`), and `rpc.method` (e.g. `GetOrder`). That fully-qualified service name is exactly what a `.proto` declares — `package orders; service OrderService { … }` — so the wire and the source agree on identity without any reconciliation step.

### Decision

1. Introduce a `GrpcMethodNode` (the 9th `NodeType`) at `(rpcService, rpcMethod)` grain, identified by `grpcMethodId(rpcService, rpcMethod)` → `grpc:<rpcService>/<rpcMethod>`. The id keys on the fully-qualified `rpc.service`, globally — deliberately not scoped to the NEAT manifest service name, unlike RouteNode and GraphQLOperationNode. The FQN is the wire contract both sides carry verbatim and is unique across a gRPC mesh, so keying on it is what fuses the observed method and its declared definition onto one node. Implementing-service ownership is carried by a separate `CONTAINS` edge, never folded into identity.

2. On the OBSERVED side, when `handleSpan` sees a serving span (`rpc.system=grpc` with both `rpc.service` and `rpc.method`), mint an OBSERVED `CONTAINS` edge from the serving service to the method node. The edge is file-grained through the standard `code.*` call-site path (reconciled onto the EXTRACTED service-relative path per ADR-118), service-level when the span carries no call site. The gate admits only the serving side (SERVER / INTERNAL / unkinded); a CLIENT span mints no ownership and instead falls through to the existing cross-service resolver, leaving the caller→callee edge intact.

3. On the static side, a new `extract/proto.ts` producer reads each service's `.proto` files as data — a bounded, brace-balanced line-scan for `service X { rpc Method(Req) returns (Res); }`, in the manner of the Kafka and infra extractors — and mints the same method nodes with an EXTRACTED `service ──CONTAINS──▶ method` edge, evidence pinned to the `rpc` line. No tree-sitter grammar and no new language enter the toolchain; polyglot files are read as data.

4. Scope this cut to method-grain edges and `.proto` service/method definitions. Defer `grpc.status_code` / error-detail enrichment on incidents, client-side method attribution, message/field grain, and `.proto` `import` resolution across files.

### Consequences

- A gRPC service's methods become first-class nodes: the operations a client actually calls appear in the graph, and the methods a `.proto` declares appear alongside them. Because both sides key on the fully-qualified `rpc.service`, a declared method and its observed counterpart fuse onto one node carrying both provenances — a method-grain two-sided divergence surface (a `.proto`-declared method with no observed traffic, or observed traffic with no declaration), rather than the service-grain approximation gRPC offered before.
- Node identity is decoupled from NEAT service ownership: a monorepo where `service.name` differs from the proto package still fuses correctly, since the node is the wire FQN and the manifest service is only the `CONTAINS` source. Two services that legitimately implement the same fully-qualified gRPC service would share the method node — acceptable and honest, since gRPC's own contract treats the FQN as the single identity.
- `GrpcMethodNode` is additive schema growth (ADR-031): the schema snapshot regenerates with insertions only, and the `NodeType` count moves 8→9. Divergence computation is unchanged — `CONTAINS` remains excluded from the missing-observed/missing-extracted machinery, so fusion lives at the node exactly as it does for routes and GraphQL operations.
- The client side of a gRPC call keeps its current behavior: the CLIENT span still resolves the cross-service edge through address/parent-span resolution, so introducing serving-side ownership does not drop or double the caller→callee topology. Richer client→method attribution and gRPC status-code enrichment remain available as later, self-contained slices.

## ADR-124 — The Supabase connector and the connectors plane

**Status:** Accepted. Refs #653. Opens the connectors plane — a second OBSERVED ingestion path (pull) alongside OTLP (push) — with Supabase as the first provider; Vercel is next. Follows the fusion discipline ADR-118/121/122/123 established for file-grained OBSERVED edges, applied to a pull model instead of a span model.
**Contracts:** [`connectors.md`](contracts/connectors.md) (new), [`otel-ingest.md`](contracts/otel-ingest.md) (amended — connector-sourced edges share the span-derived minting path), [`identity.md`](contracts/identity.md).

### Context

Every OBSERVED edge NEAT has ever minted starts from an OTel span the observed application was instrumented to emit. That's a real constraint: it requires the app to carry an SDK, and plenty of production behavior lives in a provider's own infrastructure rather than in application code the app's own spans would ever cover. Supabase is the sharpest example — a `supabase-js` call reads a table over PostgREST, and Supabase's own Management API and Postgres extensions already record which tables got hit, how often, and how expensively, entirely server-side, whether or not the calling app ever imports an OTel SDK. A connector pulls that existing telemetry instead of waiting for a push, and fuses it onto the same static call site OTLP ingest already targets — the `supabase-js` `createClient(...)` sites `extract/calls/supabase.ts` recognizes today, and the `.from()`/`.rpc()` call sites a follow-up extractor cut will add.

A survey of Supabase's telemetry surfaces (docs, `supabase-grafana`, the Management API reference, and Postgres's own stats-role documentation) found: the Metrics API is aggregate-only (no per-table or per-endpoint signal, so unusable as a fusion target); no native OpenTelemetry export exists for traces or metrics (only a Pro-gated log sink); the Management API's log-query endpoint (`analytics/endpoints/logs.all` over `edge_logs`) carries the request path, which names the table or RPC a PostgREST call hit; and `pg_stat_statements`, enabled by default on every Cloud project, gives per-table call counts and query cost to any role holding Postgres's built-in `pg_read_all_stats` — a role narrower than `service_role` or the project's `postgres` admin role, but one Supabase provides no OAuth- or Management-API-brokered way to provision; a customer has to grant it via SQL themselves. That gap is the crux of the hosted least-privilege question this ADR resolves in the Decision below.

### Decision

1. **Introduce a provider-agnostic connector interface** inside `neatd`: `ObservedConnector { provider, poll(ctx) }`, returning `ObservedSignal[]` — a `(targetKind, targetName, callCount, errorCount, lastObservedIso)` tuple. The pull/map/fuse pipeline that turns a signal into a graph mutation is written once (`packages/core/src/connectors/index.ts`) and is identical across every provider; only signal-fetching and target-to-node-id resolution are provider-specific (`packages/core/src/connectors/<provider>/`).

2. **A connector runs in one of two credential profiles — local or hosted — that change credential source, deployment location, and poll cadence, never the pull/map/fuse logic.** Local: the developer's own credentials, on their own machine, on-demand poll. Hosted: credentials brokered by NEAT-operated infrastructure on the customer's behalf, continuous metered poll, held to the narrowest read grant the provider's auth model allows — never a broad, unscoped, account-level credential, because infrastructure NEAT operates holding such a credential on a customer's behalf is a different, disqualifying risk from a developer holding their own.

3. **A connector-sourced OBSERVED edge mints through the exact same primitives a span-derived edge does** — `upsertObservedEdge`, the same `signal` block, the same graded confidence, the same file-grain reconciliation via `reconcileObservedRelPath` when a static call site resolves, the same honest service-level fallback when it doesn't. No parallel mutation path; a connector edge and a span edge are indistinguishable to traversal, divergence, and the staleness loop.

4. **Supabase ships scoped to Supabase Cloud projects only, full stop, on two surfaces:** the Management API's log query over `edge_logs` (table/RPC grain from the request path — both profiles) and direct `pg_stat_statements`/`pg_stat_user_tables` reads (richer per-table signal — local profile from day one; hosted profile as a fast-follow once a customer-provisioned least-privilege role, granted `pg_read_all_stats` via a one-time SQL step the customer runs themselves, can be brokered). The hosted profile's first cut therefore runs on the log surface alone — genuinely least-privilege via a scoped OAuth-app grant — accepting a smaller surface than the local profile rather than defaulting to a broader credential to close the gap. Self-hosted Supabase is not a target for this connector — not a sequencing question, a scope one: NEAT's Supabase customers are Cloud customers, and self-hosted Supabase runs no Management API or OAuth apps for the primary surface to reach anyway.

5. **Node identity for Supabase sub-resources extends the existing `infraId` pattern** (the same one `kafka.ts` uses for topics): `infraId('supabase-table', '<projectRef>/<table>')`, `infraId('supabase-rpc', '<projectRef>/<fn>')`, scoped by the same project-ref/`env` resolution the client-construction extractor already performs. Edge type is `CALLS`, file-grained through the standard call-site path, service-level otherwise. No new `NodeType`.

6. **The static `supabase-js` extractor gap this connector exposes is named, not silently worked around.** `extract/calls/supabase.ts` recognizes client construction only — not `.from()`, `.rpc()`, `.storage`, `.auth`, `.channel()`, or `.functions.invoke()`. Every table/RPC-grain OBSERVED edge this connector mints lands service-level until a follow-up extractor cut adds call-site parsing for at least `.from()`/`.rpc()`. That's an honest missing-extracted divergence, exactly the shape the graph should surface, and it becomes the extractor's own prioritized backlog rather than a connector workaround.

### Consequences

- The OBSERVED layer gains a second, equally first-class ingestion path. A project that never instruments a single span can still get production-truth OBSERVED edges the moment its Supabase project exists — the connector needs no app cooperation at all, per the ambient/passive rule `connectors.md` states.
- Fusion quality is bounded by both sides, deliberately: the connector's edges are only as fine-grained as (a) the telemetry surface it reads and (b) the static extractor's call-site coverage. Both gaps are named in this ADR and in the connector spec rather than glossed over, so the missing-extracted divergences this cut produces are legible signal, not noise.
- The hosted profile ships with a real capability gap versus the local profile (no `pg_stat_statements` signal until the least-privilege-role fast-follow lands) rather than reaching for a broader credential to close it. That's a deliberate trade against the mandate that a third party holding a broad database credential on a customer's behalf is a breach-equals-total-compromise liability a developer holding their own credentials isn't.
- The connector interface (`ObservedConnector`, the profile split, the shared pull/map/fuse pipeline) is written to generalize — Vercel, or any other provider with its own server-side telemetry, implements `poll()` and a target-resolution mapping and gets the same fusion, credential-profile, and enforcement story for free.
- `connectors.md` ships `enforcement: [review]` — no connector code has landed yet, so there's nothing for a lint assertion to check. It moves to `[lint, review]` once the Supabase implementation ships and `contracts.test.ts` can assert the provider-interface shape and the credential-never-in-snapshot rule mechanically.

## ADR-125 — WebSocket channels get a channel-grain, OBSERVED-only topology on the existing CONNECTS_TO edge

**Status:** Accepted. Refs #617. The final transport of #576's OBSERVED-coverage tier — the WebSocket boundary. Follows the node-type pattern of routes (ADR-119), GraphQL operations (ADR-122), and gRPC methods (ADR-123), but reuses the existing `CONNECTS_TO` edge rather than introducing a new one. Client-side attribution, per-message grain, and static WebSocket extraction stay deferred.
**Contracts:** [`otel-ingest.md`](contracts/otel-ingest.md), [`identity.md`](contracts/identity.md), [`divergence-query.md`](contracts/divergence-query.md).

### Context

A WebSocket application presents almost nothing to the graph today. The extraction pipeline sees the server as a service, and the only runtime signal that survives is the occasional message-handler exception, which lands as an incident. The channels a client actually connects to — `/chat`, `/notifications`, `/socket.io` — never appear, so an agent asking "what real-time surfaces does this service expose, and are they live?" gets no answer. The reason is structural: a WebSocket connection opens with an HTTP upgrade handshake and then all further traffic rides the socket as frames, which most instrumentation does not turn into spans. The frames are dark; the handshake is not. That single upgrade span — a SERVER `GET` carrying `Upgrade: websocket` and the connection path — is the one reliable, per-channel observation available, exactly as the gRPC and GraphQL cuts (ADR-123, ADR-122) recovered method- and operation-grain topology from the one span that names them.

A channel differs from a route, a GraphQL operation, or a gRPC method in one way that drives the whole design: those are durably declared artifacts a static extractor can read, so their meaning survives silence. A channel's meaning *is* liveness — an observed channel that stops being observed has, for practical purposes, stopped existing. There is also no static WebSocket extractor in this cut, so the channel is known from observation or not at all.

### Decision

1. Add one new node type, `WebSocketChannelNode` (the tenth `NodeType`), at `(service, channel)` grain, id `websocketChannelId(service, channel)` → `ws:<service>:<channel>`. `service` is the serving service's manifest name; the channel is scoped to it like a RouteNode, because a WS path carries no package qualifier and is not unique across a mesh (unlike a gRPC FQN). The node is minted OBSERVED-only from the HTTP upgrade span; it has no declared twin, and `path` / `line` stay optional and absent rather than fabricated (file-awareness §6).

2. The edge is the **existing `EdgeType.CONNECTS_TO`** — `service ──CONNECTS_TO──▶ ws-channel` — **not a new edge type.** `CONNECTS_TO` is the connection verb a service already uses for a datastore, and it is the honest shape here precisely because a channel's meaning is liveness: the edge carries `lastObserved` and **decays `OBSERVED → STALE` on `CONNECTS_TO`'s own existing staleness threshold** via the daemon staleness loop (#532). No new edge type and no new threshold are introduced. The edge is file-grained through the standard `code.*` call-site path and falls back to service-level honestly when no call site is present.

3. Because a `WebSocketChannelNode` is OBSERVED-only by design and `CONNECTS_TO` sits in the `OBSERVABLE_EDGE_TYPES` allowlist, an observed-only channel edge would otherwise flag a false `missing-extracted` divergence. **Exclude `WebSocketChannelNode` targets from `missing-extracted`,** mirroring the existing `CONTAINS` exclusion but keyed on the target node type. An observed-only node has no static twin to diverge against, so suppressing it is signal-preserving, not signal-hiding.

4. The serving-side gate admits SERVER / INTERNAL / unkinded spans and excludes CLIENT / PRODUCER / CONSUMER, so a client-side upgrade span mints no channel; client-side channel attribution is deferred.

### Consequences

- WebSocket services gain a legible, per-channel OBSERVED surface that answers "which channels are live" and participates in traversal, blast-radius, and staleness like any other OBSERVED edge.
- Reusing `CONNECTS_TO` keeps the edge-type set stable: consumers, divergence weighting, and the staleness loop treat a channel edge as an ordinary connection edge with no special-casing beyond the one target-typed divergence exclusion.
- The channel decays to STALE when it goes quiet, so a torn-down or renamed channel stops reading as live without any teardown signal — liveness is expressed by provenance, which is the intended trust semantics.
- A future static WebSocket extractor can fuse onto the same `ws:<service>:<channel>` id, at which point channels would gain a two-sided divergence and the target-typed exclusion would be revisited; until then the observed-only exclusion keeps the divergence surface honest.
- Deferred: client-side channel attribution, per-message / event-grain topology, and static WebSocket route extraction.

## ADR-126 — Vercel gains ambient edge-runtime tracing via an installer path, not a connector

**Status:** Accepted. Refs #653 (connectors-plane tracking issue; this ADR opens a sibling installer-plane workstream under the same umbrella, not a connectors-plane provider). Amends [`framework-installers.md`](contracts/framework-installers.md) §6 and the Next.js path `sdk-install.md`/ADR-073 already established.
**Contracts:** [`framework-installers.md`](contracts/framework-installers.md), [`sdk-install.md`](contracts/sdk-install.md).

### Context

NEAT's Next.js installer already writes an `instrumentation.ts` / `instrumentation.node.ts` pair, gating the Node OTel SDK on `process.env.NEXT_RUNTIME === 'nodejs'`. The generated file's own comment says plainly: "For Edge / browser runtimes the file is ignored." That's not an oversight — `@opentelemetry/sdk-node` cannot execute in a V8-isolate edge runtime at all, so the Node-only approach was correct as far as it reached. It just stops at a boundary Vercel's own platform introduces: every Next.js app deployed to Vercel splits into a Node-runtime half (API routes, most page rendering) and an Edge-runtime half (middleware, any handler declaring `export const runtime = 'edge'`). Today the Node half gets full span coverage and the Edge half gets none — cold starts, middleware, and edge-runtime routes are invisible to NEAT regardless of traffic volume.

Vercel ships `@vercel/otel`, a small package built for exactly this seam: it detects which runtime it's executing in and configures the OTel SDK using only web-standard APIs, so one registration call works in both Node and Edge. It is not a Vercel-proprietary telemetry backend — it's a standards-compliant OTel SDK wrapper exporting over the same OTLP protocol NEAT's receiver (`otel.ts`) already speaks, to whatever endpoint it's configured with. Because of that, this is an installer-plane fix, not a connectors-plane one (`connectors.md`, ADR-124): no app-external telemetry gets pulled, no new ingestion path is needed, spans just start flowing from code NEAT already writes into the app.

### Decision

1. Extend `planNext`'s generated file set with `instrumentation.edge.{ts,js}`, alongside the existing `instrumentation.{ts,js}` / `instrumentation.node.{ts,js}` pair. The top-level `instrumentation.ts` gains a second branch mirroring the existing one exactly: `if (process.env.NEXT_RUNTIME === 'edge') { await import('./instrumentation.edge') }`.
2. `instrumentation.edge.ts`'s content is `@vercel/otel`'s `registerOTel()`, configured with the same service name and OTLP endpoint every other generated init already resolves from `daemon.json` (ADR-096) — no new configuration surface, no new env var.
3. This is the first documented exception to framework-installers.md §6 ("no framework branch swaps in a framework-specific OTel package"). The exception is scoped narrowly — the Next.js branch's edge-runtime file only — because the standard four-deps SDK cannot execute in that runtime at all, not a precedent for swapping OTel packages anywhere else. `@vercel/otel` is a fifth, edge-only dependency gated to this one generated file.
4. A genuine Vercel *connector* — pulling Log/Trace Drains for platform-level signal an app-side tracer structurally can't produce (cold starts, edge routing/caching decisions) — remains separate, deferred work, gated on a future `connectors.md` push-receiver amendment and Vercel's Pro/Enterprise Drains paywall. Out of scope here.

### Consequences

- Next.js apps deployed to Vercel get real span coverage for their edge-runtime code for the first time, at zero cost (rides the existing free OTLP path, no Drains paywall) and zero new configuration surface.
- `@vercel/otel` is inert off Vercel — a standards-compliant package, not Vercel-locked — so the installer needs no "is this actually deployed on Vercel" detection before adding it; the branch is a pure runtime check.
- `framework-installers.md`'s "no framework-specific OTel package" rule gets its first named exception rather than a silent bend. A future edge-incompatible runtime reaching for a similar SDK-injection strategy can point at this ADR as precedent, or explicitly argue why its case differs.
- No `RouteNode`, `routes.ts`, or connectors-plane machinery changes — existing Next.js static route extraction is untouched; only runtime span coverage closes.

## ADR-127 — The Railway connector

**Status:** Accepted. Refs #653 (connectors-plane tracking issue). Second connectors-plane provider under [ADR-124](#adr-124--the-supabase-connector-and-the-connectors-plane)'s `connectors.md`.
**Contracts:** [`connectors.md`](contracts/connectors.md), [`identity.md`](contracts/identity.md).

### Context

Railway is a general-purpose PaaS — no client SDK; the app's own HTTP routes run on Railway's infrastructure, the same hosting-platform shape `route-match.ts` (ADR-119) already models for any server framework's `RouteNode`. Railway's GraphQL API exposes `httpLogs`, a structured per-request record (method, path, status, duration, request id) generated by Railway's own edge/ingress layer — independent of whatever the app itself writes to stdout, so it's a reliable access-log-grade signal regardless of the app's own logging discipline. `httpMetrics` / `httpDurationMetrics` add pre-aggregated percentile time series at the same grain. A further surface, `networkFlowLogs`, carries `peerServiceId` on L4 flow records between Railway services — a dependency signal independent of HTTP entirely, not available from any other connectors-plane provider surveyed so far.

### Decision

1. The Railway connector implements `ObservedConnector` (`packages/core/src/connectors/railway/`) using only `poll()` — no push/receive path needed, unlike Vercel's deferred Drains connector.
2. `poll()` queries `httpLogs` since the last high-water mark for route-grain signal, and separately `networkFlowLogs` for service-dependency signal.
3. An `httpLogs` record maps onto the existing `RouteNode`: the connector normalizes the raw `path` against statically-extracted path-templates the same way `route-match.ts` already normalizes client-call paths onto server routes, minting a file-grained OBSERVED `CALLS` edge when a route resolves, service-level otherwise — the same honest fallback every OBSERVED surface in NEAT already uses. No new `NodeType`.
4. A `networkFlowLogs` record mints an OBSERVED `CONNECTS_TO` edge between the two `ServiceNode`s named by `peerServiceId`, independent of whether any route resolves — the first connector signal establishing a service dependency from L4 flow data rather than an HTTP/route/RPC contract.
5. Node identity: a Railway `serviceId` (Railway's own GraphQL id) doesn't necessarily match NEAT's manifest-derived `serviceId(name)` — the connector config carries an explicit mapping from Railway service id to NEAT service name, resolved once at setup, never guessed.
6. Both credential profiles use Railway's `Project-Access-Token`, already environment-scoped — no Fork-A-style least-privilege gap the way Supabase's `pg_stat_statements` had; the hosted profile ships the same credential shape as local from day one.
7. Railway has no self-hosted product — no Cloud-vs-self-hosted fork to resolve, unlike Supabase.

### Consequences

- Railway becomes the second connectors-plane provider and the first to prove the pull/map/fuse pipeline `connectors.md` specifies is genuinely provider-agnostic in practice, not just in the interface's design intent.
- The `CONNECTS_TO`-from-network-flow-logs pattern is new: prior OBSERVED `CONNECTS_TO` edges (ADR-118) came from in-process DB spans; this is the first from a connector's own platform-level signal with no span involved at all. Worth watching whether other providers' equivalents (VPC flow logs, etc.) generalize this into a third `connectors.md` fusion pattern alongside route-fusion and client-SDK-fusion.
- Fusion quality inherits `routes.ts`'s existing framework coverage (Express, Fastify, Next.js) — a Railway-hosted app using an unrecognized framework/router gets service-level-only edges, an honest gap in `routes.ts`'s coverage rather than something this connector compensates for.

## ADR-128 — The Firebase connector, scoped to Cloud Functions / Cloud Run / Firebase Hosting

**Status:** Accepted. Refs #653 (connectors-plane tracking issue). Third connectors-plane provider under ADR-124's `connectors.md`.
**Contracts:** [`connectors.md`](contracts/connectors.md), [`identity.md`](contracts/identity.md).

### Context

Firebase is architecturally a hybrid: Firestore / Realtime Database / Auth / Storage are client-SDK-shape surfaces (analogous to Supabase); Cloud Functions / Cloud Run / Firebase Hosting are hosting-platform-shape surfaces (analogous to Railway). A survey of Google Cloud's telemetry found the client-SDK half is largely a dead end for fusion: Firestore's Cloud Monitoring metrics are database-aggregate with no collection dimension at all, its Query Insights feature is shape-level and blind to `onSnapshot` listener traffic, and — decisively — its only read-only predefined IAM role (`roles/datastore.viewer`) grants actual document access rather than usage statistics, so there is no least-privilege path to even the aggregate signal without over-granting real data access. Firebase Auth has next to no audit trail on the free tier and excludes routine sign-in even under the paid Identity Platform upgrade. The hosting-platform half is comparatively strong: Cloud Run / 2nd-gen Functions structured request logs carry a full `httpRequest` object (method, path, status, latency) via Cloud Logging, and — contrary to a "static CDN, no telemetry" assumption — Firebase Hosting has its own opt-in `webrequests` log with the same per-request path-level shape.

### Decision

1. This connector's v1 scope is Cloud Functions, Cloud Run, and Firebase Hosting request logs, only. Firestore and Firebase Auth are named non-goals for the least-privilege reason above, not a scope convenience to revisit casually.
2. `poll()` queries Cloud Logging's `entries.list`, filtered to the `httpRequest` field on the relevant monitored resources (`cloud_function`, `cloud_run_revision`, `firebase_domain`), since the last high-water mark.
3. Fusion binds onto the existing `RouteNode`, the same hosting-platform pattern ADR-127 established for Railway: when a Cloud Function wraps an Express app (`functions.https.onRequest(app)`, the dominant real-world pattern), `routes.ts`'s existing Express recognizer already resolves the route; a raw `onRequest`/`onCall` handler with no Express app falls back to function-name/service-level attribution honestly, pending a future `firebase-functions`-specific static recognizer.
4. Credential: `roles/monitoring.viewer`, `roles/logging.viewer`, `roles/cloudfunctions.viewer`, `roles/firebasehosting.viewer` — GCP's predefined roles are genuinely metrics/logs-only with no path to customer data, so both profiles use the same narrow grant from day one; no Fork-A-style local/hosted split is needed the way Supabase's `pg_stat_statements` forced.
5. Cloud Storage and Realtime Database have real per-path signal via Data Access audit logs, matchable against static `ref(storage, 'path')` / `ref(db, 'path')` literals, but that logging is opt-in and explicitly flagged by Google as high-volume/cost, and would need a new client-SDK-shape extractor analogous to `supabase.ts`. Deferred to a later, separately-scoped cut rather than riding along here.
6. Testing: the Firebase Local Emulator Suite has no telemetry parity with production, so this connector's tests run against a real GCP project fixture, the same shape `observed-e2e.md` already accepts for Brief.

### Consequences

- Firebase becomes the third connectors-plane provider and the first where a large, real fraction of the platform's surface area (Firestore, Auth) is explicitly declared out of scope rather than merely unbuilt — stated plainly here so a future contributor doesn't rediscover the same IAM dead end.
- The hosting-platform half reuses the exact `RouteNode`-fusion pattern ADR-127 established for Railway, reinforcing it as the default for any hosting-platform-shape provider rather than a Railway-specific design.
- No new `NodeType`, no amendment to `connectors.md` itself — this ADR is a provider addition within the existing interface.

## ADR-129 — The Cloudflare Workers/Pages connector, v1 at whole-file grain

**Status:** Accepted. Refs #653 (connectors-plane tracking issue). Fourth connectors-plane provider under ADR-124's `connectors.md`; also names a v2 extractor cut under `static-extraction.md`, not part of this ADR's build.
**Contracts:** [`connectors.md`](contracts/connectors.md), [`static-extraction.md`](contracts/static-extraction.md) (v2 only), [`identity.md`](contracts/identity.md).

### Context

Cloudflare Workers/Pages is hosting-platform-shape, but its telemetry fundamentally thinks in scripts, not routes — no dataset surveyed carries a structured path/route dimension; the closest available field, on the Workers Observability Telemetry Query API, is a semi-structured `$metadata.trigger`/`url` string (e.g. `"GET /users"`) attached to each invocation record. Binding that to a specific route handler needs a static recognizer for whichever in-Worker routing library named the route (Hono, itty-router) — and `routes.ts`'s own scoping comment states its coverage is "mainstream routers only... grows one router at a time"; neither Hono nor itty-router nor raw manual `fetch(request)` routing is in that registry today. Building that recognizer is real, bounded, new static-extraction work — the Telemetry Query API itself, meanwhile, is ready now: a documented, public, account-scoped REST endpoint giving per-invocation status/duration/script-name/trigger-string data with zero app code change beyond a `wrangler.toml` deploy flag.

### Decision

1. v1 ships without waiting on a Hono/itty-router recognizer. `poll()` queries the Telemetry Query API and mints a file-grained OBSERVED `CALLS` edge from the Worker's single entry `FileNode` (the file containing `export default { fetch }`) — real signal, honestly scoped to whole-script grain rather than fabricating route attribution the static side can't yet back up. The `trigger`/`url` string is parsed only far enough to extract the HTTP method for edge metadata, not matched against any route table.
2. v2, a distinct fast-follow issue, not part of this ADR's build: add a Hono recognizer to `routes.ts`'s router registry (`hono.get('/path', handler)`, gated on the `hono` manifest dependency — the same shape as the existing Express/Fastify recognizers), so multi-route Workers using Hono resolve to real `RouteNode`s and this connector's edges sharpen from whole-file to route-grain automatically, no connector-side change required. itty-router and unrecognized manual routing remain file-grain-only until further demand.
3. Cloudflare's native OTLP export (push, to a configured destination) and Logpush are real but not the chosen v1 surface, for the same poll-preferred reasoning as Vercel's deferred Drains connector — both would need the same future `connectors.md` push-receiver amendment this ADR deliberately avoids depending on.
4. Credential: Cloudflare API token permission groups are confirmed granular (e.g. a distinct "Workers Tail Read" group exists); the exact group needed for the Telemetry Query API itself needs a live check before the spec locks a scope name — both profiles use whatever that narrowest group turns out to be.

### Consequences

- Cloudflare becomes the fourth connectors-plane provider, and the first to ship intentionally below its ceiling — whole-file grain now, route grain as a named fast-follow — rather than blocking the whole connector on static-extraction work landing first. This is the same "coverage grows one router at a time" discipline `routes.ts` already documents, applied to a connector's roadmap rather than only to the extractor itself.
- No push-receiver amendment to `connectors.md` gets built speculatively — this ADR explicitly defers that alongside Vercel's Drains connector, keeping the interface at just `poll()` until a real push-shaped connector is scheduled.
- The eventual Hono recognizer (v2) is scoped as an extractor change under `static-extraction.md`'s existing "grows one router at a time" pattern, not a new contract.

## ADR-130 — Connector credentials live in a machine-level `connectors.json`, enabled via `neat connector`

**Status:** Accepted. Refs #653 (connectors-plane tracking issue). Closes the gap between the connectors-plane code (ADR-124, ADR-127, ADR-128, ADR-129) and an actual user-facing way to turn one on — today `packages/core/src/connectors/*` has real, tested `poll()` implementations for Supabase/Railway/Firebase/Cloudflare with no config surface at all: nothing reads a credential from anywhere, so `startConnectorPollLoop` never gets called with a real `ConnectorContext` outside a test file.
**Contracts:** New [`connector-config.md`](contracts/connector-config.md), amends [`connectors.md`](contracts/connectors.md), [`project-registry.md`](contracts/project-registry.md), [`daemon.md`](contracts/daemon.md), [`cli-surface.md`](contracts/cli-surface.md) (additively — this is a new top-level command family alongside `init`/`sync`/`deploy`, not an eleventh query verb in the locked ten).

### Context

`project-registry.md` already establishes the right shape for machine-level, per-user, non-versioned state: `~/.neat/projects.json`, atomic tmp+rename writes, an flock during writes. Connector configuration needs the same properties plus one more that `projects.json` never had to consider: **it holds real secrets** — a Railway project-access-token, a Supabase personal-access-token, a Postgres connection string. `CLAUDE.md`'s existing rule ("don't write `.env` file contents into the snapshot") and `connectors.md` §6 ("credentials never reach the snapshot... the connector holds secrets in config/broker state") both already assume a credential-holding location exists — this ADR is what actually builds it. `.env.neat` is the wrong home: it's a committed, low-risk template file by design (never gitignored — confirmed by reading `.gitignore` — because it's only ever generated with a service name and an OTLP endpoint default, no real secret). A connector's actual bearer token or connection string needs to live somewhere that is never part of a git repo at all, not somewhere that merely happens to be gitignored today.

Everything downstream of a credential is already built and tested. `startConnectorPollLoop` (`connectors/index.ts`) is wired into the daemon slot at `daemon.ts:553`, one loop per `opts.connectors` entry, carrying `since` across ticks; the shared junction layer (ADR-131) gives every outbound call its timeout/retry/rate-limit discipline; each provider's `poll()` and signal mapping passes its fixture tests. The single remaining brick is the read chain that populates `opts.connectors` — `connectors.json` → the daemon reads it → a dispatch table resolves the provider → `opts.connectors`. Build that and the whole plane lights up against wiring that already exists. The credential itself defaults to an env-var *reference*, not a secret at rest, so the security surface a config file of provider tokens would otherwise open is closed by construction.

### Decision

1. **New file: `~/.neat/connectors.json`**, sibling to `~/.neat/projects.json`, same atomicity guarantees (`writeAtomically`, flock with the same 5s timeout). Shape:
   ```ts
   {
     version: 1,
     connectors: Array<{
       id: string,               // addressable handle, auto-slugged from provider
                                 // (disambiguated by project when a provider repeats);
                                 // used by `remove <id>` / `test <id>`
       provider: string,         // 'supabase' | 'railway' | 'firebase' | 'cloudflare' | 'vercel'
       project?: string,         // matches a projects.json `name` — whose graph the edges
                                 // attach to; omitted binds to the project the daemon
                                 // is bootstrapping (one daemon per project, ADR-096)
       credential: CredentialRef,          // env-ref by default (point 2)
       options?: Record<string, unknown>,  // provider-shaped non-secret config
     }>
   }
   ```
   File permissions are set to `0600` on write (owner read/write only) — a departure from `projects.json`, which carries no secret and needs no such restriction. In the default env-ref form the file holds only a pointer, so `0600` guards the plaintext opt-in specifically.

2. **Credential-at-rest is an env-var reference by default.** A `credential` is, by default, a string whose leading `$` marks it as the name of an environment variable (`"$SUPABASE_KEY"`), resolved to a value only when the daemon builds the connector's registration (point 4). The secret is never at rest in the file; `connectors.json` holds the pointer, the environment holds the value. Multi-field providers carry an object of field → ref (`{ "connectionString": "$SUPABASE_DB_URL", "serviceKey": "$SUPABASE_SERVICE_KEY" }`); resolution walks it. **Plaintext is the explicit opt-in fallback** — a value without a leading `$` is a literal secret, stored as-is, guarded by `0600`, and the only form that puts a secret at rest, so a user opts *in* to it rather than getting it by omission. One shape serves both credential profiles (`connectors.md` §3): local, the developer's own environment holds the secret; hosted, the control plane injects the referenced variable exactly as it already brokers `NEAT_AUTH_TOKEN` (ADR-073), so a tenant's `connectors.json` ships identical and holds no secret at rest.

3. **New CLI command family, additive to the top-level orchestrator verbs** (`init`, `sync`, `deploy` — per `one-command-cli.md`/`sync.md`), **not** an eleventh entry in the locked ten-verb query set `cli-surface.md` governs (that set mirrors read-only MCP graph queries; connector management is mutation/config, a different category, the same way `init`/`sync` sit outside it today):
   ```
   neat connector add <provider> [--project <name>] [--<field> <value> ...] [--skip-validate]
   neat connector list [--project <name>]
   neat connector remove <id>
   neat connector test <id>
   ```
   `add` takes both interactive prompts and flags — bare, it prompts for the provider's required fields (named by the dispatch-table entry, point 4); given flags, it skips the prompts for scripting and CI. `add` **validates the credential against the provider's own auth path by default** — a cheap round-trip through the junction before the entry is written, so a wrong credential fails fast at add-time instead of surfacing quietly at the first poll; `--skip-validate` is the offline / env-not-yet-populated escape. `test <id>` re-runs that round-trip against an existing entry. **An unset env-ref is a resolution error, not a validation failure**: if `$SUPABASE_KEY` is unset at add-time, the command fails with `"$SUPABASE_KEY is unset"` — a distinct exit path from a validation failure, which means the credential resolved and the provider rejected it. Conflating the two would tell a user their token is wrong when they only forgot to `export` it.

4. **A data-driven provider dispatch table** (`packages/core/src/connectors/registry.ts`) maps `provider` string → its entry: the connector factory (`createSupabaseConnector`, `createRailwayConnector`, `createFirebaseConnector`, `createCloudflareConnector`, and a Vercel entry once its Drains connector exists), a validator (the auth round-trip point 3 calls), and the required-field schema (what `add` prompts for). Both the CLI and the daemon dispatch through this one table rather than each hand-rolling a switch — the same principle `compat.json` holds for driver logic (`compat.ts` reads from data, never scattered branches). The table is also the normalization seam for the providers' differing factory shapes (some take a graph and a config object, some pair a connector factory with a separate `resolveTarget` factory). **Daemon-read at slot bootstrap**: at `bootstrapProject` — where `daemon.ts:553` already starts the poll loops from `opts.connectors` — the daemon reads `~/.neat/connectors.json`, and for every entry whose `project` matches the project being bootstrapped (or is omitted), resolves the provider via the table, resolves the env-ref credential against the environment (failing that connector slot loudly if the referenced variable is unset, never polling with an empty credential), builds a `ConnectorRegistration` with the resolved credential, and hands it to `startConnectorPollLoop`. The resolved secret lives only in memory inside the `ConnectorContext` that flows to `poll()` — never written back, never into the snapshot. An entry whose `project` matches no active project is skipped, not errored, the same graceful-skip discipline `project-registry.md` uses for a paused project.

5. **Least-privilege scoping stays a per-provider concern**, not something this file format changes — `connectors.json`'s `credential` just references whatever credential shape each provider's `docs/connectors/<provider>.md` already specifies (a bearer token, a connection string, an OAuth-scoped token) and whatever least-privilege grant it mandates (`connectors.md` §3); this ADR is only about where that value lives and how it reaches the connector, not what shape it takes per provider.

### Consequences

- The four already-built connectors (Supabase, Railway, Firebase, Cloudflare) become genuinely usable for the first time — real, tested `poll()` code with no reachable config path becomes a feature a user can turn on, lighting up against the poll loop (`daemon.ts:553`) and junction (ADR-131) that already exist.
- `~/.neat/connectors.json` never enters a git repo by construction (it's outside any project directory, in the user's home dir, exactly like `projects.json`) — stronger than relying on `.gitignore` correctness inside a user's own repo. And in the default env-ref form there is no secret in it to leak in the first place.
- The security surface a file of provider tokens would open is handled by three things together: env-ref-by-default (no secret at rest), validate-on-add (a wrong credential fails at add-time, not silently at poll time), and the never-snapshot rule (`connectors.md` §6) unchanged. The `0600` mode covers the plaintext opt-in specifically.
- The CLI gains a fourth top-level command family without touching the locked ten-verb query set — `cli-surface.md`'s "an eleventh verb requires a successor ADR" constraint is preserved exactly, since nothing is added to that list.
- The provider dispatch table (`registry.ts`) is the one place a future fifth provider (Vercel's deferred Drains connector, or provider six and beyond) needs to register — CLI and daemon code don't change per new provider, only the table gains an entry.
- The env-ref indirection is itself the local↔hosted seam: hosted brokering injects the referenced variable the way the control plane already injects `NEAT_AUTH_TOKEN`, so the file shape is profile-agnostic. How the broker obtains and rotates the value it injects is separate infrastructure this file format doesn't anticipate.
- Whether the on-ramp is a launch *gate* or a fast-follow is an urgency call, not a build change — the same read chain ships either way; only its scheduling relative to the launch moves.

## ADR-131 — A shared junction layer mediates every connector's outbound call

**Status:** Accepted. Refs #653 (connectors-plane tracking issue). Amends [`connectors.md`](contracts/connectors.md); refactors the four already-built providers (Supabase, Railway, Firebase, Cloudflare) onto the new layer without changing their `poll()` signatures or signal mapping.
**Contracts:** [`connectors.md`](contracts/connectors.md).

### Context

Four connectors exist today, each with its own independent outbound client: `railway/client.ts`, `firebase/logging-api.ts`, `cloudflare/client.ts`, `supabase/client.ts` + `supabase/postgres-client.ts`. Every one of them does a bare `fetch()` (or a bare `pg` query) and throws on a non-OK response — no timeout, no retry on a transient failure, no rate-limiting, no shared credential-injection convention, no shared logging of the connector's own outbound health. Each connector reinvented the same thin wrapper independently, and none of them protect against the exact failure modes the Phase 1 surveys already found real limits for: Cloudflare's Telemetry Query API rate limit (~300/5min), the Supabase Management API's unconfirmed-but-real limit, Railway's documented RPH/RPS caps. A connector that polls too aggressively, or that retries a transient 503 by immediately re-polling on the next tick rather than backing off, risks looking indistinguishable from the load-generation the connectors plane's ambient/passive principle explicitly forbids (`connectors.md` §2) — even though the connector itself only ever issues read requests, an unthrottled retry storm against a customer's own account is a real, if accidental, way to violate that principle's spirit.

NEAT is architecturally the single point every OCloud provider's telemetry converges through before becoming part of one graph — the pull/map/fuse pipeline (`connectors/index.ts`) already is a junction in that sense. This ADR makes the *outbound connection* itself a junction too: one shared module every provider's client code calls through, rather than four bespoke implementations of the same discipline.

### Decision

1. **New module `packages/core/src/connectors/junction.ts`** — the one place a connector's outbound HTTP call happens. Exposes `junctionFetch(url, init, policy)`:
   - **Timeout**: every call carries an `AbortController`-based timeout (default 10s, overridable per call for a provider whose API is documented as slower).
   - **Retry with backoff**: transient failures (5xx, network errors, timeout) retry with exponential backoff, capped attempts (default 3) and a capped total wall-clock budget so a retry storm can't turn one poll tick into an unbounded hang. A 4xx never retries — a bad credential or a malformed query is not a transient condition, and blind-retrying one looks exactly like the load-generation problem above.
   - **Rate limiting**: a token-bucket keyed on `(provider, accountKey)` — `accountKey` is whatever identifies one customer's account to that provider (a Supabase project ref, a Railway project id, a Cloudflare account id), so the bucket is per-customer-per-provider, not global — one customer's aggressive polling never throttles another's. Bucket sizes default to a conservative fraction of each provider's documented limit (from the Phase 1 survey), overridable per provider.
   - **Credential injection**: a small, consistent helper for the common shapes (`Authorization: Bearer <token>`) so provider code passes a token, not a header-construction routine, cutting the four near-identical "build the auth header" blocks down to one.
   - **Outbound-health logging**: every call's outcome (success, retried-then-succeeded, retried-then-failed, rate-limited) is recorded through the same structured-logging path NEAT already uses elsewhere (not a new logging mechanism) — this is what a future `neat connector list --verbose` or per-connector health surface reads from, and it's the same signal a maintainer needs today when a connector silently stops producing edges.
2. **A parallel, smaller `dbJunction` wrapper** for Supabase's `pg`-based path — same timeout/retry/rate-limit discipline, adapted to a connection-pool query rather than `fetch`. Not a full second implementation: it shares the retry/backoff and rate-limit primitives with `junctionFetch`, just swaps the transport.
3. **Every existing connector's client code refactors to call through the junction** — `railway/client.ts`, `firebase/logging-api.ts`, `cloudflare/client.ts`, `supabase/client.ts`, `supabase/postgres-client.ts` lose their own bare `fetch`/`pg` calls and gain a call through `junctionFetch`/`dbJunction` instead. `poll()` signatures, signal mapping, and test fixtures are unaffected — this is a refactor of the transport layer underneath, not a change to any provider's observable behavior.
4. **Scope for this cut: the shared code-architecture layer, for both credential profiles.** Whether hosted NEAT additionally deploys this junction as a literal network egress point (a single well-known IP/gateway a customer could allowlist on their own provider account) is a separate, later infrastructure decision — this ADR builds the module every connector calls through; it doesn't decide where hosted NEAT's outbound traffic physically originates from.

### Consequences

- All four connectors gain timeout/retry/rate-limit discipline for free, and any future provider gets it automatically by calling through the junction rather than writing its own `fetch` wrapper — the same "one place, not four" benefit the provider dispatch table (ADR-130) already gives the CLI/daemon side.
- A connector's outbound behavior becomes observable in one place, which is what makes a future connector-health surface (`neat connector list --verbose`, or surfacing a stuck connector as a NEAT-native incident) possible without instrumenting each provider module separately.
- The per-`(provider, accountKey)` rate-limit bucket keeps the ambient/passive principle intact even under retry — a transient failure backs off and self-limits rather than compounding into the kind of traffic pattern that principle exists to forbid.
- Refactoring the four existing connectors onto the junction is test-surface-neutral by design: `poll()`'s contract and every existing fixture-based test keep passing unchanged, since only the transport call underneath moves.
- The hosted-egress-gateway question (does hosted NEAT's outbound traffic come from one well-known IP a customer can allowlist) stays open, deliberately, for when hosted infrastructure decisions are made — this ADR doesn't foreclose it, but doesn't build it either.

## ADR-132 — A unified logs surface: native OTLP logs signal + connector log retention, one bounded store, filterable by source

**Status:** Accepted. Refs #653 (connectors-plane tracking issue) and opens a new tracking issue for the OTel-logs-ingest substrate work. Amends [`otel-ingest.md`](contracts/otel-ingest.md) and [`connectors.md`](contracts/connectors.md); adds a new [`logs.md`](contracts/logs.md) contract for the store/REST/MCP/CLI/frontend surface.
**Contracts:** [`otel-ingest.md`](contracts/otel-ingest.md), [`connectors.md`](contracts/connectors.md), new [`logs.md`](contracts/logs.md), [`rest-api.md`](contracts/rest-api.md), [`mcp-tools.md`](contracts/mcp-tools.md), [`cli-surface.md`](contracts/cli-surface.md), [`web-shell.md`](contracts/web-shell.md).

### Context

NEAT has never had a general log stream. The closest analog, `errors.ndjson` (`otel-ingest.md`'s incident recording), only captures failures — a span with ERROR status, an exception event, a 5xx burst — never ordinary request/activity records. Two things converge to make a real logs surface worth building now: (1) the connectors plane (ADR-124/127/128/129) already pulls genuinely log-shaped data from four providers — Railway's `httpLogs`, Firebase's `LogEntry`s, Cloudflare's invocation records, Supabase's `edge_logs` rows — and today throws every individual entry away the moment it's aggregated into an `ObservedSignal`'s `spanCount`/`errorCount`; (2) NEAT's own OTel ingest has only ever handled the traces signal (`/v1/traces`) — an app's own logger output (structured logs via winston/pino/bunyan, or explicit OTel Logs API calls) has no ingestion path at all, so "logs from the code NEAT owns" don't exist as a concept yet either.

The two halves need one unified answer, not two bolted-together features: an agent or a developer asking "what happened in the last few minutes" shouldn't have to know whether an event came from the app's own logger or from Supabase's Management API — they should see one stream, filterable by source when they want to narrow it (a debugging session focused on "is Supabase misbehaving" wants only Supabase's slice; a general health check wants everything).

### Decision

**1. Native logs: a real OTLP logs receiver, not a derivation from spans.** A new `/v1/logs` HTTP receiver (`packages/core/src/otel-logs.ts`), sibling to the existing `/v1/traces` receiver (`otel.ts`), accepting `ExportLogsServiceRequest` (JSON and protobuf, same content-type dispatch `otel.ts` already does). Each `LogRecord` maps to a native `LogEntry`: `timeUnixNano` → `timestamp`, `severityNumber`/`severityText` → `severity`, `body` → `message`, `resource.service.name` → the owning `ServiceNode`, `attributes['code.filepath']`/`code.lineno'` → an optional call-site (when the log library captured it), `trace_id`/`span_id` → optional cross-reference back to the trace that produced it. Same non-blocking-receiver discipline `otel-ingest.md` already states for traces: reply before mutation, queue-drained off the hot path. Same bearer-token gating (`NEAT_OTEL_TOKEN`) as the traces receiver.

Reaching real application log output requires new installer wiring, not just the receiver: the four-deps invariant (`sdk-node`, `auto-instrumentations-node`, `exporter-trace-otlp-http`, `api`) gains a logs-export counterpart (`sdk-logs`, `exporter-logs-otlp-http`, a `LoggerProvider`) plus, where the target app uses one, a log-library auto-instrumentation package (`instrumentation-winston` / `-pino` / `-bunyan`). Bare `console.log` calls are **not** captured — there is no standard OTel console-capture instrumentation, and patching the global console is a materially more invasive step this cut doesn't take. This is a real, named limitation: "native logs" means the app's structured logger output (when one of the three above is in use) or explicit OTel Logs API calls, not literally everything the process ever printed.

**2. OCloud logs: the four existing connectors retain raw entries, not just aggregate them.** Each connector's `map.ts` already turns a raw provider record into an `ObservedSignal` for the graph; it additionally emits a `LogEntry` for the same record, tagged `source: '<provider>'`, before or alongside that aggregation. `poll()`'s signature and the existing `ObservedSignal` behavior are unaffected — this is an addition to what a connector's mapping layer produces, not a replacement.

**3. One bounded store, not two, and not unbounded.** A per-project, per-source ring buffer (`packages/core/src/logs-store.ts`) — a capped count and/or age window per source (default: last 1,000 entries or 24h, whichever is smaller, overridable), in-memory, matching the "OBSERVED is a live signal, not a historical archive" framing the rest of the connectors plane already holds to. Per-source capping means one noisy source (a chatty native app, a high-traffic Supabase project) can never evict another source's entries — every source gets its own budget, merged only at read time by timestamp. No unbounded ndjango-style sidecar, no retention/rotation policy to operate — a daemon restart loses the buffer, the same honest trade-off NEAT already accepts for the in-memory graph between snapshots.

**4. `LogEntry` is the one shape every source produces:**
```ts
interface LogEntry {
  id: string
  projectName: string
  source: 'native' | 'supabase' | 'railway' | 'firebase' | 'cloudflare' | 'vercel'  // extensible per provider
  serviceName?: string
  nodeId?: string             // the graph node this correlates to, when resolvable
  timestamp: string           // ISO8601, the event's own time — never ingest/poll time
  severity?: string           // normalized: 'debug' | 'info' | 'warn' | 'error'
  message: string
  attributes?: Record<string, unknown>   // source-specific extra fields
}
```

**5. One REST endpoint, dual-mounted per ADR-026:** `GET /logs` / `GET /projects/:project/logs`, query params `source` (repeatable, defaults to all), `service`, `limit` (capped), `since`. Envelope per ADR-061: `{ count, total, logs: [...] }`. This is the single data path every consumer below reads through — no consumer reads the in-memory store directly.

**6. MCP gains a `get_logs` tool, no successor ADR needed to add it** — `mcp-tools.md` already states the tool set is manifest-driven (`MCP_TOOL_NAMES` in `@neat.is/types`), not count-locked the way the CLI's ten verbs are. `get_logs(source?, service?, limit?, since?)` calls the REST endpoint exactly like every other tool. **This is how "the filter is MCP-controllable" is satisfied**: the filter is a query parameter the agent passes when it calls the tool, not a stored, mutated, cross-surface toggle — `get_logs({ source: 'supabase' })` reads only Supabase's slice, in one read-only call, consistent with the "every MCP tool is read-only" rule (`cli-surface.md`). The frontend's own filter UI (§8) sets the identical query parameters against the identical endpoint; the two surfaces share a data path, not a stored filter state.

**7. CLI gains an eleventh verb, `neat logs [--source <name>] [--service <name>] [--limit N] [--since <date>]`** — this does require the successor ADR `cli-surface.md` names for extending its locked ten, which this ADR provides.

**8. Frontend gains a Logs page**, joining the existing list/table page family (Divergences, Incidents, Policies) per `web-shell.md`. A source filter (chips or a dropdown: All / Native / Supabase / Railway / Firebase / Cloudflare / Vercel) sets the same `source` query param the REST endpoint already takes — the same filter surface MCP uses, not a parallel implementation.

### Consequences

- NEAT gets a real logs surface for the first time, unifying "what the app itself logged" and "what the OCloud providers observed" into one filterable stream — the connectors plane's raw data stops being thrown away the moment it's aggregated.
- The native half is a genuine substrate addition (a new OTLP signal type), not a small feature — installer wiring, a new receiver, and a real, stated limitation (structured-logger output only, no bare `console.log` capture) all ship together, honestly scoped rather than glossed over.
- The bounded, per-source store keeps this from becoming an unbounded log-aggregation platform — a scope NEAT has deliberately stayed out of everywhere else in the connectors plane, and continues to here.
- `get_logs` costs nothing against the CLI's locked-verb discipline (that lock is CLI-specific) but does spend the MCP tool surface's one open extensibility point for this cut; `neat logs` spends the CLI's eleventh-verb allowance this ADR unlocks.
- Every consumer (REST, MCP, CLI, frontend) reads through one endpoint with one filter shape — an agent scoping a query to one provider and a developer clicking a filter chip are doing the identical operation against the identical data path.

## ADR-133 — Cloudflare platform tag: the extractor stamps `platform`/`platformName`, the connector fuses onto it

**Status:** Accepted. Refs #737.
**Contracts:** [`static-extraction.md`](contracts/static-extraction.md), [`connectors.md`](contracts/connectors.md).

### Context

The Cloudflare connector needed a way to tie a provider-observed Worker invocation back to a specific extracted service. Static extraction already reads a service's manifest for framework detection (ADR-074); a `wrangler.toml`/`wrangler.jsonc` is the same kind of manifest signal, sitting unread.

### Decision

`infra/cloudflare.ts` reads a service's wrangler config at extract time and stamps two additive fields: `platform` on `ServiceNodeSchema` (`'cloudflare'` when a wrangler config is present — a free string, the same discipline `framework` already established, so a future platform costs no schema change) and `platform` + `platformName` on the Worker's entry `FileNodeSchema` (`platformName` is wrangler's own `name` field — the only identifier Cloudflare's telemetry carries). Declared resources (KV/D1/R2/Durable Object/Queue bindings, cron triggers, routes, env-var names, service bindings) become `InfraNode`s wired from the entry file, the same pattern `dockerfile.ts` already uses for its image/`EXPOSE` nodes. Full field and edge shape: `static-extraction.md`'s platform section.

The Cloudflare connector's `resolveTarget` fuses onto this tag instead of a hand-maintained mapping. Since a provider module carries no mutation authority (ADR-030), it declares an honest fallback (`ResolvedConnectorTarget.ensureInfraNode`) for an observed Worker the extractor hasn't tagged, rather than dropping the signal. Full mechanism: `connectors.md` §4a.

`platform` doubles as the frontend's icon key at the service-rollup level — the same tagged node the extractor stamps is the one a future OBSERVED edge lights up, the static-becomes-live spine the rest of the connectors plane already follows.

### Consequences

- The Cloudflare connector reads the same tag the graph already carries, instead of its own hand-maintained service mapping.
- A future platform costs a new extractor producer and a string value, not a schema change.
- The GUI gains a free, honest icon signal — it renders what the extractor actually found, nothing inferred.

## ADR-134 — The observed-overlay leads with two paths: run your app, or connect a provider

**Status:** Accepted. Refs #750. Amends [`canvas-layout.md`](contracts/canvas-layout.md).
**Contract:** [`canvas-layout.md`](contracts/canvas-layout.md).

### Context

The observed=0 overlay (ADR-098, amended by ADR-101) has always offered exactly one path to completing the picture: instrument and run the app, OTLP fills OBSERVED. That was the only path that existed at the time. The connectors plane (ADR-124/127/128/129, on-ramp ADR-130) now offers a second, real one — Supabase/Railway/Firebase/Cloudflare's own telemetry, pulled with zero app instrumentation. A user staring at a static graph with observed=0 sees only the OTLP path today, even when their app is already deployed to a platform a connector serves directly.

### Decision

The overlay gains a second, parallel section — "or connect a provider" — alongside whichever of Mode A / Mode B is active. Not a third mode: both existing modes keep their own diagnostic story (idle vs. didn't-engage), and the provider path sits alongside as an equal alternative, not a fallback shown only when Mode B fires. "Or connect a provider" reads as a second way in, consistent with the fusion/completion framing (canvas-layout.md §3).

The path is honest by construction:

- Lists exactly the shipped providers — Supabase, Railway, Firebase, Cloudflare — never Vercel (still `#724`, an open tracking issue with no dispatch-table entry). The list reads off the same provider set `connectors/registry.ts` dispatches, so a fifth provider later is a data change, not a copy change.
- Points at the real CLI, `neat connector add <provider>`, already on `main` (`connector-config.md` §3) — the same command a terminal-first user would run, no parallel GUI-only path that could drift from what the CLI actually does. No in-GUI credential form this cut — a browser-side secret-entry flow is its own surface; this ships the honest pointer, not a shortcut around it.
- Renders as a command block, the same visual pattern Mode A's `neat sync` and Mode B's `neat extend` already use.

### Consequences

- The empty-state screen — the first thing an operator with observed=0 sees — carries both of NEAT's real paths to a complete picture, not a partial one.
- No new graph/node/edge/provenance type: this is copy and a CLI pointer over already-shipped surface.
- The providers list is a small, hand-maintained array; worth a follow-up (source it from a real endpoint rather than a hardcoded array) once the connectors plane has more than four providers — not blocking for launch.
- Escapability, persistence, and the card-height cap (canvas-layout.md §5) apply identically to the expanded overlay — a second section is more content, not license to relax the never-a-trap rule.
## ADR-135 — The Settings page retires the StubPage: project, daemon connection, and token, all real

**Status:** Accepted. Refs #753. Amends [`web-shell.md`](contracts/web-shell.md).
**Contract:** [`web-shell.md`](contracts/web-shell.md).

### Context

`web-shell.md` §4 has named "Settings / Project — the project switcher surface, daemon/connection state, token" as part of the page set since the shell's original IA design, but the surface itself has stayed `StubPage(settings)` — the one nav entry still marked `kind: 'todo'` after Divergences, Incidents, Policies, Find, and now Logs all graduated to real pages. The three controls the stub promises already exist, live, elsewhere: the project switcher in `TopBar`'s popover, daemon/SSE connection state in `StatusBar`, and the bearer token at `/login` (read/write/clear already real in `lib/active-profile.ts`). Nothing here is unbuilt — it's unconsolidated.

### Decision

`SettingsPage.tsx` joins the AppShell-embedded page family — the same pattern `PoliciesPage`/`DivergencesPage`/`LogsPage` already use (a component taking the resolved `project` as a prop, switched in by `activePage`), not a standalone route. Three real sections, each backed by the same code path its scattered counterpart already uses rather than a second implementation:

1. **Project** — the discovered profile list (`/api/profiles`) rendered inline, click-to-switch calling the same `selectProfile` AppShell already threads to `TopBar`. Not a link to "go use the topbar switcher" — the same real action, in place.
2. **Daemon connection** — a live `/api/health` poll (mirroring `StatusBar`'s ok/slow/down + latency classification) and the SSE connection state, scoped to the active project. A second independent poll is consistent with the codebase's existing precedent — `TopBar` already runs its own separate 15s health poll for its live dot alongside `StatusBar`'s 5s poll; a third consumer of the same cheap, idempotent endpoint is not a new pattern.
3. **Token** — the active profile's token status (set / not set, never displayed in full — a masked input, matching `/login`'s `type="password"` discipline), a real update action that validates the new token against `/api/health` before storing it (the identical validate-before-store round-trip `LoginForm` already runs, same error copy), and a real clear action (`clearProfileToken`, no forced navigation — the operator is already looking at the control that manages this state, unlike `StatusBar`'s sign-out button, which exists to get you *out* of the dashboard).

`nav.ts`'s `settings` entry moves from `kind: 'todo'` to `kind: 'page'`, the same graduation Incidents/Divergences/Find/Logs already made. `StubPage.tsx` drops its `settings` copy entry — the last one — since no `NavId` routes there anymore.

### Consequences

- Every sidebar entry is now a real page; `StubPage.tsx` has no live callers left (kept as the mechanism for whatever the next progressive sibling is, per its own doc comment — not deleted).
- No new REST endpoint, no new state store: Settings is a third reader of `/api/profiles` and `/api/health`, and a fourth call site (after `LoginForm`, `StatusBar`'s sign-out, and `use-auth-gate`) of `lib/active-profile.ts`'s existing token functions.
- `web-shell.md`'s Authority section is corrected from a loose `packages/web/app/{page,divergences,incidents,policies,settings}/**` glob (which never matched how Divergences/Policies/Logs actually ship) to the real component list.
## ADR-136 — A read-only connector status endpoint, backed by an in-process poll-health tracker

**Status:** Accepted. Refs #755. Amends [`rest-api.md`](contracts/rest-api.md) and [`connectors.md`](contracts/connectors.md); the response type lands in `@neat.is/types`.
**Contracts:** [`rest-api.md`](contracts/rest-api.md), [`connectors.md`](contracts/connectors.md).

### Context

The connectors plane polls (ADR-124/127/128/129), `neat connector` turns a connector on via `~/.neat/connectors.json` (ADR-130), and the shared junction gives every outbound call its timeout/retry/rate-limit discipline (ADR-131). The one piece a connector view in the web GUI still needs is a read surface: which connectors are configured for a project, and whether each one is actually polling. Today the poll loop (`startConnectorPollLoop`, `connectors/index.ts`) `console.error`s a failed tick and moves on — the outcome reaches the log and nowhere queryable. `neat connector list` reads the config and redacts each credential to its env-ref pointer, but it is terminal-only and says nothing about live poll health. So a dashboard asking "is `cf-prod` healthy, and when did it last poll?" has no answer to render.

### Decision

**1. `GET /:project/connectors`, dual-mounted per ADR-026.** Returns `{ connectors: [...] }`, one entry per `connectors.json` connector that matches the project (`connectorMatchesProject`), each shaped `{ id, provider, credentialRef, status }`. `credentialRef` is the redacted env-ref pointer (`"$CF_TOKEN"`) for a single-field credential, or a field→pointer map for a multi-field one; a plaintext literal shows `"****"` — the same `isEnvRef`-driven redaction `neat connector list` already prints, factored into a shared `redactCredentialRef` helper so the two surfaces can never disagree on what counts as a pointer. Read-only, reads the live config file (no graph read at request time), envelope per ADR-061.

**2. An in-process poll-status tracker.** A process-local module singleton (`connectors/status.ts`) — the same in-memory, daemon-restart-loses-it shape `logs-store.ts` already uses for the daemon's other live surface — that the poll loop writes on **every** tick (success and failure) and the endpoint reads. Per connector id it records `lastPollAt` (ISO), `lastOutcome` (`ok`/`error`), `lastError` (a short, secret-free string, present only on a failing tick), `signalsLastPoll` (the count the tick returned), and the time of the last successful poll. The reported `state` is derived at read time: `idle` (no tick yet), `error` (the last tick threw), `healthy` (a recent successful poll), `stale` (no successful poll within the threshold — a poll loop gone silent or wedged, a connector-poll concept distinct from the per-edge-type `OBSERVED`→`STALE` thresholds; default five poll intervals). The tracker keys by connector id, which flows from the config entry through the `ConnectorRegistration` into the poll loop; a connector without an id (a programmatic `opts.connectors` entry, never in `connectors.json`) records nothing and never appears on this endpoint.

**3. Secret discipline is kept by construction.** The endpoint never calls `resolveCredential` — it only ever reports the pointer, exactly as `neat connector list` does. `lastError` carries the poll error's own message, truncated, never a credential; the resolved secret exists only inside the `ConnectorContext` that flows to `poll()`, precisely as `connector-config.md` §6 and `connectors.md` §6 already require. A regression test asserts that a `$VAR` credential is returned as the literal pointer and that its resolved value appears nowhere in the response.

### Consequences

- The web GUI's connector view (and a future `neat connector list --verbose`, the surface ADR-131's consequences already anticipated) gets a real data path — configured connectors plus live health — where none existed.
- The poll loop's failed-tick `console.error` becomes a queryable fact without changing what the tick mints or how it advances `since`; the recording is additive and fires only for connectors that carry an id, so programmatic callers are unaffected and every existing connector test keeps passing.
- No new node, edge, or provenance type: connector status is process-local runtime state, never the graph and never the snapshot — consistent with the "OBSERVED is a live signal, not an archive" framing and the credentials-never-reach-the-snapshot rule the rest of the plane already holds to.
- A silent or wedged poll loop surfaces as `stale` rather than sitting `healthy` forever, so the view distinguishes "polling and fine" from "configured but not actually running."

## Closed forward-looking issues referenced here

- **#365** — Lazy project activation (v0.5+, deeper version of ADR-079)
- **#366** — Strategic question on single-daemon vs project-scoped daemons (future, post-hosted-SaaS pressure)
- **#367–#371** — v0.4.4 implementation issues for ADR-076, ADR-077, ADR-078, ADR-079

## ADR-137 — A connector status view makes the connector a first-class, provenance-visible source

**Status:** Accepted. Refs #756. Amends [`web-shell.md`](contracts/web-shell.md).
**Contract:** [`web-shell.md`](contracts/web-shell.md).

### Context

Every edge in the graph carries provenance — a claim is trusted by its source (EXTRACTED / OBSERVED / STALE). A connector is an OBSERVED source, the same standing OTLP ingest has, but the GUI has never surfaced it as one: a user who runs `neat connector add` sees the resulting edges land on the canvas with no visible origin, and nothing in the shell reflects that a connector exists, is polling, or has gone quiet. The connector plane's own health (configured, polling, healthy, erroring, stale) has been terminal-only, reachable through `neat connector list`/`test` but invisible in the one place most of NEAT's story already lives.

### Decision

A **Connectors** page joins the nav, in the Queries group alongside Divergences/Policies/Incidents/Logs — the same family of read-only views over what the graph already knows, not a configuration surface. Per connector: `id`, `provider`, the credential's redacted env-ref pointer (`$CF_TOKEN`, never a resolved secret — mirrors `neat connector list` exactly, same never-at-rest, never-resolved discipline `connector-config.md` §2/§6 already hold), and live status (`idle` / `polling`·`healthy` / `error` with the short failure message / `stale`, using the same STALE vocabulary the canvas legend already teaches — a connector that stopped producing signals is the same kind of fact as an edge that stopped speaking), plus last poll time and signals minted on the last tick.

**No in-GUI add form.** Credentials stay CLI-only, where they're typed once into a terminal, never into a browser form this product would then have to secure end-to-end. This view is read-only by design, the same boundary `connectors.md`/`connector-config.md` already draw around where a secret is allowed to exist.

**The re-test action ships as an explicit preview, not a mock.** `neat connector test <id>` re-runs the validation round-trip today, but it's a CLI-side call with no REST path — `GET /:project/connectors` (the endpoint this view reads) only lists status, it doesn't trigger a check. A live "re-test" button with nothing real behind it would be exactly the "live-looking control that does nothing" the honesty rule forbids. It renders `disabled`, labeled plainly, the same `preview` pattern the Policies page already established for a control whose backend isn't there yet — flips live the moment an on-demand-test endpoint ships, no redesign needed.

### Consequences

- The "know how much to trust each claim" thesis now extends to the connector itself — a user can see, in the GUI, that `cf-prod` is healthy or has gone stale, the same way they already see it for an edge.
- No new node/edge/provenance type: this reads connector metadata the daemon already holds in memory, it doesn't add a new kind of graph fact.
- The view is built against a fixture matching `GET /:project/connectors`'s exact shape ahead of the endpoint landing, and wired once it merges — the same build-ahead-of-the-endpoint pattern the Logs page used against its own REST surface.
- The re-test preview is one of the few remaining "designed, not yet live" controls in the shell (alongside Policies' enforcement layer) — both wait on their respective backend pieces, both stay honest about it in the meantime.

## Closed forward-looking issues referenced here

- **#365** — Lazy project activation (v0.5+, deeper version of ADR-079)
- **#366** — Strategic question on single-daemon vs project-scoped daemons (future, post-hosted-SaaS pressure)
- **#367–#371** — v0.4.4 implementation issues for ADR-076, ADR-077, ADR-078, ADR-079
## ADR-138 — Extend the platform identifier to Vercel, Railway, and Supabase

### Context

ADR-133 gave Cloudflare Workers/Pages a `platform` identifier at extract time — a static tag on the ServiceNode (and the Worker's entry FileNode) that the frontend service-rollup badge keys on and the connector fuses OBSERVED edges onto. It landed Cloudflare-only: `extract/infra/cloudflare.ts` reads `wrangler.toml` and stamps `platform: cloudflare`. The other three connector providers — Vercel, Railway, Supabase — had connectors but no static platform tag, so their services carried no badge, and the "static system becomes live" spine existed for one provider out of four.

### Decision

Three detector-extractors join `cloudflare.ts` under `extract/infra/`, each reading the provider's own declared config and stamping the same `platform` field — no new NodeType, no new provenance, property updates on existing nodes (allowed per ADR-030):

- **`vercel.ts`** — `vercel.json`/`vercel.jsonc`, plus `.vercel/project.json` for the linked project name → `platformName`. Models crons, env-var names, and routes/rewrites as InfraNodes. Vercel apps have no Worker-style entry file, so the tag and edges anchor on the ServiceNode itself.
- **`railway.ts`** — `railway.toml`/`railway.json`/`railway.jsonc`. Models the healthcheck path and cron schedule. Railway's config names no service (that lives in Railway's own system, which the connector resolves by `deploymentId`), so no `platformName` is stamped here.
- **`supabase.ts`** — `supabase/config.toml`, using `project_id` as `platformName` (the ref the Supabase connector resolves against). Models edge functions, storage, and auth as InfraNodes.

Declared-resource edges route through one shared helper, `emitPlatformResourceEdge` in `infra/shared.ts` — named out of the `add<Word>` producer-entry-point namespace the static-extraction audit scans, because it is an internal emitter, not a producer entry point. Env-var values are never read (names only, ADR-016 spirit). Every edge carries `evidence.file`.

### Consequences

- The `platform` badge (#752) renders for all four providers, keyed on a real extracted config file — honest, static, nothing inferred.
- The connector-fusion path is unchanged: the same tagged nodes these extractors stamp are what each connector later lights up with OBSERVED edges. Extraction now feeds every provider's target resolution, not just Cloudflare's.
- The tag stays a free string on ServiceNode/FileNode (ADR-133's discipline) — a fifth provider is a new detector file, not a schema change.

## ADR-139 — `/api/config` separates "no login required" from "read-only" (amends ADR-073 §3a)

**Status:** Accepted. Refs #761. Amends [`one-command-cli.md`](contracts/one-command-cli.md) §3a.
**Contract:** [`one-command-cli.md`](contracts/one-command-cli.md).

### Context

A daemon started without `NEAT_AUTH_TOKEN` serves every request anonymously. `mountBearerAuth` (ADR-073 §3) early-returns when no token is set, so there is no bearer hook at all — reads and writes both go through. That is the laptop dev path, and it is meant to work with zero setup.

The web shell, though, still pushes the operator to `/login` on that daemon. `/api/config` (the ADR-073 §3a negotiation surface) reports `publicRead` straight off `NEAT_PUBLIC_READ`, so a tokenless daemon answers `{ publicRead: false, authProxy: false }`. `useAuthGate` reads no stored token plus `publicRead: false` and redirects to `/login?next=…` — asking the operator for a bearer that the daemon neither issued nor checks. Whatever they paste is meaningless, so it appears to "reset," and a daemon that would serve them freely traps them at a login screen.

The root confusion is that `/api/config` only ever spoke one bit — `publicRead` — and the web layered two distinct decisions on it:

- **Does the operator need to log in?** No, for a tokenless daemon (nothing to log in with) or a proxy-terminated one (the proxy already authed them). Yes, for a token-gated daemon.
- **Should the UI render read-only?** Yes, only for a `NEAT_PUBLIC_READ=true` reference deployment, where anonymous reads are allowed but writes stay gated.

A tokenless local daemon is the case that breaks: no login needed *and* fully writable. `publicRead` cannot express it — `false` forces the login bounce, `true` would wrongly disable every mutation affordance (`useReadOnly()` keys off `publicRead`). The stopgap of widening `publicRead` to cover the tokenless case trades a login trap for a read-only lie. The two questions need two signals.

### Decision

**1. `/api/config` gains a third boolean, `requiresAuth`.** The surface now returns `{ publicRead, authProxy, requiresAuth }`. `requiresAuth` is `true` iff the daemon actually enforces a daemon-side bearer — `authToken !== undefined && !trustProxy` — which is exactly the condition under which `mountBearerAuth` mounts its hook. A tokenless daemon and a proxy-terminated one both report `requiresAuth: false`; a token-gated daemon reports `requiresAuth: true`, whether or not `publicRead` is also set. `publicRead` and `authProxy` keep their existing meaning untouched. The field threads through the web proxy route (`packages/web/app/api/config/route.ts`) and the `DaemonAuthConfig` type + loader in `public-read-mode.ts`.

**2. `useAuthGate` skips the `/login` redirect when the daemon requires no auth**, independent of `publicRead`. The gate already bailed on a discovered token, on `NEXT_PUBLIC_NEAT_AUTH_PROXY`, and on `publicRead`; it now also bails on `requiresAuth === false`. A tokenless daemon loads the dashboard directly.

**3. `useReadOnly()` / `publicRead` stay exactly as they were.** Read-only rendering remains gated on `publicRead` alone, so a `NEAT_PUBLIC_READ=true` reference deployment still renders read-only with its mutation affordances disabled and its "public read-only" badge, while a tokenless local daemon renders fully writable — because it is.

The conservative default is unchanged: when `/api/config` is unreachable or an older field-less daemon answers, `requiresAuth` reads `true` (assume secured, keep the login gate). Only an explicit `requiresAuth: false` from the daemon suppresses the redirect.

### Consequences

- A tokenless local daemon on loopback loads the dashboard with no `/login` bounce and no read-only badge — the laptop dev path works end to end, which it did not before.
- A genuine public-read reference deployment (`NEAT_PUBLIC_READ=true`) is unaffected: still no login bounce, still read-only, still badged.
- A token-gated daemon still gates to `/login` exactly as before — `requiresAuth: true` there, and the existing per-profile-token short-circuit (#637) still runs first.
- `/api/config` grows from two booleans to three. The contract's "exactly two booleans and nothing else" line becomes "exactly three," and the surface stays whoami-free / project-list-free / version-free per the ADR-073 §3a discipline.

## ADR-140 — get_dependencies excludes structural CONTAINS from its output (refines file-awareness §36)

**Status:** Accepted. Refs #780. Amends [`file-awareness.md`](contracts/file-awareness.md) §36.
**Contract:** [`file-awareness.md`](contracts/file-awareness.md).

### Context

file-awareness §36 makes file nodes first-class in the traversal queries — `getRootCause`, `getBlastRadius`, and `getTransitiveDependencies` "neither filter to service nodes nor roll file edges up" — so an agent gets file-grained answers. A consequence went unexamined: because the traversal walks *every* outbound edge, `getTransitiveDependencies` reports a service's own `CONTAINS` children — its Dockerfile, otel-init, routes — as "dependencies." On the demo graph, `get_dependencies(file:service-a:index.js)` returns ten nodes, of which five are the callee's structural files and the one dependency that matters (the `payments-db` it transitively reaches) sits at the deepest rank. An agent asking "what does service-a depend on?" gets a noisy answer with the signal buried. §36 as written mandated that behaviour, so it could not be a silent code fix — it was a contract question (#780).

### Decision

`getTransitiveDependencies` walks *through* `CONTAINS` edges — so a called service's file-grained targets (the file that `CONNECTS_TO` a database) still surface downstream — but does **not report a `CONTAINS` edge as a dependency**. A service does not depend on its own files; `CONTAINS` is structural ownership (§2), and here it is walked *outbound*.

This is asymmetric by design. `getBlastRadius` continues to report `CONTAINS`: walked *inbound*, `file ◀─CONTAINS─ service` means the service owns an affected file and is genuinely in the blast radius. So "what does X depend on" drops the structural children, while "what breaks if X changes" keeps the owning service. `getRootCause` is unchanged — it uses `CONTAINS` only to resolve a FileNode on the path to its compat-carrier service, never as a reported result.

### Consequences

- `get_dependencies(file:service-a:index.js)` now returns `{service-b (CALLS), config (CONFIGURED_BY), database (CONNECTS_TO), …}` — the transitive database is still reached through the CONTAINS hop, just without the callee's structural files as noise.
- `get_blast_radius` output is unchanged (the #392 and demo-graph blast tests still pass), preserving file-grained dependents plus the owning service.
- §36 is amended to state the asymmetry explicitly; the file-first promise still holds for the edges that carry a real relationship.
- Pinned by `packages/core/test/graph-dependencies.test.ts`.

## ADR-141 — ORM env-URL resolution + host-less OBSERVED database fusion (Prisma support)

**Status:** Accepted. Refs #801. Amends [`static-extraction.md`](contracts/static-extraction.md) and [`otel-ingest.md`](contracts/otel-ingest.md).
**Contract:** [`static-extraction.md`](contracts/static-extraction.md), [`otel-ingest.md`](contracts/otel-ingest.md).

### Context

ORMs like Prisma declare their datasource through an env indirection — `url = env("DATABASE_URL")` — and their query engine emits OTel spans that carry `db.system` but **no peer host** (Prisma's Rust engine backdates the span off the connection, ADR-118's motivating case for in-process DBs but here for a *networked* one). Two failures compound for a real Prisma app, confirmed live against Brief:

1. **Extraction mints two DatabaseNodes for one database.** The prisma parser can't resolve `env("DATABASE_URL")`, so it falls back to a placeholder host and mints `database:postgresql-prisma`; the dotenv parser reads the same `DATABASE_URL` and mints `database:<real-host>`. Drizzle and Knex carry the same `<engine>-<orm>` placeholder fallback.
2. **Ingest can't host-match the OBSERVED span.** The host-less `db.system` span resolves no peer, so `ensureLocalDatabaseNode` mints a third, service-scoped node (`database:<svc>/postgresql`).

The three never fuse. The declared `CONNECTS_TO` has no OBSERVED twin on the same `(source, target, type)` triple, so it surfaces as a false `missing-observed` divergence — NEAT reporting "you declared a database you never connect to" for a DB the app hammers. That breaks the flagship divergence query for essentially every Prisma/Drizzle/Knex backend.

### Decision

Three coordinated changes so an ORM DB dependency forms **one** fused node carrying both EXTRACTED and OBSERVED provenance, and its declared/observed edges compare cleanly:

1. **ORM env-URL resolution (extraction).** When Prisma's datasource declares its URL via `env("VAR")`, the parser resolves `VAR` from the service's `.env` files and parses the real connection string — a shared helper (`resolveEnvVar`) reusing the same `.env` read the dotenv parser performs. The placeholder-host fallback survives only when the variable is genuinely absent. The Prisma node and the dotenv node then share the real host and dedup to one declared node (`index.ts`, first-wins-on-identical-host). Per ADR-016 the resolved value is transient — it derives the DatabaseNode host and never lands in a ConfigNode or snapshot. **Scope: Prisma only for now** — Drizzle and Knex reference their URL through `process.env.X` in a JS/TS config rather than `env("VAR")`, so each needs its own env-reference detection; wiring the shared helper into them is follow-up, not done here.

2. **Host-less OBSERVED DB fusion (ingest).** When a `db.system` span carries no peer host, before minting a service-local node, look for a database the emitting service already declares (an EXTRACTED `CONNECTS_TO` from the service or one of the files it `CONTAINS`) with the *same engine*. If exactly one matches, land the OBSERVED `CONNECTS_TO` on **that** node. Ambiguous (two-plus same-engine declared DBs) or no match falls back to the ADR-118 service-local node, unchanged.

3. **Service-grain comparison for database CONNECTS_TO (divergence).** A database is *declared* in a config file (the connection string) but *executed* from a code file (the query call site) — inherently different files, so a file-grained `(source, target)` comparison flags both a `missing-observed` (on the config edge) and a `missing-extracted` (on the code edge) even after the target fuses. The divergence bucketer rolls a database `CONNECTS_TO`'s source up to its owning service, so the declared and observed edges compare at the grain they share. This is scoped to database targets — a route or service edge keeps its file/route grain (ADR-119). The file-grained edges stay in the graph untouched; only the comparison coarsens.

### Consequences

- A Prisma service's DB dependency is one node with both EXTRACTED and OBSERVED `CONNECTS_TO`. The false `missing-observed` disappears; a genuinely-unused declared DB still surfaces (no observed same-engine connection to fuse).
- The fusion is engine-scoped and single-match-only, so it never silently merges two distinct databases — the ambiguous case degrades to today's behaviour, not to a wrong merge.
- The env-resolution is Prisma-only for now; Drizzle and Knex (which reference the URL via `process.env.X`) keep their placeholder-host fallback until their env-syntax detection is added — tracked as follow-up on #801.
- Pinned by unit tests (a Prisma-shaped host-less `db.system` span fuses onto the declared node; the ambiguous case does not) and the live `e2e/brief` OBSERVED harness, which now passes with the DB dependency observed rather than divergent.

## ADR-142 — Explicit `grain` label on OBSERVED edges

**Status:** Accepted. Refs #803. Amends [`file-awareness.md`](contracts/file-awareness.md) §10.
**Contract:** [`file-awareness.md`](contracts/file-awareness.md).

### Context

An OBSERVED edge is either **file-grained** — it originates from a source file's call site (a `file:` source with an `evidence` block) — or **service-grained**, a coarse fallback where no call site was captured (a `service:` / `infra:` source). Today that grain is *implicit*: a consumer re-derives it by noticing the source-id prefix and the absence of `evidence`, and four consumers (divergence, MCP, REST, canvas) each re-derive it independently. The connector file-grained launch gate (#803) requires the service-grained case to be an *explicitly labeled fallback*, not an implicit one — that label is the pass/fail line for the gate, and today it exists only as a render-time convention on the canvas.

### Decision

Add a first-class `grain: 'file' | 'service'` field to the edge, set once at mint time in `upsertObservedEdge` — the single mint point for both the OTel ingest path and every pull-connector (`connectors/index.ts` routes through it). `grain` is `'file'` when the edge originates from a `file:` source (a call site was captured, `evidence` present) and `'service'` otherwise. Every consumer now reads the stored fact instead of re-deriving it four ways. The hard rule stands (file-awareness §6 / §10): a coarse edge is never dressed as a confident `file → file` line — now backed by an explicit label, not only a render convention.

### Consequences

- OBSERVED edges carry `grain`; the coarse fallback is machine-readable across MCP / REST / divergence / canvas.
- Foundational for the connector file-grained gate (#803): "service-grained only as a labeled fallback" becomes a stored, queryable fact rather than an implicit derivation.
- Derived from the edge source at mint time, so no new plumbing through the OTel or connector callers; a legacy edge missing the field is backfilled on its next observation.
- Follow-up (not in this change): a `coarseReason` sub-tag (`unrecognized-router`, `no-static-callsite`, `l4-flow`, `undeclared-resource`) that also feeds the `missing-extracted` reason.
- Pinned by unit tests and verified on the live Brief graph.

## ADR-143 — A route-target observation file-grains onto the route's own definition site

**Status:** Accepted. Refs #803. Amends [`connectors.md`](contracts/connectors.md) §4.
**Contract:** [`connectors.md`](contracts/connectors.md).

### Context

The connector file-grained gate (#803) sharpened *egress* observations by attribution: when a pull-connector reports a target with no caller of its own (the common case — provider telemetry records the target, never the line that called it), the pipeline lands the OBSERVED edge on the single file whose EXTRACTED edge reaches that target (`staticCallSiteFor`, ADR-142 / connectors.md §4). That works for a table or a bucket, which a static call site points *at*. It does nothing for an *ingress* target — a `RouteNode`. A route has no inbound `file → route` edge to attribute through: routes.ts owns a route via `service ──CONTAINS──▶ route`, a structural edge, not a call site. So Cloudflare Workers and Firebase Hosting — whose observations resolve onto a RouteNode (ADR-133 §5's route-grain match) — fell straight through `staticCallSiteFor` to the service-coarse fallback, even though the route's source file is known. Railway already dodged this by reading `route.path`/`route.line` into its own signal `callSite` inside its map layer — but that fix lived in one connector, so every other route-targeting connector re-hit the gap.

### Decision

A RouteNode records its own definition site: `path` (the service-relative source file routes.ts parsed the route from) and `line`. Recover the call site from there. `runConnectorPoll` gains `routeCallSiteFor(graph, targetNodeId)`, tried between the signal's own `callSite` and `staticCallSiteFor`: when the resolved target is a RouteNode carrying a `path`, the OBSERVED edge originates from that file at that line, `grain: 'file'`. This is the ingress twin of the egress attribution — same "the static pass already established this, it is a fact not a guess" discipline, a different lookup because the grain lives on the target node itself rather than on an inbound edge. It generalizes Railway's per-connector move into the shared pipeline: Railway keeps setting its own `callSite` (which still wins ahead of `routeCallSiteFor`), and Cloudflare/Firebase now file-grain identically with no per-connector code.

### Consequences

- Cloudflare Workers and Firebase Hosting observations file-grain onto the handler route's source file the moment a static router recognizer covers the Worker (ADR-133 §5), with zero connector-side change — the payoff compounds exactly as ADR-124 describes.
- The mechanism is target-shaped, not connector-shaped: any future connector that resolves a RouteNode target inherits file grain for free.
- No new provider telemetry, and none exists that would carry a caller line for an ingress hit; the grain comes entirely from the static route definition.
- A route target with no `path` (or a whole-file / coarse fallback target) stays service-coarse, honestly labeled (`grain: 'service'`, ADR-142).
- Pinned by a unit test and verified against the live Cloudflare Worker (`cloudflare-connector-live` CI).

## ADR-144 — The generated otel-init degrades to no-OBSERVED instead of crashing the host app when @opentelemetry is absent

**Status:** Accepted. Refs #820. Amends the generated-instrumentation shape (`installers/templates.ts`, file-awareness §4).

### Context

The orchestrator patches the app's entry to `require('./otel-init.cjs')`, adds the `@opentelemetry/*` packages to `package.json`, and runs the project's package manager to install them. When that install fails (a `yarn.lock` the local yarn can't parse) or simply hasn't run yet, the code patch still lands but the deps don't — and the generated init crashed the host app on boot at an unguarded top-level `require('@opentelemetry/sdk-node')`. NEAT bricked the very app it exists to observe, while the summary said "instrumented — run your app."

### Decision

The CJS otel-init template wraps the whole require-and-SDK-start block in `try/catch`: a missing dependency — or any init error — degrades to running **without OBSERVED** and prints one clear line, instead of throwing. Instrumentation is ambient (connectors.md §2's discipline, applied to the injected path): it must never break the app it's watching. The template stamp is bumped 6 → 7 so existing installs regenerate on next run.

### Consequences

- An app whose instrumentation install failed or hasn't run boots and warns, rather than dying on a missing module.
- The ESM/TS flavors use hoisted `import` and can't be guarded the same way — a follow-up (dynamic-import restructure); the CJS flavor is the common case and the one that crashed.
- Pinned by a test that runs the rendered CJS init where `@opentelemetry` is unresolvable and asserts a clean exit + the warning; the contract test's stamp assertion tracks the version bump.

## ADR-145 — `neat hooks`: reach for the graph before grepping

**Status:** Accepted. Refs #842, #843.

### Context

NEAT is the perception layer for agents, but an agent will still `grep`/`glob` by habit before it queries the graph — the exact "read text and guess" failure NEAT exists to remove. Making the agent reach for NEAT first is a wiring problem, not a model problem.

### Decision

A new `neat hooks` config command family (a sibling of `neat connector` / `neat skill`, not an eleventh locked query verb) installs two mechanisms: (1) a Claude Code **PreToolUse** hook (`neat-search-nudge.mjs`) that, on `Grep`/`Glob`/bash `grep`/`rg`/`find`, injects a short `additionalContext` note steering the agent to `semantic_search` / `get_dependencies` / `get_divergences` first — a **gentle, non-blocking nudge** (exit 0, no permission decision; the search still runs), silent on non-search tools; and (2) an agent-agnostic `GRAPH_FIRST` guidance block for `CLAUDE.md` / `AGENTS.md`. `neat hooks --apply` materializes both and merges the hook into `~/.claude/settings.json` idempotently.

### Consequences

- Claude Code users get interception + guidance; Codex/Gemini/Cursor users get the guidance block only (the hook is a Claude-Code affordance) — stated honestly in the CLI output and README.
- It never blocks a search — a wrong nudge costs nothing; the agent proceeds either way.
- Pinned by tests that the hook fires on search tools, no-ops otherwise, and `--apply` merges without disturbing existing hooks.

## ADR-146 — Vercel joins the connectors plane via Drains — a provider-push/OTLP shape, not a pull connector

**Status:** Accepted. Refs #803. Amends [`connectors.md`](contracts/connectors.md) (§1, and the "Vercel is next" framing).

### Context

The connectors contract framed Vercel as a coming **pull** provider ("Vercel is next"; the index row even read "Vercel ships as an installer path"). Live API discovery against a real Vercel account says otherwise: **Vercel exposes no public pull REST API for runtime invocations.** Runtime logs are rich (route pattern, method, status, traceId) and on all plans, but they are dashboard/streamed only — the pull endpoints 404, and the deployment-events endpoint returns build logs, not runtime. The one *supported* programmatic path is **Drains**, which forward **distributed traces in OpenTelemetry format** to a **custom HTTPS endpoint**, created via the Drains REST API (`schemas: { trace: { version: 'v1' } }`), on **Pro/Enterprise** plans.

### Decision

Vercel joins the connectors plane as a **Drains connector** — a *provider-configured push* shape distinct from the `poll()` pull interface every other provider uses. `neat connector add vercel` uses the Vercel REST API to create a trace-drain pointed at the daemon's OTLP `/v1/traces`; the daemon's **existing OTLP receiver** ingests the OTel traces and file-line OBSERVED falls out of the same OTel-ingest path an instrumented app would use. No new pull code, no new ingest code — the connector is a drain-setup command plus the receiver already in place. This corrects the "Vercel is next [as a pull provider] / installer path" framing.

### Consequences

- Vercel OBSERVED is **OTel-grade** (file-line, rich) with **zero app code** — architecturally the strongest zero-instrument source in the connector set. But it is **Pro-gated** (Drains are Pro/Enterprise, ~$0.50/drain-volume unit) — not a free-tier path.
- Establishes a second connector *shape* — provider-push via a drain — alongside the pull interface; the pull `poll()` contract is unchanged.
- **MongoDB Atlas** (a DB-egress *pull* provider, plus a paired `extract/calls/mongoose.ts` collection extractor for its file-grain) is a separate, still-pending item — deliberately not ADR'd here, because Vercel just proved a connector's shape must be confirmed against the live provider API first, and Atlas's telemetry surface + tier-gating hasn't been.

## ADR-147 — MongoDB collections: a Mongoose-faithful static extractor, the Atlas connector layered on where the tier allows

**Status:** Accepted. Refs #832. Amends [`static-extraction.md`](contracts/static-extraction.md) (a new `calls/mongoose.ts` producer). The Atlas connector under [`connectors.md`](contracts/connectors.md) is named here but its shape is deferred.

### Context

NEAT reads a Mongo connection string into a `database:mongodb:<host>` node (#832) but has never named the collections underneath it — the long-standing "NEAT doesn't expose Mongo collection names" gap. Closing it takes the same two-part shape the Supabase work took: a static call extractor that names the collection a file touches, and a connector that observes per-collection traffic and fuses onto those call sites.

Research against the real Mongoose runtime and the Atlas telemetry surface settled three things that decide the shape:

- **The collection name is the fusion key, and Mongoose's pluralizer is quirky.** A Mongoose query names a *model* (`Order.find()`), not a collection; the collection is derived — by default a whole-name lowercase-then-pluralize of the model name, overridable by a schema `collection` option or the `model()` third argument. Mongoose's pluralizer is not English-correct: `Goose` becomes `gooses`, `Leaf` becomes `leafs`, `Hero` becomes `heros`, `Data` becomes `datas`, and there is no word-boundary split (`UserProfile` becomes `userprofiles`). Because Mongoose *created* the collection under that name, the real collection on the wire is literally `gooses` — so a faithful reimplementation of the pluralizer produces the exact string the connector and the OTel layer observe. Fidelity is the mechanism, not a nicety: a "smart" English pluralizer would be confidently wrong and fuse onto nothing.

- **Per-collection telemetry is tier-gated; static extraction is not.** Atlas exposes per-collection operation counts through the Admin API's `collStats/measurements`, and a direct connection exposes them through the `top` command or `$collStats` — but each of those needs an M10+ dedicated cluster or a self-managed `mongod` (Atlas blocks `top` on every tier; `$collStats` and the Admin metrics are M10+ only). The free-tier default (M0/Flex) yields nothing per-collection. The static extractor pays off on every deployment regardless of tier, so it comes first; the connector layers observation on top wherever the tier allows.

- **There is no per-collection error count on any path.** The Admin API, `top`, and `$collStats` all report operations and latency but not failures. The observed signal carries `callCount`, not `errorCount`.

### Decision

Build `extract/calls/mongoose.ts` now — a CALLS-family producer mirroring `calls/supabase.ts`, gated on a `mongoose` or `mongodb` import. It recognizes the native-driver literal path (`db.collection('orders')`, where the collection is the string argument) and the Mongoose model path (`mongoose.model('Order', schema)`, deriving `orders`), reusing Mongoose's own pluralization rules verbatim so the derived name matches the collection Mongoose actually created. Where the collection resolves within the file it emits a file-grained `mongodb-collection:<name>` edge at `verified-call-site` confidence; where the model is known but the collection is not — the schema lives in another module, or the name is computed at runtime — it falls back to a `mongodb-model:<Model>` edge at lower confidence rather than fabricating a name. A later resolution pass, or the observed layer that sees the real collection on the wire, collapses a model-grained edge onto its collection. This is the divergence story in miniature: static intent, sometimes quirk-derived or unresolved; observed reality as ground truth; fusion reconciling the two.

The MongoDB Atlas connector — a DB-egress provider with two profiles (the Admin API for M10+ clusters, a direct read-only connection where a connection string is available), whose per-collection `callCount` fuses onto the extractor's call sites through the same bare-and-qualified dual resolution `connectors/supabase/resolve.ts` already uses — is the second half, and is not decided here. Its concrete shape (auth, endpoint response shapes, tier detection) waits on a live probe against a real cluster, the discipline ADR-146 set for Vercel: confirm against the live provider before locking the contract.

### Consequences

- Every Mongoose or native-driver app gets file-grained `file → collection` edges the moment the extractor lands — no connector, no cluster, no tier requirement — and the "no Mongo collection names" gap closes.
- The extractor's pluralizer is fixtured against Mongoose's actual output, quirks included. A divergence between our derivation and Mongoose's is a fusion bug, not a cosmetic one.
- `mongodb-collection` and `mongodb-model` join the open set of infra kinds with no schema change; the collection node sits one layer below the `database:mongodb:<host>` node #832 fuses onto.
- The Atlas connector's observed signal is `callCount` only, and its per-collection depth is an M10+/self-hosted capability — an honest limit to state wherever the connector is described, never a free-tier promise.

## ADR-148 — MongoDB collection OBSERVED comes from the driver's OTel spans NEAT already ingests, not an Atlas pull connector

**Status:** Accepted. Refs #832. Revises the OBSERVED-half framing of ADR-147 (its "Atlas connector, two profiles" direction; the EXTRACTED half — the `calls/mongoose.ts` extractor — is unchanged). Amends [`otel-ingest.md`](contracts/otel-ingest.md).

### Context

ADR-147 framed the MongoDB OBSERVED half as an Atlas *pull* connector. Weighing the OpenTelemetry surface against that says otherwise. Three OTel paths exist for MongoDB, and they are not interchangeable:

- **The MongoDB driver's OTel instrumentation** (`@opentelemetry/instrumentation-mongodb`, plus the mongoose instrumentation) emits one span per operation, carrying the collection (`db.mongodb.collection` in the older convention, `db.collection.name` in the stable one) and the operation. It is **already bundled** in the `@opentelemetry/auto-instrumentations-node` package NEAT's installer wires up — so a NEAT-instrumented app already emits these spans, and the daemon's `/v1/traces` receiver already ingests them, reading `db.system`/`db.name` to the database node (ADR-141) but **dropping `db.collection`**. That dropped attribute is the "NEAT doesn't expose Mongo collection names" gap.
- **Atlas's own OpenTelemetry Metrics integration** pushes OTLP *metrics* to a custom endpoint. Wrong signal here on three counts: the daemon has no metrics receiver (it ingests traces and logs, not metrics); the metrics are cluster/server-level, not per-collection; and the exportable set is narrow (Atlas Stream Processing).
- **The Atlas Administration API** exposes per-collection counts, but only on M10+ dedicated clusters, bounded and without errors.

The driver-span path is the only one that is per-collection, tier-independent, and **local-first**: the app exports its spans to the same OTLP endpoint NEAT already configures, which for a local install is `localhost:4318`. No public reachability, no tunnel, no Atlas credentials — the app talks to the local daemon over localhost. (The Atlas metrics push, like Vercel Drains, would instead require the local daemon to be publicly reachable.)

### Decision

The MongoDB per-collection OBSERVED signal is the `db.collection` attribute on the mongodb spans the daemon already receives — not a pull connector. The OTLP span ingest reads the collection off a `db.system: mongodb` span (`db.collection.name`, falling back to `db.mongodb.collection`) and mints a collection-grained OBSERVED edge to `infra:mongodb-collection:<name>`, one layer below the database node ADR-141 already fuses, and lands it on the `file → collection` call sites `extract/calls/mongoose.ts` (ADR-147) produces. This is tier-independent and local-first, and revises ADR-147's "Atlas connector, two profiles" framing.

The Atlas Administration API pull is demoted to an optional, tier-gated (M10+), app-code-free fallback for apps that are not OTel-instrumented — not built now, not the primary path. Atlas's OpenTelemetry Metrics push is out of scope: cluster metrics, no receiver for it, not per-collection.

### Consequences

- The primary MongoDB OBSERVED path needs **no Atlas credentials, no M10+ cluster, no tunnel**. It works on local NEAT with the app exporting to `localhost:4318`, the default install. The M10+ tier gate the research surfaced applies only to the demoted Admin-API fallback.
- It **requires the app to be OTel-instrumented**, which NEAT's installer does — consistent with NEAT auto-instrumenting at install. The rich OBSERVED layer was never zero-instrument; only the app-code-free connector paths are.
- The ingest reads both `db.collection.name` and `db.mongodb.collection` — the instrumentation moved attribute keys across semconv versions.
- Where the extractor's static derivation is quirk-wrong or unresolved, the span's collection is ground truth — the divergence story ADR-147 named, now with a live observed side.
- Ships as two changes, in two PRs: the extractor (ADR-147, EXTRACTED) and the span-ingest collection read (this ADR, OBSERVED).

## ADR-149 — Cross-file model→collection resolution: attribute a query to its collection through the import graph NEAT already builds

**Status:** Accepted, implementation pending. Refs #832. Extends ADR-147 (the in-file extractor). Amends [`static-extraction.md`](contracts/static-extraction.md).

### Context

`calls/mongoose.ts` (ADR-147) resolves a collection within a single file — a native-driver literal, or a `mongoose.model('Order', schema)` whose definition and use share a file — and names the collection at its **definition** site. The dominant real-world Mongoose layout splits those apart: the model is registered in `models/Order.js` and queried across `routes/`, `services/`, `controllers/`.

```
// models/Order.js — const Order = mongoose.model('Order', orderSchema)         // v1 names 'orders' here
// routes/orders.js — const Order = require('../models/Order'); Order.find(...)  // v1 can't attribute this file
```

So v1 under-reports: the files that actually read and write a collection — the ones an agent asking "what touches `orders`?" cares about most — go unnamed statically. Two facts make closing this bounded rather than open-ended:

- **NEAT already builds a resolved import graph** (`extract/imports.ts`, ADR-092, file-awareness §10). It walks every file's AST for `import`/`require`, resolves the specifier to a FileNode with full TypeScript resolution — extensions, `index`/barrel files, `baseUrl` — via `resolveJsImport`, and emits `IMPORTS` edges between FileNodes. The hard part — turning `'../models/Order'` into a real file, through barrels and extensions — is done and queryable.
- **The OBSERVED layer already covers the runtime query sites** (ADR-148, #849). For an instrumented, running app the mongodb span fires at the actual call in `routes/orders.js`, so NEAT already sees that file→collection access at runtime. Cross-file static resolution adds the **declared twin** for those sites — which is what makes divergence legible at collection grain (a route declaring a query to a collection that is never hit, or was renamed).

### Decision

Resolve query sites to collections with a whole-program pass that leans on the existing import graph rather than re-implementing resolution. Three parts:

1. **A service-scoped model registry.** Scan every file for model registrations — `mongoose.model('Name', schema[, coll])`, the schema `collection` option, and the global `mongoose.pluralize(null)` flag (a whole-program pass finally sees the bootstrap toggle a single-file scan misses). Reuse ADR-147's verbatim pluralizer to derive each model's collection, and record the **exported binding** each registration is reachable through (`module.exports = Order`, `export const Order`, `export default`).

2. **Binding resolution through the import graph.** In a file that queries a model it does not define, resolve the local binding to a registered model: follow the file's resolved `IMPORTS` edge (or re-run `resolveJsImport` on the same specifier) to the defining file, and match the imported name to that file's exported model binding. Barrel re-exports resolve because `resolveJsImport` already lands `index` files.

3. **Query-site attribution.** For `<binding>.<mongoose-method>()` — the method set the research enumerated — where the binding resolves to a registered model, emit a `queryFile → mongodb-collection:<name>` edge onto the same node ADR-147 and ADR-148 already use, so the definition edge, the query edges, and the observed edges all fuse on one collection node.

The pass runs after imports (Phase 2), so the graph already carries the `IMPORTS` edges it reads. A binding whose model is registered with a computed name or collection, or reached through a dynamic import, stays unattributed — never guessed (the ADR-147 discipline).

### Consequences

- The files that actually use a collection get named statically, not just the model-definition file — the grain a blast-radius query and an agent want, and the grain at which collection-level divergence becomes measurable.
- Bounded effort: file-level resolution is reused (`imports.ts`); the new work is the model registry, binding-level linkage on top of the file graph, and query-site attribution. It moves the mongoose producer from a per-file scan to a whole-program pass.
- Additive and fusion-safe: it emits onto the existing `mongodb-collection` node, so definition, query, and observed edges converge rather than twin.
- OBSERVED already fills the runtime side (#849), so the value here is static coverage plus divergence at query grain, not a runtime blind spot — which is why it sits behind the connector-hardening docket unless collection-grain static divergence is wanted for the launch.
- The global `mongoose.pluralize(null)` flavour, undecidable in-file, is decided here.

## ADR-150 — MongoDB collection OBSERVED reads `db.system: mongoose` spans, not only `mongodb` — the mongoose instrumentation is the working source

**Status:** Accepted. Refs #832. Corrects the span-source premise of ADR-148, from a live MongoDB Atlas test. The ingest read (`db.collection.name` / `db.mongodb.collection`) and the fusion target are unchanged; only the `db.system` gate is wrong.

### Context

ADR-148 decided that MongoDB's per-collection OBSERVED signal is the `db.collection` attribute on the mongodb OTel spans NEAT already ingests, gated on `db.system: mongodb`. That gate was written against the OpenTelemetry semantic conventions, not against a running system. Standing the path up end-to-end against a real Atlas cluster — a NEAT-instrumented app driving real traffic, its spans flowing into the daemon's real receiver — surfaced two facts the convention hid:

- **The raw `@opentelemetry/instrumentation-mongodb` produces no command spans on modern drivers.** With the `mongodb` driver at 6.3 and 7.5 (and `auto-instrumentations-node`'s bundled instrumentation), the only spans emitted for real database work are connection spans (`tcp.connect` / `tls.connect` / `dns.lookup`) — no per-operation span, no `db.system: mongodb`, no collection. The instrumentation patches the connection internals but the command-span path is dead for current driver versions. This is an upstream limitation NEAT does not control and cannot rely on.
- **The `@opentelemetry/instrumentation-mongoose` produces exactly the spans we need — but under a different `db.system`.** A NEAT-instrumented mongoose app emits one span per model operation (`mongoose.Order.find`, `…save`, `…countDocuments`) carrying `db.mongodb.collection: 'orders'`, `db.name`, `db.operation` — and **`db.system: 'mongoose'`**, not `'mongodb'`. So NEAT's `db.system === 'mongodb'` gate drops every one of them, and a mongoose app — NEAT's *primary* Mongo target, since the extractor is mongoose-based — is observed as nothing.

ADR-148's premise ("the bundled instrumentation emits collection spans, so they already flow") was therefore half-wrong: the *mongoose* instrumentation does, the raw *mongodb* one does not, and NEAT was reading only for the one that doesn't work.

### Decision

The OTLP span ingest treats a `db.system` of **`mongoose`** the same as `mongodb` for the collection read: when either is present alongside a collection attribute (`db.collection.name`, falling back to `db.mongodb.collection`), it mints the OBSERVED `mongodb-collection:<name>` edge onto the same node the extractor and any real `mongodb`-system span use. The mongoose instrumentation is the load-bearing source; the raw mongodb-driver instrumentation stays supported for the day it (or a future driver) emits command spans again, but nothing depends on it.

### Consequences

- A mongoose app under NEAT instrumentation now produces real per-collection OBSERVED edges, fused onto the statically-extracted models (ADR-147/149). This is the path that actually fires in practice.
- The raw-mongodb-driver OBSERVED path is documented as **not functional on current driver versions** — an honest limit, not a silent gap. An app on the bare `mongodb` driver (no mongoose) gets no collection OBSERVED today, because the upstream instrumentation emits no command spans; the connection-grain `database:mongodb:<host>` edge (ADR-141) is unaffected.
- `db.system: 'mongoose'` is a datastore-family value, not a distinct engine — the collection node, the database node, and divergence all continue to key on MongoDB. `mongoose` on the span is an instrumentation detail the ingest normalizes, nowhere else.
- This was found only by running against real Atlas; it is the first connector-level bug the live-provider hardening pass surfaced, and it argues for validating every connector's OBSERVED path against a running provider, not against the spec.

## ADR-151 — Python reaches file-grain fusion: a FastAPI-first vertical slice (routes + ORM call sites + a Python call-site span processor)

**Status:** Accepted, implementation pending. Refs #796, #595, #576. Amends [`static-extraction.md`](contracts/static-extraction.md) (Python route + ORM producers), [`otel-ingest.md`](contracts/otel-ingest.md) (a table-grain OBSERVED mint and dual `code.*` attribute-name reads), [`sdk-install.md`](contracts/sdk-install.md) and [`file-awareness.md`](contracts/file-awareness.md) (a Python call-site span processor extends §4's layered mechanism to a second runtime). This is the first language chosen through the expansion rubric in [`docs/plans/language-expansion-playbook.md`](plans/language-expansion-playbook.md); the recommendation and scoring live in [`docs/plans/language-expansion-recommendation.md`](plans/language-expansion-recommendation.md).

### Context

Python extraction reaches manifest and import grain today: `extract/python.ts` reads `pyproject.toml`/`requirements.txt`/`setup.py` into the shared `PackageJson` shape, `imports.ts` resolves `from X import y` edges, the DB-driver compat rows (`psycopg2`, `pymongo`, `mysql-connector-python`) already sit in `compat.json`, and `installers/python.ts` wires `opentelemetry-instrument`. What the fusion-acceptance bar asks for beyond that is the file+line join — declared call sites and observed spans landing on one node — and for Python that join needs two producers Python does not have yet and one runtime capability it does not emit yet.

The join itself is already language-neutral. The ingest path (`callSiteFromSpan` → `relPathForRuntimeFile` → `reconcileObservedRelPath` → `fileId` → `upsertObservedEdge`, with `grain` taken from the source-id prefix) is pure path/string logic with no extension or language branch, and the OTLP receiver accepts any SDK's spans. A Python span carrying `code.file.path` fuses onto a statically-extracted Python `FileNode` with no new ingest code — the same way a Node span does. So the work is not in the join; it is in (a) minting the Python nodes the span lands on, and (b) making the Python runtime emit the attribute that lands it.

Three facts shape the slice:

- **Route and target grain are out of the box; file grain is NEAT-built.** `opentelemetry-instrument` auto-patches FastAPI/Django/Flask and the DB drivers, and those instrumentations emit templated `http.route` (route grain) and `db.sql.table` / `db.collection.name` (target grain). File grain is the one grain no language emits on its own — Node reaches it only because NEAT injects a stack-walking `SpanProcessor` (`file-awareness.md` §4). Python reaches it the same way: a `SpanProcessor.on_start` that reads the application frame via `sys._getframe()` / `traceback.extract_stack()`, walked past the OTel and framework frames, and stamps the code attributes. This is the Python analog of the inlined `NeatCallSiteSpanProcessor`, and it is the load-bearing net-new runtime capability.

- **The fusion key is the ORM's model→table naming, reproduced verbatim.** As Mongoose's pluralizer names the real collection (ADR-147), a Python ORM names the real table: Django derives `<app_label>_<lowercased-model>` unless `Meta.db_table` overrides; Flask-SQLAlchemy derives a CamelCase→snake_case name; plain SQLAlchemy takes the explicit `__tablename__`. The `db.sql.table` on the wire is whatever the ORM created, so the extractor reproduces that naming byte-for-byte and lands its edge on `infra:<engine>-table:<name>`; a "smarter" derivation fuses onto nothing. Where the table is computed or the model is defined cross-file, the extractor falls back to a model-grained edge rather than a fabricated name — the ADR-147 discipline.

- **The code attributes are mid-stabilization, so the ingest reads both name families.** OpenTelemetry's code attributes stabilized at semconv v1.33.0 as `code.file.path` / `code.line.number` / `code.function.name` (the prior `code.function` and `code.namespace` fold into the last). Ingest reads the stable names and the prior `code.filepath` / `code.lineno` / `code.function` together, and the generated processors emit the stable names, so a span from either instrumentation generation file-grains cleanly. This dual read is language-neutral and applies across every instrumented runtime.

### Decision

Ship Python file-grain fusion as a vertical slice mirroring the ADR-147→150 shape — extractor, then observed twin — scoped to a FastAPI-first proof and broken into small PRs (the plan lives in [`docs/plans/2026-07-21-python-fusion-vertical-slice.md`](plans/2026-07-21-python-fusion-vertical-slice.md)).

- **Static (EXTRACTED).** Add Python route recognizers to `routes.ts` — FastAPI decorators (`@app.get('/users/{id}')`), Flask (`@app.route`), Django URLconf — gated on the framework manifest dependency the way the JS registry gates, minting `RouteNode(method, pathTemplate)` at the same id (`routeId`) an observed `http.route` and the Railway connector land on, with the template kept verbatim (`normalizePathTemplate` collapses `{id}` / `:id` / `[id]` at match time). Add a Python ORM/driver call extractor — SQLAlchemy/Flask-SQLAlchemy model queries, Django ORM, `psycopg2`/`pymongo` — minting a file-grained `file → infra:<engine>-table:<name>` (or `mongodb-collection:<name>`) edge at `verified-call-site` confidence using the verbatim ORM naming, with the model-grained fallback. Complete the import graph where the route/ORM resolvers need it (bare `import X`). These are new Python-dispatched producers alongside the JS ones; the tree-sitter grammar is the already-pinned `tree-sitter-python@0.21.0`, so no ABI coordination enters this slice.

- **Runtime (OBSERVED).** `installers/python.ts` gains an apply-side generated bootstrap (a `sitecustomize.py` / OTel-distro `SpanProcessor` registration) that installs a Python call-site processor stamping `code.file.path` / `code.line.number` / `code.function.name` from the walked application frame, giving Python the file-grain capability Node already has. `opentelemetry-instrument` stays the route/target-grain source. The OTLP ingest gains a table-grain OBSERVED mint: a `db.sql.table` on a SQL `db.system` span mints a `CALLS` edge to `infra:<engine>-table:<name>` — the analog of the ADR-148/150 mongodb-collection mint, onto the same node the extractor produces — and reads both `code.*` name families as above. Both additions are language-neutral and benefit the JS path too.

- **Grain, stated honestly.** File grain where the processor fires — the caller side of DB/HTTP-client calls and the framework handler entry; route grain from `http.route` on the server span; target grain from `db.sql.table` / `db.collection.name`; the service floor otherwise, labeled `grain: 'service'` (ADR-142). The proof states the grain it achieved; no file-grain claim is made over a route/service-grain graph.

- **Out of scope.** eBPF (Beyla/Pixie/Odigos) and any service/wire-grain Python path; the browser/client tier (`file-awareness.md` §9); non-OTel Python runtimes; the inbound-server-span → RouteNode OBSERVED mint (#576) beyond what the connector already supplies for route-grain fusion; Kafka two-sided coverage (#796) beyond the DB slice; and the tree-sitter ABI-14/15 upgrade, which Python does not need and which is sequenced as its own task before any greenfield language.

### Consequences

- A real, instrumented FastAPI/Django app that NEAT was not engineered against produces fused EXTRACTED+OBSERVED edges at file grain on its DB and HTTP-client call sites, route grain on its handlers, and target grain on its tables — the fusion-acceptance bar, cleared on the highest-ICP language for AI-agent-built systems.
- Divergence becomes legible for Python at collection/table and route grain: a model that declares a table the runtime never hits, a route declared but never served, a table hit at runtime with no declared query. `get_blast_radius` and `get_root_cause` traverse the Python file graph the same as the JS one, because the file nodes and target nodes are the same id shapes.
- The table-grain OBSERVED mint and the dual `code.*` read are language-neutral: the JS path gains SQL table-grain observation and stays correct across the code-attribute stabilization, so the slice hardens the existing runtime while extending the new one.
- The Python call-site processor establishes the second instance of `file-awareness.md` §4's layered capture, and with it the shape every subsequent interpreted-language installer (Ruby, PHP) follows — a `SpanProcessor.on_start` plus native stack introspection — so the next language's runtime half is a known quantity, not a research question.
- The rubric and playbook are proven end-to-end on the language with no ABI dependency, de-risking the program before the first greenfield grammar and its ABI-upgrade cost.

## ADR-152 — SQLAlchemy's OBSERVED table comes from parsing `db.statement`; the instrumentation emits no table attribute

**Status:** Accepted. Refs #796. Sharpens the OBSERVED-table premise of ADR-151 (its "a table-grain OBSERVED mint reading `db.sql.table`" line), confirmed against a live instrumented SQLAlchemy app. The EXTRACTED half — the model→table extractor — is unchanged. Amends [`otel-ingest.md`](contracts/otel-ingest.md) and [`static-extraction.md`](contracts/static-extraction.md).

### Context

ADR-151 scoped the Python SQL table OBSERVED signal as a `db.sql.table` attribute on the DB span, by analogy to the MongoDB collection attribute (ADR-148). Standing the path up against a running system settles it differently. A NEAT-instrumentable SQLAlchemy app — `opentelemetry-instrumentation-sqlalchemy`, and the raw dbapi/psycopg instrumentation — emits, per DB operation, `db.system`, `db.name`, `db.statement`, `db.operation`, and nothing that names the table. `db.sql.table` and `db.collection.name` are never set. This is verified three ways: against a real Postgres, against sqlite, and in the instrumentation source (the attribute-setting functions set only `db.statement` / `db.system` / `db.operation`; a search for `db.sql.table` / `db.collection` across the package is empty). It is structural, not version-incidental — the instrumentation has never parsed the statement for a table. (One quirk to record: `db.operation` is `"<VERB> <db_name>"`, e.g. `"SELECT brief"`, not a bare verb — unusable as a structured signal.)

The table therefore lives only as free text inside `db.statement` (`SELECT orders.id … FROM orders`). ADR-151's `db.sql.table` premise, drawn from the OpenTelemetry semantic conventions rather than a running app, would have gated the mint on an attribute that never arrives — the same shape of finding as ADR-150, where the mongoose instrumentation emits `db.system: mongoose`, not `mongodb`.

### Decision

The SQLAlchemy per-table OBSERVED signal is the table parsed out of `db.statement`, not a dedicated attribute. `tableFromSqlStatement` (in `otel.ts`) extracts the single table after `FROM` / `INTO` / `UPDATE` — quote- and schema-stripped — and degrades to nothing on a joined or multi-`FROM` (subquery) statement rather than guessing. When a table resolves, the span mints an OBSERVED `CALLS` edge to `infra:sql-table:<name>` — the same node `extract/calls/sqlalchemy.ts` (ADR-151) produces from a model's declared or derived table — so the declared and observed table access fuse rather than twin. The table node is engine-agnostic (`sql-table:<name>`): the engine lives on the `database:<host>` node the connection-grain `CONNECTS_TO` edge already fuses (ADR-141), one layer up. Additive: a SQL span whose statement doesn't yield a single table still mints the database-grain edge, exactly as before.

The static half derives the table verbatim the way the ORM does — an explicit `__tablename__`, Flask-SQLAlchemy's `camel_to_snake_case(ClassName)` reproduced byte-for-byte (`UserProfile` → `user_profile`, `OAuth2Token` → `o_auth2_token`), or a native `Table('orders', …)` literal — so the static string matches the table the running query hits. Fidelity is the fusion key, the same discipline the Mongoose pluralizer follows (ADR-147). Django's `<app_label>_<model>` derivation waits for the Django rung, where the app-label resolution belongs.

### Consequences

- A running SQLAlchemy / Flask-SQLAlchemy app produces real per-table OBSERVED edges, fused onto the statically-extracted model tables — table-grain divergence (a model declaring a table the runtime never hits, or a table hit with no declared model) becomes legible for Python.
- The join is conservative by construction: joins and subqueries degrade to the database-grain edge, honestly, so a multi-table query never mis-attributes to one table. Statement-parse coverage can grow to a fuller SQL parse if a concrete need warrants it; the single-table read is the dominant ORM shape.
- Where the extractor's model→table derivation is unresolved — a computed `__tablename__`, a cross-file model — the parsed statement is ground truth, the divergence story with a live observed side.
- The finding argues, again after ADR-150, for validating every OBSERVED path against a running provider rather than the spec: the attribute the convention names is not the attribute the instrumentation sets.

## ADR-153 — NEAT's MCP server lists in the official MCP Registry (`io.github.neat-technologies/neat`), published by OIDC on release

**Status:** Accepted. Refs #890. Extends the publish-system contract (#25 / [ADR-052](#adr-052--publish-system-contract) + [ADR-064](#adr-064--tarball-smoke-test-verifies-built-web-artifact--post-neatd-start-liveness-amends-adr-052)) with the registry manifest and its lockstep.

### Context

NEAT is a capable MCP server, but it is listed in no registry and offers no one-click install — the only way to find and wire it is by reading the README. Ubiquity is coverage × distribution, and distribution is the underpriced half. The official MCP Registry is the upstream that MCP clients and aggregators mirror (VS Code, Cursor, Glama, PulseMCP, Goose, Zed): one listing there fans NEAT out to all of them. Listing requires proving two things — control of the server's namespace, and ownership of the package the server points at.

### Decision

NEAT's MCP server publishes to the official registry under the name `io.github.neat-technologies/neat`, on every release, authenticated by GitHub Actions OIDC.

- **Namespace.** `io.github.neat-technologies` is a GitHub-verifiable namespace: the registry accepts it when the publishing workflow's OIDC token proves it runs under the `neat-technologies` GitHub org. No long-lived registry secret and no DNS record. A reverse-DNS `is.neat` namespace via a DNS TXT record stays available if a domain-branded name is later wanted; the GitHub namespace is the credential-free default and does not preclude it.
- **Manifest.** `server.json` at the repo root is the registry manifest — schema-pinned, describing the `@neat.is/mcp` npm package as a stdio server with the optional `NEAT_CORE_URL` daemon URL. Its `version` and its `packages[0].version` stay in lockstep with the six published packages: one more versioned file that moves with a release, enforced the same mechanical way as the existing package lockstep.
- **Package ownership.** `@neat.is/mcp`'s `package.json` carries an `mcpName` marker equal to the server name. The registry fetches the published npm package and matches the field, which is how it confirms the manifest's author controls the package.
- **When it publishes.** A release-flow job runs the registry publish after the npm publish + smoke gate, because the registry validates against the live `@neat.is/mcp` — the package must already be on npm. It runs only on a real tag release, `mcp-publisher login github-oidc` then `publish`. It is additive: a failure isolates to its own job and never unpublishes the npm / ghcr / GitHub-Release trio that has already shipped; the release does not gate on it.
- **One-click install.** README buttons — Add to Cursor, Install in VS Code — drive `npx -y @neat.is/mcp`, so an editor install needs no hand-edited JSON. These work today, independently of the registry listing.

### Consequences

- NEAT becomes discoverable in the built-in MCP browsers and the aggregators that source the official registry, and installable in an editor in one click — the distribution half of ubiquity, previously absent.
- The registry entry tracks the npm release: bump the six packages and `server.json` together, tag, and the next release lists the new version. No separate cadence to keep.
- Publishing stays credential-free via OIDC, at the cost of an `io.github.*` name rather than a branded domain namespace; the branded name remains a later DNS-verified option that layers on without breaking the GitHub one.
- `server.json` joins the publish-system contract's governed set. Its name-matches-`mcpName` and its version lockstep are asserted in `contracts.test.ts`, so a half-bumped or renamed manifest fails on `main` exactly as a half-bumped package does.

## ADR-154 — Go reaches static and file-grain runtime fusion

**Status:** Accepted. Refs #902. Amends [`static-extraction.md`](contracts/static-extraction.md), [`sdk-install.md`](contracts/sdk-install.md), and [`file-awareness.md`](contracts/file-awareness.md). The runtime stamper is validated against a real compiled Go binary: the `NEAT_GO_BIN`-gated proof in `go-compat.test.ts` builds the generated `neat_otel.go` and confirms its `runtime.Callers` walk stamps `code.file.path` / `code.line.number` / `code.function.name` onto the actual user call site (verified on go1.26.5).

### Context

The compatibility rubric scores Go at **22/25**: reach 5, OBSERVED tractability 4, extraction tractability 5, fusion-key clarity 4, strategic fit 4. Go is pervasive in cloud-native services; its OTel SDK exposes a synchronous span-start hook; `tree-sitter-go` is mature; source locations and gin routes are structurally explicit; and the language broadens NEAT beyond scripting runtimes. The runtime half carries the cost because upstream instrumentation does not stamp user call sites.

The ABI gate is clear: `tree-sitter-go@0.21.2` declares a `tree-sitter ^0.21.0` peer, matching core's `tree-sitter ^0.21.1`. No native-binding or grammar ABI upgrade is part of this decision.

### Decision

- Discover a Go service from `go.mod`, using the final module-path segment as its service name and `require` entries as dependency gates. Parse `.go` with `tree-sitter-go`. Emit FileNodes unconditionally, local-package IMPORTS edges where a package maps to one unambiguous source file, gin routes with literal paths and in-file literal group prefixes, and single-table `database/sql` call sites. Computed and ambiguous identities remain absent.
- Generate `neat_otel.go` beside root `main.go` or `cmd/*/main.go`. Its `sdktrace.SpanProcessor.OnStart` calls `runtime.Callers` synchronously for CLIENT/PRODUCER spans, selects the first frame beneath the service root, and stamps `code.file.path`, `code.line.number`, and `code.function.name`. The file locates the root by walking upward to `go.mod`; `NEAT_SERVICE_ROOT` is the explicit deployment override.
- The fusion key is unchanged: extractor path and ingest-normalized runtime path both resolve through `fileId(service, relPath)`. The Go fixture proves an absolute runtime `.../main.go` frame reconciles onto the extracted `file:orders-api:main.go`, not a twin. SQL table literals reuse `infraId('sql-table', table)`, the node the OBSERVED SQL statement path already targets.
- If stack capture yields no frame inside the service root, stamp nothing. Ingest keeps the OBSERVED relationship on the service node with `grain: 'service'`; no path is synthesized. SERVER spans remain route/service-grained because they begin before the handler frame exists.

### Consequences

- Go, gin, local package imports, and literal single-table database calls enter the EXTRACTED graph with file evidence and per-file failure isolation.
- Existing Go OTel instrumentation gains the same file-first OBSERVED origin as Node and Python without adding Go to NEAT's own implementation toolchain.
- Multi-file package import attribution, computed gin paths, multi-table SQL, and framework-specific auto-instrumentation stay follow-ons; each degrades by omission or service grain rather than a guessed fusion key.

## ADR-155 — NestJS decorator routes join the existing Node route and file fusion paths

**Status:** Accepted. Refs #904. Amends [`static-extraction.md`](contracts/static-extraction.md) and [`installer-scope.md`](contracts/installer-scope.md).

### Context

NestJS is the highest-value framework addition that requires no new source grammar or runtime SDK. Its controllers declare route identity through class and method decorators: `@Controller('users')` supplies a prefix and `@Get(':id')` supplies the method and leaf path. The runtime composes those literals into `GET /users/:id`; NEAT must reproduce that composition exactly for the static `RouteNode` and the server span's `http.route` to converge.

The compatibility rubric scores NestJS **24/25**:

| Dimension | Score | Rationale |
|---|---:|---|
| Reach | 5 | NestJS is a mainstream TypeScript backend framework with broad production adoption. |
| OBSERVED tractability | 5 | Node auto-instrumentation supplies HTTP/Nest server spans, while NEAT's existing Node call-site processor supplies downstream CLIENT/PRODUCER file attributes. |
| Extraction tractability | 5 | The pinned JavaScript grammar parses TypeScript decorators and class bodies without another grammar or ABI change. |
| Fusion-key clarity | 5 | Static controller and method path literals compose deterministically into the same route template carried by `http.route`. |
| Strategic fit | 4 | It expands a high-value application-framework tier while reusing the established Node distribution path. |

### Decision

Add a dependency- and import-gated NestJS recognizer to `extract/routes.ts`. A service must declare `@nestjs/core` and the source file must import its route decorators from `@nestjs/common`. The recognizer reads `@Controller()` on a class and the standard HTTP method decorators on methods, composes controller prefix plus method path, preserves `:param` tokens verbatim, and emits one `RouteNode` per statically-resolved route at the method decorator's line. Empty decorator arguments represent an empty segment. String arrays expand to their deterministic route alternatives. Computed paths, custom composed decorators, global prefixes configured outside the controller, URI versioning, and inherited controller metadata remain unattributed rather than guessed.

NestJS continues through the vanilla Node installer. A conventional `src/main.ts` is already resolved, the generated Node SDK setup already installs auto-instrumentations plus NEAT's call-site processor, and no framework-owned boot surface displaces that entry point. A Nest-specific installer branch would duplicate the same generated bytes without adding runtime coverage.

Fusion has two shared keys:

- **Route grain:** `routeId(service, method, composedTemplate)`. The extractor preserves the declared Nest template; ingest normalizes parameter syntax only for matching and writes the OBSERVED `CONTAINS` twin onto that exact node.
- **File grain:** `fileId(service, relPath)`. The existing Node call-site processor stamps `code.file.path` on CLIENT/PRODUCER spans created under a controller, and ingest reconciles that path to the statically-created controller `FileNode`.

The baseline proof extracts a controller and then ingests runtime-shaped Nest HTTP and downstream client spans. It asserts EXTRACTED and OBSERVED edge ids coexist on one RouteNode and one FileNode, with no alternate route/file twin.

### Consequences

- NestJS controllers become queryable at method, template, file, and line grain without widening NEAT's runtime installer surface.
- Literal controller/method arrays expand honestly; dynamic controller prefixes and application-level global prefixes stay visible as coverage limits instead of producing incorrect route ids.
- The framework registry gains a decorator-driven TypeScript precedent that future decorator frameworks can follow while retaining explicit dependency and import gates.

## ADR-156 — Neon observation reads pg_stat_statements and fuses on the canonical SQL-table identity

**Status:** Accepted. Refs #903. Amends [`connectors.md`](contracts/connectors.md) and [`connector-config.md`](contracts/connector-config.md).

### Context

The compatibility-expansion rubric scores Neon: reach **4/5**, OBSERVED tractability **4/5**, extraction tractability **5/5**, fusion-key clarity **5/5**, and strategic fit **5/5** (**23/25**). Neon is a high-reach serverless Postgres platform, existing ORM extractors already produce table-grained static targets, and Postgres exposes cumulative per-statement execution counts.

Neon's management and consumption APIs expose projects, branches, computes, and aggregate resource usage, but not per-table query telemetry. Neon supports `pg_stat_statements`, and a Postgres role with `pg_read_all_stats` can read statements executed by other users. A management-API connector would have to invent the missing target, while a hosted connector using an owner or `neon_superuser` login would exceed the least-privilege requirement.

`pg_stat_statements.calls` is cumulative and has no event timestamp or error count. Its query text can name several tables through joins and subqueries. Replaying the total on every poll, assigning poll time to the full history, or choosing one table from a multi-table statement would overstate the evidence.

### Decision

Neon joins the pull registry through a direct Postgres telemetry read. Its credential is a connection string for a dedicated `LOGIN` role granted only `pg_read_all_stats`; documentation requires revoking ordinary schema/table privileges. Every poll passes through the shared DB junction — its bounded timeout, retry, elapsed-time, and per-project rate-limit behavior fulfills the same outbound-junction contract as HTTP providers — sets `default_transaction_read_only = on`, and selects a bounded busiest set from `pg_stat_statements`. The runtime path requires no Neon management API key.

The connector keeps a per-instance baseline keyed by `queryid`. A first sighting emits nothing. Later polls emit only a positive `calls` delta; a lower counter establishes a fresh baseline after a reset or compute restart. Rows that leave the bounded result lose their baseline, so a later reappearance also starts fresh. `errorCount` remains zero because the view carries no failure count, and `lastObservedIso` is the time the increased counter was read — observation time, not execution time.

Mapping reuses the conservative SQL parser used by OTLP ingest: one unambiguous table after `FROM`, `INTO`, or `UPDATE`; joins and multiple `FROM` clauses stay unresolved. A signal targets `infraId('sql-table', table)` and declares `ensureInfraNode` only for an undeclared target. This is byte-identical to SQLAlchemy and Django ORM extraction. The generic connector pipeline attributes the OBSERVED source to a file only when exactly one EXTRACTED file edge from the configured service reaches the table; otherwise it stays service-grained.

Unlike provider request-log rows governed by connectors §7, a `pg_stat_statements` row emits no `LogEntry`: it is an aggregate counter with no event timestamp or individual invocation. Synthesizing a log from query text and poll time would fabricate an event.

Local and hosted profiles run the same pull/map/fuse implementation. They differ only in how the scoped connection-string environment value is brokered and in poll cadence.

### Consequences

- Neon query activity lands on the same SQL-table nodes as existing static ORM extraction, enabling exact EXTRACTED/OBSERVED fusion without a Neon-specific node kind.
- The first poll deliberately produces no edges; two snapshots are the minimum truthful proof of new activity.
- Multi-table and unparsable statements remain at coarser database/runtime grain rather than receiving a guessed table.
- Polling can wake a scaled-to-zero compute and consumes a database connection; the documented cadence and bounded statement limit keep that cost explicit.
- The hosted credential has database-monitoring scope rather than project-owner authority.

## ADR-158 — Observed-first edges, static-first nodes: symbol grain under file-first, and the provider/platform/framework/language-agnostic deterministic trace

**Status:** Accepted, implementation pending. Refs #913. Amends [`file-awareness.md`](contracts/file-awareness.md) (§1, §3, §7), [`provenance.md`](contracts/provenance.md), [`lifecycle.md`](contracts/lifecycle.md), [`get-root-cause.md`](contracts/get-root-cause.md), [`get-blast-radius.md`](contracts/get-blast-radius.md), [`identity.md`](contracts/identity.md), [`schema.md`](contracts/schema.md), [`static-extraction.md`](contracts/static-extraction.md), [`divergence-query.md`](contracts/divergence-query.md). Sibling to ADR-157 (schema/column grain), the data-axis instance of the same below-file principle.

### Context

File-first gives an agent a deterministic answer for *where in the code* a relationship originates (`file-awareness.md`). The product NEAT is now for asks one grain deeper and one axis wider: trace a bug in a constructor (a symbol) through the structure that inherits and calls it, to the symbol that carries an observed edge to an external effect, and compute that chain deterministically whatever the language, framework, platform, or provider is. The graph is the reasoning; no model runs in the loop.

This is an extension, not a rebuild, because the shape is already latent in the contracts. `lifecycle.md` mints nodes from static analysis and edges (observed) from ingest. `provenance.md` coexists OBSERVED and EXTRACTED edges and ranks `OBSERVED > EXTRACTED` at every hop (`PROV_RANK`). `get-root-cause.md` already follows the outbound failing OBSERVED CALLS chain from a file into runtime. The observed signal for symbols is already on the wire: every NEAT-instrumented span carries `code.function` beside `code.file`/`code.line` (`file-awareness.md §4`), which ingest parses today and drops at node-mint. What is absent is a name for the spine, a node under the file to carry the function, and the lifting of one clause — "function-level nodes are deferred."

### Decision

1. **Name the spine: static-first nodes, observed-first edges.** A node's existence is a static fact — the inventory, the denominator, and the cold-start answer that needs no telemetry (`file-awareness.md §1`; `lifecycle.md` static-fields-override). An edge's truth is observed: what the system does outranks what it declares, already encoded as `PROV_RANK.OBSERVED > EXTRACTED` and the coexistence rule. This ADR promotes that ranking from a tiebreaker to the stated organizing principle. Coexistence is unchanged — both edges persist; observed-first means the observed edge is the default answer and the extracted edge is the declared claim surfaced beside it, and divergence is the diff between the two layers (`provenance.md`; ADR-027). Nothing is deleted; the default reading of the graph leads with reality. File-first remains the global default grain; symbols are the layer a query descends into, never a replacement.

2. **Symbols are nodes under files; the file stays primary.** A `SymbolNode` — `kind ∈ {function, method, constructor, class}` — is minted by `extract/*` and owned by its file through `file ──CONTAINS──▶ symbol`, as a file is owned by its service. Its id is built only via a new `symbolId(service, relPath, qualname, disambiguator?)` helper (`identity.md`), never a literal, carrying no provider/platform/framework/language token. `qualname` is the source-declared qualified name (`OrderService.constructor`, `merge`); an ordinal `disambiguator` separates same-named siblings (overloads, anonymous closures) so the id is collision-free without inventing a name. Every `SymbolNode` carries its definition span `{ startLine, endLine }` — the fusion key for observed grain (point 4). The static extractor is the per-language adapter (tree-sitter for the wired languages); the node it produces is language-neutral. Adding `columns` under a table (ADR-157) and `symbols` under a file are the same move on two axes.

3. **Static symbol edges are the confident ones only.** The extractor emits the symbol-grain edges it resolves without guessing: `CALLS` (symbol→symbol, for direct and import-resolved calls), and the new heritage types `INHERITS`/`IMPLEMENTS` (from a class's parsed extends/implements clause). These grade EXTRACTED per `provenance.md`, evidence the real `file:line`. Edges that need a type or a runtime value to resolve — dynamic dispatch, dependency injection, reflection, higher-order calls — are not fuzzy-matched into the graph: a guessed symbol edge violates never-fabricate-evidence (`file-awareness.md §6`) and poisons the determinism the product sells. Those edges are resolved by OBSERVED (point 4) where they cross a boundary, or by an ingested SCIP index — a compiler-accurate symbol graph produced by an external indexer and consumed through the same ingest seam NEAT uses for OTel (opt-in, never a resolver run inside the TypeScript extractor) — and are otherwise left unclaimed rather than guessed.

4. **Observed symbol edges land the function already captured.** `file-awareness.md §4` stamps `code.function` on every CLIENT/PRODUCER/SERVER span. Ingest lands the observed edge on the `SymbolNode` whose definition span `{startLine, endLine}` contains `code.line`, and validates against `code.function` (the qualname's terminal name) when present — line-in-span primary, name as tiebreaker and drift check, degrading to the file node when no symbol span contains the line. This is the same file+line join as file grain, one level finer, and is boundary-grained per `file-awareness.md §5`: it resolves the calling symbol at an instrumented I/O boundary and the caller→handler symbol across a service hop; it is not, and does not claim to be, a complete intra-process call graph (a deferred profiler/eBPF concern). Minted by `ingest.ts` per `lifecycle.md`, provenance OBSERVED, evidence the real call site.

5. **Observed may extend the symbol inventory, never silently.** Symbols are static-first for the inventory, but a runtime call can land on a symbol static extraction never produced — dynamically generated code, or an extractor gap. Per `lifecycle.md`'s auto-create-and-merge rule, ingest mints such a symbol with `discoveredVia: 'otel'`, and static fields override on the next extract pass if it later resolves. An observed symbol with no extracted twin is itself the signal: `missing-extracted` at symbol grain (`file-awareness.md §7` / `divergence-query.md`) — the symbol-grain sibling of the FrontierNode, and how observed-first surfaces the dynamic wiring static cannot see, honestly labeled rather than guessed.

6. **The reasoning core stays agnostic — enforced.** `getRootCause`, `getBlastRadius`, and the traversal machinery dispatch only on `node.type`, `edge.type`, and `provenance`. No provider, platform, framework, or language may be a branch condition in the graph model or the reasoning core; all such specificity lives in adapters (grammars, connectors, framework recognizers, `compat.json`) that normalize into the one universal graph. To the reasoning, an OBSERVED edge to a managed Postgres, a self-hosted Mongo, or a payments API is one fact: an observed edge to an external-effect node. A contract test scans `traverse.ts` and the root-cause / blast-radius paths and fails on any provider/platform/framework/language name used as a dispatch condition.

7. **The deterministic trace is the existing machinery over symbol and observed edges.** A symbol becomes a first-class member of every traversal path, as `file-awareness.md §3` already made files first-class — PROV_RANK best-edge selection, FrontierNode-skip, confidence cascade, and schema validation carry forward unchanged. `getRootCause` gains a `SymbolNode` shape (one entry in the `rootCauseShapes` table) and considers a file's owned symbols as edge sources alongside the file (`get-root-cause.md` cross-service localization, one grain finer). `getBlastRadius` enumerates symbol dependents with the same inbound BFS. The chain *constructor-q (file a:20) → … → symbol X → OBSERVED external effect* is computed by graph walk, provenance-tagged and confidence-cascaded at every hop, returned schema-validated. The agent reads the answer; NEAT computes it.

`SymbolNode` and the file's `symbols` are a schema shape change (`schema.md`): `SCHEMA_VERSION` bumps and `persist.ts` backfills. Growth of the symbol set thereafter is commit-and-go.

### Consequences

- The file stays the primary, global node; symbols are the descent a query takes for the deep trace. Every existing file-grained answer is unchanged; a symbol-grained answer is available where the query asks and the grain exists.
- Cold start is preserved. With zero telemetry, NEAT still shows the declared system — files, symbols, and static symbol edges. Observed sharpens the graph; it is never the price of entry.
- Observed-first edges make two queries native rather than derived: real blast radius (what actually depends on this, including the dynamic couplings static cannot see) and divergence (the diff between observed and declared layers, sharpest at symbol grain, and now including observed-only symbols per point 5).
- The agnosticity that was a convention (`compat.ts` reads data) becomes an enforced invariant of the reasoning core — the property that lets one deterministic trace span a stack of mixed languages, frameworks, platforms, and providers.
- The honest limit is stated, not hidden: observed symbol grain is boundary-adjacent, not a full call graph; the ambiguous intra-process edges come from SCIP ingest where supplied and are otherwise left unclaimed rather than guessed.
- `file-awareness.md §1`'s "function-level nodes are deferred" is superseded; §3, §7, and §10 are amended additively (no-rollup and never-fabricate stand verbatim). The provenance model, the mutation-authority split, and the traversal machinery are unchanged — symbol grain rides them.
- ADR-157 (schema/column grain) and this ADR are the two instances of one architecture — below the file, static-first nodes, observed-first edges — on the data axis and the code axis.

## ADR-157 — Column grain: columns as provenanced table-node attributes, observed from `db.statement`, declared per-ORM at database-name fidelity, and column-drift divergence

**Status:** Accepted, implementation pending. Refs #918. Amends [`schema.md`](contracts/schema.md), [`static-extraction.md`](contracts/static-extraction.md), [`otel-ingest.md`](contracts/otel-ingest.md), [`provenance.md`](contracts/provenance.md), and [`divergence-query.md`](contracts/divergence-query.md). The data-axis sibling of ADR-158 (symbol grain), the same below-file architecture one grain finer. (ADR-158 already references this as its sibling; the number is reserved for that reason.)

### Context

NEAT resolves a database to its tables — `infra:sql-table:<name>` (ADR-152), observed off the `db.statement` the SQL instrumentations carry. The grain beneath the table — which columns application code touches, which columns production actually reads and writes, and where the two disagree — is the sharpest divergence and a seam no one else occupies. Data-lineage tools (dbt, DataHub, Select Star) do column→column lineage *inside the warehouse*, statically parsed; NEAT's axis is the application code ↔ operational database seam: the code that touches a column against what production does with it. The field rename `orders.total → orders.amount`, where the writer was never updated, is the case NEAT can answer and they cannot.

A spike against real ORM fixtures and a real `pg_stat_statements` capture settled the shape and surfaced the one constraint the design hinges on. The observed signal is already in hand: `tableFromSqlStatement` (ADR-152) parses `db.statement` for the table, and the column list lives in that same statement. Production statements are parameterized (`INSERT INTO orders (amount) VALUES ($1)`) — values redacted, column names present — and real ORM SQL is quoted, schema-qualified, and (SQLAlchemy) projects every column as `<table>.<col> AS <table>_<col>`; the parse must recover the real column, not the alias.

### Decision

1. **Columns are provenanced attributes on the table node, never their own nodes.** The `infra:sql-table:<name>` node carries `columns: { name, provenance, confidence }[]`. A table holds an order of magnitude more columns than there are tables, and nothing traverses *to* a column — it is described, not called — so column nodes would be pure hairball. A column is `EXTRACTED` when a migration or ORM schema declares it, `OBSERVED` when a production statement touches it, and records both when they agree. Provenance moves to attribute grain; the enum and `PROV_RANK` carry over. This is the ADR-157/ADR-158 shared rule read on the data axis: tables earn nodehood, columns earn attribute-hood.

2. **Observed columns come from `db.statement`, extending ADR-152's parse.** A `columnsFromSqlStatement` returns the columns an `INSERT (cols)` / `UPDATE … SET` / `SELECT proj … WHERE` / `DELETE … WHERE` statement touches — quote-, schema-, and qualifier-stripped, the `AS` alias dropped to recover the real column, aggregate/`*` projections skipped — and degrades to nothing on the same JOIN / multi-`FROM` shapes the table parse degrades on. Ingest and the pull connectors merge the resolved columns onto the table node with `OBSERVED` provenance. This half stands on its own: "which columns does production read and write on this table" is the connector-drain fix-context use case, and needs no declared side.

3. **Declared columns come from the schema, at database-name fidelity.** The load-bearing constraint: the fusion key is the **database column name, not the code field name**. SQLAlchemy's attribute name *is* the column name and fuses directly; camelCase-mapping ORMs (Drizzle, Prisma, TypeORM — `userId` on the DB as `user_id`) must have their actual column name reproduced, or every one produces a phantom drift for a single real column. The extractor reproduces each ORM's field→column naming verbatim — an explicit column mapping where given, the ORM's default casing otherwise — the same fidelity-is-the-fusion-key discipline as the Mongoose pluralizer (ADR-147) and the SQLAlchemy tablename (ADR-152). Drizzle first (JS/TS primary), then SQLAlchemy and raw `CREATE TABLE`; Prisma and TypeORM are named follow-ons. Where a column name is computed or the mapping is unresolved, the column is left unclaimed rather than guessed.

4. **Column drift reuses the existing divergence semantics at column grain.** A read-only detector compares a table node's declared and observed column sets: a declared-only column is `missing-observed`, an observed-only column is `missing-extracted`, reported at column grain (`orders.total`, `orders.amount`) through `get_divergences`. A table with only one side present emits nothing — no drift claim without both sides (the ADR-141 fusion discipline). This is the same semantics the edge-triple detectors use, computed over column sets on one node.

Adding `columns` to the node is a schema shape change (`schema.md`): `SCHEMA_VERSION` bumps and `persist.ts` backfills. Growth of the column list thereafter is commit-and-go.

### Consequences

- A database gains an observed column view for free from the statement NEAT already parses — "what production actually touches on this table" — the drain-to-column fix-context, with no declared side required.
- The field-rename drift becomes answerable: schema declares `total`, production writes `amount`, reported as a column-grain divergence — a seam no data-lineage or schema-drift or data-contract tool occupies (they do warehouse column lineage, structural schema drift, or data-quality checks respectively).
- Columns cost one attribute list per table, not a node per column; traversal, blast-radius, and the graph's shape are unaffected beyond the one migration — the graph-hygiene rule symbol grain also follows.
- The honest limits are stated: JOINs, subqueries, and `SELECT *` yield no columns and are recorded at no finer grain than the statements support; a declared column absent from observed traffic is `missing-observed` only where the traffic could have shown it. The declared side is only as faithful as the per-ORM naming reproduction — an ORM whose mapping NEAT does not yet reproduce is left at table grain rather than emitting a false column drift.
- ADR-158 (symbol grain) and this ADR complete the one below-file architecture on both axes: the code side descends service ▸ file ▸ symbol, the data side database ▸ table ▸ column, and the same deterministic queries run at whatever grain a question lives at.

## ADR-159 — A Claude Code plugin, and the graph as live mid-session context (the monitor)

**Status:** Accepted. Shipped in #921 (Refs #920). Amended by ADR-162 (multi-grain fact set). Amends [`cli-surface.md`](contracts/cli-surface.md) (a `neat monitor` command), [`package-split.md`](contracts/package-split.md) and [`publish-system.md`](contracts/publish-system.md) (the plugin as a distributed artifact). Builds on the SSE event bus (`frontend-api.md`, ADR-051) and the skill/hooks config commands (ADR-145).

### Context

NEAT exists so an agent has a true, full-stack map of the system as it works — the graph is the product, and every query (blast radius, root cause, observed dependencies, divergence, policies) is a feature of it. Two things blunt that today. First, distribution: NEAT reaches only Claude Code, and only through two manual commands (`neat skill --apply` for the MCP server, `neat hooks --apply` for the search-nudge hook), while the comparable static tools ship a single-install plugin for both Claude Code and Codex. Second, latency of context: the graph answers only when the agent remembers to ask. A live fused graph has something a static index never will — events. It can tell the agent what changed the moment it matters, instead of waiting to be queried.

The materials for both already exist. `neat skill`/`neat hooks` already write exactly the MCP config and PreToolUse hook a plugin bundles; the daemon already runs an SSE event bus (`events.ts`, `/events`, the eight-type taxonomy of ADR-051) that emits `extraction-complete`, `edge-added`, `stale-transition`, and the rest. Divergence is not on that bus — it is a computed query (`get_divergences`), by design. So the live-context piece is not a new event type; it is a consumer that composes the structural events (as triggers) with the REST reads (the context).

### Decision

1. **A Claude Code plugin packages what NEAT already ships.** A `.claude-plugin/plugin.json` at a plugin root bundling: NEAT's MCP server (`.mcp.json` → `npx -y @neat.is/mcp`), the PreToolUse search-nudge hook (`hooks/hooks.json` referencing the existing `neat-search-nudge.mjs` via `${CLAUDE_PLUGIN_ROOT}`), and the skill (`skills/`), plus a `marketplace.json` so it is installable with one command. This repackages shipped surface into the plugin layout; it invents no capability. The existing `neat skill`/`neat hooks` commands stay — the plugin is the one-install path, they are the à-la-carte path.

2. **The monitor is a real CLI command first, the plugin wire second.** `neat monitor` connects to the local daemon's SSE `/events` and, on a structural trigger (`extraction-complete`, a new OBSERVED `edge-added`, a `stale-transition`), reads the graph over REST and emits **one human-readable line per high-signal fact** to stdout: a fresh divergence between declared and observed, an integration that just went STALE, an observed dependency the code does not declare. It holds a small seen-set so it emits each fact once, and it stays silent when nothing is worth saying. Because it is a CLI command, it runs under `neat watch`, for any agent, and in a plain terminal — not only inside the plugin.

3. **The plugin auto-wires the monitor through `monitors/`.** The plugin's `monitors/monitors.json` invokes `neat monitor`; Claude Code delivers each stdout line to the agent as a mid-session notification, so the agent is told what production just contradicted *before* it edits, without querying. This is the offense a snapshot graph cannot match — a static index has no events to push. The monitor degrades safely: no daemon, no output (it does not fabricate); the `monitors/` mechanism is the delivery, not the capability, so the command remains useful if that mechanism is unavailable.

4. **The monitor composes existing surface — no new bus event, no change to the locked taxonomy.** It is a client of the SSE bus and the REST reads, both of which exist. The eight-type SSE taxonomy (ADR-051) is unchanged; divergence stays a computed query the monitor calls, not a persisted event. The one new surface is the `neat monitor` command itself (`cli-surface.md`), additive alongside the existing lifecycle/config verbs.

### Consequences

- NEAT becomes a one-command Claude Code plugin, closing the distribution gap with the tools that already ship one; the manual `skill`/`hooks` path remains for anyone who wants it.
- The graph stops waiting to be asked: an agent working with the plugin is told, mid-session, when the live graph learns something that contradicts what it is about to touch — the fused graph's events made ambient, which no static tool can do.
- The monitor is honest by construction — it emits only real, already-computed facts, once each, and nothing when the graph has nothing to say; it fabricates no signal and needs no new event type.
- The plugin surface is a new distributed artifact under the publish system; the monitor is a new CLI command under the CLI surface. Both are additive — the graph, the queries, the event bus, and the existing config commands are unchanged.

## ADR-160 — Cross-file Express mount prefixes compose onto routes, so declared and observed routes fuse

**Status:** Accepted, implementation pending. Refs #924. Amends [`static-extraction.md`](contracts/static-extraction.md) (supersedes the "Mount-prefix resolution … out of scope" clause for Express). Follows the cross-file resolution pattern of ADR-149 (`mongooseCrossFileEndpoints`).

### Context

Real Express apps mount their routers under a prefix — `app.use('/api', router)` — and define the router and its routes in other files (`routes/`, `controllers/`). NEAT's route extractor (`serverRoutesFromSource`) reads each file in isolation, so it captures the leaf path (`/tags`) without the mount prefix; production serves `/api/tags`, and the OBSERVED server span's `http.route` (`/api/tags`) never matches the static route node (`/tags`). The declared and observed route stay twinned, and route-grain divergence and fusion silently fail. This was confirmed live on a RealWorld/Express app NEAT was not built for: every prefixed route stayed dark; only the un-prefixed root route fused.

NEAT already composes mount prefixes *in file* — FastAPI `include_router`, Flask `register_blueprint`, in-file `APIRouter(prefix=…)` — and it already resolves cross-file bindings through the import graph in `mongooseCrossFileEndpoints` (ADR-149) and `pythonOrmCrossFileEndpoints`, whole-program passes that walk `resolveJsImport` to a binding's defining file. The Express cross-file mount is the one composition explicitly deferred; this closes it with the mechanism that already exists.

### Decision

A whole-program pass composes the Express mount prefix onto the routes it mounts. After the per-file route scan, the pass finds mount statements `<app>.use('<prefix>', <router>)` where `<prefix>` is a string literal beginning with `/` and `<router>` is a resolvable binding — a router imported from another file, or a local `Router()` that aggregates imported controllers through chained `.use(<controller>)`. It resolves each mounted router to its defining file(s) through the import graph (`resolveJsImport`, the ADR-149 path), and prepends `<prefix>` to every route those files declare, transitively through a chained/aggregating `.use()` so the RealWorld shape `Router().use(a).use(b).use('/api', agg)` composes `/api` onto the routes `a` and `b` declare. The declared template is rewritten to the full path (`/api/tags`) — the exact string an OBSERVED `http.route` carries — so declared and observed routes fuse on one node via `normalizePathTemplate`, unchanged.

The discipline is the ADR-149 discipline: a prefix built from a config symbol or a computed expression, or a router that resolves to no file or to many ambiguously, leaves the leaf path un-prefixed rather than guessing — the honest partial is a route at the wrong grain, never a fabricated one. Mutation authority stays in `extract/*`; this is a route producer, evidence on each route unchanged.

### Consequences

- Real Express apps — the overwhelming majority mount a router under `/api` — get route fusion and route-grain divergence that silently failed before; the declared route matches the `http.route` production emits.
- The mechanism is the one ADR-149 established (import-graph cross-file resolution), so it is a new pass, not new infrastructure; the Python cross-file mount (`app.use`-analog) can follow the same shape when demanded.
- Honest limits carry over: a config-symbol or computed prefix, or an unresolvable/ambiguous mounted router, stays un-prefixed rather than guessed — coverage grows one shape at a time, not by heuristic.
- Supersedes the Express half of static-extraction.md's "mount-prefix resolution is out of scope" clause; the in-file Python composition and the still-deferred Python cross-file mount are unchanged.

## ADR-161 — Foreign-key `REFERENCES` edges: the data axis gains table→table structure

**Status:** Accepted, implementation pending. Refs #928. Amends [`identity.md`](contracts/identity.md), [`schema.md`](contracts/schema.md), [`static-extraction.md`](contracts/static-extraction.md), [`traversal.md`](contracts/traversal.md), [`get-blast-radius.md`](contracts/get-blast-radius.md), and [`get-root-cause.md`](contracts/get-root-cause.md). The structural-edge sibling of ADR-158 §3 (symbol `INHERITS`/`IMPLEMENTS`), read on the data axis: as symbol grain gave a function its heritage edges, this gives a table its foreign keys.

### Context

Column grain (ADR-157) gave a `infra:sql-table:<name>` node its columns, but the tables stayed islands — a table node carries no edge to the table it references. So the data axis of the graph is edgeless: `getBlastRadius`/`getDependencies`/`getRootCause` can walk service→file→symbol and file→table, but not table→table. "What breaks if `users` changes" cannot include the tables whose foreign keys point at it, because the graph does not record that they do. The foreign key is the one structural fact a relational schema always declares and NEAT was not yet reading.

The shape is already latent. `provenance.md` grades an EXTRACTED edge with `evidence.file`/`line`; `identity.md`'s `infraId('sql-table', name)` is the one node id the column/table extractors and the OTLP `db.statement` parse (ADR-152) already fuse on; the traversal machinery walks generically over `edge.type` with no per-type allowlist (ADR-158 §6). What is absent is a name for the edge and a producer that reads the FK out of each ORM's schema at that node id.

### Decision

1. **A new `REFERENCES` edge type — `infra:sql-table:<child> ──REFERENCES──▶ infra:sql-table:<parent>`, EXTRACTED.** It joins `EdgeTypeSchema` as additive growth (a new enum value, `schema.md` §Growth — no `SCHEMA_VERSION` step, an older snapshot simply carries no FK edges and re-extraction mints them). The child table declares the foreign key; the parent is the referenced table. The direction is the dependency direction — the child depends on the parent — so blast radius (inbound) from the parent reaches the child, and `getDependencies` (outbound) from the child reaches the parent. This mirrors exactly how ADR-158 §3 added `INHERITS`/`IMPLEMENTS`: a structural edge type in `@neat.is/types`, an id via `extractedEdgeId`, `evidence.file`/`line` on every edge, `hasNode`/`hasEdge`-guarded writes, and a dedicated producer (`extract/table-edges.ts`) that runs after the node inventory it resolves against exists.

2. **Fidelity is the fusion key — the parent resolves to the DATABASE table name, verbatim per ORM.** The load-bearing constraint, the same one ADR-152/ADR-157 turn on: the FK must land on the same `infra:sql-table:<name>` node the OBSERVED `db.statement` parse and the column read target, or it twins instead of fusing. So each reader reproduces the parent's DB name the ORM's own way, never the code model/variable name:
   - **Drizzle** (`.references(() => users.id)`) names the schema *variable*; the reader resolves it through the in-file variable→`pgTable('...')` map, so `appUsers` referenced by variable resolves to the table `app_users`, not `appUsers`.
   - **Prisma** (`@relation(fields: […], references: […])`) mints only on the `fields:` side — the side that holds the FK column — so the edge is minted once and in the child→parent direction; the parent is the relation field's base-type model resolved to its table (its `@@map` name, else the model name verbatim, Prisma's non-snake-cased default).
   - **SQLAlchemy** (`ForeignKey('users.id')`) names the DB table directly in the string — the parent is the segment before the last dot (`public.users.id` → `users`), already at DB-name fidelity; the child is the enclosing model's `__tablename__` / Flask-derived table.
   A computed or cross-file-unresolvable reference is left **unclaimed** — the reader returns nothing rather than guess (`file-awareness.md` §6, never-fabricate). A missing edge is a correct partial; a wrong fusion is a bug.

3. **Traversal admits `REFERENCES` with no reasoning-core change.** The walk is generic over `edge.type` (ADR-158 §6 invariant, enforced by the agnosticity contract test over `traverse.ts`), so `getBlastRadius`/`getTransitiveDependencies`/`getRootCause` walk FK edges the moment they exist — no provider/framework/language/edge-type branch is added to the reasoning core. Blast radius from a parent table now enumerates the child tables that FK into it; a child table's dependencies now include the parent. This is the point of a universal graph: a new structural edge is new reach, not new machinery.

4. **Scope: Drizzle, Prisma, and SQLAlchemy in this slice; the rest are named follow-ons.** The three ORMs that already carry a column reader (ADR-157) gain a FK reader beside it. Left explicitly unclaimed rather than half-built: raw `CREATE TABLE … REFERENCES parent(col)` in migration SQL, cross-file FK resolution (a reference to a table imported from another schema module), composite/table-level constraints (Drizzle `foreignKey({…})`, SQLAlchemy `ForeignKeyConstraint`, Prisma multi-field relations), the SQLAlchemy `ForeignKey(Class.col)` mapped-attribute form, and TypeORM. Each is a new recognizer emitting a `TableReference`, not a model change — the same demand-and-test-gated growth path column grain follows.

Self-referential foreign keys (a tree's `parent_id`) are skipped: the graph disallows self-loops, and a table referencing itself carries no cross-table blast radius.

### Consequences

- The data axis is walkable. "What breaks if I change the `users` table" now includes the tables that reference it, computed by the same graph walk that answers the code axis — the fused model's promise read one axis over.
- The edge fuses, it does not twin. Because both endpoints resolve to `infra:sql-table:<name>` at DB-name fidelity, the FK lands on the same node the observed traffic and the declared columns already share; there is no code-model twin node.
- The reasoning core stayed agnostic and the agnosticity test still guards it — a structural fact was added to the adapters (the ORM readers), never to the walk.
- The honest limits are stated, not hidden: cross-file, composite, raw-SQL, and non-string FKs are named follow-ons; a reference NEAT cannot resolve deterministically is left unclaimed, so a table with an unread FK is at worst edgeless on that axis, never wrongly connected.
- ADR-157 (columns) and this ADR (foreign keys) complete the table node the way ADR-158 completes the file node: attributes below it, structural edges beside it, the same deterministic queries at whatever grain the question lives at.
## ADR-162 — The monitor goes multi-grain: column drift and live policy violations in the ambient stream

**Status:** Accepted. Refs #929. Amends [ADR-159](#adr-159--a-claude-code-plugin-and-the-graph-as-live-mid-session-context-the-monitor) (the `neat monitor` fact set) and [`cli-surface.md`](contracts/cli-surface.md). Builds on the column grain (ADR-157), symbol grain (ADR-158), the divergence query (ADR-060), and the soft-guardrail policy surface (ADR-108 / ADR-043 / ADR-045). The SSE taxonomy (ADR-051) is unchanged.

### Context

`neat monitor` (ADR-159) is the plugin's ambient channel: it holds the daemon's SSE `/events` bus open, and on a structural trigger reads the graph over REST and pushes one human-readable line per high-signal fact — a fresh divergence, a stale integration, a new observed dependency — deduped by a seen-set, silent when nothing is new. Its value is that the fused graph stops waiting to be asked: the agent is told what production just contradicted before it edits.

The graph the monitor reads has since grown two things the ambient stream should carry. The first is grain: divergence is now computed at column grain (ADR-157) — `orders.total` renamed to `orders.amount` with the writer left behind is a `missing-extracted` on one table node — the sharpest "before you edit" fact NEAT surfaces, and the exact string a downstream edit needs. The second is a query the monitor does not yet watch: `check_policies` (ADR-108) answers which soft-guardrail rules a change would trip, and a newly-appearing violation is precisely the fact the monitor exists to push ahead of the edit. Both are already computed and already served over REST; what is missing is the monitor rendering them.

This is additive to the monitor's rendering. It is not a new event type, not a new REST route, not a new capability — the mechanics of ADR-159 are unchanged: SSE structural trigger → REST read → one line → seen-set dedupe → silent when nothing is new.

### Decision

1. **Column-grain divergence renders with the column named.** The divergence read (`GET /graph/divergences`) already returns column-locus findings (ADR-157 §4); the monitor renders them at column grain — `orders.amount declared, never observed in production` (`missing-observed`) and `production writes orders.amount — not declared in code` (`missing-extracted`) — carrying the drifting column, not a table-shaped shrug. The dedupe key includes the column, so two drifts on one table are two distinct lines. No new read: the same debounced divergence query the monitor already calls carries the finer locus.

2. **Fresh policy violations join the trigger→read→line flow.** A `policy-violation` SSE event (already in the locked eight-type taxonomy, ADR-051) triggers a debounced read of `GET /policies/violations` — the same list the `check_policies` state-read returns — and the monitor emits one line per not-yet-seen violation: `⚠ policy [<severity>] <policyName> — <message>  (<subject>)`, where `<subject>` is the node, edge, or rule path the violation points at. The dedupe key is the violation's deterministic id (ADR-043), so a re-read (or a reconnect catch-up, or the baseline read on first connect) prints only what is genuinely new. The monitor reads the authoritative violation list rather than rendering the event payload, so the seen-set dedupes against exactly the set the baseline read saw. This is the soft guardrail (ADR-108) made ambient: informs, never blocks — the monitor emits a line, it does not gate.

3. **Observed-only symbols wait for a query to surface them.** ADR-158 §5 frames an observed symbol with no extracted twin as `missing-extracted` at symbol grain, but the divergence detector excludes symbol-grained buckets by design (to keep every static heritage link and intra-process call off the file/service-grain divergence surface), so there is no computed set the monitor can render today. Rather than add a bespoke graph scan to the ambient stream, this is held back until a query surfaces observed-only symbols; the monitor renders it the moment one does, the same trigger→read→line way.

4. **The mechanics are ADR-159's, unchanged.** No new SSE bus event, no change to the eight-type taxonomy, no new REST route (the monitor is a REST client of the existing divergence and policy endpoints), no new capability. The transport is made injectable so the flow can be driven against a scripted SSE source and a fixture graph without a live daemon — the same seam the emitter already exposes for its network-free unit tests, one level up.

### Consequences

- The ambient stream carries the grain where the value concentrates: a column rename that left its writer behind reaches the agent as `orders.amount`, the exact locus, not "something on `orders` diverged."
- The soft guardrail becomes a push, not only a pull: a rule a change would trip surfaces mid-session, before the edit, on the same channel as divergence — the "stay inside the lines" fact delivered ambiently rather than waiting for `check_policies` to be called.
- The monitor stays honest by construction — every added line is a fact the graph already computed (divergence at column grain, a recorded policy violation), emitted once, silent when there is nothing new; nothing is fabricated and no new event type is minted.
- The change is confined to the monitor's rendering and its trigger wiring. The graph, the queries, the event bus, the taxonomy, and the plugin surface are unchanged; ADR-159's monitor gains grain and one more query, and nothing it already did is altered.

## ADR-163 — `neat codex`: one-command install of NEAT into the OpenAI Codex CLI

**Status:** Accepted. Refs #932. Amends [`cli-surface.md`](contracts/cli-surface.md) (a `neat codex` config command). Mirrors the `neat skill`/`neat hooks` config commands (ADR-145) and closes the second half of the distribution gap ADR-159 named — "both Claude Code and Codex." Reuses the agent-agnostic graph-first guidance (`GRAPH_FIRST.md`) the hooks command already ships.

### Context

NEAT reaches Claude Code through a one-install plugin (ADR-159) and the à-la-carte `neat skill --apply` (the MCP server) / `neat hooks --apply` (the search-nudge hook + graph-first guidance). Every other MCP-capable agent has to be wired by hand. Codex is the one ADR-159 called out by name, and it is the closest match to the surface NEAT already ships: it reads MCP servers from a user-level TOML config and it reads project instructions from `AGENTS.md`, the exact two things `neat skill` and `neat hooks` write for Claude Code. The materials already exist — the MCP invocation is `npx -y @neat.is/mcp`, unchanged from the skill, and the guidance block is `GRAPH_FIRST.md`, the same file the hooks command materialises. What is missing is a command that writes them where Codex looks.

Codex stores MCP servers under a `[mcp_servers.<name>]` table in `~/.codex/config.toml` (a project-scoped `.codex/config.toml` is also read); a local stdio server is `command` + optional `args` + optional `env`. That config file is TOML the user hand-edits, so the write has to merge into it, not replace it — a wrong config there stops Codex at startup, which is worse than no NEAT.

### Decision

1. **`neat codex` writes the two things Codex reads, plan by default.** With no flag it prints what it would change and writes nothing; `--apply` writes. It adds an `[mcp_servers.neat]` table to `~/.codex/config.toml` — `command = "npx"`, `args = ["-y", "@neat.is/mcp"]`, `env = { NEAT_CORE_URL = "http://localhost:8080" }`, the same invocation and the same canonical daemon-URL env var the Claude skill uses — and writes NEAT's graph-first block into `AGENTS.md` at the project root. It is a config command family alongside `neat connector` / `neat hooks`, not a twelfth locked query verb, so it stays off the ADR-050 allowlist and parses its own argv. `--print-config` and `--print-guide` print the two artifacts for a manual install.

2. **Merge, never clobber; a re-run is a no-op.** The config is parsed with the TOML library already in the tree (`smol-toml`), and only NEAT's own `[mcp_servers.neat]` table is spliced in — every other server, key, and comment is preserved, and re-running writes identical bytes. The spliced text is re-parsed and compared against the original before it is returned, so a splice that cannot prove it preserved every other table falls back to a full parse-merge-serialize round-trip that is guaranteed to keep every key. The `AGENTS.md` block is delimited by stable `<!-- neat:graph-first -->` … `<!-- /neat:graph-first -->` markers, so a re-run replaces only NEAT's block and leaves the user's own instructions untouched; absent the file, it is created.

3. **Fail honest — a malformed config is a clear error with no partial write.** If `~/.codex/config.toml` is not valid TOML, `neat codex` says so and writes nothing to either file, rather than append to a broken config or half-apply. The MCP invocation carries no secret (`NEAT_CORE_URL` is a localhost default the user edits for a non-default daemon), so nothing sensitive is written at rest.

4. **The guidance is the shipped, agent-agnostic block — no Codex-specific fork.** `AGENTS.md` gets `packages/claude-skill/GRAPH_FIRST.md` verbatim, the same block `neat hooks --print-guide` emits and the same one the README points every non-Claude-Code harness at. Codex has no equivalent of the Claude Code PreToolUse hook, so the search-nudge is not part of this command; the graph-first guidance is how a Codex agent learns to reach for the graph first.

### Consequences

- Codex users get NEAT in one command, closing the half of the ADR-159 distribution gap the plugin did not reach; the skill/hooks path and the Claude Code plugin are unchanged.
- The command reuses shipped surface — the `npx -y @neat.is/mcp` server and the `GRAPH_FIRST.md` guidance — and invents no capability; it writes them where Codex reads.
- The user's Codex config is safe by construction: a value-preserving merge verified before write, a no-op on re-run, and a clean refusal on a malformed file. The one artifact NEAT owns (`[mcp_servers.neat]` and the marker-delimited `AGENTS.md` block) is the only thing it rewrites.
- The verb set for queries is unchanged — `neat codex` is a config command, off the locked allowlist, the same standing as `neat connector` and `neat hooks`.
## ADR-164 — `neat cursor` / `neat devin`: one-command install into the VS Code MCP family

**Status:** Accepted. Refs #933. Amends [`cli-surface.md`](contracts/cli-surface.md) (two new config-command verbs alongside `skill` / `hooks` / `connector`). Builds on the skill/hooks config commands (ADR-145) and the one-install Claude Code plugin (ADR-159); reuses `packages/claude-skill/GRAPH_FIRST.md`, the agent-agnostic guidance block. The MCP tool surface (ADR-039) and the locked query-verb allowlist (ADR-050) are unchanged.

### Context

NEAT reaches an agent through two wires: an MCP server (`npx -y @neat.is/mcp`, pointed at the local daemon) so the graph is queryable, and a graph-first steer so the agent reaches for it before grepping. For Claude Code both wires ship pre-tied — the plugin (ADR-159) bundles the MCP server and the search-nudge hook, and `neat skill` / `neat hooks` are the à-la-carte path. Cursor and Devin Desktop's Cascade agent speak the same MCP protocol, but neither reads Claude Code's config, so a NEAT user on those editors gets nothing from that setup and must wire both wires by hand: hand-edit a JSON config to add the server, then paste the guidance into a rules file. That hand-wiring is the same shape NEAT already automates for Claude Code — only the destinations differ.

Where those destinations are is the one thing that must be right, because a wrong config file is worse than none. Verified against each client's own docs (Aug 2026): **Cursor** reads MCP servers from `~/.cursor/mcp.json` (user-level) or `.cursor/mcp.json` (project), a top-level `mcpServers` object keyed by name (`docs.cursor.com/context/mcp`); **Devin Desktop** — Cognition's successor to Windsurf — reads them through its Cascade agent from the unchanged legacy `~/.codeium/windsurf/mcp_config.json`, the same top-level `mcpServers` shape (`docs.devin.ai/desktop/cascade/mcp`). Both take an stdio server as `{ command, args, env? }` — exactly the object `neat skill` already writes for Claude Code. Cursor's always-on rules file is a single `.cursorrules` at the project root (the modern `.cursor/rules/*.mdc` split is one-rule-per-file with frontmatter — a worse fit for a fenced block NEAT owns). Devin's current docs don't re-document an always-on rules file, so NEAT writes the guidance to `.windsurfrules` — the legacy surface the Cascade agent inherited from Windsurf — as the best-effort half: the MCP config is the verified, load-bearing wire, and the rules write is additive and marker-fenced, harmless if a Cascade build ignores it.

### Decision

1. **Two verbs, one implementation.** `neat cursor` and `neat devin` join the config-command family (`skill` / `hooks` / `connector`), not the locked ADR-050 query allowlist — each parses its own argv. They are two verbs rather than one `neat editor <client>` dispatch because a user reaches for the name of the editor in front of them, and the surface reads better in `--help`; the two clients differ only in a descriptor carrying the MCP config path and the rules filename, so the body is shared, not duplicated.

2. **Plan by default, `--apply` to write — the ADR-046 discipline the rest of the CLI already keeps.** With no flag, each verb prints what it would write to each destination and writes nothing. `--apply` writes NEAT's stdio server (`{ "command": "npx", "args": ["-y", "@neat.is/mcp"] }`) into the client's `mcpServers` object and the graph-first block into the client's rules file.

3. **Merge, never clobber; a re-run is a no-op.** The MCP write preserves every other server and top-level key — only `mcpServers.neat` is set. The guidance is written between `<!-- neat:graph-first -->` … `<!-- /neat:graph-first -->` markers, so a re-run replaces only NEAT's fenced block and leaves anything the user wrote around it exactly as it was. Re-running either verb produces byte-identical files.

4. **Fail honest — a malformed existing config is a hard stop with nothing written.** Reads and validation happen before any write; if the client's MCP config exists but is not valid JSON, the verb reports which file to fix and exits non-zero without touching either file. No partial state.

### Consequences

- A Cursor or Devin Desktop user gets the same one-command setup a Claude Code user gets from the plugin: the graph wired in and the agent steered to it, in a single verb, without hand-editing JSON.
- NEAT's reach widens to the VS Code MCP family with no new capability — the MCP server, the guidance block, and the merge/idempotency discipline are all reused; the two verbs are destinations for surface NEAT already ships.
- The config paths are pinned to what each client documents today. They drift; when a client moves its config, the descriptor for that client is the one place that changes, and the verb is the seam that absorbs it.
- The guidance lands in each client's single-file rules surface: `.cursorrules` for Cursor (documented and read), `.windsurfrules` for Devin Desktop (the legacy Cascade surface, not re-documented under Devin, so best-effort — additive and marker-fenced, losing nothing if a build ignores it). If a client moves to directory-based rules, the block moves to the new home behind the same marker fence — a descriptor change, not a redesign.

## ADR-165 — The Cloud Run connector reads Cloud Logging request logs and fuses onto route grain

**Status:** Accepted. Refs #937. Amends [`connectors.md`](contracts/connectors.md) and [`connector-config.md`](contracts/connector-config.md); adds [`docs/connectors/cloud-run.md`](connectors/cloud-run.md). Follows the hosting-platform-fusion pattern ADR-127 (Railway) established and ADR-128 (Firebase) already applies to `cloud_run_revision` request logs; borrows the honest infra-node fallback ADR-133 gave Cloudflare.

### Context

The compatibility-expansion rubric scores Cloud Run: reach **5/5** (one of the top serverless hosts, and the substrate under 2nd-gen Cloud Functions too), OBSERVED tractability **4/5** (request logs are auto-emitted with zero app instrumentation, but only ever at route/service grain — an un-instrumented host emits no runtime `code.*` call-site stamp, so file precision can come only from a route's own static definition site, never a live stack walk), extraction tractability **5/5** (`extract/routes.ts` already parses the Express/Fastify/Next apps Cloud Run hosts), fusion-key clarity **4/5** (the `(method, path)` → `RouteNode` join is the same route-match path Railway and Firebase use; the GCP `service_name` → NEAT service name step needs a config-time map, resolved once, never guessed), strategic fit **5/5** (a top hosting on-ramp). Total **23/25**.

Every field below was confirmed against Google's own documentation rather than recalled, per the connectors build discipline (ADR-150/152 — the attribute a convention names is often not the one the API returns):

- **Cloud Logging `entries.list`** — `POST https://logging.googleapis.com/v2/entries:list`, request body `{ resourceNames, filter, orderBy, pageSize, pageToken }`, response `{ entries, nextPageToken }` (`cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list`). The same surface Firebase's connector already polls.
- **Cloud Run request-log resource** — the monitored resource type is `cloud_run_revision`, carrying labels `project_id`, `service_name`, `revision_name`, `location`, `configuration_name` (`cloud.google.com/logging/docs/api/v2/resource-list`).
- **The request-log name** — `projects/<PROJECT_ID>/logs/run.googleapis.com%2Frequests`; the `/` inside the log id is URL-encoded `%2F`, and the filter must carry that encoded form (`cloud.google.com/run/docs/logging`, cross-checked against a live project's exported logs). Request logs are created automatically by Cloud Run for services — no logging agent, no app change.
- **The `httpRequest` payload** — `requestMethod`, `requestUrl`, `status` (integer), plus `latency`, `remoteIp`, `requestSize`, `responseSize`, `serverIp`, `userAgent`, `referer` (`cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry`). `requestUrl` is documented as "typically without the scheme, host, port, and query portion" — usually already a bare path. The entry's `timestamp` is the request's own event time, distinct from `receiveTimestamp` (ingest time).
- **Least-privilege read** — `entries.list` needs `logging.logEntries.list`, carried by the predefined read-only role `roles/logging.viewer`; a custom role holding only `logging.logEntries.list` is narrower still. This role reads logs only and reaches no customer data — there is no Fork-A-style local/hosted split (the same finding Firebase recorded), so both profiles use the same grant.

Firebase's connector (ADR-128) already reads `cloud_run_revision` request logs, but only for services a Firebase project deployed, and it filters by resource type + `httpRequest:*` without pinning the log name — so it also sweeps whatever an app writes to stdout/stderr on the same resource. Cloud Run is a general serverless host, not a Firebase surface, and deserves a connector that reads exactly its own request record.

### Decision

Cloud Run joins the pull registry as provider `cloud-run`, cloning the `{client,index,map,resolve,types}.ts` provider layout. Its credential is `{ projectId, accessToken }`: `projectId` is not a secret (a plaintext literal is expected); `accessToken` is a short-lived OAuth token minted from a service-account key or ADC scoped to `roles/logging.viewer`. The connector consumes an already-minted token and performs no auth handshake of its own — the same shape Firebase and Railway keep. `docs/connectors/cloud-run.md` requires revoking every grant beyond logging read.

`poll()` runs `entries.list` once per tick, filtered to Cloud Run's own request log specifically:

```
logName = "projects/<projectId>/logs/run.googleapis.com%2Frequests"
AND resource.type = "cloud_run_revision"
AND httpRequest.requestMethod != ""
AND timestamp >= "<since>"
```

ordered `timestamp asc`, paginated to a bounded page count, every call through the shared junction (timeout, retry, per-account rate limit keyed on the GCP project id). Pinning the log name is what separates this connector from Firebase's broader `cloud_run_revision` sweep: it reads the request record and nothing else.

Dedup is a timestamp watermark, not a baseline. A Cloud Run request log is a per-request event, not a cumulative counter, so — unlike Neon's `pg_stat_statements` — no baseline is kept: `since` advances to each tick's start and the filter's `timestamp >= since` lower-bounds the next window. A first poll with no watermark backfills a bounded 24h lookback, never an unbounded full-history replay.

Mapping is 1:1 — one log entry becomes one `ObservedSignal` carrying `(service_name, method, path)`, `callCount: 1`, `errorCount` set at the 5xx threshold (a bare 4xx is often correct app behavior, the same line ingest.ts draws), and the entry's own `timestamp` as `lastObservedIso` (event time, never poll-arrival time). Resolution runs in two tiers:

1. **Route grain (the fused win).** The GCP `service_name` maps through a config-time `serviceMap` to a NEAT service name (resolved once at setup, never inferred at poll time — the "resolved once, never guessed" discipline ADR-127 states for Railway, since a Cloud Run service name need not match `package.json#name`). When the request's normalized `(method, path)` matches a `RouteNode` that service already declares, the OBSERVED `CALLS` edge lands on that route — and, because the RouteNode records its own definition file/line, the shared pipeline (`routeCallSiteFor`, ADR-143) sharpens the edge to that static site. This is file precision drawn from the *static* route definition, not a runtime stamp.
2. **Service grain, honestly (the missing-extracted divergence).** When no static route resolves — the app's router isn't one `routes.ts` recognizes yet, or the path matches no declared template — the connector does not fabricate a route. It declares an honest fallback via `ensureInfraNode` (ADR-133 §4a): the edge lands on `infraId('cloud-run-service', <service_name>)`, the Cloud Run service as the real platform resource its own log names, surfacing as a `missing-extracted` divergence — observed production traffic the codebase's static route table doesn't account for — instead of a silent drop. The fallback id is chosen so a *future* static recognizer for Cloud Run services (a `run.yaml` / service-manifest extractor, the analog of Cloudflare's `extract/infra/cloudflare.ts`) fuses onto the same node rather than twinning it.

Route/service grain is the honest ceiling here, and it is the correct one: an un-instrumented host emits no `code.*` file-grain telemetry, so the only file precision available is a route's own static definition site (tier 1), and everything else is honestly service-grained (tier 2). Local and hosted profiles run the identical pull/map/fuse implementation, differing only in how the scoped token is brokered and in poll cadence.

### Consequences

- Cloud Run request traffic lands on the same `RouteNode`s static extraction already builds, so a declared route and its production traffic fuse without a Cloud-Run-specific node kind — and a route that only production hits, never the static picture, surfaces as a divergence rather than vanishing.
- Firebase keeps its broader hosting-platform sweep; this connector is the sharper read for a plain Cloud Run deployment. The two can both be configured against one project without contention — each mints onto the same `RouteNode` identity, so an overlap fuses rather than twins.
- The GCP `service_name` → NEAT service mapping is a required piece of setup for route-grain fusion. An unmapped service still produces honest service-grained edges (tier 2 falls back to the Cloud Run service's own name), so a connector added before the map is filled is never silent — it just stays coarse until the map lands.
- File precision comes only from a matched route's static definition site; there is no runtime `code.*` grain, and there cannot be until an app instruments itself and pushes OTLP — at which point the OBSERVED span fuses onto the very same `RouteNode` this connector already targets.
- Cloud Logging ingest latency means a request logged a second before a tick's watermark can become queryable a second after it; the `timestamp >= since` window can miss such a straggler. Widening the window would risk double-counting an event across two ticks. The watermark stays honest-and-simple over exhaustive, the same trade Firebase's connector makes against the same API.
## ADR-166 — Render observation reads the request-log API and fuses on the RouteNode

**Status:** Accepted. Refs #938. Amends [`connectors.md`](contracts/connectors.md) and [`connector-config.md`](contracts/connector-config.md); adds [`docs/connectors/render.md`](connectors/render.md).

### Context

The compatibility-expansion rubric scores Render: reach **4/5** (a popular indie/startup host), OBSERVED tractability **3/5** (route/service grain from request logs — no file-grain on an un-instrumented host), extraction tractability **5/5** (the RouteNodes it fuses onto already come from `extract/routes.ts`, so nothing new is built on the static side), fusion-key clarity **4/5** (path→template normalization, the same Railway uses), and strategic fit **4/5** (widens the hosting-platform connector lineup). **Total 20/25.**

Render's telemetry surface was checked against Render's own docs before choosing a shape, because the connectors plane has two — a Vercel-style push/drain that reuses the OTLP receiver (ADR-146) and a Railway-style pull (ADR-127). Three surfaces exist and only one reaches NEAT's OBSERVED layer:

- **Log streams** (`render.com/docs/log-streams`) forward logs to a TLS syslog endpoint over TCP in RFC5424 format (Datadog, Better Stack, Papertrail, or another syslog/HTTPS drain). This is syslog, not OTLP — it does not arrive at the daemon's `/v1/traces` receiver, so a drain here would need a new syslog receive path, which the drain shape exists specifically to avoid.
- **Metrics streams** (`render.com/docs/metrics-streams`) forward service metrics (memory, CPU, disk) as OTLP to a Pro-plan-or-higher observability provider. This is OTLP, but *metrics*, not spans — NEAT's OBSERVED edges come from spans, so a metrics stream produces no edge.
- **The REST API** (`api-docs.render.com/reference/list-logs`) exposes `GET /v1/logs`, which returns the edge-layer HTTP request logs (`type=request`) a Pro workspace already generates: per-request records carrying method, path, statusCode, host, timestamp, and a requestID, filterable and paginated by timestamp cursors, authenticated with a Bearer API key (`render.com/docs/api`).

So Render has no OTLP trace-drain to point a push connector at, and its one runtime-traffic surface that produces graph edges is a pull API. Render joins the pull registry.

Render's API key is the honest limit worth naming up front. Render does not offer a granularly-scoped or read-only key: a key grants access to every workspace the user belongs to (`render.com/docs/api`, and Render's own "A Sandbox Doesn't Constrain an API Key"). The connector only ever issues read GETs (`/v1/services` to validate, `/v1/logs` to poll), but the token itself cannot be narrowed to that — a real gap for the hosted profile, which `connectors.md` §3 anticipates.

### Decision

Render joins the pull registry as a route-grain connector, the second after Railway to fuse hosting-platform request logs onto the `RouteNode` that `extract/routes.ts` already builds — no app instrumentation, and no client SDK to recognize, because a Render-hosted app's routes simply run behind Render's edge.

`poll()` reads `GET /v1/logs?type=request`, scoped by the workspace `ownerId` and the service `resource` id, over a `since`-bounded window capped by a conservative default lookback, following Render's `hasMore`/`nextStartTime`/`nextEndTime` pagination up to a bounded page count so one tick stays bounded on a busy service. Each request log's method, path, and statusCode are read from the entry's `labels` (Render's log object shape); the path is normalized with the same `normalizePathTemplate` the static side uses and matched against the polled service's own RouteNodes. A match mints a file-grained OBSERVED `CALLS` edge onto that RouteNode, reconciled onto the EXTRACTED service-relative path via the RouteNode's own recorded `path`/`line` (`connectors.md` §4 ingress-target file-graining, ADR-143). A request whose path matches no declared route stays an honest `unmatched-route` signal that resolves to nothing — never a fabricated RouteNode, whose `path` is a required real source location.

The credential is a single Bearer API key (`credential: "$RENDER_API_KEY"`, env-ref by default per `connector-config.md` §2). `neat connector add render` requires `ownerId`, `resourceId`, and `serviceName` options and validates by a cheap `GET /v1/services?limit=1` round-trip — Render is a plain REST API, so a live key returns 2xx and a bad one 401/403, unlike Railway's GraphQL-in-200 auth trap. Local and hosted profiles run the same pull/map/fuse implementation; they differ only in how the API key is brokered and in poll cadence.

The request-log surface, response envelope, and filter/label names are sourced from Render's public API docs, not from a live authenticated introspection — this connector has no Render account to probe. What that leaves unconfirmed against a real response (whether every request attribute is a label vs a top-level field, and the exact retention window) is flagged in `render.md` §"What is verified", the same discipline `railway.md` kept before its live check.

### Consequences

- Render request traffic lands on the same RouteNodes static route extraction already produces, so declared and observed routes fuse — and a route Render observes that static extraction misses surfaces as a `missing-extracted` divergence, the honest gap that belongs to `routes.ts`'s framework coverage and shrinks as it grows.
- The grain is route/service, not file — an un-instrumented host carries no `code.*` call site, so this connector is honestly coarse where an OTel-instrumented app would be file-grained, and never guesses a finer grain than the request log supports.
- The hosted-profile credential is as broad as Render's key model allows, not as narrow as least-privilege wants; the connector's read-only behavior is the mitigation until Render exposes a scoped key.
- Only the `type=request` surface is read. App and build logs are free-text stdout with no structured route to bind to, and metrics/syslog streams don't reach the OBSERVED layer — so this connector observes request traffic, not everything Render can emit.

## ADR-168 — ServerActionNode: Next.js Server Actions become first-class, the client→action call path lands

**Status:** Accepted, implementation pending. Refs #940. Amends [`static-extraction.md`](contracts/static-extraction.md), [`schema.md`](contracts/schema.md) (node-union growth, `SCHEMA_VERSION` 6→7), [`persistence.md`](contracts/persistence.md), [`file-awareness.md`](contracts/file-awareness.md) (`file CONTAINS action`), [`identity.md`](contracts/identity.md). Mirrors ADR-158 (SymbolNode) and the `GraphQLOperationNode` precedent (a node recovered for a surface that collapses to one HTTP edge, OBSERVED fusion deferred).

### Context

Server Actions are the mutation surface of a modern Next.js App Router app, and the graph barely sees them. Symbol grain mints at most one untyped `CALLS` edge, and only for bare-identifier calls — the idiomatic `<form action={fn}>` and `useActionState(fn)` produce nothing, and there is no node carrying the semantics "this is a server RPC boundary." An agent reading the graph cannot follow the client→action→service→datastore chain that its edits most often get wrong.

### Decision

1. A new producer `extract/actions.ts`, gated on the `next` dep, detects `"use server"` two ways — a module-level directive (every exported async function in the file is an action) and an in-body directive (one function) — and mints a `ServerActionNode` per exported action at `(service, module, exportName)` grain, owned by its file via `CONTAINS`. This mirrors `GraphQLOperationNode`: a first-class node for a surface that collapses at HTTP grain, with OBSERVED fusion deferred (Next serializes actions to opaque `Next-Action` hashes — out of scope here).
2. A client-stitch pass mints `file ──CALLS──▶ action` on any **reference** to an imported action binding — a call, an `action={}` JSX attribute, or a `useActionState`/`.bind` argument — resolved through `resolveJsImport` (the `symbol-edges.ts` mechanism, honoring `@/*` tsconfig paths). "Referenced, not only called" is what closes the form-action gap. Reuse `CALLS`/`CONTAINS`; no new edge type.
3. A new `ServerActionNode` node type is added to the schema, stamping `SCHEMA_VERSION` 6→7 with a version-only `migrateV6ToV7` (no field to backfill — a v6 snapshot simply carries no actions and re-extraction mints them next pass).

### Consequences

- The client→action chain is a real call path; an agent can see a mutation entrypoint and what it reaches. This is the EXTRACTED context the stack most needs; divergence on actions is a later, harder arc.
- The reasoning core stays blind to the new type (it reaches a `ServerActionNode` over `CALLS`/`CONTAINS` like any node) — the agnosticity invariant holds.
- The version bump is this feature's alone; sibling additive features carry no version step.

## ADR-167 — Firestore call-site recognizer: collections become nodes, fields become provenanced attributes

**Status:** Accepted, implementation pending. Refs #939. Amends [`static-extraction.md`](contracts/static-extraction.md) (new producer) and [`schema.md`](contracts/schema.md) (`ColumnAttr` gains an optional write-SDK dimension — growth, no version step). Follows ADR-147 (Mongoose recognizer) and ADR-157 §3 (columns as provenanced attributes).

### Context

NEAT recognizes Supabase, Mongoose, Drizzle, Prisma, SQLAlchemy, and Django ORM access at call sites, but not Firestore — the datastore of the Firebase/Next.js stack. Today every `collection(` the extractor sees resolves to Mongoose's native driver; a Firestore app's reads and writes name no collection in the graph. Firestore has no least-privilege telemetry path (ADR-128 makes its runtime an explicit connector non-goal), so its value is on the EXTRACTED side: which collections exist, which fields the code writes, and — the load-bearing distinction for the field-guard policy (ADR-169) — whether a write comes from the client SDK (`firebase/firestore`, governed by security rules) or the admin SDK (`firebase-admin/firestore`, which bypasses rules entirely).

### Decision

1. A new producer `extract/calls/firestore.ts`, import-gated on `firebase/firestore` and `firebase-admin/firestore`, recognizes the modular (`collection(db,'orders')`, `doc(db,'orders',id)`) and namespaced (`db.collection('orders').doc()`) shapes, scoping matches to a recognized client var exactly as `calls/supabase.ts` scopes `.from()`. Nested subcollections compose to a full path-template node; computed/interpolated path segments are left unclaimed.
2. Each collection is emitted as an `InfraNode` of kind `firestore-collection` (`infraId('firestore-collection', path)`) at `verified-call-site` confidence. Field names read from `.set/.update/.add({...})` object keys and `where(...)`/`orderBy(...)` arguments land as `ColumnAttr` on the node via the existing columns fold — the Firestore field name is the JS field name, no remap.
3. `ColumnAttr` gains an optional `sdkWrites: ('client'|'admin')[]` dimension recording which SDK wrote each field, folded by a new pure helper `foldSdkWrites` — `foldColumns` is left byte-identical. This is the declared interface ADR-169 consumes.

### Consequences

- A Firebase/Next.js app's datastore surface becomes first-class: collections are nodes, fields are attributes, at the same grain as `sql-table`/`ColumnAttr`. Blast-radius and dependency queries reach them for free (the core keys on `InfraNode`, learns nothing Firestore-specific).
- The nodes are EXTRACTED-only by design (ADR-128); they may appear as `missing-observed` candidates in the divergence surface — accepted, and the honest state.
- The client-vs-admin write tag is the seam the field-guard policy joins on; nothing else reads it, so it is inert until ADR-169 ships.

## ADR-169 — The `field-guard` policy: a generic declared-set-subset rule, firestore.rules its first instance

**Status:** Accepted, implementation pending. Refs #941. Amends [`policy-schema.md`](contracts/policy-schema.md), [`policy-evaluation.md`](contracts/policy-evaluation.md), [`policies-soft-guardrail.md`](contracts/policies-soft-guardrail.md), [`static-extraction.md`](contracts/static-extraction.md), [`schema.md`](contracts/schema.md). Follows ADR-095 (divergence is a policy bundle; the policy engine is the general form) and ADR-043 (a new rule type is one schema entry + one evaluator). Depends on ADR-167 (`ColumnAttr.sdkWrites`).

### Context

The Firestore footgun: a change adds a privileged field on the write path, and the security-rules denylist the dashboard trusts never covered it, so the field is silently client-writable. This is `code writes field X` vs `firestore.rules guards X` — two **declared** artifacts. It is not divergence: divergence is EXTRACTED↔OBSERVED, defensible because it fuses static with runtime; a declared-vs-declared check needs no runtime and belongs in the policy engine, which ADR-095 already named the general form. Framing it as a new divergence type would both dilute the divergence wedge and violate the locked taxonomy (ADR-157 §4 declined to add a type even for column drift).

### Decision

1. A new producer reads `firestore.rules` as a declared artifact (a bounded CEL-like scanner, sibling to reading `schema.prisma` as text) and folds a `guardedFields` set per collection onto the `firestore-collection` `InfraNode`. Rules whose guards are condition-based, function-indirected, or otherwise not reducible to an explicit field set leave the collection's guard **indeterminate** — the check then stays silent. This is extracting structure from a checked-in policy file, not snapshotting secrets.
2. A new **generic** policy rule `field-guard` asserts: for a node type, every member of attribute set A must appear in attribute set B on the same node. It is data-configured, not Firestore-specific. Firestore is the first instance: A = client-written fields (`ColumnAttr` where `sdkWrites` includes `'client'` — admin writes bypass rules and are excluded), B = `guardedFields`. A client-written field absent from B is the violation ("field written but unguarded"). One entry in the `PolicyRule` union, one evaluator in the engine (ADR-043 path); the `matchPolicyToNode` switch's exhaustiveness forces the new case at compile time.
3. It surfaces through `check_policies` today (via `evaluateAllPolicies`). The `get_divergences`-bundle view lands for free when ADR-095 unifies the two engines — it must **not** be forced by re-plumbing `divergences.ts` now.

### Consequences

- The stack's ranked-#1 need is met deterministically and on the PR (the neat-action comment + `check_policies` in CI), with no dependency on the blocked Firestore telemetry path.
- The rule is reusable for any "declared set A ⊆ declared set B on one node" invariant; Firestore is the proving instance, not a special case.
- It flags, it does not hard-block a deploy — the kernel gate (ADR-093) is post-launch. Condition-based/unparseable rules degrade to silence, never a false positive.

## ADR-171 — NEAT ships an editor extension to the VS Code Marketplace and Open VSX

**Status:** Accepted. Refs #949. Amends [`publish-system.md`](contracts/publish-system.md) — `packages/vscode` is private, esbuild-bundled, outside the six-package lockstep, and ships on its own `vscode-v*` tag. Adds `packages/vscode` and [`.github/workflows/publish-vscode.yml`]. Builds on the MCP server (ADR-039) and the `neat codex` / `neat cursor` / `neat devin` editor verbs (ADR-163, ADR-164), whose MCP config shape it reuses verbatim.

NEAT reaches the OpenAI Codex, Cursor, and Devin CLIs through the `neat codex`/`neat cursor`/`neat devin` verbs and sits in the official MCP registry, but it has no presence inside the editors themselves. The VS Code forks — Cursor, Devin's Cascade, Kiro — install extensions from exactly one place: Open VSX. That makes an Open VSX extension the single distribution surface that reaches them, and the same build lists on the VS Code Marketplace for stock VS Code and the Copilot audience. So NEAT ships one: `packages/vscode`.

The v1 does two things and stops there. It configures the `@neat.is/mcp` server for whichever editor is running — natively through `vscode.lm.registerMcpServerDefinitionProvider` on VS Code 1.101 and up, and by writing the fork's own MCP config file on Cursor/Cascade/Kiro, where that API isn't honoured, reusing the merge the CLI verbs already perform. And it shows a status-bar item backed by one call to the local daemon's REST API: whether the daemon is up and how many nodes the graph holds — the piece that keeps the extension earning its place once the one-time configuration is done. It renders nothing of the graph itself; the dashboard in `packages/web` owns that surface, and duplicating it in a webview is the trap this ADR declines.

The extension is an application, not a library. The rule that every package emits ESM, CJS, and DTS exists so importers can consume a library from any module system; nothing imports an extension — the editor host loads a single CommonJS entry. So `packages/vscode` is the documented exception: one CommonJS bundle from esbuild with `vscode` external, no dual format and no types. It is `private`, never published to npm, and stands outside the six-package version lockstep. It carries its own version line and ships on its own `vscode-v*` tag, so a marketplace outage can't stall the npm release train and a broken npm publish can't hold the extension back. A dedicated workflow packages the `.vsix` once and pushes that one artifact to both Open VSX and the Marketplace.

What the extension cannot promise, it doesn't. "One-click MCP" is literal only on VS Code proper; on the forks it is a config-file write, and the copy says so. Publishing needs credentials NEAT doesn't hold yet — an Azure DevOps token for the Marketplace, an Eclipse Foundation publisher agreement and a claimed namespace for Open VSX — so the code and the CI job land now and the listings light up when a maintainer sets the secrets and pushes the first `vscode-v*` tag, the same way the MCP-registry listing waited on the next tagged release.
## ADR-170 — Zod-as-contract: declared object shapes land on a dedicated InfraNode kind

**Status:** Accepted, implementation pending. Refs #942. Amends [`static-extraction.md`](contracts/static-extraction.md), [`schema.md`](contracts/schema.md). Follows ADR-157 (declared fields as provenanced attributes).

### Context

For apps that treat Zod as the source of truth, the declared shape is invisible to the graph — a `const UserSchema = z.object({...})` is not even a SymbolNode (`collectSymbolDefs` mints `const` only for arrow/function values, not call expressions). The declared field contract, which the developer treats as authoritative, is absent. This ADR fixes the one open design question — where the shape lands — before code.

### Decision

1. A new producer `extract/zod-shapes.ts`, gated on the `zod` dep, reads top-level `z.object({...})`/`z.enum(...)` literals via tree-sitter and names each schema plus its top-level field names. Composed/computed forms (`.extend()`, `.merge()`, `.pick()`, unions, refinements, spreads) are follow-ons or left unclaimed; per-field primitive-type detail is a later grain, not v1 (`ColumnAttr` carries a name, not a type).
2. Each schema is emitted as an `InfraNode` of a new kind `zod-schema`, with its fields as `ColumnAttr`. A dedicated node kind — **not** extending `SymbolKind`, which would ripple into `symbol-edges.ts`, symbol-grain OBSERVED fusion, and `divergences.ts`. `kind` is an open string, so this is zero schema-version change.

### Consequences

- A Zod-source-of-truth app's declared contracts become graph facts, at the same `ColumnAttr` grain as table columns — the foundation for a future declared-vs-observed field comparison.
- Choosing an `InfraNode` kind over a NodeType avoids any collision with the ServerActionNode version bump and keeps this additive.
- EXTRACTED-only for now; no OBSERVED fusion (a runtime `parse()` failure is not observed at field grain today). Field names only in v1; primitive types are a follow-on.

## ADR-172 — More one-command MCP installs: `neat gemini` / `qwen` / `amazonq` / `roocode` / `zed`

**Status:** Accepted. Refs #957. Amends [`cli-surface.md`](contracts/cli-surface.md). Extends the `neat cursor` / `neat devin` verbs (ADR-164) and the editor extension (ADR-171) to the stdio-MCP agent clients NEAT was still absent from.

NEAT installs into Codex, Cursor, and Devin with one command, ships a VS Code / Open VSX extension, and a Claude Code plugin — but the fast-growing agent clients each read a standard stdio MCP config and NEAT is in none of them. Google's Gemini CLI, its Qwen Code fork, the Amazon Q Developer CLI, Roo Code, and Zed are each a single merge away. So NEAT adds a verb per client, each the same shape as `neat cursor`: read the client's own config, splice in NEAT's stdio server under the client's server key, preserve everything else, plan by default and write on `--apply`.

Four of them — `gemini`, `qwen`, `amazonq`, `roocode` — take NEAT's server object verbatim under a `mcpServers` key, so they are descriptor additions over the existing merge; `roocode` writes the project's `.roo/mcp.json` rather than a home-level file, matching how it is meant to be committed. Zed is the one that differs: its servers live under `context_servers` in a JSONC `settings.json` that ships with comments, so NEAT edits that file in place — inserting only `context_servers.neat` and leaving every comment intact — rather than reparsing and rewriting it, and it writes the flat `command`-string shape Zed's current schema expects, not the legacy nested form.

The line NEAT holds is honesty about the target. A verb ships only where the client's config is a single, stable, documented file NEAT can merge without guessing. That rules out Cline and Roo Code's global store — OS-and-editor-variant `globalStorage` blobs their own docs steer you away from hand-editing — and JetBrains AI Assistant, which has no on-disk file at all. Goose keeps a bespoke YAML its docs drive through an interactive command, and Aider has no MCP client to install into; neither gets a verb. OpenCode and Crush expose a stable file but a different server-object shape, and ride a later increment. The graph-first guidance file follows the same rule: it lands where a client's always-on context file is a verified single file, and the verb stays MCP-config-only where it isn't.

## ADR-173 — Ruby/Rails route extraction (the language wave's first pilot)

**Status:** Accepted. Refs #959. Amends [`static-extraction.md`](contracts/static-extraction.md) (new producer, `.rb` service extension). First rung of the Ruby language pilot, following the Python (ADR-151) and Go (ADR-154) pilots. `tree-sitter-ruby` is pinned at `0.21.0` — the only ABI-14 release; the grammar jumps to ABI-15 afterwards, which the pinned tree-sitter runtime can't load.

NEAT reads JavaScript, TypeScript, Python, and Go; Ruby, and the Rails monopoly on top of it, is the next language on the coverage frontier, and the route axis is where Rails fuses most cleanly. The Rails OpenTelemetry instrumentation sets `http.route` to the route's `:id`-form template with the trailing `(.:format)` stripped — `/orders/:id` for a request to `/orders/42` — which is exactly the string a static `config/routes.rb` recognizer produces, and both sides already collapse every `:param` segment to the same key. So route-grain OBSERVED fuses with no normalization gymnastics.

This rung wires the grammar — `.rb` joins the service-file extensions and is parsed with tree-sitter-ruby — and adds a `routes.rb` recognizer that emits a RouteNode per method and path template. It reads the explicit verb routes and `root` from the source directly, and reimplements Rails' resourceful expansion: `resources` into its seven index/new/create/show/edit/update/destroy routes with update landing on both PATCH and PUT, the singular `resource` with its pluralized controller and no id segment, `namespace` contributing a path and a module prefix, `scope` contributing one or the other, `member` and `collection`, and one level of nesting where the parent param is `:<singular>_id`.

What it can't resolve statically, it doesn't fake. routes.rb metaprogramming, split `draw` files, mounted engines, and `constraints` stay unextracted; those routes still appear at runtime, so they read as an honest observed-but-not-declared divergence rather than a wrong RouteNode. The ActiveRecord data axis — schema.rb tables, columns, and foreign keys, and model associations — is the next rung, and file-grain call-site stamping is a later deepening, so this pilot is route and service grain.

## ADR-174 — Ruby/Rails ActiveRecord data axis: schema.rb and models become tables, columns, and foreign keys

**Status:** Accepted. Refs #961. Amends [`static-extraction.md`](contracts/static-extraction.md). Second rung of the Ruby pilot, after ADR-173's Rails routes. Reuses `ColumnAttr` (ADR-157) and `REFERENCES` edges (ADR-161), and mirrors the declared-schema readers for Prisma and Drizzle.

Rung 1 gave a Rails app its HTTP surface; this rung gives it its data surface. Rails declares its schema twice — authoritatively in `db/schema.rb` and behaviourally in the ActiveRecord models — and the first is a goldmine: `create_table "orders"`, `t.string "name"`, `t.references :user, foreign_key: true`, and `add_foreign_key "orders", "users"` are literal table, column, and foreign-key names, matching exactly what the database calls them and what a query's `db.statement` carries at runtime. So NEAT reads schema.rb into `sql-table` nodes, `ColumnAttr` columns, and `REFERENCES` edges — the same types Prisma and Drizzle already produce, so the reasoning core learns nothing Rails-specific.

The models add what the schema can't name on its own: the class-to-table link and the association graph. `class Order < ApplicationRecord` maps to the `orders` table — via `self.table_name` when set, otherwise the ActiveSupport pluralisation as a fallback — and `belongs_to`/`has_many`/`has_one` become REFERENCES edges, honouring `class_name:`/`foreign_key:`/`table_name:` overrides. schema.rb is the anchor because its names are literal; the pluraliser is only a fallback for a model with no schema entry, since Rails' inflector is a different ruleset from the one NEAT's Mongoose recogniser uses and is user-extensible in ways a static reader can't see.

The OBSERVED half fuses on the table name, but only if the app instruments its database adapter: Rails' `active_record` instrumentation emits no SQL, so table-grain runtime edges come from the `pg`/`mysql2` adapter's `db.statement` — a deployment fact this rung documents, not a code dependency. What schema.rb doesn't cover — the `structure.sql` schema format, `has_and_belongs_to_many` join tables, `has_many :through` — is deferred and reads as honest absence, not a guess.

Consequences: a Rails app's tables, columns, and foreign keys join the graph at the same grain as every other ORM NEAT reads, walkable by the same data-axis queries; combined with rung 1's routes, a Rails service now has both its HTTP and data surfaces EXTRACTED.

## ADR-175 — The PlanetScale connector reads Query Insights and fuses onto table grain

**Status:** Accepted. Refs #963. Amends [`connectors.md`](contracts/connectors.md) and [`connector-config.md`](contracts/connector-config.md). Clones the Supabase/Neon data-grain pull connector (ADR-124) and adds a `PROVIDER_DISPATCH` entry.

NEAT's data-grain connectors read a hosted database's own query telemetry and fuse it onto the `sql-table` nodes the extractor already builds. PlanetScale exposes exactly that through its Query Insights API, and more cleanly than the `pg_stat_statements` path Supabase and Neon use: each query fingerprint comes back with its tables already parsed and its query count already windowed to the poll interval, so the connector needs neither the FROM-clause regex nor the cumulative-counter delta bookkeeping those two require.

`neat connector add planetscale` polls the branch insights endpoint with a read-only `read_database` service token, once per cadence over the shared junction layer, and turns each query row into an observed signal per table it touched — call count, error count, and the provider's own last-run time as the observation instant. Each signal resolves onto the existing `sql-table` node the SQL or ORM extractor minted from application code, minting an OBSERVED CALLS edge that sharpens to file grain wherever that node carries a real file and line; where no such node exists yet, the signal stays honestly at the provider level rather than fabricating a table.

The credential is the narrowest PlanetScale grants — a per-database `read_database` service token, read-only, stored opaque and never written to the snapshot, and sent in PlanetScale's non-Bearer `id:token` header form — and the connector has no mutation authority, like every other. The honest ceiling is table grain: Insights aggregates per query fingerprint, so there is no row or column grain, and file grain only appears transitively. One caveat this decision records rather than hides: PlanetScale is a paid product with no free tier, so the exact insights payload shape is taken from the API reference and must get the same confirm-the-response-not-the-pitch treatment (ADR-150, ADR-152) against a real branch before the connector is trusted in production.

## ADR-176 — `neat opencode` / `neat crush`: the second wave of one-command MCP installs

**Status:** Accepted. Refs #965. Amends [`cli-surface.md`](contracts/cli-surface.md). Extends the `neat gemini` / `qwen` / `amazonq` / `roocode` / `zed` verbs (ADR-172) to the two terminal agents that ADR-172 named and set aside for a different server-object shape.

ADR-172 wired NEAT into five stdio-MCP clients and called out the two it left for later: OpenCode and Crush each keep a stable, documented config file, but describe an stdio server differently from the clients whose entry is the flat `{ command, args }`. They get the same treatment now — one verb each, the shape of `neat cursor`: read the client's own config, splice NEAT's server under the client's key, preserve everything else, plan by default and write on `--apply`.

Both nest MCP servers under an `mcp` key, and both take NEAT's server keyed as `neat` — but the object differs, and that difference is the whole design question this ADR settles. OpenCode wants `{ "type": "local", "command": ["npx", "-y", "@neat.is/mcp"], "enabled": true }`, where the command is an array under `type: "local"`. Crush wants `{ "type": "stdio", "command": "npx", "args": ["-y", "@neat.is/mcp"] }`, an explicit `type: "stdio"` with a string command and `args`. So the descriptor gains one optional field — a per-client server entry — defaulting to the flat object the other seven clients already take. The merge is unchanged: spread the existing config and the existing container, set only the `neat` key, no-op when it already matches; it just reads the entry off the descriptor instead of a module constant. The seven shipped verbs inherit the default and are untouched.

Both configs are plain JSON at `~/.config/opencode/opencode.json` and `~/.config/crush/crush.json` (`$XDG_CONFIG_HOME`-aware, each with a project-level file of the same shape), so the existing JSON merge does the work once it reads the container key and the per-client entry. Both read `AGENTS.md` as an always-on instructions file, so the graph-first guidance lands there — the same agent-agnostic block `neat codex` writes, marker-fenced so a re-run replaces only NEAT's block. Each verb keeps a `NEAT_OPENCODE_CONFIG` / `NEAT_CRUSH_CONFIG` env override so tests never touch a real file.

Continue.dev is the one still held back: it keeps a YAML config written by dropping a file into a directory rather than merging one in place — a different write mode that rides its own increment. The honesty line from ADR-172 stands — a verb ships only where the client's config is a single, stable, documented file NEAT can merge without guessing, and the guidance file lands only where the always-on context file is one verified file — and the GUI-only and no-MCP-client clients ADR-172 named (Cline, JetBrains AI Assistant, Goose, Aider) stay out.

## ADR-177 — PHP/Laravel route extraction (the language wave, PHP pilot)

**Status:** Accepted. Refs #967. Amends [`static-extraction.md`](contracts/static-extraction.md) (new producer, `.php` service extension). PHP is the next language after the Ruby pilot (ADR-173, ADR-174). `tree-sitter-php` is pinned at `0.21.1` — the newest ABI-14 release; `0.22`+ is ABI-15 and won't load against the pinned tree-sitter runtime. The npm package is already split into `{ php, php_only }` grammars, and this extractor parses pure-PHP source (controllers and route files, no HTML islands) with `php_only`.

NEAT reads JavaScript, TypeScript, Python, Go, and Ruby; PHP — Laravel and Symfony — is the next ecosystem on the coverage frontier, and this rung takes Laravel, the framework whose runtime and static pictures line up cleanly. Laravel's OpenTelemetry auto-instrumentation sets `http.route` to the route's templated URI (`orders/{id}` for a request to `/orders/42`, without a leading slash), and NEAT's route normalizer already reduces that to the same key it derives from the static route — the leading slash and the `{id}` parameter both fall out in normalization — so Laravel route-grain OBSERVED fuses with no ingest change.

The recognizer reads `routes/web.php` and `routes/api.php` and emits a RouteNode per method and normalized template: the explicit `Route::get`/`post`/… verbs, the group composition that wraps them (`prefix`, `controller`, `name`, `middleware` via `->group()`), the automatic `/api` prefix Laravel prepends to `api.php`, and the resourceful `Route::resource`/`apiResource` expansion into its seven (or five) routes with the singularized route parameter — the convention the source text never spells out. The singular parameter is for the declared view only; fusion collapses any `{param}` to the same key, so it never turns on getting the pluralizer exactly right.

Symfony is a deliberate non-goal of this rung, and the reason is the fusion key. Symfony's auto-instrumentation sets `http.route` to the internal route name (`order_show`), not the path, and puts only the concrete path in `url.path` — so a Symfony span carries the templated path nowhere. Fusing Symfony needs the extractor to emit the composed route name as a first-class join key and the ingest to join on it, a mechanism the JS, Python, Go, and Ruby extractors never needed; extracting Symfony routes without it would mint RouteNodes that never fuse and read as false missing-observed divergences. So Symfony — attributes plus the name join, done whole — is its own later rung, as are the PHP data axis (Doctrine attributes, Eloquent convention) and file-grain call-site stamping.

## ADR-178 — PHP/Laravel data axis: migrations and Eloquent become tables, columns, and foreign keys

**Status:** Accepted. Refs #969. Amends [`static-extraction.md`](contracts/static-extraction.md). Rung 2 of the PHP pilot, after ADR-177's Laravel routes. Reuses `ColumnAttr` (ADR-157) and `REFERENCES` edges (ADR-161), and mirrors the Rails ActiveRecord reader (ADR-174) and the Prisma/Drizzle declared-schema readers.

Rung 1 gave a Laravel app its HTTP surface; this rung gives it its data surface. Laravel declares its schema literally in `database/migrations`, and that is the anchor the same way Rails' `db/schema.rb` is: a `Schema::create('orders', function (Blueprint $table) { … })` names the table, and the `$table->` calls inside name the columns — `$table->string('code')`, `$table->id()`, `$table->timestamps()` — all as the exact strings the database uses. So NEAT reads those into `sql-table` nodes and `ColumnAttr` columns, and mints `REFERENCES` edges from the literal foreign-key forms: `$table->foreignId('user_id')->constrained()` (parent by the `<name>_id` convention, or the explicit `constrained('accounts')` argument), `$table->foreignIdFor(User::class)`, and `$table->foreign('buyer_id')->references('id')->on('buyers')`. A bare `foreignId` with no `->constrained()` is a column only and mints no edge; a computed or unresolvable target is left unclaimed.

The Eloquent models corroborate. `class Order extends Model` links to its table — via `protected $table` when set, otherwise the snake-case pluralization of the class name, a fallback only since the migration literal already anchors the node — and `belongsTo`/`hasMany`/`hasOne` become `REFERENCES` edges, deduped against the migration foreign keys so a relationship declared on both sides collapses to one edge. `belongsToMany` pivot synthesis and `hasManyThrough` are deferred, as are Doctrine (which rides the Symfony rung) and file-grain. The OBSERVED half fuses on the table name through the DB adapter's `db.statement` — a deployment fact, not a code dependency — and the literal migration names line up with it, the same way every other ORM NEAT reads does.

## ADR-179 — Ingest reads the new OTel database semconv, and a direct table attribute

**Status:** Accepted. Refs #971. Amends [`otel-ingest.md`](contracts/otel-ingest.md). Extends the table recovery of ADR-152.

NEAT's table-grain fusion recovered the table from `db.statement` alone (ADR-152), because the SQLAlchemy and dbapi instrumentations that motivated it emit no table attribute. But the OpenTelemetry database semantic conventions have since stabilized and renamed the keys — `db.statement` became `db.query.text`, `db.sql.table` became `db.collection.name`, and `db.system` became `db.system.name` — and the current ORM plugins emit the new names. The official GORM plugin (v0.1.13 and up) is the case that forced the change: it emits `db.query.text` and `db.collection.name`, neither of which the ingest read, so a modern GORM app's queries fused onto nothing.

So `parseOtlpRequest` now reads both semconv families. The SQL text is taken from `db.statement` or `db.query.text`. The table is taken from a direct attribute when the instrumentation emits one — `db.sql.table`, or `db.collection.name` on a relational system — which is the ORM's own resolved table name and more reliable than parsing the SQL, since it doesn't degrade on `SELECT *`, joins, or CTEs; it falls back to `tableFromSqlStatement` on the SQL text otherwise. `normalizeDbSystem` reads `db.system` or `db.system.name`, so the mongodb guard still holds and a mongodb span's `db.collection.name` stays a collection, never a table. The change is additive and upgrades every ORM whose instrumentation moved to the new semconv, not only GORM — and it is the prerequisite for the Go GORM data axis fusing at all.

## ADR-180 — Go gains a data axis: GORM structs become tables, columns, and foreign keys

**Status:** Accepted. Refs #974. Amends [`static-extraction.md`](contracts/static-extraction.md). The data rung for Go, after ADR-154's routes and `database/sql` call sites. Reuses `ColumnAttr` (ADR-157) and `REFERENCES` edges (ADR-161), and mirrors the Rails ActiveRecord reader (ADR-174) and the Laravel Eloquent reader (ADR-178) — `calls/gorm.ts` is to a GORM struct what `calls/activerecord.ts` is to an ActiveRecord model.

Go could see its routes and its raw SQL but not its schema: a GORM app's models never became `sql-table` nodes, so blast-radius, dependencies, and divergence couldn't walk its data. This rung reads GORM model structs — a struct that embeds `gorm.Model`, is passed to `db.AutoMigrate`/`Model`/`Create`/`Find`/`First`/`Where`, declares a `TableName()` method, or is referenced as a relation by another model — into `infra:sql-table:<name>` nodes carrying their columns as `ColumnAttr`s: each scalar field snake-cased (or the `gorm:"column:x"` override verbatim), `gorm.Model` expanded to `id`/`created_at`/`updated_at`/`deleted_at`, an anonymous embedded local struct inlined, `gorm:"-"` skipped, and a struct- or slice-of-struct-typed field excluded as a relation while its `<Field>ID` companion scalar stays a column. Associations become `REFERENCES` edges: belongs-to (the struct holds the `<Field>ID` FK) points this table at the association's; has-one and has-many put the FK on the other table; `many2many:` synthesizes the join table with an edge to each side. belongs-to/has-one/has-many first; `many2many` is included; cross-file type resolution beyond `AutoMigrate`, cross-package relations, and file-grain call-site stamping are best-effort or deferred.

The load-bearing difference from Rails and Laravel is the fusion key. Rails' `schema.rb` and Laravel's migrations spell the table and column names out as the exact database strings, so the literal is the anchor and the pluralizer there is a corroborating fallback whose wrong guess costs only a missed edge. GORM has **no literal schema file**: the table name is DERIVED from the struct name by `schema.NamingStrategy.TableName` = `inflection.Plural(toDBName(name))`, so the derivation IS the node identity and a wrong plural mints a table node the runtime never creates — a **false** node, not a missed edge. So `calls/gorm.ts` reproduces GORM's own naming byte-for-byte: `toDBName` is the initialism-aware CamelCase→snake port (the golint `commonInitialisms` are replaced Title-case before snake-casing, so `APIKey` → `api_key`, not `a_p_i_key`, and `LineItem` → `line_item`), and `Plural` reproduces `github.com/jinzhu/inflection` — uncountables (`series`, `equipment`) unchanged, irregulars (`person`→`people`, `child`→`children`), and the ordered rules (`-y`→`-ies`, `-s/-x/-ch/-sh`→`-es`). The irregular and initialism sets are finite and GORM-version-sensitive, so they are a documented best-effort; the OBSERVED table is the ground truth. That OBSERVED table arrives as `db.collection.name` from the GORM OpenTelemetry plugin — the new-semconv attribute PR #972 (ADR-179) just taught ingest to read into the table key — and it carries `tx.Statement.Table`, GORM's own resolved name, which is exactly the string the derivation aims at. So an extracted GORM table fuses onto `infra:sql-table:<name>` by table name the same way every other ORM NEAT reads does, and where the derivation is wrong the divergence surfaces the miss rather than hiding it. `TableName()` literal overrides are honored; `db.Table(...)` per-call and a global `NamingStrategy{TablePrefix, SingularTable}` fall back to the derived name.

## ADR-181 — Echo and Fiber join Go's route recognizers

**Status:** Accepted. Refs #973. Amends [`static-extraction.md`](contracts/static-extraction.md) (Echo + Fiber added to the Go route producers). NEAT read Go routes from Gin only; Echo and Fiber are the two other frameworks a Go HTTP service is most likely to use.

All three declare their route table the same way: a router value carries an HTTP-verb method whose first argument is the path, and `Group("/prefix")` returns a sub-router that composes a prefix onto everything registered on it. At the Go AST that is a single grammar — a `call_expression` on a `selector_expression` — with the verb differing only in casing (Gin and Echo upper-case `GET`, Fiber title-cases `Get`), which the recognizer's lower-cased method check already absorbs. So rather than clone the Gin reader twice, the walker becomes one framework-keyed reader that Gin, Echo, and Fiber are thin wrappers over; each stamps its own label and is gated on its own `go.mod` require (`github.com/labstack/echo/v4`, also the pre-modules `.../echo`, for Echo; `github.com/gofiber/fiber/v2` or `/v3` for Fiber). Group variables are tracked the way the receiver var already was, and now compose across nesting — `v1 := admin.Group("/v1")` reaches `/admin/v1` — which the single-level Gin tracker didn't do, so Gin gains multi-level composition for free.

Fusion needs no ingest change, and that is the reason to take these two now. Echo's `otelecho` sets `http.route` from `c.Path()`, and Fiber's `otelfiber` (v2) and its v3 middleware set it from `c.Route().Path` — both the group-composed templated route, the same string the recognizer emits. Echo's `:id` and Fiber's `:id` collapse to `:param` through `normalizePathTemplate`; Fiber's optional-param `:id?` drops its `?` at canonicalization (a query delimiter there, and the readable form the Laravel `{id?}` rung already chose) yet still reduces to `:param`, so the extracted `:id` and an observed `:id?` land on one key; a bare `*` wildcard stays literal on both sides and still matches. Route-param type constraints (Echo/Fiber's typed `:id` syntax), `Static` and middleware-only mounts, and routes registered dynamically in loops are deferred — those surface as observed-but-not-declared divergence rather than a fabricated node.

## ADR-182 — Chi and net/http complete Go's route coverage

**Status:** Accepted. Refs #977. Amends [`static-extraction.md`](contracts/static-extraction.md) (Chi + net/http added to the Go route producers). Gin, Echo, and Fiber (ADR-154, ADR-181) left two of the most common Go HTTP surfaces dark: Chi, and Go 1.22's own `net/http` ServeMux. This rung reads both.

**net/http is the cleaner of the two, and a genuinely new gating shape.** Go 1.22 taught `ServeMux` to carry the method and the path template in one string literal — `mux.HandleFunc("GET /orders/{id}", h)`, and the `http.HandleFunc` / `mux.Handle` / `http.Handle` variants — so the recognizer reads the first string-literal argument, splits on the first space, and emits a route only when the leading token is an HTTP method AND the remainder starts with `/`. The problem it poses is that `net/http` is stdlib: there is no `go.mod` require to key on the way every other route producer keys on its framework dependency. So the gate is structural instead — the file must `import "net/http"`, and only the method-prefixed pattern shape mints a route. That method-token-plus-leading-slash precision is doing the real work: it's what tells a route registration apart from a generic `HandleFunc("literal", h)` on some unrelated value, and it's why the pre-1.22 bare-prefix form (`mux.HandleFunc("/orders/", h)` — no method, a coarse subtree, and the biggest false-positive source) is deliberately left out rather than read at a grain that would never fuse cleanly. `{id}` single segments, `{path...}` multi-segment wildcards, and the `{$}` end-anchor all collapse to `:param` under `normalizePathTemplate` with no special casing. Fusion is automatic but version-gated, and the honesty is in naming the gate: Go 1.23's `Request.Pattern` plus otelhttp ≥ v1.36 set `http.route` to the path-only template (method stripped), exactly the stored string, so it fuses with no ingest change — but on an older stack `http.route` is absent and the node stays EXTRACTED-only. That is a real limit, documented, not papered over.

**Chi reads verbs like Fiber but composes prefixes unlike anything before it.** Its verbs are title-cased `r.Get/Post/Put/Patch/Delete` on a router value, first argument the path — the same read the Gin/Echo/Fiber walker does, gated on `github.com/go-chi/chi/v5` (also the pre-modules `.../chi`). What's new is the prefix. Gin/Echo/Fiber name a sub-router (`admin := r.Group("/admin")`) and the prefix follows that variable; Chi's `Route("/articles", func(r chi.Router){ … })` has no assignment at all — the prefix is lexically scoped to the closure body, and the inner `r` shadows the outer. A variable map can't express that, so the Chi walker carries a **prefix stack**: a `Route(strLit, funcLit)` pushes the literal, recurses into the `func_literal` body, and pops on return, so nested `Route`s compose (`/articles` + `/{articleID}` → `/articles/{articleID}`). Chi's `Group(func(r chi.Router){ … })` is distinguished from a path group by its argument shape — a closure, not a string — and is middleware grouping, so it contributes no prefix and just recurses. Inline regex constraints (`{id:[0-9]+}`) strip to `{id}` for a clean stored template, though `normalizePathTemplate` would collapse either form to `:param`. **Chi's fusion is conditional, and that is the load-bearing caveat.** It fuses only under `otelchi` (`github.com/riandyrn/otelchi`), which reads `chi.RouteContext(r).RoutePattern()` — the composed template — into `http.route`, the same path-only shape echo's `c.Path()` and fiber's `c.Route().Path` produce. Under bare `otelhttp` a Chi app sets no `http.route` at all, because Chi never populates `r.Pattern`; those RouteNodes stay EXTRACTED-only with nothing to land on.

Two deferrals are explicit. Chi's `Mount("/admin", handler)` composes no route: the mounted sub-router is almost always built in another func or file, the same cross-func/cross-file resolution Express `app.use` needed before ADR-160 gave it a whole-program pass. Skipping it costs one fused edge — otelchi emits the full composed `/admin/...` path at runtime, so an observed span there won't land on the bare inner route — which is the honest partial, not a fabricated `/admin` node. And net/http's bare-prefix registrations, Chi's generic `Method`/`MethodFunc` helpers, host-prefixed net/http patterns, and routes registered dynamically in loops are all left for later — each surfaces as observed-but-not-declared divergence rather than a guessed node.

## ADR-183 — Generated hooks export to the project-scoped OTLP path, not the bare one

**Status:** Accepted. Refs #879. Amends ADR-096 and [`one-command-cli.md`](contracts/one-command-cli.md) / [`sdk-install.md`](contracts/sdk-install.md) / [`framework-installers.md`](contracts/framework-installers.md). ADR-096's core — one daemon per project, `daemon.json` self-description, stable port reuse, no shared coordination registry — is unchanged. This refines only the OTLP path the generated instrumentation exports to.

**The bug.** A by-the-book `neat init --apply` pointed every generated artifact — `instrumentation.node.{ts,js}` (both the daemon.json-discovery branch and the fallback), `instrumentation.edge.{ts,js}`, and `.env.neat` — at the **bare** `http://localhost:<otlp>/v1/traces`. On that path the daemon routes by matching the span's `service.name` against the project registry, a heuristic that silently mis-routes or drops the span whenever the name doesn't resolve cleanly (case skew, a `deployment.environment` suffix forking the service id, #880). A pilot on a third-party Next.js + Supabase app reported spans reaching the daemon and minting nothing, with the query surface (`observed-dependencies`) actively suggesting OTel wasn't running when it was. Every documented precondition was satisfied; only the path was wrong.

**The decision.** The generated hooks export to the **project-scoped** `http://localhost:<otlp>/projects/<project>/v1/traces`. That route dispatches by the URL path — a direct slot lookup — so the owning project is named explicitly, not guessed from `service.name`. The port still resolves from `daemon.json` (the ADR-096 anti-darking mechanism, untouched: a second project's app still finds its own daemon's stepped port rather than colliding on a baked 4318), and the project name comes from the **same** `daemon.json` record, so scope and port always agree. The static fallback and `.env.neat` bake the project name at apply time (the `__PROJECT__` placeholder the renderers already substitute); the edge file, which can't walk `daemon.json` under the Edge runtime, bakes both name and canonical port.

**Why this is strictly better on the darking axis ADR-096 cared about.** Under the old bare fallback, a second project's app that failed to find `daemon.json` and fell back to `:4318` would land on the first project's daemon and be silently quarantined (or, worse, fuzzy-matched into the wrong graph). Under the scoped fallback the same span hits `/projects/<other>/v1/traces` on a daemon that doesn't host `<other>` and gets a loud `404` (#881) instead of a silent drop. A misconfigured exporter now finds out. The single-project daemon keeps the OBSERVED-never-dark guarantee for the cold-start window: a scoped span for the sole project it hosts counts as registered even before initial extraction finishes, and the receiver builds the slot on demand rather than 404-ing a span it definitionally owns.

The bare `/v1/traces` route stays mounted and lenient (existing exporters, hand-rolled OTel, and collectors that target it keep working, routed by `service.name` as before) — it is no longer what NEAT *generates*.

## ADR-184 — Go's raw-SQL data axis: `database/sql` and `sqlx` call sites become tables and columns

**Status:** Accepted. Refs #994. Amends [`static-extraction.md`](contracts/static-extraction.md). The raw-SQL rung for Go, beside ADR-180's GORM reader — the columns-aware, import-gated successor to the minimal `database/sql` call-site seed ADR-154 shipped. Reuses `ColumnAttr` (ADR-157) and, for the fusion key, the OBSERVED SQL-parse helpers (ADR-152), landing on the same `infra:sql-table:<name>` node every ORM NEAT reads produces. ADR-154's route half and ADR-180's GORM reader stand unchanged; this replaces only the seed's SQL-call-site body.

GORM gave Go a data axis, but plenty of Go services skip the ORM and hand `database/sql` or `github.com/jmoiron/sqlx` a literal SQL string. ADR-154 already matched the six base `database/sql` methods, but only just: it was ungated (any Go string that happened to parse as SQL minted a table), it read argument 0 blindly (so every `*Context` variant, whose first argument is a `ctx`, silently missed its SQL), it covered none of the sqlx surface, and it emitted no columns — so a service that reads its tables through raw SQL showed up thin or not at all. `calls/go.ts` now reads the full statement-taking surface: `database/sql`'s `Query`/`QueryContext`/`QueryRow`/`QueryRowContext`/`Exec`/`ExecContext`/`Prepare`/`PrepareContext`, plus sqlx's `Get`/`Select`/`Queryx`/`QueryRowx`/`NamedExec`/`NamedQuery`/`MustExec`/`Preparex`/`GetContext`/`SelectContext`. The SQL is the **first string-literal argument**, not a fixed position — that one rule skips a leading `ctx` on the `*Context` calls and the destination pointer sqlx's `Get(&u, "…")` / `Select(&xs, "…")` take, and it reads both the interpreted `"…"` and the raw backtick `` `…` `` form since multi-line backtick SQL is idiomatic. A statement that isn't a static literal — a `fmt.Sprintf(…)` or a `base + " WHERE …"` concatenation — is a call/binary expression, not a string literal, so nothing matches and the call site is left unclaimed rather than guessed. Each matched statement runs through `tableFromSqlStatement` → the table and `columnsFromSqlStatement` → the touched columns, folded onto the table node as `ColumnAttr`s (ADR-157 §3) the same way the ORM readers fold theirs; a statement whose table doesn't resolve (a JOIN, a multi-`FROM` subquery) is skipped, never guessed.

The load-bearing part is the fusion key, and the whole reason this is worth shipping over a static-only table list (which is what other tools already do): the OBSERVED side has no dedicated table attribute — the `database/sql` / pgx instrumentation puts the statement in `db.statement` (semconv ≤ 1.10) or `db.query.text` (≥ 1.30), and ingest recovers the table by running `tableFromSqlStatement` on that text (ADR-152). So this recognizer runs the **exact same** `tableFromSqlStatement` / `columnsFromSqlStatement` helpers on the **same** SQL — no second parser — which makes the extracted table name byte-identical to the observed one, so an extracted `db.Query("… FROM users")` and the runtime span for that query fuse on `infra:sql-table:users` instead of twinning. The whole reader is gated on a structural import check the way the net/http route recognizer (ADR-182) is: recognize only in a file that imports `database/sql` and/or `github.com/jmoiron/sqlx`, so an arbitrary Go string literal never mints a table. The sqlx-only methods are gated on the sqlx import specifically; the base `database/sql` methods are read under either import, since a `*sqlx.DB` embeds `*sql.DB` and answers them too. Cross-file prepared-statement handles, query-builder chains (squirrel, goqu), and statements assembled at runtime are deferred — each is a computed statement the never-guess bar leaves unclaimed, surfacing as observed-but-not-declared divergence rather than a fabricated node.

## ADR-185 — EAS build failures as OBSERVED, commit-grain incidents on the repo

**Status:** accepted · **Refs:** #996 · **Contracts:** connectors.md §10, connector-config.md §7.1

Parsing `eas.json` / `app.json` as static infrastructure is weak — build *config* emits no runtime signal, so there is nothing for it to fuse with, and it clears no bar static tools don't already clear. But an EAS build **failure** is a genuine OBSERVED event about the repo: it ran real code at a real commit and broke. Tracing that failure back to the source node that caused it — so an agent can query it and fix it — is NEAT's root-cause query pointed at a new failure domain, CI builds. The signal is runtime, and the join back to source is exact (a commit hash), so it fuses rather than sitting as inert config. The loop this enables: an EAS build errors, NEAT pulls it, maps it to the repo node the failure implicates, and the agent reads `get_incident_history` / `get_root_cause` over MCP and fixes the cause in the repo.

NEAT pulls `ERRORED` builds from the Expo GraphQL API (`POST https://api.expo.dev/graphql`, a robot-user `EXPO_TOKEN` bearer) and mints one OBSERVED build-failure incident per build, anchored to the commit it ran (`gitCommitHash`) and — where `error.buildPhase` allows — to the specific repo node that failed. `buildPhase` is a strict enum, so it is the deterministic classifier: config and dependency phases (`READ_PACKAGE_JSON` / `INSTALL_DEPENDENCIES`, `READ_APP_CONFIG`, `READ_EAS_JSON`, the expo-updates phases) map onto the ConfigNode or ServiceNode the extractor produces for those files, and native-compile phases (`PREBUILD`, `RUN_GRADLEW`, `INSTALL_PODS`, `RUN_FASTLANE`, the Xcode phases) anchor to the app's ServiceNode with the build logs attached for the agent to read. `status` and `buildPhase` are the only stable classifiers; `error.errorCode` is free-text and is treated as a hint handed to the agent, never a strict switch.

This is the first **incident-emitting** connector. The request-log connectors (Railway, Cloud Run, Render) fuse traffic onto a RouteNode at route grain; EAS has no route — a build ran the whole repo at one commit — so it fuses at **commit grain** and lands an `ErrorEvent` on the project's incident ledger (`errors.ndjson`) instead of an edge. It reuses the exact incident model OTLP-derived failures use — the same ledger, the same `affectedNode` resolution through `resolveFusedServiceId` (#988/#992) so the incident lands on the extracted node, not a connector twin — via a single new `ingest.ts` primitive (`appendConnectorIncident`) called from the shared pipeline; the connector module writes nothing itself (ADR-030 mutation authority holds). Because the extractor did not previously mint nodes for JSON build-config files, this ships a small, curated JSON-config extraction (`app.json`, `app.config.json`, `eas.json`) so the config-phase incidents have a real extracted node to fuse onto; `package.json` stays represented by its ServiceNode (it already is one, and recognizing it globally would churn every project's graph), so dependency-phase incidents anchor there.

Three honesty guardrails are load-bearing. First, infra / credentials / transient failures mint nothing: an EAS outage comes back wearing the same `ERRORED` status as a real bug, so the `SPIN_UP_BUILDER` / `PREPARE_CREDENTIALS` / `RESTORE_CACHE` / internal phases and `INTERNAL_SERVER_ERROR`-class codes are excluded — a provider outage must never become a repo divergence. Second, `isGitWorkingTreeDirty` tags the incident lower-confidence, because a dirty-tree build's commit hash doesn't fully represent what built. Third, the Expo GraphQL API is undocumented and unversioned, so the query set is pinned and a schema/shape error surfaces as a loud connector error rather than silently dropping builds — and NEAT writes its own query selecting `error { buildPhase errorCode message docsUrl }` rather than shelling to `eas build:view --json`, whose fragment omits `buildPhase`. Logs come from `Build.logFileUrls` (time-limited signed URLs, and Xcode logs can reach ~10MB), so they are fetched on the poll and stored size-capped in the incident, never referenced by a URL that will expire.

v1 is Build only — not EAS Update or Submit — and does not parse native build logs into `file:line` (that fuzzy Gradle/Xcode tier is deferred); NEAT surfaces the failure and the logs, and the agent fixes.
## ADR-186 — Ruby and PHP gain auto-instrumentation installers

**Status:** Accepted. Refs #997. Amends [`installer-scope.md`](contracts/installer-scope.md) (Ruby/Rails and PHP/Laravel join the in-scope set) and [`sdk-install.md`](contracts/sdk-install.md) (two new language rows). The instrumentation half of the Ruby and PHP support whose extraction half already landed — Rails routes (ADR-172) and its ActiveRecord data axis (ADR-174), Laravel routes (ADR-177) and its Eloquent data axis (ADR-178). Until now those two languages were static-only: the extractor read their routes and tables, but `INSTALLERS` was `[javascript, python, go]`, so nothing wired the app to emit OTel, and the OBSERVED layer that fusion depends on stayed empty. This closes that gap the same way ADR-047/069 (Node), ADR-151 (Python), and ADR-154's Go installer did — one `detect / plan / apply` module per language, plan pure data so `init --dry-run` renders a reviewable patch, apply the codemod, manifests touched and lockfiles never.

**Ruby is the clean case, and it reaches file grain.** `installers/ruby.ts` detects a `Gemfile`, adds `opentelemetry-sdk`, `opentelemetry-exporter-otlp`, and the `opentelemetry-instrumentation-all` meta-gem (which pulls Rails, ActiveRecord, Net::HTTP, PG, and the rest, so a Rails app gets route and DB spans without naming each instrumentation gem), and for a Rails app generates `config/initializers/neat_otel.rb`. Rails requires everything under `config/initializers/` at boot, so the initializer is convention-loaded — there is no entry-point injection to do, the same shape Go's same-package `init()` and Nuxt's `server/plugins/` convention already take. The initializer calls `OpenTelemetry::SDK.configure` with `use_all`, points the OTLP exporter at NEAT's project-scoped `/projects/<project>/v1/traces` path (ADR-183, overridable through the standard OTel env vars), and installs a `NeatCallSiteSpanProcessor` whose `on_start` walks `caller_locations` to the first application frame — under the app root, not in `vendor/` or `.bundle/` — and stamps `code.file.path` / `code.line.number` / `code.function.name` on CLIENT/PRODUCER spans. That is the Ruby analog of the Go `runtime.Callers` processor and the Python `sys._getframe` one (ADR-151): an absolute call-site path that ingest anchors against the service root, so a runtime DB or HTTP-client span fuses onto the source file that issued it instead of stopping at route/service grain. SERVER spans are created before the handler runs, so they stay route/service-grained, honestly. The whole file degrades to a no-op when the gems aren't installed (the ADR-144 discipline), and `NEAT_CALLSITE_DISABLED=1` turns the processor off. `Gemfile.lock` is never written; after `--apply` the user runs `bundle install` so bundler owns the lockfile.

**PHP lands route/table/service grain, and the honesty is in what it can't do.** `installers/php.ts` detects a `composer.json`, adds `open-telemetry/sdk`, `open-telemetry/exporter-otlp`, and `php-http/guzzle7-adapter` (the PSR-18 client the OTLP exporter discovers; Laravel already ships Guzzle), plus `open-telemetry/opentelemetry-auto-laravel` for a Laravel app, and generates a `neat_otel.php` bootstrap that points the exporter at NEAT's project-scoped path and turns on the zero-code SDK autoloader (`OTEL_PHP_AUTOLOAD_ENABLED`). composer.json is strict JSON, so the apply merges the new packages into `require` by parse → add-missing-keys → re-serialize, preserving every sibling key (name, type, `require-dev`, autoload); `composer.lock` joins the never-touch set beside `Gemfile.lock` and `go.sum`.

The load-bearing caveat, stated plainly rather than papered over: **PHP OpenTelemetry auto-instrumentation is driven by the `opentelemetry` PECL extension** — a system-level `pecl install opentelemetry` + `extension=opentelemetry.so` in php.ini that NEAT cannot perform through composer. Without it the auto-laravel hooks never fire and no spans are produced. So the installer *plans* the requirement and surfaces it in four places — the generated file's header, the recommended env, the `ApplyResult.reason`, and an apply-time warning — but never claims composer alone instruments PHP. And **PHP file grain is a deferred follow-up**, not shipped. Ruby and Go stamp `code.file.path` from a call-site span processor they register on a tracer provider they can reach; the PHP equivalent would inject a custom processor into the *zero-code autoloaded* SDK, a hook whose behavior can't be verified without a live PHP + PECL runtime to test against. Shipping an unverified registration that might silently never fire is exactly the flaky outcome the never-guess bar rejects, so PHP takes route, table, and service grain now — enough to fuse onto the extracted Laravel routes and Eloquent tables — and file-grain call-site attribution waits for a validated hook. Both installers are registered in `installers/index.ts`; each keys on a distinct marker (`Gemfile` → Ruby, `composer.json` → PHP), so `pickInstaller` routes without ambiguity.

**Addendum — the post-apply install is now language-aware, which also fixes Go.** The apply phase (`applyInstallersOver`) used to schedule the JS package manager whenever a plan carried dependency edits, and `package-manager.ts` only knows `bun`/`pnpm`/`yarn`/`npm`, defaulting to `npm install` when no JS lockfile is found. So `neat init --apply` on a Ruby, PHP, or Go repo wrote the Gemfile/composer/go.mod edits and then spawned `npm install` in that directory — npm walks up to any ancestor `package.json`, so in a polyglot monorepo it would install the root JS deps while the real Gemfile/composer/go dependencies stayed unresolved with nothing telling the operator to run `bundle`/`composer`/`go`. The dispatch now keys on the manifest basename of the dependency edits: `package.json` runs the JS package manager as before; `Gemfile`, `composer.json`, and `go.mod` skip it and surface the native command each installer reports on its `ApplyResult.followUpInstall` (`bundle install`, `composer install`, `go mod download`) through the orchestrator's `dependencyInstructions` tally — instruct, don't execute, since NEAT can't guarantee those toolchains are on PATH. Only the JavaScript case spawns a process. This corrects the Go installer's behavior too (it shipped in ADR-154 with the same spurious npm path), and amends [`sdk-install.md`](contracts/sdk-install.md)'s post-apply-install section.
## ADR-187 — neat-action becomes a verdict, driven by the OBSERVED layer

**Status:** accepted · **Refs:** #1002 · **Contracts:** none (`packages/action` is ungoverned)

The graph-impact comment listed what a PR changed in the graph and let the reviewer judge it. A reviewer facing a route deletion still had to answer the one question that matters — *is anything actually calling this in production?* — and the comment couldn't help, because that answer lives in the OBSERVED layer, not the diff. When the Action is pointed at a connected NEAT host (`neat-api-url`, any daemon serving `/graph/*`), it now answers that question and leads with the answer: a **verdict-first** report, ranked worst-first, so the reviewer reads the conclusion before the evidence.

The load-bearing definition is the **observed break**. For every node the PR removes or changes, the Action asks the host what production does with it — `GET /graph/observed-dependencies/:nodeId`. A node the OTel layer has actually seen (`observed: true`, i.e. a non-zero `inboundObservedCount` of callers or a non-empty set of OBSERVED outbound calls) is one production is live on, so removing or changing it will break real callers. That is a fact only the fused graph can state — static analysis sees the deletion, not the traffic — and it is the Action's whole reason to reach past the diff. The severity model falls straight out of it: **🛑 RED** when there is at least one observed break; **⚠️ YELLOW** when there are divergences or removed routes/tables (static blast-radius risk) but nothing observed breaks; **✅ GREEN** when nothing the PR touches is observed in production and it introduces no new divergence. Observed breaks rank above divergences in the RED list, each carrying a 🔴/🟠 severity dot.

Honesty is enforced at the render boundary. The `observed-dependencies` response carries counts of observed edges but **no request volume and no timestamp**, so the report states "N observed dependents (OBSERVED)" and never a manufactured "served 3,214× in 7d" or "last seen 14m ago" — if the host shape later grows those fields, the renderer is the one place they surface. And when no host is connected, the Action cannot see production at all, so it does not pretend to: it keeps the static graph-diff comment and says plainly that observed-break detection requires the OBSERVED layer, nudging the reviewer to connect a host rather than implying the check ran and passed.

Two capabilities the report points at are deliberately **not** built here, only surfaced as configurable inputs. `sniper-dispatch-url` renders a "Dispatch Sniper to fix these" link in the RED/YELLOW tiers — Sniper (a separate domain) does the fixing; the Action emits a link, it does not trigger or implement the fix. The hosted-account tie-in — OAuth, account-linking, and resolving a repo to its NEAT project automatically — is the neat-infra hosted plane's seam and gets its own contract; the Action stays on the connected-host model (`neat-api-url`), which self-hosters can drive today. A `neat-api-token` rides as an `Authorization: Bearer` header on the `/graph/*` requests so a self-hosted daemon exposed on the customer's own network — or the hosted host — can require auth; unset sends none, which is the neat-local static tier (no host) and any open host. This is the seam across the three Action customers: neat-local (no host, static comment), self-hosted (`neat-api-url` + `neat-api-token` at their own daemon, full verdict), and hosted (the same, pointed at the hosted plane, with account-linking layered on later). A `tone` input (`loud` | `professional`, default `loud`) swaps only the headline strings; the severity model and structure are identical across tones. The Action remains zero-dependency (Node builtins, `node --test`), and its own errors still exit 0 so a NEAT hiccup never fails a user's PR check.


## ADR-188 — The Action ↔ NEAT-host seam is a contract, so self-hosted and hosted are one client

**Status:** Proposed. Refs the neat-action (ADR-187). New contract: [`action-hosted-seam.md`](contracts/action-hosted-seam.md). Owners: Action side neat-core, hosted-plane side neat-infra — public because it governs public Action code; the hosted-plane specifics are the Action's requirements, to reconcile with the hosted v1 before locking.

The Action reads its verdict from whatever host `neat-api-url` points at. Three customers share one client: neat-local (no host, static comment), self-hosted (their own daemon, `neat-api-url` + `neat-api-token`), and hosted (the same client pointed at the hosted plane, with account-linking layered on). Pinning the seam is what makes the self-hosted and hosted paths byte-identical to the Action: it calls `GET /graph/divergences` and `GET /graph/observed-dependencies/:nodeId` (both already served by the engine — ADR-060, #593), sends `Authorization: Bearer` when a token is configured, and degrades to the static tier on any error so a NEAT hiccup never fails a user's PR check. The hosted plane's own half — account-linking, repo→project resolution, multi-tenant scoping, and graph-freshness the verdict can cite — is specified as the Action's requirement here and implemented in neat-infra. One proposed extension is called out: `observed-dependencies` returns dependent counts today, so the verdict honestly says "N observed dependents"; the visceral "served 3,214× in 7d, last seen 14m ago" needs per-edge OBSERVED call-counts + last-seen timestamps, rendered when present and never fabricated when absent — the recommended fast-follow.


## ADR-189 — `get_root_cause` becomes agent-driven bidirectional navigation with per-node classification

**Status:** Proposed. Refs #1006. Amends [`get-root-cause.md`](contracts/get-root-cause.md), [`rest-api.md`](contracts/rest-api.md). Builds on ADR-037, ADR-114, ADR-110, ADR-038.
**Contract:** [`get-root-cause.md`](contracts/get-root-cause.md), [`traversal.md`](contracts/traversal.md).

### Context

`getRootCause` resolves a failure to a single culprit. For a `ServiceNode` origin it follows the outbound failing `CALLS` chain (ADR-114) to the deepest still-failing callee — "the service whose own downstream calls are clean" — and returns that as `rootCauseNode`, with a `traversalPath`, `edgeProvenances`, and one `confidence`; the compat path walks incoming edges to depth 5 for an upstream incompatibility. Both shapes terminate at one node and return one verdict, and neither labels the nodes along the path.

Two shapes of real incident fall outside what a single-culprit, outbound-terminating result can express:

1. **An upstream-load failure.** When a client overloads the system, the alert surfaces at an ingress service, the outbound failing-`CALLS` chain runs to the deepest saturated callee — a node the load starves, which then decays to STALE — and that callee is returned as the cause. The node that *originates* the load is an inbound caller of the chain, reachable only by the dependents/inbound traversal (`get_blast_radius`, ADR-110), which cross-service localization does not walk. The saturated callee is a symptom of the load, and a single `rootCauseNode` has no field in which to say so.

2. **A multi-candidate failure.** One confident node gives the caller no material to reason with — no ranked alternatives, no per-node evidence, no statement of which nodes are symptoms and which are unrelated. A consuming agent can only relay the verdict; it cannot weigh it.

NEAT already carries both traversal directions as primitives: the inbound dependents walk (`get_blast_radius` / ADR-110) and the outbound dependency walk (`getTransitiveDependencies` / `get_dependencies`). What is absent is a per-node local view that reaches in either direction and separates the signals a classification decision needs.

### Decision

`get_root_cause` gains an **agent-driven navigation** result alongside the single-verdict one. The navigation result becomes the default; the single verdict is retained behind a flag for one deprecation cycle.

Together the navigation exposes NEAT's adaptation of PRAXIS's four-move traversal protocol: `Expand` (a neighbourhood step) and `Relate` (a pairwise link check) are explicit calls, and the per-node classification realises the other two — a node named `primary-failure` is PRAXIS's *complete*, a node named `unrelated` is its *discard*. PRAXIS is the reference model, not a clone-target, so these are framed by its four-move structure rather than reproducing its command signatures.

1. **Bidirectional `Expand(node, direction)`.** A caller steps from any node in either direction — `up` = inbound (toward callers/dependents, the `get_blast_radius` primitive), `down` = outbound (toward callees/dependencies, the `get_dependencies` primitive). One step returns that node's immediate neighbours in the chosen direction with their edges and provenance, under the depth-bounded deterministic mechanics `traversal.md` already governs — exposed as a single navigable step rather than a fixed, pre-walked path.

2. **`Relate(a, b)` — pairwise link-confirmation.** Where `Expand` takes a neighbourhood step, `Relate` answers a directed question about two *specific* nodes: does a path run between them, which way, and does that path carry the failure it is hypothesised to explain. It composes the `traversal.md` primitives — no new engine — bounded by the same `maxDepth`.
   - **Directed.** RCA turns on causal direction, so `Relate` searches both ways but **labels the direction it found** (`a→b` / `b→a`): "a causes b" needs the traffic/failure to flow `a→b`, and an undirected "connected" loses exactly that.
   - **Signal-carrying, first-class.** Each returned path carries a `carriesSignal` summary — whether `errorCount` / `latencyMs` (ADR-190) / `anomalous` runs end-to-end along its hops. This is the move's point: relating a load-origin candidate to a saturated subgraph returns not "a `CALLS` path exists" but "a path exists, `a→b`, and `p95` climbs along it" — reachability becomes cause-confirmation.
   - **Finest grain, honest fallback.** NEAT is multi-grain and its value is at the lower rungs, so `Relate` returns the **finest** path it can construct — descending across grain boundaries by containment and call edges when `a` and `b` differ in grain — each hop annotated with its own `grain`. When the fine link is not in evidence but a coarser one is, it returns the coarser path and **flags the grain gap** ("related at service grain; the symbol-grain hop was never observed"), never synthesising a finer link than the evidence supports (file-awareness §6).
   - **Terminal honesty.** No path within `maxDepth` returns `related: false` labelled **"no path within N hops," not "unrelated"** — a depth-bounded absence is not proven independence.

3. **Per-node local context, classification inputs separated.** For the expanded node the result carries the signals a classification rests on, each kept distinct rather than folded into one confidence: errors emitted at this node, errors arriving from its callers (inbound edges' `errorCount`), call volume through it, staleness (`lastObservedAgeMs`), and edge latency (the OBSERVED signal enriched in ADR-190). A node with errors arriving from callers but none emitted locally, gone stale under inbound load, is materially a downstream symptom — the separated signals make that legible without the caller re-deriving them.

4. **Classification, not a single verdict.** Each surfaced node carries a classification — `primary-failure` / `symptom-only` / `unrelated` — the evidence it rests on, and a per-node confidence. A saturated downstream node classifies `symptom-only`, and the navigation continues `up` toward the highest-volume inbound feeder to reach the load origin. The result is a ranked candidate set, never one `rootCauseNode`.

5. **Result shape.** The navigation result returns `candidates: Array<{ node, classification, evidence, confidence }>` alongside the `traversalPath` / `edgeProvenances` that reached them. `Relate` returns `{ related, direction, paths: Array<{ nodes, edgeTypes, provenance[], grain[], carriesSignal }> }`, with `related: false` and the depth-bounded label when no path is found within `maxDepth`. `RootCauseResultSchema` grows the candidate and relate shapes (schema growth per ADR-031); the legacy single-verdict fields stay populated while the deprecation flag is on.

6. **Non-breaking rollout.** Every consumer of the single verdict is audited first — the MCP `get_root_cause` tool, the REST `/graph/root-cause/:nodeId` route, any UI surface, and the eval/smoke harnesses. The legacy `{ rootCauseNode, rootCauseReason, … }` shape stays behind a flag for one release cycle; the navigation shape ships additively, and the verdict is removed only in a later change once consumers have moved.

### Consequences

- The failure that originates upstream of the alert becomes reachable: navigation walks `up` over the inbound feeders to the load origin instead of terminating at the deepest downstream callee.
- A saturated victim is nameable as `symptom-only` rather than being returned as the cause — the separated per-node signals carry the distinction, and the ranked candidate set carries the alternatives.
- The single collapsed `confidence` gives way to per-node confidence over a candidate set; a consuming agent gets material to weigh, not one string to relay.
- No consumer breaks on the release: the single-verdict shape is audited and kept behind a flag for a cycle; the navigation result is additive schema growth.
- Reuses the existing inbound/outbound traversal primitives and `traversal.md` mechanics — `Expand`, `Relate`, the per-node view, and classification are new surfaces over them, not a new traversal engine.
- NEAT exposes the full four-move protocol on a persistent fused graph: `Expand` walks, `Relate` confirms a hypothesised cause→symptom link *and* whether the connecting path carries the failure that explains it, and classification concludes (`primary-failure`) or prunes (`unrelated`). `Relate` is what turns a candidate into a *confirmed* cause rather than a merely reachable one.
- Pinned by the ITBench acceptance harness (an upstream-load scenario resolves to the load origin, with the saturated callee classified `symptom-only`; a code-caused scenario converges on the faulty node), a `Relate` unit test (a directed signal-carrying path returns `carriesSignal`; a cross-grain pair returns the finest path with a flagged grain gap; an unreachable pair returns the depth-bounded label), and unit tests on the classification-input separation and the deprecation-flag consumers.


## ADR-190 — The OBSERVED edge signal carries per-edge latency and an optional alert flag; `observed-dependencies` exposes the full signal

**Status:** Proposed. Refs #1006. Amends [`otel-ingest.md`](contracts/otel-ingest.md), [`rest-api.md`](contracts/rest-api.md), [`action-hosted-seam.md`](contracts/action-hosted-seam.md). Builds on ADR-066, ADR-124, ADR-116, ADR-188.
**Contract:** [`otel-ingest.md`](contracts/otel-ingest.md), [`rest-api.md`](contracts/rest-api.md).

### Context

Every OBSERVED edge carries a `signal` block — `spanCount`, `errorCount`, `lastObservedAgeMs` — written at one mint point, `upsertObservedEdge`, for both span-derived and connector-derived edges (ADR-124), with a graded confidence (ADR-066). The block records how much traffic an edge carried and how much of it failed, but not how slow it was. Saturation — a subgraph whose latency climbs under load while error counts stay low — leaves no mark in the signal. The navigation in ADR-189 classifies a node partly on whether it is saturated, and today has nothing to read for it.

Separately, `GET /graph/observed-dependencies/:nodeId` surfaces a node's runtime dependencies but not the full per-dependency signal, and it carries no node-level view of the *inbound* traffic a node receives. A consumer that wants to state how heavily and how recently production exercises a node — neat-action's fused-tier verdict is the immediate case, the navigation the second — cannot read it off the response.

### Decision

1. **`latencyMs` on the edge signal.** `EdgeSignal` gains `latencyMs: { p50, p95 }`, derived from span duration at `upsertObservedEdge`. It is maintained per edge with a **bounded streaming percentile estimator** (t-digest / HDR-histogram), never by retaining raw durations — the ingest path is non-blocking and the edge cardinality unbounded, so a stored-sample approach is out of scope. `p95` is the saturation signal; `p50` is context. A connector-sourced edge that carries a provider latency populates it through the same primitive; one without leaves it absent, never fabricated (file-awareness §6).

2. **`anomalous` — an optional pre-thresholded alert riding on the edge.** `EdgeSignal` gains an optional `anomalous?: { source, rule } | boolean`, set when an external monitor has already fired against this edge (`"latency > X for 5m"`). NEAT records the fact; it does not compute its own baseline or threshold — this keeps the signal absolute and baseline-free, matching how the navigation reasons (ADR-189) and how PRAXIS's classifier consumes pre-thresholded alerts. Absent when no alert applies.

3. **`observed-dependencies` exposes the full per-dependency signal and a node-level *inbound* block.** Per dependency, the result carries the whole signal block — `errorCount`, `lastObserved` / `lastObservedAgeMs`, `latencyMs`, `anomalous` — the traversal's classification inputs. These are the node's **outbound** dependencies (what it calls), so their `lastObserved` is *outbound* recency. Separately, the result carries a **node-level inbound block `{ inboundVolume, window, inboundLastObserved }`** describing how production hits *this* node:
   - `inboundVolume` — the aggregate production call volume *into* the node (the summed inbound-edge count), a field distinct from any per-edge or outbound count.
   - `window` — labels the count (`"7d"` / `"lifetime"`) so a consumer only ever renders a window the data actually has. A 7-day window is preferred where the ingest supplies it cheaply; lifetime is an acceptable, explicitly-labelled fallback.
   - `inboundLastObserved` — the most-recent inbound observation, i.e. when production last *called* this node. Distinct from the per-dependency (outbound) `lastObserved`, which is the wrong recency for "when was this node last hit."

   All recency is emitted **raw** (ISO / ms), never pre-formatted — the consumer formats. Together the inbound block is the full "how hard and how recently did production hit this node" story the neat-action verdict renders ("served N× in {window}, last seen {age}"), and it keeps the verdict's two halves sourced from the correct direction.

   This node-level inbound block supersedes the per-edge `callCount` / `windowDays` / `lastSeenAt` sketch [`action-hosted-seam.md`](contracts/action-hosted-seam.md) named as the recommended fast-follow (ADR-188). The seam's intent was correct — "served N× in {window}, last seen {age}, rendered when present and never fabricated when absent" — but the verdict's question is *how hard and how recently production hit the changed node*, which is an **inbound aggregate on the node**, not a property of any one dependent edge; and reusing `callCount` would collide with the neat-action break object's existing `callCount` (its outbound `dependencies.length`). So the shipped shape is the node-level `{ inboundVolume, window, inboundLastObserved }`, and this ADR amends `action-hosted-seam.md` to pin those names. The seam's degrade-not-fabricate rule carries over unchanged.

### Consequences

- Saturation becomes legible to the navigation (ADR-189): a downstream subgraph with climbing `p95` and low `errorCount` reads as saturated, which is what lets a node classify `symptom-only` and the walk continue toward the load origin.
- `observed-dependencies` serves both consumers from one response — neat-action's fused verdict reads the node-level inbound block ("served N× in {window}, last seen {age}"), the traversal reads the per-dependency signal — one core change, not two competing shapes, and each half sourced from the correct direction.
- The streaming estimator bounds ingest memory regardless of graph size and holds the non-blocking-ingest discipline; no raw duration samples are retained.
- The explicit `window` label makes a lifetime count impossible to render as a 7-day rate, and the separate `inboundLastObserved` keeps "last seen" from being read off outbound recency — the consumer prints a window only when the data carries one, and a recency that means what it says.
- Additive schema growth (ADR-031): a legacy edge missing `latencyMs` backfills it on its next observation and is honestly absent until then; the `anomalous` slot is optional and empty until an alert source is wired.
- Pinned by unit tests (a span run produces a `p95`; a node-level inbound aggregate carries `window: "lifetime"` and an `inboundLastObserved`; a host-less connector edge leaves `latencyMs` absent) and the ITBench acceptance harness (the saturated-subgraph scenario exercises the latency read end to end).


## ADR-191 — In-process failures localize to the symbol, so root-cause answers at function grain

**Status:** Proposed. Refs #1011. Amends [`otel-ingest.md`](contracts/otel-ingest.md), [`get-root-cause.md`](contracts/get-root-cause.md). Builds on ADR-158, ADR-189, ADR-117.
**Contract:** [`otel-ingest.md`](contracts/otel-ingest.md), [`get-root-cause.md`](contracts/get-root-cause.md).

### Context

OBSERVED *edges* already land on the calling symbol (ADR-158 §4): `landObservedSymbol` walks the file's `CONTAINS`'d symbols and lands a runtime CALLS edge on the `SymbolNode` whose definition span brackets `code.line`, with `code.function` as tiebreaker. But the OBSERVED evidence of an in-process *throw* — the incident — stopped one grain short. `incidentAffectedNode` resolved a span's call site to a `FileNode` and returned it directly, and the handleSpan inline write attributed to the outbound edge target the span happened to mint. Neither descended to the symbol.

The consequence surfaced in the navigation (ADR-189). `incidentCountForNode` reads incidents through `incidentMatchesNode`; for a `SymbolNode` it always counted zero, because no incident carried a `symbol:` `affectedNode`. So a symbol's `errorsEmittedHere` reflected only its outbound failing calls, never an in-process throw; `getRootCause` on a `SymbolNode` returned `null` for the common case (a function throwing a `TypeError` / null-deref) while the same query on the owning file succeeded; and `classifyNode` mislabelled an in-process thrower `unrelated`. ADR-158 §7 made symbols first-class for root-cause, yet "why did `OrderService.create` fail?" answered with nothing — one grain up gave the answer. This is the gap between "NEAT fuses at function grain" and "an agent navigates a bug root at function grain."

### Decision

An in-process failure localizes one grain finer when the span supports it, and the two incident-write paths agree.

1. **`incidentAffectedNode` descends to the symbol.** When a failing span carries a call site (`code.filepath` / `code.lineno` / `code.function`) whose line falls inside a statically-extracted symbol's span, `affectedNode` is that `symbol:` id — the same span-containment `landObservedSymbol` lands edges by, keyed on the fused service name so the incident fuses onto the static symbol. The resolution is **read-only** (it mints no observed-only symbol from the incident path, so it stays safe at the receiver, which runs before reply and off the mutation queue), and it degrades to the file, then the service, honestly (file-awareness §6) — without a graph, when the fused file node isn't materialised, or when no static symbol contains the line.

2. **The inline write attributes from the source, like the durable one.** The handleSpan inline ErrorEvent write (the daemon-less / CLI-and-test fallback) now attributes through `incidentAffectedNode` rather than the outbound edge target it had reused — matching the durable receiver write and the source-based intent (ADR-117: "this service's calls to X are failing," not "X failed"). A failing DB call attributes to the calling service, not the datastore; a worker throw attributes to its handler file (or symbol), one grain finer than the service and still discoverable from it.

3. **`incidentMatchesNode` is grain-aware.** A `symbol:` incident also matches its owning **file** (parsed via `parseSymbolId` → `fileId`) and, through `ev.service`, its service. So a query at any grain still surfaces the failure the finer node localized — no regression for the file- or service-grain caller — and `localizeFromIncidents` descends a coarser query down to the symbol the incident named.

### Consequences

- "Why did this function fail?" is answerable at the grain it was asked: `getRootCause(symbol)` names the symbol `primary-failure`, and `getRootCause(file)` / `getRootCause(service)` descend to it. `classifyNode` reads a symbol's own emitted error.
- The two incident-write paths converge on one source-based attribution; incidents localize one grain finer where a call site supports it, always discoverable from the owning file and service.
- Additive and observed-first: an incident fuses onto the static symbol; nothing is minted from the incident path; behavior is unchanged when no static symbol contains the line. Symbol-grain *divergence* stays deferred (ADR-158 §7, Phase 3) — this ADR is the failure-attribution half, not the divergence half.
- Pinned by unit tests (an in-process throw whose line is inside a symbol → incident's `affectedNode` is the symbol; degrades to the file when the line is in no symbol span; `getRootCause` names the symbol from a symbol / file / service query; `classifyNode(symbol)` is `primary-failure`) and the DB / worker attribution updates that reflect the source-based, finer-grained localization.

## ADR-192 — Symbol grain reaches Python and Go

**Status:** Accepted. Refs #1017. Builds on ADR-158 (symbol grain), ADR-191 (symbol-grain failure localization). Amends [`static-extraction.md`](contracts/static-extraction.md).
**Contract:** [`static-extraction.md`](contracts/static-extraction.md).

### Context

ADR-158 mints a `SymbolNode` per function / method / constructor / class definition, and ADR-191 localizes an in-process failure to the symbol whose span brackets the call site. Both stopped at the JS/TS island: `symbols.ts` keyed its grammar map on the JS/TS extensions only, and its header called Python and Go "a follow-on rung." So a Python or Go service topped out at file grain — the file existed, its routes and tables and cross-service calls existed, but the functions inside it did not. "Why did `OrderService.create` fail?" answered with nothing on those services, because there was no `OrderService.create` node to answer with, and the OpenTelemetry Demo (mixed Python/Go/JS) could not fuse at symbol grain on more than half its services.

The node is already language-neutral — `symbolId(service, relPath, qualname, disambiguator?)` carries no language token, and the fusion join is span containment, not an id the observed side reconstructs (ADR-158 §4). What was missing was the per-language adapter: a tree-sitter walker that reads the language's definition node types into the same `SymbolDef` shape. Both grammars are already dependencies — `extract/routes.ts` and the call producers load `tree-sitter-python` and `tree-sitter-go` today — so this is an extractor extension, not a new dependency or a new toolchain language (the extractor stays TypeScript; it reads other languages' source).

### Decision

1. **A per-language walker mints the same `SymbolNode` shape.** Python's `function_definition` / `class_definition` (and the `decorated_definition` wrapper) and Go's `function_declaration` / `method_declaration` map onto the same `SymbolKind` set JS/TS uses — `function`, `method`, `constructor`, `class`. A Python method's qualname is `Class.method` (`__init__` the constructor); a Go method's is `Receiver.method`, the receiver type read off the method's receiver parameter (unwrapping `*T` and `T[U]`). Method-ness comes from direct class-body membership (Python) or the presence of a receiver (Go), never ambient scope, so a `def` nested in a method stays a plain function — mirroring the JS/TS walker, where the node type decides. Go has no class; struct types are not symbols in this rung. Every node carries its real `{ startLine, endLine }` definition span and `discoveredVia: 'static'`, identical to the JS/TS path.

2. **The keying is the JS/TS keying, so fusion is automatic when the anchor is present.** A Python/Go `SymbolNode` fuses with an observed span exactly as a JS/TS one does: `landObservedSymbol` lands the observed edge on the `SymbolNode` whose span brackets the span's `code.lineno`, with `code.function` (the qualname's terminal name) the tiebreaker and drift check — line-in-span primary. `terminalName` splits the qualname on its last `.`, so a Go span's package-qualified `main.(*Server).Handle` and the extracted `Server.Handle` both reduce to `Handle`; and the line-in-span primary lands the edge even when the runtime function name doesn't reduce cleanly. The extracted id and the observed line key the same node or the graph twins — pinned two-sided for Python and Go (a real Postgres CLIENT span with a `code.*` call site inside a method fuses onto the static symbol, one node, no twin), the symbol-grain sibling of the #796 fusion tests.

3. **Symbol-grain RCA (ADR-191) now reaches these languages, for free.** ADR-191's failure localization and ADR-158's blast-radius / root-cause traversal dispatch only on `node.type` — never on language (ADR-158 §6). With Python/Go functions now first-class nodes, "why did this function fail?" and "what depends on this function?" answer at symbol grain on a Python or Go service the moment its spans carry the anchor; nothing in the reasoning core changed.

4. **The shared grammar map stays JS/TS; symbol *edges* stay Phase 2.** The exported `GRAMMAR_BY_EXT` that the other AST producers import (`symbol-edges.ts`, `actions.ts`, `zod-shapes.ts`, `calls/drizzle.ts`, `calls/firestore.ts`) stays JS/TS-only, so none of them quietly starts parsing Python/Go; symbol extraction layers `.py`/`.go` on through a local `SYMBOL_GRAMMAR_BY_EXT`. Scope is definitions only: the symbol→symbol `CALLS` / `INHERITS` / `IMPLEMENTS` edges (ADR-158 §3, `symbol-edges.ts`) stay JS/TS — Python/Go get the symbol inventory, not yet the static symbol-edge graph.

### Consequences

- Static symbol coverage climbs on every Python and Go service NEAT scans, cold, with zero telemetry — the inventory, the denominator, and the cold-start answer (ADR-158 §1) now include Python and Go functions.
- **Necessary, not sufficient, for observed fusion.** The extractor mints the node and keys it to fuse; whether an observed span *lands* on it depends on that span carrying the `code.*` anchor (`code.filepath`/`code.function`/`code.lineno`, or the stable-semconv `code.file.path` … per ADR-193). That anchor is a property of the instrumentation, not of this extractor. Standard OTel auto-instrumentation does **not** stamp it: a sweep of the OpenTelemetry Demo confirmed its Python and Go (and JS/TS/Ruby) services emit zero `code.*` natively. So on otel-demo the Python/Go symbols land but stay unfused until those services are re-instrumented with NEAT's own installer, which stamps the anchor — a separate harness step. This ADR is the extractor half; symbol-grain fusion on a stack NEAT did not instrument is gated on the installer, not on this change.
- Pinned by unit tests: symbol extraction against a Python fixture (top-level `def`, `async def`, class, `__init__`, plain and decorated methods, def-nested-in-method) and a Go fixture (free function, receiver methods) asserting concrete ids / kinds / spans, plus the two-sided fusion tests that prove the observed edge originates from the static symbol.
- Adding the next language's symbol grain is now one walker and one `SYMBOL_GRAMMAR_BY_EXT` entry — the shape ADR-158 promised (per-language adapter, language-neutral node).

## ADR-193 — Symbol grain reaches Ruby

**Status:** Accepted. Refs #1019. Builds on ADR-158 (symbol grain), ADR-191 (symbol-grain failure localization), ADR-192 (Python and Go). Amends [`static-extraction.md`](contracts/static-extraction.md).
**Contract:** [`static-extraction.md`](contracts/static-extraction.md).

### Context

ADR-192 promised the next language would be one walker and one `SYMBOL_GRAMMAR_BY_EXT` entry. Ruby is that language — the next service in the OpenTelemetry Demo compat loop, `email`, is Ruby, and until now a Ruby service topped out at file grain: `.rb` files were FileNodes and `config/routes.rb` gave Rails routes, but the methods inside a class were invisible. "Why did `OrderMailer#deliver` fail?" answered with nothing, because there was no symbol node to answer with. `tree-sitter-ruby` is already a dependency — `extract/routes.ts` loads it for Rails route extraction — so this is the extractor extension ADR-192 set up, not a new dependency or a new toolchain language.

### Decision

1. **A Ruby walker mints the same `SymbolNode` shape.** `collectRubySymbolDefs` reads Ruby's definition node types into the same `SymbolDef` the JS/TS, Python, and Go walkers produce: `method` (instance method) and `singleton_method` (a `def self.x` class method) inside a class or module body become methods, an instance `initialize` the constructor; `class` and `module` become `class`-kind nodes; a top-level `def` is a plain function. Method-ness comes from direct class/module-body membership, never ambient scope — a `def` nested in a method stays a plain function, mirroring the Python and JS/TS walkers. Every node carries its real `{ startLine, endLine }` span and `discoveredVia: 'static'`, identical to the other languages.

2. **The qualname joins the nesting with `.` so it reduces under `terminalName`.** Ruby writes a method as `OrderMailer#deliver` and a namespace with `::` (`Shop::OrderMailer`), but the qualname joins the class/module nesting with a plain `.` — `OrderService.create`, `Shop.Mailer.deliver`, and a `::` scope-resolution declared name (`class Billing::Invoice`) normalized to `Billing.Invoice`. `terminalName` splits the qualname on its last `.`, so every method reduces to its bare name (`create`, `deliver`, `render`). A runtime `code.function` of `deliver` matches the tiebreaker; a Ruby-style `OrderMailer#deliver` does not reduce cleanly, but the line-in-span primary lands the edge regardless — the same keying ADR-192 relies on for Go's package-qualified names. Fusion is pure extractor-side: `landObservedSymbol` (line-in-span primary, `code.function`→`terminalName` tiebreaker) is unchanged, and a two-sided test proves a real Postgres CLIENT span with a `code.*` call site inside `OrderService.create` fuses onto the static symbol — one node, both provenances, no twin.

3. **Symbol-grain RCA (ADR-191) now reaches Ruby, for free.** ADR-191's failure localization and ADR-158's blast-radius / root-cause traversal dispatch on `node.type`, never on language. With Ruby methods now first-class nodes, "why did this method fail?" and "what depends on this method?" answer at symbol grain on a Ruby service the moment its spans carry the anchor; nothing in the reasoning core changed.

4. **The shared grammar map stays JS/TS; symbol *edges* stay Phase 2.** `.rb` lands in `symbols.ts`'s own `SYMBOL_GRAMMAR_BY_EXT`, not the exported `GRAMMAR_BY_EXT` its sibling AST producers import, so none of them starts parsing Ruby. Scope is definitions only: Ruby's symbol→symbol `CALLS` / `INHERITS` edges stay a follow-on rung, as they do for Python and Go.

### Consequences

- Static symbol coverage climbs on every Ruby service NEAT scans, cold, with zero telemetry — the inventory now includes Ruby methods, and the third language rides the walker ADR-192 built.
- **Necessary, not sufficient, for observed fusion.** The extractor mints the node and keys it to fuse; whether an observed span *lands* on it depends on that span carrying the `code.*` anchor. That is a property of the instrumentation, not this extractor. Standard OTel Ruby auto-instrumentation does **not** stamp `code.*` — the otel-demo sweep in ADR-192 confirmed its Ruby services emit zero `code.*` natively — so on otel-demo the `email` service's Ruby symbols land but stay unfused until it is re-instrumented with NEAT's own installer, which drops the anchor in live. This ADR is the extractor half; symbol-grain fusion on the `email` service is gated on the installer, not on this change.
- Pinned by unit tests: symbol extraction against a Ruby fixture (top-level `def`, instance method, `initialize` constructor, `def self.` singleton, module-nested class, `::` scope-resolution class name) asserting concrete ids / kinds / spans, plus the two-sided fusion test that proves the observed edge originates from the static symbol.
## ADR-194 — A Dockerfile-declared service is discoverable without a language manifest

**Status:** Accepted. Refs #1019. Amends [`static-extraction.md`](contracts/static-extraction.md).
**Contract:** [`static-extraction.md`](contracts/static-extraction.md).

### Context

`discoverServices` finds a service by its language manifest: a JS/TS `package.json`, a Python `pyproject.toml` / `requirements.txt` / `setup.py`, a Go `go.mod`, a Ruby `Gemfile`, a PHP `composer.json`. Each manifest is the anchor for a directory — the walker keys on it, reads dependencies off it, and everything downstream (files, symbols, routes, calls) hangs off the ServiceNode it mints.

A containerized service that ships none of them falls through the whole set. The OpenTelemetry Demo's `load-generator` is the shape: a k6 script whose directory is `Dockerfile`, `entrypoint.sh`, `people.json`, `README.md`, `script.js`, `xk6-otel/` — real JavaScript source, an explicit container definition, and not a single language manifest. Discovery never sees it, so it has no ServiceNode, no FileNode for `script.js`, no symbols. And because it has no static node, an observed span from it has nothing to fuse onto — it stays observed-only. In the RCA benchmark's Scenario-1 the load-generator is the overload *source*, so the one node the fault originates from is exactly the node discovery was missing. Fixing this sharpens root-cause, not just coverage.

The gap is narrow but the fix has to stay narrow with it. "Any directory with a `.js` in it" would mint phantom services all over a tree — a scripts folder, a config directory, a docs example. The precision discipline the rest of extraction holds (ADR-065) applies here too: mint only where the evidence is unambiguous.

### Decision

1. **A `Dockerfile` plus source, with no language manifest, declares a service.** A new `discoverDockerfileService` mints a ServiceNode for a directory that has a `Dockerfile` **and** top-level source **and** no language manifest. The `Dockerfile` is the load-bearing signal: it's an explicit, checked-in "this directory is a deployable service" marker, which is what separates a real service from a directory that merely happens to contain a script. The service name is the directory basename (the convention the Go/Ruby/PHP readers already use for manifests that name no project), dependencies are empty, and the node carries no framework tag.

2. **The precision boundary is three ANDs, proven by negative tests.**
   - A `Dockerfile` **alone** (no source) mints nothing — it may be a base image or a tooling container. The Demo's `collector/` directory (Dockerfile + two YAML configs, no source) is exactly this case and correctly stays out.
   - Source **alone** (no `Dockerfile`, no manifest) mints nothing — a loose script is not a deployable unit.
   - A directory a **manifest already owns** is unchanged. `discoverDockerfileService` runs last in the discovery chain and, independently, bails when any manifest (even a nameless `package.json`) is present, so a dir with both a manifest and a Dockerfile discovers through the manifest and is never double-minted.
   - **Vendored / build-output / ignored** directories never reach the check — the walk skips `IGNORED_DIRS` and `.gitignore` matches before the per-directory marker test runs, so this path inherits that filtering for free.

3. **Language is inferred from the primary top-level source, top-level only.** The winner is the language with the most top-level source files (`.js`/`.mjs`/`.cjs` → JavaScript, `.ts`/`.tsx` → TypeScript, `.py` → Python, `.go` → Go, `.rb` → Ruby, `.php` → PHP), ties broken by a fixed precedence so a mixed directory resolves the same way on every pass — idempotency, the same property every producer holds. Top-level-only is a deliberate precision knob: it pins discovery to a leaf service directory whose own files are the source, so a repo root that holds a `Dockerfile` above subdirectory services doesn't mint a root service off code that belongs to something else.

4. **Same shape, same flow.** The minted `DiscoveredService` is the identical `{ pkg, dir, node }` the manifest paths return, so it flows through the unchanged pipeline: `addFiles` enumerates `script.js`, and — because symbol extraction is now polyglot (ADR-192) and JavaScript is a symbol grammar — `addSymbols` grains `script.js` into SymbolNodes with no further wiring. A JS/TS/Python/Go Dockerfile-declared service reaches symbol grain the moment it's discovered.

### Consequences

- The load-generator, and manifest-less containerized services like it, become first-class static nodes: a ServiceNode, a FileNode per source file, and symbols where the language is grammar-backed. The RCA fault origin now has a static twin for its observed spans to fuse onto.
- Discovery stays precise. The three-AND boundary means the broadening is bounded to directories that carry an explicit deployment marker alongside their own source; a Dockerfile alone, a script alone, a manifest-owned dir, and an ignored dir all mint nothing, each pinned by a negative test.
- Scanning a single manifest-less service directory *as* `scanPath` (rather than a parent that contains it) is out of scope — the walk visits descendants, not `scanPath` itself. A follow-on if a concrete need appears; the manifest paths have the same descendants-only shape today.
- Adding the signal is one module (`dockerfile-service.ts`) and one fall-through in the discovery chain — the per-marker adapter shape the manifest readers already established.
## ADR-195 — Symbol grain reaches PHP

**Status:** Accepted. Refs #1022. Builds on ADR-158 (symbol grain), ADR-191 (symbol-grain failure localization), ADR-192 (Python and Go), ADR-193 (Ruby). Amends [`static-extraction.md`](contracts/static-extraction.md).
**Contract:** [`static-extraction.md`](contracts/static-extraction.md).

### Context

ADR-193 promised the next language would be one walker and one `SYMBOL_GRAMMAR_BY_EXT` entry, and PHP is the next service in the OpenTelemetry Demo compat loop. It is also the payoff case. Until now a PHP service topped out at file grain — `.php` files were FileNodes and ADR-177's Laravel route reader and ADR-178's Eloquent recognizer gave routes and tables, but the functions and methods inside a class were invisible. "Why did `QuoteService::calculate` fail?" answered with nothing, because there was no symbol node to answer with. `tree-sitter-php` is already a dependency — `extract/routes.ts` and `calls/eloquent.ts` load its `php_only` variant for Laravel — so this is the extractor extension ADR-192 set up, not a new dependency or a new toolchain language.

### Decision

1. **A PHP walker mints the same `SymbolNode` shape.** `collectPhpSymbolDefs` reads PHP's definition node types into the same `SymbolDef` the JS/TS, Python, Go, and Ruby walkers produce: a top-level `function_definition` is a plain function, a `method_declaration` inside a class / trait / interface body is a method (its `__construct` the constructor), and `class_declaration` / `trait_declaration` / `interface_declaration` all mint as `class`-kind nodes — a trait and an interface are class-shaped heritage targets, so an INHERITS / IMPLEMENTS to either has a symbol to land on. Method-ness comes from direct class-body membership, never ambient scope, mirroring the Python and Ruby walkers. Every node carries its real `{ startLine, endLine }` span and `discoveredVia: 'static'`, identical to the other languages. It parses through tree-sitter-php's `php_only` variant, the one the existing PHP producers already use, so no second grammar variant enters the codebase.

2. **The qualname joins namespace + class nesting with `.` so it reduces under `terminalName`.** PHP writes namespaces with `\` (`App\Quote`) and static members with `::` (`QuoteService::calculate`), but the qualname joins both with a plain `.` — `App.Quote.QuoteService`, `App.Quote.QuoteService.calculate`. `terminalName` splits the qualname on its last `.`, so every method reduces to its bare name (`calculate`). A runtime `code.function` of `calculate` matches the tiebreaker; a namespaced `App\Quote\QuoteService::calculate` does not reduce cleanly, but the line-in-span primary lands the edge regardless — the same keying ADR-192 relies on for Go's package-qualified names. A semicolon-form `namespace App\Quote;` threads its ambient namespace onto every sibling that follows it; a braced `namespace App\Quote { … }` scopes it to its body. Fusion is pure extractor-side: `landObservedSymbol` (line-in-span primary, `code.function`→`terminalName` tiebreaker) is unchanged, and a two-sided test proves an observed PDO CLIENT span with a `code.*` call site inside `QuoteService::calculate` fuses onto the static symbol — one node, both provenances, no twin.

3. **Symbol-grain RCA (ADR-191) now reaches PHP, for free.** ADR-191's failure localization and ADR-158's blast-radius / root-cause traversal dispatch on `node.type`, never on language. With PHP methods now first-class nodes, "why did this method fail?" and "what depends on this method?" answer at symbol grain on a PHP service the moment its spans carry the anchor; nothing in the reasoning core changed.

4. **The shared grammar map stays JS/TS; symbol *edges* stay Phase 2.** `.php` lands in `symbols.ts`'s own `SYMBOL_GRAMMAR_BY_EXT`, not the exported `GRAMMAR_BY_EXT` its sibling AST producers import, so none of them starts parsing PHP. Scope is definitions only: PHP's symbol→symbol `CALLS` / `INHERITS` / `IMPLEMENTS` edges stay a follow-on rung, as they do for Python, Go, and Ruby.

### Consequences

- Static symbol coverage climbs on every PHP service NEAT scans, cold, with zero telemetry — the inventory now includes PHP functions and methods, and the fourth language rides the walker ADR-192 built.
- **PHP is the first symbol-grain language whose otel-demo service fuses without the installer.** ADR-192 and ADR-193 both noted the same gate: standard OTel auto-instrumentation stamps no `code.*`, so on otel-demo the Python / Go / Ruby symbols land but stay unfused until NEAT's own installer drops the anchor. PHP breaks that pattern. The demo's `quote` service emits `code.*` natively — in the stable semconv form (`code.file.path` / `code.function.name` / `code.line.number`), which ingest already reads alongside the prior names (ADR-151) — so the moment PHP symbols exist, a real `quote` span lands on `QuoteService::calculate` at symbol grain with no re-instrumentation. It is the only otel-demo service where symbol-grain fusion is available out of the box, and the two-sided test carries the stable-name attributes to prove that new-name read reaches a SymbolNode.
- Pinned by unit tests: symbol extraction against a PHP fixture (namespaced top-level function, class, `__construct` constructor, static method, trait, interface, ambient-namespace-threaded second-namespace class) asserting concrete ids / kinds / spans, plus the two-sided fusion test — carrying the stable-semconv `code.*` the `quote` service emits — that proves the observed edge originates from the static symbol.

## ADR-196 — C#/.NET language support: discovery, file grain, and symbol grain

**Status:** Accepted. Refs #1025. Builds on ADR-158 (symbol grain), ADR-191 (symbol-grain failure localization), ADR-192 (Python and Go), ADR-193 (Ruby), ADR-195 (PHP), ADR-194 (Dockerfile-declared discovery). Amends [`static-extraction.md`](contracts/static-extraction.md).
**Contract:** [`static-extraction.md`](contracts/static-extraction.md).

### Context

C#/.NET is the first of the five languages the OpenTelemetry Demo runs that NEAT could not yet see at all — its `cart` and `accounting` services are .NET, and until now they discovered nothing: no ServiceNode, no FileNodes for their `.cs` source, no symbols. Every prior language wave (Python/Go in ADR-192, Ruby in ADR-193, PHP in ADR-195) extended an *already-loaded* grammar — `extract/routes.ts` and the call producers had pulled `tree-sitter-python`, `-go`, `-ruby`, and `-php` in for route and ORM work, so symbol grain was one walker and one map entry with no new dependency. C# has no route or call producer yet, so it is the first language that needs its grammar added from scratch, and the grammar pin is the load-bearing risk — the same one that bit Ruby (ADR-173) and PHP (ADR-177).

### Decision

1. **A `*.csproj` (or `*.sln`) declares a .NET service.** `discoverCsharpService` (`extract/csharp.ts`) mints a ServiceNode for a directory that holds an MSBuild project, joining the discovery chain after the PHP reader and before the Dockerfile fallback (ADR-194), so a manifest always wins. Unlike every other language, the marker is a **glob**, not a fixed filename — a project is named for its assembly (`Cart.csproj`), not a canonical `go.mod` / `Gemfile` — so the predicate reads the directory (`hasCsharpProject`) instead of an `exists(path.join(dir, 'X'))`, and that one predicate is reused by the Dockerfile fallback's `hasLanguageManifest` check so a `.csproj` dir is never double-minted. The project is found whether it sits flat at the service-root directory (`accounting/Accounting.csproj`) or one level down in the conventional `src/` subdirectory (`cart/src/cart.csproj`) — `resolveProjectDir` checks the directory itself first, then its `src/` child, and anchors on whichever holds the project; the discovery loop folds the root and its `src/` project onto that shared directory so the nested layout mints exactly one node. The service name is the `.csproj` basename (the assembly convention); each `<PackageReference Include Version />` becomes a dependency gate the way a go.mod require does (a later ASP.NET / EF Core recognizer reads them); a `.sln`-only directory falls back to the directory basename. `.cs` files flow through the unchanged file pipeline as FileNodes (`language: 'csharp'`).

2. **The grammar is pinned at `tree-sitter-c-sharp@0.21.3` — the ABI-14 ceiling, verified by loading it.** NEAT's runtime is `tree-sitter@^0.21.1`, which loads ABI-14 grammars through a `node-addon-api` binding. The published `tree-sitter-c-sharp` versions step `0.21.1` → `0.21.2` → `0.21.3` → `0.23.0` (no `0.22.x`). `0.21.3` is the newest that (a) generates an ABI-14 parser and (b) ships a `node-addon-api` binding `require()`-able from the CJS extractor; it loads against `tree-sitter@0.21.1` and parses a `.cs` file with zero ERROR nodes. `0.23`+ is doubly incompatible: it declares `tree-sitter ^0.25` (ABI-15, which the pinned runtime rejects at `setLanguage`) **and** ships an ESM-with-top-level-await node binding that a CJS `require()` throws on before the ABI check even runs. So the pin is exact, not a caret — the same ABI-14 discipline that pins `tree-sitter-ruby` at `0.21.0` and `tree-sitter-php` at `0.22.8`. Verifying the grammar actually loads and parses before building the collector was the gate; an incompatible pin crashes the native binding at load, so this was proven first, not assumed.

3. **A C# walker mints the same `SymbolNode` shape, keyed to fuse with no ingest change.** `collectCsharpSymbolDefs` reads C#'s definition node types into the same `SymbolDef` the other walkers produce: `method_declaration` → method, `constructor_declaration` → constructor (a C# constructor's declared name is the type name), and `class_declaration` / `interface_declaration` / `struct_declaration` / `record_declaration` → `class`-kind nodes (an interface, struct, or record is a class-shaped heritage or definition target, so an INHERITS/IMPLEMENTS to any of them has a symbol to land on). Method-ness comes from direct type-body membership, mirroring the Python/Ruby/PHP walkers. The qualname joins the namespace and type nesting with `.` — but C# already writes namespaces and members with `.` (`Cart.Services.CartService.AddItem`), so normalization is minimal (no `::`/`\` to rewrite), and it reduces under ingest's `terminalName` (last-`.` split) to the bare method name (`AddItem`). Both C# namespace forms thread the same way PHP's do: a block `namespace X { … }` scopes its name to its body; a C# 10 file-scoped `namespace X;` carries no body and sets the ambient namespace for every sibling after it. **Fusion is pure extractor-side** — `landObservedSymbol` (line-in-span primary, `code.function`→`terminalName` tiebreaker) is UNCHANGED; `ingest.ts` is not touched. A two-sided test proves a real Npgsql CLIENT span whose `code.*` call site falls inside `AddItem` fuses onto the static SymbolNode — one node, both provenances, no twin.

4. **Symbol-grain RCA (ADR-191) reaches C# for free, and `.cs` stays out of the JS/TS grammar map.** ADR-191's failure localization and ADR-158's blast-radius / root-cause traversal dispatch on `node.type`, never on language, so "why did this method fail?" and "what depends on this method?" answer at symbol grain on a .NET service the moment its spans carry the anchor — nothing in the reasoning core changed. `.cs` lands in `symbols.ts`'s own `SYMBOL_GRAMMAR_BY_EXT`, not the exported `GRAMMAR_BY_EXT` its sibling AST producers import, so none of them starts parsing C#. Scope is definitions only: C#'s symbol→symbol `CALLS` / `INHERITS` / `IMPLEMENTS` edges, ASP.NET routes, and the EF Core data axis are grain-deepening follow-ons, not this change.

### Consequences

- The otel-demo `cart` and `accounting` services become first-class static nodes — ServiceNode, a FileNode per `.cs` file, and a SymbolNode per method / constructor / type — cold, with zero telemetry. NEAT could see nothing of them before; now it sees their static structure, the first of the five missing otel-demo languages lit up.
- **Necessary, not sufficient, for observed fusion — extraction climbs now, fusion waits on the installer.** The extractor mints the node and keys it to fuse; whether an observed span *lands* depends on that span carrying the `code.*` anchor, which is a property of the instrumentation, not this extractor. Unlike PHP's `quote` service (ADR-195), the otel-demo `cart` / `accounting` .NET services emit no native `code.*` under standard auto-instrumentation, so their symbols land but stay unfused until NEAT's own installer drops the anchor — a separate rung, the honest caveat this ADR carries.
- Pinned by unit tests: discovery (a `.csproj` fixture → a `csharp` ServiceNode named for the project, with PackageReference deps; a root-level `.csproj`; a `.sln`-only dir → dir basename); symbol extraction against a C# fixture (block-namespaced class with a constructor / instance method / static method, an interface, a struct, a positional record, plus a file-scoped-namespace file with a nested type) asserting concrete ids / kinds / spans; and the two-sided fusion test that proves the observed edge originates from the static symbol.
- Adding the grammar from scratch — one dependency at the verified ABI-14 pin, one `SYMBOL_GRAMMAR_BY_EXT` entry, one discovery module, one walker — is the shape the next brand-new language takes. The four prior waves reused a loaded grammar; C# is the template for one that isn't.

## ADR-197 — Java language support: discovery, file grain, and symbol grain

**Status:** Accepted. Refs #1028. Builds on ADR-158 (symbol grain), ADR-191 (symbol-grain failure localization), ADR-192 (Python and Go), ADR-193 (Ruby), ADR-195 (PHP), ADR-196 (C#/.NET), ADR-194 (Dockerfile-declared discovery). Amends [`static-extraction.md`](contracts/static-extraction.md).
**Contract:** [`static-extraction.md`](contracts/static-extraction.md).

### Context

Java is the next of the OpenTelemetry Demo's languages NEAT could not yet see — its `ad` service is Java (Gradle), and until now it discovered nothing: no ServiceNode, no FileNodes for its `.java` source, no symbols. C# (ADR-196) was the first language whose grammar had to be added from scratch, with no route or call producer already loading it; Java is the second, and it takes the exact template C# established — one dependency at a verified ABI-14 pin, one `SYMBOL_GRAMMAR_BY_EXT` entry, one discovery module, one walker. The grammar pin is again the load-bearing risk, and — unlike C# — it had to be re-checked empirically rather than assumed from the sibling case, because a grammar's ABI and its binding style are per-package facts.

### Decision

1. **A Maven `pom.xml` or a Gradle `build.gradle` / `build.gradle.kts` declares a Java service.** `discoverJavaService` (`extract/java.ts`) mints a ServiceNode for a directory that holds a build manifest, joining the discovery chain after the C# reader and before the Dockerfile fallback (ADR-194), so a manifest always wins. Unlike C#, the marker is a **fixed filename**, not a directory glob, so it rides the same `exists` predicate the Ruby/PHP/Go readers use (`hasJavaManifest`, reused by the Dockerfile fallback's `hasLanguageManifest` check so a Java dir is never double-minted). A Maven POM names the service — its `<artifactId>`, read once `<parent>` / `<dependencyManagement>` / `<dependencies>` / `<build>` blocks are stripped so the parent's artifactId can't be mistaken for the project's — and each `<dependency>` registers as a `groupId:artifactId` gate (version optional under a managed BOM, so it falls back to ''); a Gradle build carries no name here (the canonical `rootProject.name` lives in `settings.gradle`), so it falls back to the directory basename the Go/Ruby/PHP readers use, and its `implementation`/`api`/… string-notation coordinates become the same gates a later Spring / JPA recognizer reads. `.java` files flow through the unchanged file pipeline as FileNodes (`language: 'java'`).

2. **The grammar is pinned at `tree-sitter-java@0.21.0` — an ABI-14 grammar, verified by loading it, and the honest caveat that the ceiling is looser than C#'s.** NEAT's runtime is `tree-sitter@^0.21.1`, which loads ABI-14 grammars through a `node-addon-api` binding. `tree-sitter-java@0.21.0` generates an ABI-14 parser (`LANGUAGE_VERSION 14`) and ships a `node-addon-api` binding `require()`-able from the CJS extractor; it loads against `tree-sitter@0.21.1` and parses a `.java` file with zero ERROR nodes, resolving `method_declaration` / `constructor_declaration` / `class_declaration` / `interface_declaration` / `enum_declaration` / `record_declaration` and their `name` / `body` fields — proven before the walker was written, not assumed. **The pin is not forced by an ABI ceiling the way C#'s is.** C# pins `0.21.3` because `tree-sitter-c-sharp@0.23` jumps to ABI-15 and an ESM-with-top-level-await binding a CJS `require()` throws on; `tree-sitter-java`'s published versions step `0.21.0` → `0.23.2`+, and the `0.23.x` line — checked empirically in an isolated install — is *still* `LANGUAGE_VERSION 14` and *still* CJS-loadable against the pinned runtime. So Java's ceiling is genuinely looser than C#'s: the newest grammar would also load. The exact `0.21.0` pin is chosen for **parity** — it keeps the whole grammar set on one generation next to `tree-sitter-ruby` `0.21.0` and `tree-sitter-c-sharp` `0.21.3` — and because `0.21.0` is the version proven against the runtime, a conservative floor at the runtime's own major. It is an exact pin, not a caret, the same discipline the other from-scratch grammars take, but the ADR records that the reason is consistency, not the ABI incompatibility that pins C#.

3. **A Java walker mints the same `SymbolNode` shape, keyed to fuse with no ingest change.** `collectJavaSymbolDefs` reads Java's definition node types into the same `SymbolDef` the other walkers produce: `method_declaration` → method, `constructor_declaration` → constructor (a Java constructor's declared name is the type name), and `class_declaration` / `interface_declaration` / `enum_declaration` / `record_declaration` → `class`-kind nodes (an interface, enum, or record is a class-shaped heritage or definition target, so an INHERITS/IMPLEMENTS to any of them has a symbol to land on). Method-ness comes from direct type-body membership, mirroring the Python/Ruby/PHP/C# walkers. Java's scoping is **simpler** than C#'s: a compilation unit carries at most one file-level `package com.a.b;` that prefixes every top-level type, with no nested or block namespaces — so the package is read once from the root and there is nothing to thread through siblings (where C# had to thread a block `namespace X { … }` and a file-scoped `namespace X;` the way PHP does). The qualname joins that package and the type nesting with `.` — Java already writes packages and members with `.` (`com.example.cart.CartService.addItem`), so normalization is minimal (no `::`/`\` to rewrite), and it reduces under ingest's `terminalName` (last-`.` split) to the bare method name (`addItem`). **Fusion is pure extractor-side** — `landObservedSymbol` (line-in-span primary, `code.function`→`terminalName` tiebreaker) is UNCHANGED; `ingest.ts` is not touched. A two-sided test proves a real PostgreSQL CLIENT span whose `code.*` call site falls inside `addItem` fuses onto the static SymbolNode — one node, both provenances, no twin.

4. **Symbol-grain RCA (ADR-191) reaches Java for free, and `.java` stays out of the JS/TS grammar map.** ADR-191's failure localization and ADR-158's blast-radius / root-cause traversal dispatch on `node.type`, never on language, so "why did this method fail?" and "what depends on this method?" answer at symbol grain on a Java service the moment its spans carry the anchor — nothing in the reasoning core changed. `.java` lands in `symbols.ts`'s own `SYMBOL_GRAMMAR_BY_EXT`, not the exported `GRAMMAR_BY_EXT` its sibling AST producers import, so none of them starts parsing Java. Scope is definitions only: Java's symbol→symbol `CALLS` / `INHERITS` / `IMPLEMENTS` edges, Spring / JAX-RS routes, and the JPA/Hibernate data axis are grain-deepening follow-ons, not this change.

### Consequences

- The otel-demo `ad` service becomes a first-class static node — ServiceNode, a FileNode per `.java` file, and a SymbolNode per method / constructor / type — cold, with zero telemetry. NEAT could see nothing of it before; now it sees its static structure, another of the missing otel-demo languages lit up.
- **Necessary, not sufficient, for observed fusion — extraction climbs now, fusion waits on the installer.** The extractor mints the node and keys it to fuse; whether an observed span *lands* depends on that span carrying the `code.*` anchor, which is a property of the instrumentation, not this extractor. Standard JVM auto-instrumentation stamps no native `code.*`, so the `ad` service's symbols land but stay unfused until NEAT's own installer drops the anchor — a separate rung, the honest caveat this ADR carries.
- Pinned by unit tests: discovery (a Maven `pom.xml` fixture → a `java` ServiceNode named for the `<artifactId>`, with `<parent>` stripped and a version-less managed dependency at ''; a root-level `pom.xml`; a Gradle `build.gradle` → dir basename with `implementation` deps; the Kotlin-DSL `build.gradle.kts` `implementation("…")` form); symbol extraction against a Java fixture (a packaged class with a constructor / instance method / static method, an interface, an enum, a record, plus a second-package file with a nested type) asserting concrete ids / kinds / spans; and the two-sided fusion test that proves the observed edge originates from the static symbol.
- Java is the second grammar added from scratch on the C# template, and the first to show the template's grammar-pin step is a genuine per-language check, not a copy: the sibling's ABI story did not transfer, and only loading the candidate against the runtime settled it.

## ADR-199 — Kotlin language support: discovery, file grain, and symbol grain

**Status:** Accepted. Refs #1034. Builds on ADR-158 (symbol grain), ADR-191 (symbol-grain failure localization), ADR-192 (Python and Go), ADR-193 (Ruby), ADR-195 (PHP), ADR-196 (C#/.NET), ADR-197 (Java), ADR-194 (Dockerfile-declared discovery). Amends [`static-extraction.md`](contracts/static-extraction.md).
**Contract:** [`static-extraction.md`](contracts/static-extraction.md).

### Context

Kotlin is the next of the OpenTelemetry Demo's languages NEAT could not yet see — its `fraud-detection` service is Kotlin (Gradle, `.kt` under `src/main/kotlin/frauddetection/`), and until now it discovered as nothing useful: a Gradle directory was assumed to be Java, so its `.kt` source yielded no symbols. Kotlin is the JVM sibling of Java (ADR-197) and C# (ADR-196), and it takes their template — one grammar dependency at a verified ABI-14 pin, one `SYMBOL_GRAMMAR_BY_EXT` entry, one discovery module, one walker — but with two twists that make it more than a copy. First, Kotlin shares Java's **entire build toolchain**: a Kotlin service carries the *same* Maven `pom.xml` or Gradle `build.gradle` / `build.gradle.kts` a Java one does, so the manifest alone cannot tell the two apart — discovery has to read the source. Second, the grammar is a **community** grammar (fwcd/tree-sitter-kotlin), whose version line (`0.x`) is independent of the official grammars' (`0.2x`), so its ABI could not even be *inferred* from the sibling pins the way one might guess — it had to be loaded and parsed to settle.

### Decision

1. **A JVM build manifest whose source is Kotlin declares a Kotlin service.** `discoverKotlinService` (`extract/kotlin.ts`) runs just ahead of `discoverJavaService` in the discovery chain and claims a directory only when it holds a Maven/Gradle manifest (the shared `hasJavaManifest`, so a JVM directory is already a candidate) **and** a bounded recursive scan finds `.kt` to be the dominant source. Kotlin conventionally lives at `src/main/kotlin/…`, several levels below the manifest, so the discriminator descends rather than reading only the top level (the Dockerfile fallback's precision knob would miss it). A `.java`-dominant directory fails the discriminator and falls through to `discoverJavaService` unchanged — so Java discovery does not regress and nothing double-mints. The POM `<artifactId>` naming, Gradle-basename fallback, and `groupId:artifactId` dependency gates are reused verbatim from `extract/java.ts`; only the language label and the source-based discriminator differ. `.kt` files flow through the unchanged file pipeline as FileNodes (`language: 'kotlin'`).

2. **The grammar is pinned at `tree-sitter-kotlin@0.3.8` — an ABI-14 grammar, verified by loading it, and this time the version number carried no ABI signal at all.** NEAT's runtime is `tree-sitter@^0.21.1`, which loads ABI-14 grammars through a `node-addon-api` binding. `tree-sitter-kotlin` is the fwcd community grammar, and its release line runs `0.0.1` → `0.3.8` — numbers that track its own history, not the official grammars', so unlike Java (where `0.21.0` at least echoed the runtime's major) nothing about the version hinted at the ABI. It had to be checked empirically: `0.3.8` declares `tree-sitter ^0.21.0` as a peer, is built with `tree-sitter-cli 0.22` (ABI-14; ABI-15 only lands in the CLI's `0.23` line), generates a `LANGUAGE_VERSION 14` parser, and ships a `bindings/node` entry that is a plain `require("node-gyp-build")` with no top-level await. Loaded against `tree-sitter@0.21.1` it parses a `.kt` file with zero ERROR nodes, resolving `class_declaration` / `object_declaration` / `companion_object` / `function_declaration` / `secondary_constructor` / `package_header` — proven before the walker was written, not assumed. It is an exact pin, not a caret, the same ABI-14 discipline that pins `tree-sitter-ruby` at `0.21.0` and `tree-sitter-php` at `0.22.8`.

3. **A Kotlin walker mints the same `SymbolNode` shape, keyed to fuse with no ingest change.** `collectKotlinSymbolDefs` reads Kotlin's definition node types into the same `SymbolDef` the other walkers produce. The fwcd grammar folds every type-shaped definition into `class_declaration` — a plain `class`, an `interface`, an `enum class`, a `data class`, and a `sealed class` are all `class_declaration` nodes distinguished only by an anonymous keyword child — so one case mints them all as `class`-kind, `object_declaration` (Kotlin's singleton) joins them, and an anonymous `companion object` is descended into without adding a name segment so its members read under the enclosing type (`FraudService.threshold`, the shape Kotlin itself exposes). A `function_declaration` is a `method` inside a type body and a `function` at file scope — **unlike Java**, Kotlin has real top-level functions, so method-ness is decided by the class context, mirroring the Python/JS walkers rather than Java's always-a-method rule; a `secondary_constructor` mints as a `constructor` named for its enclosing type. The grammar exposes **no `name` / `body` fields**, so a definition's name (`type_identifier` / `simple_identifier`) and body (`class_body` / `enum_class_body`) are found by child node type, not `childForFieldName`. Kotlin's scoping is Java-simple: one file-level `package a.b.c` prefixes every top-level type, so the qualname joins that package and the type nesting with `.` (`com.example.fraud.FraudService.check`) and reduces under ingest's `terminalName` (last-`.` split) to the bare function name (`check`). **Fusion is pure extractor-side** — `landObservedSymbol` (line-in-span primary, `code.function`→`terminalName` tiebreaker) is UNCHANGED; `ingest.ts` is not touched. A two-sided test proves a real PostgreSQL CLIENT span whose `code.*` call site falls inside `check` fuses onto the static SymbolNode — one node, both provenances, no twin.

4. **Symbol-grain RCA (ADR-191) reaches Kotlin for free, and `.kt` stays out of the JS/TS grammar map.** ADR-191's failure localization and ADR-158's blast-radius / root-cause traversal dispatch on `node.type`, never on language, so "why did this method fail?" and "what depends on this method?" answer at symbol grain on a Kotlin service the moment its spans carry the anchor — nothing in the reasoning core changed. `.kt` lands in `symbols.ts`'s own `SYMBOL_GRAMMAR_BY_EXT`, not the exported `GRAMMAR_BY_EXT` its sibling AST producers import, so none of them starts parsing Kotlin. Scope is definitions only: Kotlin's symbol→symbol `CALLS` / `INHERITS` / `IMPLEMENTS` edges, Spring / Ktor routes, and the datastore axis are grain-deepening follow-ons, not this change.

### Consequences

- The otel-demo `fraud-detection` service becomes a first-class static node — ServiceNode, a FileNode per `.kt` file, and a SymbolNode per function / method / constructor / type — cold, with zero telemetry. A Gradle directory that used to be silently mistaken for Java (or extract nothing) now resolves to its true language, another of the missing otel-demo languages lit up.
- **Necessary, not sufficient, for observed fusion — extraction climbs now, fusion waits on the installer.** The extractor mints the node and keys it to fuse; whether an observed span *lands* depends on that span carrying the `code.*` anchor, which is a property of the instrumentation, not this extractor. Standard JVM auto-instrumentation stamps no native `code.*`, so `fraud-detection`'s symbols land but stay unfused until NEAT's own installer drops the anchor — a separate rung, the honest caveat this ADR carries.
- Pinned by unit tests: discovery (a Gradle `build.gradle.kts` whose Kotlin source is nested under `src/main/kotlin/frauddetection` → a `kotlin` ServiceNode named for the directory with `implementation` deps; a Groovy `build.gradle` with `.kt` source still `kotlin`, proving the source decides not the build DSL; a `build.gradle` with `.java` source staying `java`, the no-regression guard; a mixed tree where two `.java` to one `.kt` resolves to `java` on dominance; a Maven `pom.xml` Kotlin service named for its `<artifactId>`); symbol extraction against a Kotlin fixture (a packaged class with a secondary constructor / instance method / companion-object method, an interface, two objects, an enum class, and a data class, plus a second-package file with a nested type and a top-level function) asserting concrete ids / kinds / spans; and the two-sided fusion test that proves the observed edge originates from the static symbol.
- Kotlin is the first language whose grammar is a **community** grammar, and it sharpens ADR-197's lesson to its point: the grammar-pin step is a genuine per-language empirical check, and here even the *version number* carried no ABI signal — the fwcd line is independent of the official grammars, so only loading `0.3.8` against the runtime and parsing a `.kt` file settled that it is ABI-14 and CJS-loadable. It also establishes the shared-manifest discriminator: when two languages share a build toolchain, discovery keys on the source, not the manifest.

## ADR-200 — Nearest-service-wins file ownership: a source file belongs to the deepest discovered service that contains it

**Status:** Accepted. Refs #1033. Builds on ADR-010 (one node per package name), ADR-158 (symbol grain), ADR-092 / file-awareness (`service ──CONTAINS──▶ file`). Amends [`static-extraction.md`](contracts/static-extraction.md).
**Contract:** [`static-extraction.md`](contracts/static-extraction.md).

### Context

`discoverServices` finds a service per directory that carries a manifest. When the root `package.json` has a `name` but no `workspaces`, two things happen at once (`extract/services.ts`): the root itself is pushed as a candidate service at `scanPath`, **and** the depth-bounded recursive walk discovers every nested service under it (`src/ad`, `src/cart`, …). Both survive into the discovered set. Downstream every producer enumerates a service's files from its `dir`, and the root service's `dir` **is the whole repo** — so its file walk descends straight through each nested service's subtree and re-parses those files a second time, re-minting the nested service's symbols (and routes, ORM tables, ConfigNodes, gRPC methods) under the root as well as under the service they actually belong to.

The damage is concrete. On the OpenTelemetry Demo extract, the root JS service `opentelemetry-demo` held 2035 SymbolNodes, of which 1942 (~49% of the whole symbol layer) were duplicates of a real sub-service symbol — including 870 `.go`, 191 `.py`, 71 `.cs`, and 31 `.java` symbols that belong to services the root only *contains* on disk. Those root-scoped copies carry repo-relative paths (`src/cart/index.js`) that never match an observed span's service-relative `code.filepath`, so they are inert phantom nodes: they never fuse, they double-count every per-service inventory, and they make `opentelemetry-demo` falsely appear to depend on every language and every collection in the tree. A single-service repo and a clean `workspaces` monorepo don't hit it — the bug is specific to a named root that also parents discovered services — but that is exactly the otel-demo shape and the shape of any polyglot monorepo whose root ships a `package.json`.

### Decision

1. **A source file is owned by the deepest discovered service directory that contains it.** Ownership is by directory containment, nearest-wins: when two discovered services both contain a file (an ancestor and a descendant), the descendant owns it. An ancestor excludes any subtree that a strictly-deeper discovered service already owns. This is the file-grain analog of ADR-010's one-node-per-name rule — there, two manifests sharing a name collapse to one node; here, one file under two nested services attributes to one owner, the nearest.

2. **`discoverServices` computes the exclusion set; the shared file walks honor it.** After the discovered set is built, each `DiscoveredService` records `excludeDirs` — the absolute directories of the *other* discovered services nested strictly under its own `dir` (`other.startsWith(self + sep)`, resolved paths). The three recursive walk seams — `walkSourceFiles` / `loadSourceFiles` (the source spine every symbol / route / ORM / import / call / action / zod producer rides), `walkProtoFiles` (gRPC methods), and `walkConfigFiles` (ConfigNodes) — take `excludeDirs` and skip a directory whose resolved path is in the set. Skipping at the subtree root drops every file beneath it in one check, so an ancestor never re-enumerates a nested service's source. The exclusion lives at the walk, not in each producer, so symbols and routes and ORM and configs all honor it uniformly or none would.

3. **The rule is uniform across every discovery shape — no special-casing the no-workspaces path.** `excludeDirs` is computed for every service in the discovered set, so a `workspaces` member that happens to nest another discovered service excludes it exactly the way a named root excludes its `src/*` services. A single-service repo, or any leaf service that nests nothing, gets an empty `excludeDirs` and walks its whole tree exactly as before — the fallback recursive walk is untouched when there is nothing to exclude, which is the regression guard.

4. **This changes which files each service sees, not how anything is keyed.** The `SymbolNode` id format (`symbol:<service>:<relpath>#<name>`), the `FileNode` / CONTAINS spine, and every other node/edge id are unchanged; identity still flows through `@neat.is/types` helpers. Fusion is untouched — `ingest.ts` is not edited. The fix removes phantom nodes an ancestor should never have minted; it does not move or re-key a single node that a service legitimately owns. Database parsers already read shallowly at each service root (`findFirst` / a non-recursive `readdir`), so they never re-visited nested subtrees and needed no change.

### Consequences

- The root service's inventory drops to the files it actually owns: on the otel-demo extract the `opentelemetry-demo` JS root goes from 2035 SymbolNodes to ~93 (the ~1942 cross-service duplicates disappear), and its spurious `.go` / `.py` / `.cs` / `.java` symbols and cross-language dependencies vanish with them. Each nested service still owns its own symbols, once.
- Per-service counts stop double-inflating and `get_dependencies` / blast-radius on the root stop over-reporting. The removed nodes were inert (they never fused), so nothing that was fusing stops — the OBSERVED layer is unaffected, which is why the fix is a pure discovery-side change that never touches `ingest.ts`.
- Pinned by unit tests: a root `package.json` (name, no workspaces) nesting a JS sub-service and a Python sub-service asserts the root records both nested dirs on `excludeDirs`, claims none of their files/symbols, that each nested service claims its own, and that every symbol is minted exactly once; plus a single-service regression fixture proving a repo with no nested services still walks its whole tree (deep source in `src/lib/util.js` still grains) so the fallback path is guarded.
- The exclusion is set-membership at directory boundaries, so it composes: a service nested three deep excludes only its own nested services, and an ancestor two levels up excludes the whole chain because it skips the nearest subtree root before ever descending to the deeper ones.

## ADR-201 — Rust language support: discovery, file grain, and symbol grain

**Status:** Accepted. Refs #1038. Builds on ADR-158 (symbol grain), ADR-191 (symbol-grain failure localization), ADR-192 (Python and Go), ADR-193 (Ruby), ADR-195 (PHP), ADR-196 (C#/.NET), ADR-197 (Java), ADR-199 (Kotlin). Amends [`static-extraction.md`](contracts/static-extraction.md).
**Contract:** [`static-extraction.md`](contracts/static-extraction.md).

### Context

Rust is the next of the OpenTelemetry Demo's languages NEAT could not yet see — its `shipping` service is a Cargo crate (`Cargo.toml` plus `.rs` under `src/`), and until now that directory discovered as nothing and its `.rs` source yielded no symbols. It takes the sibling template — one grammar dependency at a verified ABI-14 pin, one `SYMBOL_GRAMMAR_BY_EXT` entry, one discovery module, one walker — but two things make it more than a copy. First, the manifest is TOML, and NEAT already parses TOML (`pyproject.toml`, `wrangler.toml`, `railway.toml`) with `smol-toml`, so unlike Java's regex-scanned XML/Gradle the Cargo reader uses that parser and adds no dependency. Second, and the sharper point: Rust addresses its items with `::`, and this walker keeps that native form in the qualname rather than normalizing it to `.` the way the Ruby and PHP walkers rewrite their separators — a deliberate choice that leans the whole fusion story onto the primary key, because a `::`-addressed name defeats ingest's `terminalName` tiebreaker. Rust is the language that proves line-in-span carries fusion on its own. After Rust, only C++ remains of the otel-demo languages.

### Decision

1. **A `Cargo.toml` directory declares a Rust service.** `discoverRustService` (`extract/rust.ts`) claims a directory that holds a `Cargo.toml` — a fixed filename, so it rides the same `exists` predicate the Go/Ruby/Java readers use (`hasRustManifest`, reused by the Dockerfile fallback's manifest check), not the directory glob C# needs (ADR-196). Cargo's `[package] name` names the service; a virtual-workspace manifest (a `[workspace]` with no `[package]`) carries no name here, so it falls back to the directory basename the way a Gradle build or a Gemfile does. Each `[dependencies]` entry registers as a `crate → version` gate — the string form (`serde = "1.0"`) and the inline-table form (`tokio = { version = "1", … }`) both read, a path/git source with no version at `''` — the gate a later Axum / Actix / SQLx recognizer would key on. The manifest is read with `smol-toml`, the parser `extract/python.ts` already reads `pyproject.toml` with, so no hand-rolled scan and no new package; a malformed manifest is swallowed to an empty result rather than thrown, so one bad `Cargo.toml` can't abort a whole-repo walk. `.rs` files flow through the unchanged file pipeline as FileNodes (`language: 'rust'`).

2. **The grammar is pinned at `tree-sitter-rust@0.21.0` — an ABI-14 grammar, verified by loading it, and the pin is forced by the publish history.** NEAT's runtime is `tree-sitter@^0.21.1`, which loads ABI-14 grammars through a `node-addon-api` binding. `tree-sitter-rust`'s published line runs `0.1.0` → `0.21.0` and then jumps straight to `0.23.0` — there is no `0.22.x` — so `0.21.0` is the single release that both generates a `LANGUAGE_VERSION 14` parser and ships a `require()`-able binding under the pinned runtime; `0.23`+ moves to ABI-15 and an ESM-with-top-level-await binding a CJS `require()` can't import. It was checked empirically the same way the sibling grammars are: loaded against `tree-sitter@0.21.1` it parses a `.rs` file with zero ERROR nodes, resolving `function_item` / `impl_item` / `struct_item` / `enum_item` / `trait_item` / `mod_item` (including nested modules) — proven before the walker was written, not assumed. It is an exact pin, not a caret, the same ABI-14 discipline that pins `tree-sitter-ruby` at `0.21.0` and `tree-sitter-php` at `0.22.8`.

3. **A Rust walker mints the same `SymbolNode` shape, keyed to fuse on line-in-span alone.** `collectRustSymbolDefs` reads Rust's definition node types into the same `SymbolDef` the other walkers produce. A `function_item` is a `function` at module/file scope and a `method` inside an `impl_item` or a `trait_item` (a trait's `function_item` default methods and its `function_signature_item` abstract declarations both mint as `method`, the way Kotlin's abstract interface method does). Rust has **no constructor keyword** — an associated `fn new()` is just an associated function — so everything inside an `impl` mints as `method` with no `constructor` case, the SymbolKind vocabulary reused, not extended. `struct_item`, `enum_item`, and `trait_item` mint as `class`-kind nodes, the class-shaped definition / heritage targets Rust has, mirroring how Java maps interface/enum/record and C# maps struct/record/interface. A `mod_item` is a **namespace only** — it scopes the qualname but is not itself a symbol, the way a Java `package` scopes without minting. **The qualname keeps Rust's native `::`**: a module's items read `module::item`, an impl's methods read `module::Type::method` keyed on the impl's target type, a nested module threads `outer::inner::item` — unlike the Ruby/PHP walkers, which rewrite `::`/`\`/`#` to `.`. **Fusion is pure extractor-side** — `landObservedSymbol` (line-in-span primary, `code.function`→`terminalName` tiebreaker) is UNCHANGED; `ingest.ts` is not touched. Because the qualname carries `::`, `terminalName` (a last-`.` split) leaves it whole, so a `::`-addressed Rust `code.function` matches no candidate's terminal name — which is exactly the case that proves the primary key stands alone: line-in-span (the observed `code.lineno` inside a SymbolNode's definition span) lands the edge regardless of separator. A two-sided test proves a real SQLx/PostgreSQL CLIENT span whose `::`-addressed `code.*` call site falls inside `price` fuses onto the static SymbolNode — one node, both provenances, no twin.

4. **Symbol-grain RCA (ADR-191) reaches Rust for free, and `.rs` stays out of the JS/TS grammar map.** ADR-191's failure localization and ADR-158's blast-radius / root-cause traversal dispatch on `node.type`, never on language, so "why did this method fail?" and "what depends on this method?" answer at symbol grain on a Rust service the moment its spans carry the anchor — nothing in the reasoning core changed. `.rs` lands in `symbols.ts`'s own `SYMBOL_GRAMMAR_BY_EXT`, not the exported `GRAMMAR_BY_EXT` its sibling AST producers import, so none of them starts parsing Rust. Scope is definitions only: Rust's symbol→symbol `CALLS` / `IMPLEMENTS` edges, Axum / Actix routes, and the SQLx/Diesel data axis are grain-deepening follow-ons, not this change.

### Consequences

- The otel-demo `shipping` service becomes a first-class static node — a ServiceNode, a FileNode per `.rs` file, and a SymbolNode per free function / impl method / trait method / struct / enum / trait — cold, with zero telemetry. Another of the missing otel-demo languages lit up; only C++ is left.
- **Necessary, not sufficient, for observed fusion — extraction climbs now, fusion waits on the installer.** The extractor mints the node and keys it to fuse; whether an observed span *lands* depends on that span carrying the `code.*` anchor, which is a property of the instrumentation, not this extractor. Standard Rust auto-instrumentation stamps no native `code.*`, so `shipping`'s symbols land but stay unfused until NEAT's own installer drops the anchor — a separate rung, the honest caveat this ADR carries.
- Pinned by unit tests: discovery (a Cargo service named after its `[package] name` with string / inline-table / git dependency gates; a project whose `Cargo.toml` sits at the scan root; a virtual-workspace manifest with no `[package]` falling back to the directory basename; a Go service beside a Rust one still discovering, the no-shadow guard); symbol extraction against a Rust fixture (a module carrying a struct, a trait with an abstract signature and a default method, an inherent impl, an enum, and a nested module with a free function, plus a top-level function and a second file's file-scope struct/impl) asserting concrete ids / kinds / spans and the `::` keying; and the two-sided fusion test that proves the observed edge originates from the static symbol on line-in-span alone.
- Rust is the language that proves the fusion key is **separator-agnostic**. Keeping the native `::` and letting the `code.function` tiebreaker miss on purpose shows the primary key — line-in-span — carries fusion without the terminal-name reduction every sibling relied on. It is the cleanest demonstration that ADR-158's span containment, not the qualname string, is what makes an observed span land on a static symbol.

## ADR-202 — C++ language support: discovery, file grain, and symbol grain

**Status:** Accepted. Refs #1040. Builds on ADR-158 (symbol grain), ADR-191 (symbol-grain failure localization), ADR-192 (Python and Go), ADR-193 (Ruby), ADR-195 (PHP), ADR-196 (C#/.NET), ADR-197 (Java), ADR-199 (Kotlin), ADR-201 (Rust). Amends [`static-extraction.md`](contracts/static-extraction.md).
**Contract:** [`static-extraction.md`](contracts/static-extraction.md).

### Context

C++ is the last of the OpenTelemetry Demo's languages NEAT could not yet see — its `currency` service is a CMake project (`CMakeLists.txt` plus `src/server.cpp` and `*_common.h` headers), and until now that directory discovered as nothing and its `.cpp` source yielded no symbols. It takes the sibling template — one grammar dependency at a verified ABI-14 pin, one `SYMBOL_GRAMMAR_BY_EXT` entry, one discovery module, one walker — but two things make it more than a copy. First, C++ has **no single clean manifest** the way Cargo/Maven/composer.json name a service: the marker is `CMakeLists.txt` and the name comes from its `project(<name> …)` directive, read with a targeted regex (there is no TOML/JSON to parse), falling back to the directory basename. Second, the ambiguous-extension problem: `.h` and `.c` are shared with C, a language NEAT does not add, so claiming them globally in the extension→grammar map would parse pure-C headers with the C++ grammar and mislabel them. The walker also has to read C++'s own shape — a `function_definition` carries its name **inside** its `function_declarator`, not in a `name` field, and an out-of-line member definition (`ReturnType Class::method(…)` at file scope) carries the class in a `qualified_identifier` — neither of which any sibling walker had to navigate. Like Rust, C++ addresses members with `::` and this walker keeps that native form, leaning fusion onto the primary key. After C++, the whole otel-demo language set fuses at symbol grain.

### Decision

1. **A `CMakeLists.txt` directory declares a C++ service.** `discoverCppService` (`extract/cpp.ts`) claims a directory that holds a `CMakeLists.txt` — a fixed filename, so it rides the same `exists` predicate the Go/Ruby/Java/Rust readers use (`hasCppManifest`, reused by the Dockerfile fallback's manifest check), not the directory glob C# needs (ADR-196). The service name is the first token of the `project(<name> …)` directive (`parseCMakeProjectName`, a comment-stripped regex read — CMake keywords like `VERSION`/`LANGUAGES` always follow the name, so the first token is always the name; a variable-reference name like `${FOO}` matches nothing and falls back); a `CMakeLists.txt` with no usable `project()` name takes the directory basename the way a Gradle build or a Gemfile does. C++ has no dependency-manifest analog this reader parses, so `dependencies` is left empty — CMake's `find_package` / `target_link_libraries` are a later gate if a route/data recognizer ever needs one. `.cpp` files flow through the unchanged file pipeline as FileNodes (`language: 'cpp'`). A `currency` service discovered instead via ADR-194's Dockerfile-declared path still reaches symbol grain, because the symbol grain keys off the file extension, not the discovery route.

2. **The grammar is pinned at `tree-sitter-cpp@0.22.3` — an ABI-14 grammar, verified by loading it.** NEAT's runtime is `tree-sitter@^0.21.1`, which loads ABI-14 grammars through a `node-addon-api` binding. `tree-sitter-cpp`'s `0.22.3` release generates a `LANGUAGE_VERSION 14` parser and ships a `require()`-able `node-gyp-build` (CJS) binding declaring `tree-sitter ^0.21.1` — it was loaded against the pinned runtime and parsed a `.cpp` file with zero ERROR nodes, resolving `function_definition` / `class_specifier` / `struct_specifier` / `namespace_definition` / `template_declaration` and the `declarator` / `type` / `name` / `body` fields the walker navigates, before the walker was written. (Unlike the sibling grammars whose next line jumps to an ESM-with-top-level-await binding, `tree-sitter-cpp` keeps a CJS binding even on its `0.23.x` line; `0.22.3` is chosen as the newest `0.22.x` for parity with the `tree-sitter-php@0.22.8` pin and to stay on the same ABI-14 generation as the rest of the grammar set.) `tree-sitter-cpp` bundles its own C grammar and is self-contained. It is an exact pin, not a caret, the same discipline that pins `tree-sitter-ruby` at `0.21.0` and `tree-sitter-php` at `0.22.8`.

3. **Only the unambiguous C++ extensions enter the grammar map; `.h`/`.c` stay out.** `SYMBOL_GRAMMAR_BY_EXT` gains `.cpp` / `.cc` / `.cxx` / `.c++` (implementation) and `.hpp` / `.hh` / `.hxx` / `.h++` (C++-only headers) → the Cpp grammar; the same set joins `SERVICE_FILE_EXTENSIONS` so the source walk reads them. `.h` and `.c` are **deliberately not claimed**: they are shared with C, and the map is global (the symbol grain dispatches on extension, not on the owning service's language), so claiming `.h` would parse every pure-C header in any repo with the C++ grammar and mislabel it `cpp`. The cost is nil for the target — `currency`'s executable code lives in `src/server.cpp` (a `.cpp`), the file whose functions run and carry the observed `code.*` anchor; its `*_common.h` headers hold OTel setup boilerplate, not the fusion target. A `.h` sitting beside `.cpp` in a service already identified as C++ is the only case that would benefit, and resolving that needs per-service extension arbitration the flat map doesn't have — a follow-on, not this slice.

4. **A C++ walker mints the same `SymbolNode` shape, keyed to fuse on line-in-span alone.** `collectCppSymbolDefs` reads C++'s definition node types into the same `SymbolDef` the other walkers produce. A `function_definition` is a `function` at namespace/file scope and a `method` inside a `class_specifier` / `struct_specifier` body; a `function_definition` whose declarator name equals its enclosing class name is a `constructor`, and a destructor (`~Name`) maps to `method` (the SymbolKind vocabulary is reused, not extended). The name lives inside the `function_declarator` (C++ has no `name` field on `function_definition`), unwrapping a `pointer_declarator` / `reference_declarator` return type to reach it; an **out-of-line member definition** at file/namespace scope (`ReturnType Class::method(…)`) carries a `qualified_identifier` declarator, so its class is read from the qualified path and the method keys onto that class (`Money::Money` out-of-line still a `constructor`, `Money::~Money` a `method`). `class_specifier` and `struct_specifier` mint as `class`-kind nodes — the class-shaped definition / heritage targets, mirroring how Java maps interface/enum/record and Rust maps struct/enum/trait. A `namespace_definition` is a **namespace only** — it scopes the qualname but is not itself a symbol, the way a Rust `mod_item` or a Java `package` scopes without minting. A `template_declaration` wraps a function or class, so the walker descends to the inner definition and mints that. **The qualname keeps C++'s native `::`**: a namespace's items read `ns::item`, a class's methods read `ns::Class::method`, a nested namespace threads `outer::inner::item` — unlike the Ruby/PHP walkers, which rewrite their separators to `.`. **Fusion is pure extractor-side** — `landObservedSymbol` (line-in-span primary, `code.function`→`terminalName` tiebreaker) is UNCHANGED; `ingest.ts` is not touched. Because the qualname carries `::`, `terminalName` (a last-`.` split) leaves it whole, so a `::`-addressed C++ `code.function` matches no candidate's terminal name and the observed span lands on line-in-span alone — the same case Rust (ADR-201) proved the primary key stands on. A two-sided test proves a real CLIENT span whose `::`-addressed `code.*` call site falls inside a method fuses onto the static SymbolNode — one node, both provenances, no twin.

### Consequences

- The otel-demo `currency` service becomes a first-class static node — a ServiceNode, a FileNode per `.cpp`/`.hpp` file, and a SymbolNode per free function / method / constructor / class / struct — cold, with zero telemetry. The last missing otel-demo language lit up: the whole demo now reaches symbol grain.
- **Necessary, not sufficient, for observed fusion — extraction climbs now, fusion waits on the installer.** The extractor mints the node and keys it to fuse; whether an observed span *lands* depends on that span carrying the `code.*` anchor, which is a property of the instrumentation, not this extractor. Standard C++ auto-instrumentation stamps no native `code.*`, so `currency`'s symbols land but stay unfused until NEAT's own installer drops the anchor — a separate rung, the honest caveat this ADR carries.
- **`.h`/`.c` are conservatively unclaimed**, so a pure-C repo is never mislabeled `cpp` at symbol grain and a C++ service's `.h`-declared inline definitions are the one gap — acceptable, since definitions that run live in `.cpp` and the fusion anchor rides the running code. Widening to per-service `.h` arbitration is a named follow-on.
- Pinned by unit tests: discovery (a `CMakeLists.txt` directory named after its `project()` directive; a `project()`-less manifest falling back to the directory basename; a C++ project whose `CMakeLists.txt` sits at the scan root; a Go service beside a C++ one still discovering, the no-shadow guard); symbol extraction against a C++ fixture (a namespace with a free function, a class with methods and a constructor, an out-of-line `Class::method` definition, and a template function) asserting concrete ids / kinds / spans and the `::` keying; and the two-sided fusion test that proves the observed edge originates from the static symbol on line-in-span alone.
- C++ closes the otel-demo compat loop the language program (ADR-192 → ADR-201) walked service by service. Every language the demo ships now discovers, grains to files, and grains to symbols; what remains for each is the route/data axis and the installer's file-grain `code.*` drop — grain-deepening follow-ons, not new-language work.

## ADR-203 — Static Kafka topic recognizer for Go Sarama producers and consumers

**Status:** Accepted. Refs #1042. Builds on ADR-032 (static-extraction contract), ADR-065 (precision filters + loud failure), ADR-066 (confidence tiers), ADR-089 (file-first), ADR-123 (proto read-as-data), ADR-154/ADR-184 (Go raw-SQL read-as-data). Amends [`static-extraction.md`](contracts/static-extraction.md).
**Contract:** [`static-extraction.md`](contracts/static-extraction.md).

### Context

The otel-demo fusion map surfaced an orphaned edge: the observed replay has `checkout` PUBLISHES_TO `infra:kafka-topic:orders` and downstream services CONSUME_FROM it, but the `orders` topic carried no static twin, so the observed queue topology hung off a node nothing declared. The cause is language coverage in one recognizer. `extract/calls/kafka.ts` is regex-based and matches only the JS shapes — `producer.send({ topic: 'x' })` for kafkajs / node-rdkafka. `checkout` is a Go service on the Sarama client, whose `sarama.ProducerMessage{Topic: "orders"}` shape the JS regexes never see. Because kafka fusion lands on the topic node id (`infra:kafka-topic:<topic>`, the same id an OBSERVED `messaging.destination.name` span mints, per ADR-179), a missing EXTRACTED twin doesn't degrade gracefully — there is simply nothing for the observed edge to fuse onto, and the declared side of the queue goes dark. This is a coverage gap, not a design gap: the identity and the fusion seam already exist; only the Go shape was unread.

### Decision

1. **The kafka recognizer reads Go Sarama call sites as data, minting the same topic node.** `kafkaEndpointsFromFile` dispatches on file extension: `.go` files run a Go Sarama pass, everything else keeps the unchanged JS regexes. The Go pass is text-scan recognition — the same "polyglot files are read, the extractor stays TypeScript" approach `proto.ts` (ADR-123) and the Go raw-SQL reader (ADR-154/184) already use, adding no grammar and no language to the toolchain. It mints the identical `ExternalEndpoint` — `infraId('kafka-topic', <topic>)`, `kind: 'kafka-topic'`, `verified-call-site` confidence (ADR-066), `evidence.file` on every edge — so a Go-declared topic and its observed twin fuse on one node exactly as the JS path's do.

2. **Producer → PUBLISHES_TO.** `sarama.ProducerMessage{Topic: "orders"}` (sync `SendMessage`) and the async `producer.Input() <- &sarama.ProducerMessage{Topic: topicVar}` form both mint a PUBLISHES_TO edge. The `Topic` field is read from anywhere in the struct literal within a bounded window. A string-literal topic (interpreted `"x"` or raw `` `x` ``) is taken verbatim; a bare-identifier topic is resolved to an in-file literal — `topic := "orders"`, `topic = "orders"`, a `const KafkaTopic = "orders"` (including const-block members), or a typed `var topic string = "orders"`. A topic with no in-file literal RHS — `os.Getenv("KAFKA_TOPIC")`, any computed string — stays **unextracted rather than guessed** (ADR-089 §6: evidence is never fabricated). NEAT declines to invent a topic name it cannot see.

3. **Consumer group → CONSUMES_FROM.** `consumerGroup.Consume(ctx, []string{"orders"}, handler)` mints a CONSUMES_FROM edge per topic in the `[]string{...}` argument; literals are read directly and bare identifiers inside the slice resolve through the same in-file literal lookup as the producer path. A slice built in a separate variable and passed by name is a named follow-on, not this slice.

4. **Everything is gated on a real Sarama import.** The Go pass is a no-op unless the file imports a `.../sarama` path (IBM or Shopify fork). Without the gate an arbitrary Go struct named `ProducerMessage` or any unrelated `.Consume(...)` method would mint a phantom topic — the same structural-import gate `calls/go.ts` and `routes.ts` use to keep a common method name from over-matching. Comment bodies are already masked before the recognizer runs (ADR-065 §2, `maskCommentsInSource` in the calls orchestrator), so a topic named only inside a `//` or `/* */` comment never mints. **This is extractor-side only: `ingest.ts` is untouched** — the observed side already lands on `infra:kafka-topic:<topic>`; the fix is purely to make the declared side reach the same node.

### Consequences

- The otel-demo `checkout` service's `orders` publish now has a static twin, so the observed PUBLISHES_TO / CONSUMES_FROM edges fuse onto a declared node instead of orphaning — the queue topology reads as one model, both provenances, no twin. This is the divergence seam working as designed: the gap was visible precisely because fusion keys on the shared node id.
- Pinned by unit tests over a Go fixture set (realistic `checkout` / `fraud-detection` service names): a `ProducerMessage{Topic: "orders"}` literal mints `infra:kafka-topic:orders` + PUBLISHES_TO with `evidence.file` on the `.go` file; a `const`-resolved topic (`payments`) mints from its in-file literal; an env-only topic mints nothing (the file publishes to exactly the two topics it names in source); a comment-body topic mints nothing; and a consumer-group `Consume(ctx, []string{"orders"}, …)` mints CONSUMES_FROM. The existing kafkajs JS tests are unchanged, so JS matching does not regress.
- The Go raw-SQL reader (ADR-154/184) and this Kafka reader now both read Go call sites as data from `extract/calls/`, one gated on `database/sql`/`sqlx`, the other on `sarama`. Go's other messaging clients (`confluent-kafka-go`, `segmentio/kafka-go`) and the older `sarama.NewConsumer().ConsumePartition(topic, …)` shape are named follow-ons; the Sarama consumer-group + producer path is the otel-demo shape and the one that closes this gap.

## ADR-204 — Next.js API-route fusion: read the templated route from `next.span_name`

**Status:** Accepted. Refs #1043. Builds on ADR-119 (route extraction + route-grain fusion) and the SERVER-span route-grain edge (#576). Amends [`otel-ingest.md`](contracts/otel-ingest.md).
**Contract:** [`otel-ingest.md`](contracts/otel-ingest.md).

### Context

A Next.js frontend's API routes extract cleanly — `app/**/route.ts` and `pages/api/**` mint RouteNodes like `route:frontend:ALL /api/products/:productId` — but none of them fused with their observed traffic, even under tens of thousands of `/api/*` spans. The route-fusion path keys off `http.route`, and Next.js doesn't put the matched template there. For an API-route serving span it names the template in `next.span_name` (mirrored on the span's own name): `executing api route (pages) /api/products/[productId]` for the Pages Router, `executing api route (app) /api/products/[productId]` for the App Router. The transport span's `http.target` carries only the concrete path (`/api/products/L9ECAV7KIM`), which `normalizePathTemplate` can't reduce to the `:productId` template — a concrete id segment collapses to `:param` only when it's all-digits / uuid / long-hex, and an opaque product id is none of those. So the fusion key never matched and the declared route stayed cold: 8 static RouteNodes, 0 fused, against a live `/api/*` stream.

### Decision

1. **The route-fusion path reads `next.span_name` as a templated-route source, preferred over the concrete path.** In `ingest.ts`, `nextApiRouteTemplate(span)` matches `next.span_name` (falling back to the span name, where Next mirrors the same string) against `executing api route (pages|app) <route>` and returns `<route>` — the templated form, `[productId]` brackets and all. The SERVER-span fusion block uses `nextApiRouteTemplate(span) ?? span.httpRoute` as the route it hands `findRouteNodeByHttpRoute`, so a Next route fuses on its template the way an Express route fuses on `http.route`. The change is confined to the route-fusion functions; `landObservedSymbol` and the whole symbol-fusion path are untouched.

2. **`normalizePathTemplate` already collapses Next's bracket syntax.** A dynamic `[productId]`, a catch-all `[...slug]`, and an optional-catch-all `[[...slug]]` each reduce to `:param` — the same key `:productId` / `{productId}` / `<int:productId>` reduce to — because `isDynamicSegment` already treats any `[`-leading segment as dynamic. So the templated route from `next.span_name` matches the declared RouteNode's `pathTemplate`: `normalizePathTemplate('/api/products/[productId]') === normalizePathTemplate('/api/products/:productId')`. This decision records and locks that coverage with direct unit tests; no new branch was needed.

3. **Additive, not a replacement.** Only a span carrying the `executing api route (…)` phrase takes the Next path; every other span falls back to `http.route` and fuses exactly as before, so Express / FastAPI / NestJS / Go behavior is unchanged. A route NEAT never extracted still mints nothing — an unmatched Next template lands on no node, the same honest floor the SERVER-span edge already held. This only makes the *existing* static RouteNodes matchable; minting observed-only RouteNodes for served-but-undeclared routes stays a follow-on.

### Consequences

- A Next.js frontend's declared API routes gain their OBSERVED twin, so `get_divergences` compares declared against served at route grain for Next the way it already did for Express and FastAPI — the frontend stops looking dead under load.
- The template lives in a framework-specific attribute, so this is a Next.js recognizer sitting inside the route-fusion path, not a general HTTP change. Other frameworks that hide the matched template off `http.route` are separate, additive recognizers on the same seam.
- Pinned by tests: a Pages-Router and an App-Router `executing api route (…)` span — one carrier via the span name, one via the `next.span_name` attribute — each fusing onto the extracted RouteNode as one node with both provenances; a catch-all `[...slug]` route fusing; a plain `http.route` span still fusing (the additive guard); and `normalizePathTemplate` unit-equivalence for `[param]` / `[...param]` / `[[...param]]` against `:param`.

## ADR-205 — C# datastore recognizers: EF Core/Npgsql tables + StackExchange.Redis/Valkey connections

**Status:** Accepted; id scheme refined by ADR-207 (DatabaseNode id keys on host alone, an unresolvable host mints no node). Refs #1045. Builds on ADR-141 (declared DB host fusion), ADR-152 (table recovered from `db.statement`), ADR-157 §3 (declared columns), ADR-180 (GORM data axis, the closest sibling), ADR-196 (C#/.NET discovery + symbol grain). Amends [`static-extraction.md`](contracts/static-extraction.md).
**Contract:** [`static-extraction.md`](contracts/static-extraction.md).

### Context

NEAT read datastores for the JS ORMs (Prisma/Drizzle/Knex/Sequelize/TypeORM), Python (SQLAlchemy/Django), Go (GORM + raw `database/sql`), Ruby (ActiveRecord), PHP (Eloquent), and a Redis URL literal — but nothing read **C#**. On the otel-demo fusion map that left three OBSERVED datastore nodes orphaned, with no EXTRACTED twin at the matching id to fuse onto: `accounting` (C#/.NET) CONNECTS_TO `database:postgresql` and CALLS `infra:sql-table:orderitem`; `cart` (C#/.NET) CONNECTS_TO `database:valkey-cart`. ADR-196 gave C# discovery, file grain, and symbol grain, but not the datastore axis — so an OBSERVED db span had a node to point at while the declared side stayed silent, exactly the twin-instead-of-fuse gap the other languages' data axes close. The two real shapes: EF Core over Npgsql (a `DbContext` with `DbSet<T>` properties, entities carrying `[Table("orderitem")]` annotations, `UseNpgsql(connectionString)`), and StackExchange.Redis against a Valkey store (`ConnectionMultiplexer.Connect`, address from `VALKEY_ADDR`).

### Decision

1. **Two recognizers, split across the two producer families the way every datastore already is.** `calls/efcore.ts` is the **table axis** (`infra:sql-table:<name>` + CALLS, the EF Core sibling of `calls/gorm.ts`); `databases/csharp.ts` is the **connection axis** (`DatabaseNode` + CONNECTS_TO, the C# sibling of `prisma.ts`), registered in `databases/index.ts` beside the JS-ORM parsers. Both are extractor-side — **`ingest.ts` is untouched**.

2. **The table name is read as a LITERAL, never derived.** This is the load-bearing difference from GORM (ADR-180), where the table is *derived* from the struct name and the pluralizer must match byte-for-byte or the node is false. EF Core's fusion-anchored table name is **explicit** — a `[Table("orderitem", Schema = "accounting")]` data annotation or a `modelBuilder.Entity<T>().ToTable("orderitem")` fluent call — so `calls/efcore.ts` parses `.cs` with tree-sitter-c-sharp (the raw file, so `//` / `/* */` comments are `comment` nodes, excluded structurally) and reads the string literal directly. A `[Table(nameof(X))]` or a keyword-only `[Table(Schema = "s")]` carries no positional string and is left unclaimed rather than guessed. One `infra:sql-table:<name>` per distinct literal at `structural` (0.85) confidence. `orderitem` matches the OBSERVED table (recovered from `db.statement` the way ADR-152 recovers SQLAlchemy's) because both are the same explicit string.

3. **Table grain only — no columns.** EF Core column names are convention-transformed (`UseSnakeCaseNamingConvention()` and friends, configured in the `DbContext`, a *different file* than the entity), so unlike GORM's per-field tags a per-file column read can't see the active convention. A partial column set would manufacture false column-drift (declaring only the `[Column("order_id")]`-annotated columns exist), so columns are deferred; the OBSERVED side anchors them regardless. Convention-derived table names (a `DbSet<T>` with no `[Table]`) are deferred for the same "can't see the convention" reason.

4. **The connection axis keys the `DatabaseNode` on the resolved peer host, so the twin lands on the same `database:<host>` id ingest already minted** (`ingest.ts` keys a db span on `server.address` / `net.peer.name` via `databaseId`). `databases/csharp.ts` recognizes Npgsql (`UseNpgsql(<conn>)`) → Postgres, host parsed from the ADO.NET keyword string's `Host=` (or a `postgres://` URL); and StackExchange.Redis (`ConnectionMultiplexer.Connect` / `ConfigurationOptions.Parse`) → Redis/Valkey, host the token before the endpoint's first `:`/`,`. Valkey is Redis-wire-compatible, so `db.system` is `redis` and the store keys on its own host (`valkey-cart`) like any Redis peer — engine `redis`.

5. **The scan is service-wide, and env-indirected connection strings resolve up to the repo root.** The client call and the address often live in different files — cart reads `VALKEY_ADDR` in `Program.cs` but calls `ConnectionMultiplexer.Connect` in `cartstore/ValkeyCartStore.cs` — so literals and `IConfiguration`/env keys are pooled across every `.cs` file, with the client-call file remembered as the connection's origin (the CONNECTS_TO source). The shape gates (a Postgres keyword/URL string vs a Redis `host:port` endpoint) keep the two engines' pools disjoint despite the shared pool. An indirected value is resolved from the service's `.env`, **walking up to the repo root** (`.git`) — the otel-demo keeps `DB_CONNECTION_STRING` / `VALKEY_ADDR` in a root `.env`/compose above each service dir — with one level of `${VAR}` interpolation. ADR-207 refines this axis: the id keys on the resolved host **alone** (engine as an attribute, no driver suffix), **every** genuinely declared host is extracted (the cart's `badhost:1234` fault-probe is a real declared peer, not a phantom), and a client with no resolvable host at all is **skipped** — never backfilled with a fabricated placeholder.

### Consequences

- The otel-demo `accounting` service mints `database:postgresql` + `infra:sql-table:orderitem` (and `order`, `shipping`) and the `cart` service mints `database:valkey-cart` — the exact ids their OBSERVED CONNECTS_TO / CALLS edges already carry, so the two layers fuse instead of twinning. Minted ids are constructed only through the identity helpers (`databaseId`, `infraId`), so they equal the observed ids by construction, not by coincidence.
- **Fusion caveat on the postgres host.** The host is whatever the connection string's `Host=` resolves to. In the *current* otel-demo compose that is `Host=${POSTGRES_HOST}` → `astronomy-db`, while the fusion-map `database:postgresql` reflects a deployment where the peer resolved to `postgresql`. The recognizer keys on the string it can resolve, so the twin fuses when (and only when) the extracted `Host=` equals the string the OBSERVED span's `server.address` carried — the honest limit of static host recovery when the host is deployment-configured outside the source. Valkey's host (`valkey-cart`) is recoverable because `VALKEY_ADDR`'s value names it directly in the reachable root `.env`.
- Pinned by unit + e2e tests (`extract-csharp-datastore.test.ts`, 18 cases): `[Table]` / `ToTable` / verbatim / qualified-name reads, the `nameof` and comment-body negatives, the gate declining a stray `[Table]` with no EF signal; the Npgsql literal and env-driven (with `${VAR}` interpolation) connection strings, the StackExchange.Redis literal and the cross-file (`VALKEY_ADDR` in one file, `Connect` in another) case, the two-declared-peers case (config-driven `valkey-cart` + the genuine `badhost:1234` fault-probe both mint), and the no-fabricated-placeholder negative (a client with no resolvable host mints nothing); and an end-to-end `extractFromDirectory` over an otel-demo-shaped tree asserting the concrete ids, engines, and the file-grained CONNECTS_TO / CALLS edges with `evidence.file`.
- ASP.NET Core routes, EF Core column grain, the convention-derived table fallback, C#'s `using`-graph, and file-grain call-site stamping stay unmodelled — named follow-ons, not this slice.

## ADR-206 — Route recognizers for Rust Actix-Web, PHP Slim, and Ruby Rack/Sinatra

**Status:** Accepted. Refs #1047. Builds on ADR-119 (RouteNode grain), ADR-173 (Rails routes), ADR-177 (Laravel routes), ADR-181/ADR-182 (Go route recognizers), ADR-201 (Rust language support). Amends [`static-extraction.md`](contracts/static-extraction.md).
**Contract:** [`static-extraction.md`](contracts/static-extraction.md).

> ADR numbering note: 206 is the genuine next-free number at land time — 203 (Kafka), 204 (frontend fusion), and 205 (C# datastores) were taken by sibling v0.9.1 PRs merging in parallel. If a later collision surfaces, keep both and renumber by ascending merge order (this one is the route-recognizer ADR). Reconfirm against `docs/decisions.md` tail before merge.

### Context

On the OpenTelemetry Demo fusion map, three services serve real HTTP endpoints whose `http.route` server spans could not fuse, because the route extractor minted no static twin for them. Each is a framework NEAT's route reader did not yet recognize: `shipping` (Rust) serves `/get-quote` and `/ship-order` under Actix-Web (776 Server spans, scope `opentelemetry-instrumentation-actix-web`) and had **no** Rust route recognizer at all — ADR-201 took Rust to symbol grain but not route grain; `quote` (PHP) serves `POST /getquote` under Slim (scope `io.opentelemetry.contrib.php.slim`), which our Laravel-shaped PHP reader (ADR-177) misses because Slim declares routes on an `$app` value rather than the `Route` facade in conventional files; `email` (Ruby) serves `POST /send_order_confirmation` under Sinatra/Rack (scope `OpenTelemetry::Instrumentation::Rack`), which our Rails-shaped Ruby reader (ADR-173) misses because Sinatra declares routes as a bare verb DSL rather than a `config/routes.rb` table.

Unlike the frontend Next.js case, these routes ARE carried in the observed `http.route` attribute, and ingest already fuses `http.route` → RouteNode (`findRouteNodeByHttpRoute` normalizes path templates and matches on service + normalized template + method). So the fix is **extractor-side only**: mint a `RouteNode` at the correct `(service, method, pathTemplate)` and the existing ingest path fuses the observed span onto it. `ingest.ts` is not touched.

### Decision

1. **Rust Actix-Web reads attribute macros and the App builder, gated on `actix-web`.** `actixRoutesFromSource` (`extract/routes.ts`) reads `.rs` files in a service whose Cargo dependencies include `actix-web` (the manifest gate Gin/Echo/Fiber use, off `extract/rust.ts`'s reader). The idiomatic form is an attribute macro on the handler fn — `#[post("/ship-order")]`, `#[get("/get-quote")]`, and the multi-method `#[route("/x", method = "GET", method = "POST")]` — where the macro name is the HTTP method and the first string literal in its `token_tree` is the path; `.service(handler)` carries no path (the macro already did), so it needs no separate read. The second form is the builder `App::new().route("/health", web::get().to(h))`, where the path is the first argument and the method is the `web::<verb>()` in the second — a bare `web::route()` or a `.route(...)` whose method doesn't resolve to a known verb mints nothing, keeping a generic `.route` in unrelated code from manufacturing a route. Rust is admitted only when `actix-web` is present (there is only an Actix recognizer today; a non-Actix Rust service reads no routes rather than being scanned).

2. **PHP Slim reads every `.php` file and self-gates on a Slim App value, gated on `slim/slim`.** `slimRoutesFromSource` extends the PHP path beside Laravel. Slim has no conventional route file, so unlike Laravel's `routes/web.php`/`api.php` it reads every `.php` file and self-gates on finding a Slim `App` value in that file: a variable assigned from `AppFactory::create()` (Slim 4) or `new …App` (Slim 3), **or a function/closure parameter type-hinted `Slim\App`** (`App`, `Slim\App`, or `\Slim\App` — the same precision bar as the constructor branch: the bare name or a trailing `\App`). The typed-parameter form is the Slim skeleton the otel-demo `quote` service actually uses: `public/index.php` builds the app (there via the PHP-DI Slim bridge, `Bridge::create($container)`, not `AppFactory`) and registers its route in a separate `app/routes.php` that returns `function (App $app) { $app->post('/getquote', …) }`. That route file constructs no app, so the constructor gate finds nothing there — the `App` type hint on the passed-in `$app` is the only local Slim signal, and an authoritative one. Without it `quote`'s route minted no static twin (the baseline fixture, a single index.php that assigns its app, passed while this split shape didn't). Either way a `$cache->get('key')` on some other, untyped object mints nothing. It reads the verb calls `$app->get/post/put/patch/delete/options/head`, the method-agnostic `$app->any` (→ `ALL`), the multi-method `$app->map(['GET','POST'], '/x', …)`, and route groups `$app->group('/prefix', function ($group) { … })` whose prefix composes across nesting — inside a group closure the proxy parameter and `$this` join the app-var set for that scope only. A `->setName(…)`/`->add(…)` chained after a verb doesn't change the template.

3. **Ruby Sinatra reads every `.rb` file and self-gates on the file referencing Sinatra, gated on the `sinatra` gem.** `sinatraRoutesFromSource` extends the Ruby path beside Rails. Sinatra declares a route as a bare verb DSL call with a string pattern and a block (`post '/send_order_confirmation' do … end`), so the recognizer requires the receiver-less verb-with-string-path-and-block shape AND the file itself to reference Sinatra (a `require 'sinatra'` or a `Sinatra::Base` superclass) — the precision that keeps a bare `get`/`post` word or a receiver'd `client.post(…)` in unrelated Ruby from minting a route. Both the classic single-file and the modular `Sinatra::Base` styles read the same way.

4. **The declared template is the fusion key; `ingest.ts` is untouched.** Each recognizer mints a `RouteNode` through the existing `addRoutes` producer with the framework label (`actix-web` / `slim` / `sinatra`), `routeId(service, method, pathTemplate)` from the identity helper, and a `service ──CONTAINS──▶ route` EXTRACTED edge pinned to the defining file:line. The template keeps each framework's native param form verbatim (`{id}` for Actix/Slim, `:id` for Sinatra); `normalizePathTemplate` collapses every `{…}`/`:word` segment to `:param` on both the declared and observed sides, so a route-grain server span fuses with no ingest change. The HTTP method is captured where the idiom gives it (the macro name, `$app->post`, the Sinatra verb) — load-bearing because ingest's `findRouteNodeByHttpRoute` rejects a method mismatch unless the RouteNode is `ALL`.

### Consequences

- The otel-demo `shipping` (`/get-quote`, `/ship-order`), `quote` (`/getquote`), and `email` (`/send_order_confirmation`) endpoints get a static RouteNode whose `pathTemplate` equals the observed `http.route` after normalization, so their Server spans fuse instead of standing as observed-but-undeclared. Actix is the first Rust route recognizer; Slim and Sinatra widen the PHP and Ruby readers past their single-framework shape.
- **Precision degrades to silence, never a false route.** A computed path, a `.route`/`->get`/verb call that doesn't resolve to a real framework route, or a Ruby file that doesn't reference Sinatra reads nothing rather than a guessed node — an unrecognized route surfaces as an honest observed-but-not-declared divergence.
- Deferred, per framework: Actix `web::scope("/prefix")` / resource prefix composition; Slim cross-file route registration where the route file carries no local Slim signal (the app is neither constructed nor `App`-typed in it — the skeleton's type-hinted route file is now read, but a fully untyped hand-off is not) and controller-array handlers; Sinatra regex routes, `Sinatra::Namespace` prefixes, and routes in files that don't themselves reference Sinatra. Each is a grain-widening follow-on, not a change to the RouteNode shape.
- Pinned by unit + end-to-end tests per framework: an Actix `#[post("/ship-order")]` fixture mints `route:shipping:POST /ship-order` with the builder and multi-method forms; a Slim `$app->post('/getquote', …)` fixture with `map`/`any`/nested groups and a non-app-var precision guard, plus a second `php-slim-quote` fixture in the real skeleton shape (a split `app/routes.php` returning `function (App $app) { … }`) asserting `route:quote:POST /getquote` mints off the type-hinted parameter and pins to `app/routes.php`; a Sinatra `post '/send_order_confirmation'` fixture with the receiver'd-call and non-referencing-file precision guards; each asserting concrete ids / methods / `evidence.file` and idempotency, and the existing Laravel/Rails/Go/Express route tests continuing to pass unchanged.

## ADR-207 — C# DatabaseNode ids key on the resolved host alone; every declared host mints, no fabricated placeholder

**Status:** Accepted. Refs #1054. Refines ADR-205 (C# datastore recognizers, the connection axis in `databases/csharp.ts`); builds on ADR-141 (declared DB host fusion). Amends [`static-extraction.md`](contracts/static-extraction.md).
**Contract:** [`static-extraction.md`](contracts/static-extraction.md).

> ADR numbering note: 207 is the genuine next-free number — 206 (route recognizers, #1047) is the highest landed. Reconfirm against `docs/decisions.md` tail before merge.

### Context

The C# connection-axis recognizer (`databases/csharp.ts`, ADR-205) minted `DatabaseNode` ids that could not fuse with the OBSERVED side. Run over the real otel-demo extract, it produced `database:postgresql-npgsql` and `database:badhost`, while the OBSERVED CONNECTS_TO spans carried `database:postgresql` and `database:valkey-cart` — zero DB fusion. Ingest keys a db span on `server.address` / `net.peer.name` via `databaseId(host)` alone (`ingest.ts`, untouched here), so the EXTRACTED twin must key on the same bare host or it twins instead of fusing. Two separate defects sat behind the two bad ids:

1. **A driver suffix in the id.** When a verified `UseNpgsql` client's host could not be resolved, the recognizer backfilled a deterministic placeholder host `postgresql-npgsql`. That string is `postgresql` with a `-npgsql` driver suffix welded on — an id that can never equal the observed `database:postgresql`. The engine/driver is a NODE ATTRIBUTE, not part of the identity.
2. **First-declared-host-wins hid a real peer.** For redis the recognizer returned the *first* host it could parse and stopped. The otel-demo `cart` declares two redis peers: the primary store connects to the config-driven `VALKEY_ADDR` (`valkey-cart`), and a second `new ValkeyCartStore("badhost:1234")` is a deliberately fault-injected probe (the ITBench scenario). Because a bare `host:port` literal was scanned before the env/config key, `badhost:1234` won and `valkey-cart` — the peer that actually fuses — was never minted. `badhost` is **not** a phantom: it is a genuinely declared connection. The bug was dropping `valkey-cart`, not minting `badhost`.

### Decision

1. **The `DatabaseNode` id keys on the resolved host ALONE.** The engine (`postgres` / `redis`) is a node attribute; it is never concatenated into the id. Ids are constructed only through the `databaseId` identity helper, so a `Host=postgresql` string yields exactly `database:postgresql` — the id an OBSERVED span already minted — with no `-npgsql` / `-stackexchange` suffix.

2. **Every genuinely declared host is extracted; a service may name more than one peer of an engine.** `resolveConfigs` returns *all* hosts that parse to a plain string — config/env-referenced addresses first (the deployment's real target), then matching literals — and the caller mints one node per distinct `engine:host`. So the cart mints **both** `database:valkey-cart` (fuses with the OBSERVED peer) and `database:badhost` (a declared-but-unobserved connection). A declared host that has no OBSERVED twin is an honest divergence — the extraction working, NEAT naming the declared bad host while the runtime shows the real one — not a node to suppress.

3. **A client with no resolvable host at all mints NO node.** The earlier per-client placeholder fallback is removed: a fabricated host (`postgresql-npgsql`, or any made-up peer) shares the `database:<host>` shape an OBSERVED span carries but never fuses onto it, so it would pollute the graph with a twin that looks joinable and isn't. When nothing resolves, the connection is left as an honest gap. This is the only skip — a host that *does* resolve is always kept, even when it won't fuse (defect 2's `badhost`).

### Consequences

- On the real otel-demo, `cart` now mints `database:valkey-cart` (fuses) alongside the genuine `database:badhost`, and `accounting`'s postgres connection mints nothing rather than a `postgresql-npgsql` phantom, because its `DB_CONNECTION_STRING` lives in `compose.yaml` (`Host=${POSTGRES_HOST}` → `astronomy-db`) — outside any `.env` the recognizer reads. This is the honest limit of static host recovery when the peer is deployment-configured outside the source; the `database:postgresql` on the fusion map reflects a deployment where the peer resolved to `postgresql`, and the twin fuses only when the extracted host equals the string the OBSERVED `server.address` carried (ADR-205's fusion caveat, now with no placeholder standing in).
- `ingest.ts` is untouched — the entire fix is extractor-side, keying the EXTRACTED twin onto the id ingest already mints.
- Pinned by `extract-csharp-datastore.test.ts` (18 cases): the two-declared-peers case asserts the cart mints both `database:valkey-cart` and `database:badhost` with host-alone ids; a negative asserts a verified client with no resolvable host mints nothing (no fabricated placeholder); and the end-to-end `extractFromDirectory` asserts `database:valkey-cart` + `database:badhost` + `infra:sql-table:orderitem` are present and `database:postgresql-npgsql` is not. The table axis (`calls/efcore.ts` → `infra:sql-table:orderitem`) is unchanged — it already fused.
- Reading `compose.yaml` env for a connection host the `.env` doesn't carry, and per-host provenance for the CONNECTS_TO origin when two peers share one client-call file, stay unmodelled — named follow-ons, not this fix.

## ADR-208 — Streaming and long-lived spans are kept out of the per-edge latency digest

**Status:** Accepted. Refs #1056. Builds on ADR-190 (per-edge latency signal), ADR-189 (agent-driven navigation / the saturation classifier). Amends [`otel-ingest.md`](contracts/otel-ingest.md).
**Contract:** [`otel-ingest.md`](contracts/otel-ingest.md).

> ADR numbering note: 208 is the next-free number — 207 (#1054) is the highest landed on this tail. A sibling fix (#1050) may also be claiming a number in a parallel branch; reconfirm against `docs/decisions.md` tail before merge and renumber if 208 was taken.

### Context

ADR-190 gave every OBSERVED edge a `latencyMs: { p50, p95 }`, derived from span duration at `upsertObservedEdge` and maintained by the bounded HDR histogram in `latency-digest.ts`. `p95` is the saturation signal the navigation reads (ADR-189): `traverse.ts` classifies an edge as saturated when its `p95` clears `SATURATION_P95_MS` (1000ms), and a saturated downstream node reads as a starved victim the walk climbs past toward the load origin.

The digest assumes every duration it folds in is a **per-request** latency. That assumption breaks on a **streaming or long-lived** span, whose duration is the whole stream's lifetime, not one request. On the otel-demo the ±NEAT RCA benchmark caught it with runtime evidence: flagd emits a gRPC **server-streaming** span, `flagd.evaluation.v1.Service/EventStream`, that stays open for the connection's whole life (~10 minutes). Its ~600000ms duration landed in the per-edge digest and read as a **606208ms inbound p95**, tripping the saturation classifier. `get_root_cause(service:ad)` then built a confidently-wrong "the load generator overloads everything" narrative — "its inbound p95 606208ms is saturated" — steering the agent *away* from the real cause (checkout) toward a phantom overload. One long-lived span poisoned the percentile and inverted the verdict.

The same shape recurs beyond gRPC streams: a WebSocket connection (the upgrade span lives for the whole socket, ADR-125) and a Server-Sent-Events response both carry a lifetime-long duration that is not a request latency.

### Decision

1. **Streaming / long-lived spans are withheld from the latency feed, and only that feed.** The guard sits at the single point in `handleSpan` where a span's duration becomes `durationMs` — the value handed to `upsertObservedEdge` for the digest. When a span is streaming by shape, `durationMs` is left `undefined`, exactly as a span with no usable duration already is (ADR-190): the edge still records `spanCount`, `errorCount`, and `lastObserved`, its confidence grade is unchanged (latency never fed confidence — ADR-190), and a `undefined` duration leaves any prior latency on the edge untouched, never cleared. Nothing else about the edge, and nothing about the symbol-fusion path (`landObservedSymbol`, which never sees `durationMs`), is touched.

2. **Detection prefers a span-shape signal, with a documented duration ceiling as the fallback.** `spanIsStreaming` reads, in order:
   - **WebSocket** — `span.websocketChannel` is set (the upgrade span, otel-ingest.md §WebSocket channels). A span-shape signal NEAT already parses; caught regardless of duration.
   - **Server-Sent Events** — a captured response header names `content-type: text/event-stream` (read at `http.response.header.content-type` / `…content_type`, string- or array-valued, since SDKs differ on header-name normalisation). A span-shape signal, best-effort: present only when the instrumentation captured response headers.
   - **Duration ceiling** — a span longer than `NEAT_LATENCY_STREAM_CEILING_MS` (default 60s) is treated as long-lived. This is the **weaker** fallback, used because the base OTel gRPC semconv carries **no** streaming marker NEAT parses — a bidi / server-streaming RPC is indistinguishable from a unary one on the wire but for its per-message span events, which ingest does not read. flagd's `EventStream` is caught here. 60s is chosen as a duration no genuine unary request legitimately reaches while sitting far below a real stream's lifetime; it is env-overridable for a deployment whose request tail runs longer.

   Keying on the ceiling as the gRPC-stream catch is a deliberate, named weakness: a real streaming marker would be strictly better, and if a future ingest cut reads gRPC message-event counts (or an SDK emits a streaming attribute), that shape signal should front-run the ceiling here.

### Consequences

- The saturation classifier stops false-firing on stream traffic: flagd's `EventStream` edge no longer reports a ~600000ms p95, so `service:ad`'s downstream no longer reads as a saturated victim, and `get_root_cause` no longer manufactures the overload narrative that steered away from checkout. Normal unary request latencies still feed the digest unchanged, so genuine saturation still surfaces.
- The change is confined to the latency feed. `durationMs` flows only into `upsertObservedEdge`'s latency histogram; withholding it changes no other edge property and no other query. The symbol-fusion invariant is independent and untouched.
- A stream edge reads latency as **honestly absent** rather than as a fabricated saturation (file-awareness.md §6): a WebSocket / SSE / long-lived edge carries `spanCount` and `lastObserved` but no `latencyMs`, which is the truth — a stream has no per-request p95.
- The ceiling is a heuristic, not a proof: a genuinely slow unary request past 60s is also withheld from p95 (still counted everywhere else), and a stream shorter than 60s with no WS/SSE marker still feeds latency until a real gRPC-streaming shape signal exists. Both are named limits, not silent gaps.
- Pinned by unit tests: `spanIsStreaming` flags WebSocket (by shape, under the ceiling), SSE (by header), and a past-ceiling span, and passes a normal unary request; `handleSpan` withholds a 10-minute gRPC stream from the edge digest while an interleaved unary run keeps a sane p95; and the classifier reads a stream-only edge as unsaturated while a slow-unary edge still reads saturated.

## ADR-209 — `getRootCause` navigates a STALE-only causal chain instead of dead-ending on the symptom

**Status:** Accepted. Refs #1050. Builds on ADR-189 (agent-driven navigation), ADR-190 (edge latency signal), ADR-114 (#589 cross-service failing-CALLS chain), ADR-029/ADR-066 (provenance ranking + STALE ≤ 0.3). Amends [`get-root-cause.md`](contracts/get-root-cause.md).
**Contract:** [`get-root-cause.md`](contracts/get-root-cause.md).

> ADR numbering note: 209 is the genuine next-free number — the sibling latency fix (ADR-208, #1061, keeping streaming spans out of the per-edge latency digest) landed on main first and took 208, so this STALE-navigation ADR is 209. Reconfirm against `docs/decisions.md` tail before merge.

### Context

The ±NEAT RCA benchmark ran an agent over an ITBench S24 incident against a stale NEAT snapshot — the graph was ~8 months old and every edge had transitioned to STALE (ADR-024) as the runtime went quiet. `get_root_cause(service:frontend)` returned `service:frontend` itself — *"primary-failure, direct, no edges traversed"* — and `get_root_cause(service:checkout)` did the same, even though the fused topology (`frontend → checkout → cart/kafka`) was all still in the graph. The agent, handed the symptom, fell back to grepping source and answered wrong. This is worse than no graph: a graph that dead-ends on stale and names the alerting node is net-negative against a no-graph baseline, and it was the concrete reason the NEAT arm lost the benchmark.

The mechanism: `legacyRootCause` for a `ServiceNode` entry point runs the incoming compat walk (empty — nothing calls the entry service), then the #589 outbound **failing**-CALLS chain (`crossServiceRootCause` / `followFailingCallChain`), then the incident store. The failing-CALLS walk gates each hop on `isFailingCallEdge` — `signal.errorCount > 0`. A STALE edge keeps its topology but on an old snapshot carries **no error signal** for the live incident (the failure is a new event the stale graph never observed), so every hop reads as non-failing and the chain walks nothing. The failure is known only through the incident store, which localizes it to the queried node, and navigation (ADR-189) confirms that seed `primary-failure` because it is not a load victim (no errors arrive from callers — it is the entry). The STALE downstream chain — a real, if low-trust, causal hypothesis — is never walked.

STALE is a *ranked* provenance (PROV_RANK 0, confidence ceiling ≤ 0.3, ADR-029/066), not an absent one. A node whose only causal chain is stale still has a knowable last-observed origin. Dead-ending discards it.

### Decision

1. **Tag the single-verdict source.** `legacyRootCause` returns its verdict alongside a `LegacyCauseSource` — `'compat' | 'cross-service' | 'incident'` — so the navigation layer knows *how* the seed was found. The escape hatch (`NEAT_RCA_NAVIGATION=0`) drops the tag and returns the pre-navigation `result` verbatim, unchanged.

2. **A STALE-chain fallback in the navigation layer, gated tightly.** In `enrichWithNavigation`, when — and only when — the seed is an `'incident'`-sourced dead-end (`source === 'incident'`, the seed is the queried node, `traversalPath.length === 1`, no causal edge walked) and is **not** a load victim (`isVictimSeed` takes precedence, ADR-189), `getRootCause` follows `followStaleCallChain` outbound from the queried node. Each hop takes the dominant **STALE-only** CALLS edge: the best-provenance edge per callee is computed first (`PROV_RANK`), then only callees whose best edge is STALE are eligible — so a callee still reachable by any fresher (OBSERVED/INFERRED/EXTRACTED) edge is **never** walked stalely. With no error signal to rank on (that is what went quiet), hops break ties on last-observed call volume, then id — deterministic like `failingCallDominates`. The deepest stale-only callee is the surfaced cause.

3. **The stale-derived cause is honest, low-confidence, STALE-provenanced.** It leads `candidates` as a `primary-failure` with `provenance: STALE` and a confidence from `confidenceFromMix` over the stale edges — the STALE ceiling (≤ 0.3) caps it, so the number reads as the low trust it is, no hand-set floor. Its `reason` says outright that live telemetry went quiet and this is a stale-topology hypothesis to confirm, not a signal-backed verdict; `traversalPath` is the walked stale chain (origin → … → culprit) with every hop's STALE provenance on `edgeProvenances`, so the invariant (path ends at `rootCauseNode`) holds. The queried node stays in the set, demoted to `symptom-only` — the surface of a stale-traced failure. `fixRecommendation` names the stale-derived cause and reads as a recovery step (restore instrumentation / re-run with live traces), never the overload "throttle the load" wording.

4. **Stale is the fallback, never a replacement.** A `'compat'` or `'cross-service'` seed is never second-guessed. A fresh OBSERVED failing chain still names its culprit OBSERVED-preferred. A dead-end whose first reachable hop is fresh (a healthy OBSERVED edge) preserves existing behavior — the node is named, not walked past. A genuinely isolated node (an incident but no outbound causal edge of any provenance) stays `primary-failure`: there is nothing to walk, and nothing is fabricated. `ingest.ts` is untouched — the entire fix is read-side, in `traverse.ts`.

### Consequences

- On the stale-snapshot shape the benchmark hit, `get_root_cause` now hands the agent the stale causal chain and its deepest node as a low-confidence STALE candidate — pointing downstream toward the real cause — instead of the alerting symptom with no edges walked. The confidence and reason make the uncertainty legible so the agent weighs it correctly rather than acting on a false certainty.
- The dead-end that made a stale graph net-negative is gone for the incident-localized case. The null case (no incident anywhere) still returns null — the honest "nothing to say" — since the "hands the agent the symptom" bug requires a non-null seed.
- Pinned by `root-cause-stale-navigation.test.ts`: the stale-only chain surfaces a STALE, ≤ 0.3-confidence `service:cart` cause with the full walked path (not the `service:frontend` symptom); the middle-node query reaches the same cause; the escape hatch returns the pre-navigation dead-end verbatim; a fresh OBSERVED cross-service verdict stays OBSERVED-preferred; a fresh first hop preserves the seed; and a genuinely isolated node stays `primary-failure` with no fabricated upstream.
- Deferred: branch-aware stale navigation (a stale chain that forks picks the highest-volume branch and does not surface the others) and a stale fallback for the null case (no incident at all) stay unmodelled — grain-widening follow-ons, not this fix.
