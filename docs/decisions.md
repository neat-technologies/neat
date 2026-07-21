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
