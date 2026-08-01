---
name: file-awareness
description: "NEAT is file-first. Files are the primary nodes and relationships originate from files; a service is a repo root dir that owns files and the honest fallback where a relationship can't be attributed to one. OBSERVED gets its file from a call-site span processor (CLIENT/PRODUCER → code.* captured synchronously at span creation); EXTRACTED resolves the file from the parse. There is no rollup of file edges into service edges and no service-level view. Evidence is never fabricated."
governs:
  - "packages/types/src/identity.ts"
  - "packages/types/src/edges.ts"
  - "packages/core/src/installers/javascript.ts"
  - "packages/core/src/installers/templates.ts"
  - "packages/core/src/ingest.ts"
  - "packages/core/src/extract/calls/**"
  - "packages/core/src/extract/retire.ts"
  - "packages/core/src/traverse.ts"
  - "packages/core/src/divergences.ts"
adr: [ADR-087, ADR-089, ADR-100, ADR-158]
enforcement: [lint, review]
---

# File-awareness contract

An agent consuming NEAT gets a deterministic answer when the result names *where in the code* a relationship originates. NEAT reaches that by making the file the subject of the graph.

## 1. The file is the primary node

`FileNode` is a first-class node, identified by `fileId(service, relPath)` → `file:<service>:<relPath>` (service-scoped so a shared relative path across monorepo packages stays distinct). Relationships originate from files: a `CALLS` edge runs `file:<svc>:<path>` ──▶ target. The file is the primary, global node and the default grain of every query.

Symbols nest **under** the file (ADR-158). A `SymbolNode` — a function, method, constructor, or class definition, identified by `symbolId(service, relPath, qualname, disambiguator?)` → `symbol:<service>:<relPath>#<qualname>` — is owned by its file through `file ──CONTAINS──▶ symbol`, one containment level below `service ──CONTAINS──▶ file`. The extractor mints one per definition with its `{ startLine, endLine }` span (static-first: a symbol exists in the inventory whether or not runtime ever exercised it), and a query descends to symbol grain where it needs the deeper trace. This is additive: symbols are a layer under the file, never a replacement for it — the file stays primary and global.

File-node existence is independent of edge-target precision, and symbols inherit that independence. A matched call site is a parsed fact: the `FileNode` and its owning `service ──CONTAINS──▶ file` edge materialize for every site, whatever the confidence in the resolved target; a statically-extracted symbol likewise exists whether or not any edge was ever observed on it (the denominator). The precision floor (ADR-066 §3) gates the file→target edge alone — a sub-floor target is recorded as a drop and the resolved relationship stays out of the graph, but the certain file fact still surfaces. A file that originates only low-confidence calls is present in the graph; what's withheld is the claim about what it calls, not the file itself.

## 2. A service is a grouping of files, not a layer above them

A service is a repo root dir / monorepo package, recovered by static analysis (two packages → two services). It owns its files through a `CONTAINS` edge (`service ──CONTAINS──▶ file`) and serves as the fallback identity where a relationship cannot be attributed to a file. It is not an aggregation the graph rolls up to.

## 3. No service rollup, no service view

The graph, the queries, and the dashboard are file-first, symbol-deep where the query asks. File edges are never collapsed into service edges, and — the same rule one grain finer — symbol edges are never collapsed into file edges (ADR-158): a symbol relationship is reported at symbol grain, never rolled up into the file's. The default grain stays the file; symbols are the layer a query descends into. Service-level nodes and edges exist **only** as the honest fallback (§4), never as a summary of file edges. Consumers — traversal, divergence, the REST reads — walk the graph generically and return answers at whichever grain the nodes on the path carry.

Traversal walks file and symbol nodes as first-class members of the path: `getRootCause`, `getBlastRadius`, and `getTransitiveDependencies` neither filter to service nodes nor roll file edges up. A `SymbolNode` rides the same generic machinery a `FileNode` does — an OBSERVED edge that lands on a symbol (§4) puts that symbol on the path with no traversal-code change, exactly as the file was already first-class — and the no-rollup rule holds at symbol grain (a symbol edge is never collapsed into its owning file's edge). Where a root-cause shape needs the service that carries a compatibility property (declared dependencies, node engine), it resolves a `FileNode` on the path to its owning service through the inbound `CONTAINS` edge (§2) — the file stays on the traversal path, and the service is named as the carrier. A `FileNode` origin resolves the same way before the service shape runs. A `SymbolNode` resolves one containment level deeper, up the inbound chain `symbol ◀─CONTAINS─ file ◀─CONTAINS─ service` (ADR-158 §7) — the symbol stays on the path, the service is named as the carrier; the root-cause dispatch gains a `SymbolNode` shape that is the file shape one grain finer, and the cross-service failing-CALLS chain counts a file's owned symbols as call sources alongside the file so an observed symbol-grained call is found the same way. `getBlastRadius` keeps `CONTAINS` inbound at symbol grain too: `symbol ◀─CONTAINS─ file` means the file owns an affected symbol and is genuinely a dependent, so the owning file (and its service) stay in the radius — the same rule `file ◀─CONTAINS─ service` already follows. The result schemas accept file node ids, and MCP surfaces them verbatim, so an agent asking root-cause or blast-radius over a file-first graph gets file-grained answers. FrontierNode-skip and the `PROV_RANK` best-edge selection (provenance contract) are unchanged.

`CONTAINS` is walked to reach file-grained targets but is treated asymmetrically in the *reported* output (ADR-140). `getTransitiveDependencies` walks *through* an outbound `CONTAINS` edge — so the file that `CONNECTS_TO` a called service's database still surfaces downstream — but does **not** report the `CONTAINS` edge itself: a service does not depend on the files it owns, so its structural children (Dockerfile, otel-init, routes) never appear as dependencies. `getBlastRadius` keeps `CONTAINS`: walked inbound, `file ◀─CONTAINS─ service` means the service owns an affected file and is genuinely a dependent, so the owning service stays in the blast radius. `getRootCause` uses `CONTAINS` only for the compat-carrier resolution above, never as a reported result. The file-first promise — never filter to service nodes, never roll file edges up — is unchanged for every edge that carries a real relationship.

## 4. Every NEAT-instrumented span is file-attributed

NEAT controls the instrumentation surface end-to-end — the bundled installer wires the in-scope frameworks ([`installer-scope.md`](./installer-scope.md)) and `/neat extend` covers the long tail ([`extend-skill.md`](./extend-skill.md)). Every CLIENT, PRODUCER, and SERVER span NEAT emits carries `code.filepath` / `code.lineno` / `code.function`, set through a **layered mechanism** (ADR-087, ADR-090):

1. **Stack walk at span start.** A `SpanProcessor`'s `onStart` reads the first user-code frame from the synchronous stack on CLIENT/PRODUCER spans (skipping `node_modules` / `@opentelemetry/*` / `node:` internals). Covers the synchronous-wrapper instrumentations — the majority of bundled Node integrations across HTTP, databases, queues, and cloud SDKs.

2. **Handler-entry attribution.** At every framework route-handler entry, the instrumentation stamps `code.*` on the active SERVER span with the handler's `file:line:function`, and enriches the framework's existing handler context with the same frame under a `neat.user-frame` context key. The processor falls back to that context value on downstream CLIENT/PRODUCER spans when the synchronous stack carries no user frame, so every downstream span inherits at minimum the handler-file grain.

3. **Facade wrappers for off-stack patterns.** For instrumentations whose span creation is detached from the caller's stack — Node's built-in `fetch` / `undici` (`diagnostics_channel`-based) and `@prisma/instrumentation` (post-hoc backdated dispatch) today — the instrumentation wraps the user-visible library facade and pushes the exact call-site frame into context for the inner call. The registry enumerates the set; it grows as the ecosystem evolves.

Go extends the first layer through a generated `sdktrace.SpanProcessor`. `OnStart` uses `runtime.Callers` synchronously for CLIENT/PRODUCER spans, selects the first frame beneath the service root while excluding vendor and NEAT-generated frames, and stamps the stable `code.*` names. The generated file locates the root by walking to `go.mod`; `NEAT_SERVICE_ROOT` overrides it. No honest frame means no attributes and the labeled service-grain fallback.

Ingest reads the call site through both OpenTelemetry attribute generations — the stable names `code.file.path` / `code.line.number` / `code.function.name` (semconv ≥1.33) and the prior `code.filepath` / `code.lineno` / `code.function`, stable-name first — so a span carrying either generation file-grains identically, whether it comes from NEAT's own emit or from third-party instrumentation that has moved to the stable names. The dual read lives in one shared helper so every code.* reader (edge attribution and incident localization) stays on one definition and the names can't drift across sites.

Ingest joins the runtime path against the service root, resolving `dist/...js` through the file's source map to the original `src/...ts` where applicable, to land the edge on a `FileNode`. The raw dist path is preserved as `code.original_filepath` for diagnostic. The injected template is version-stamped so a re-run upgrades an existing install onto the current layered mechanism.

A NEAT-emitted span without `code.*` is a capture-mechanism bug; ingest surfaces it via a loud audit for diagnostic.

## 5. The mechanism is span-time capture across the three layers, not profiler correlation

NEAT captures the user call site at span creation through §4's layered mechanism — synchronous stack walk for sync-wrapper instrumentations, handler-entry context attribution as the floor, and facade wraps for off-stack patterns. A separate CPU-time / wall-time profiler correlated with spans (the Pyroscope-style approach) is out of scope.

## 6. Evidence is never fabricated

Evidence is populated only from a real origin — a parsed `code.*` attribute on a NEAT-emitted span or a matched extractor call site. Config/infra edges without a line carry partial evidence honestly. No synthesized file paths or line numbers. A NEAT-emitted span missing `code.*` is a capture-mechanism bug (§4); ingest surfaces it via a loud audit for diagnostic.

## 7. Divergence compares at the shared grain

`get_divergences` compares a declared relationship against its observed twin at whichever grain both sides share: symbol-to-symbol when both carry the symbol, file-to-file when both carry a call site, service-level when the observed side has none — degrading through the grains honestly. The symbol-grained case — declared symbol edge vs. observed symbol edge for the same pair — is the divergence finding at its sharpest (ADR-158), one grain finer than the file case. An observed symbol with no extracted twin is itself a divergence signal: `missing-extracted` at symbol grain — a runtime call landing on a symbol the extractor never produced (the `discoveredVia: 'otel'` symbol of §4's landing), the symbol-grain sibling of the FrontierNode, surfaced rather than guessed.

## 8. Service-graph completeness precedes this

Multi-service attribution by `resource.service.name` is a prerequisite — files belong to services, so service attribution must be correct before file grain hangs on it. The make-or-break — does call-site capture land on the user's frame on real async Node code — is validated by a capture spike on the Brief harness before the file-node model is built on it.

## 9. File-native is server-side; the browser tier is deferred

The file in a file-native edge is the file in the **instrumented runtime** — the server process whose call-site processor captured the frame (§4). Server-side code is fully file-native: handlers, server actions / RSC, cron jobs, and workers all run where the processor sees the call site. The client/browser tier is not instrumented, so a pure client interaction attributes to the server file it reaches, not the frontend file.

Browser/client-tier file attribution — capturing the `.tsx` that issued a request — is a **deferred, demand-gated tier**: OTel-web instrumentation plus source-map resolution, additive on the same call-site model with no rework to the server-side graph. It is out of scope for the v0.5 arc and is built only when a concrete client-tier user story warrants its cost (source-map resolution, sampling the high-volume firehose, the added surface). This is consistent with the installer's runtime-kind detection, which already treats browser-bundle / React-Native packages as cleanly skipped and browser-OTel as a future feature, not a gap.

## 10. The service `CONTAINS`-grouping renders as a collapsible compound container (ADR-100)

This clause is **additive**. It blesses one canvas-rendering shape and reaffirms — does not rewrite — §3's hard lines. §3 stands exactly as written; nothing below loosens it.

A service renders on the canvas as a **collapsible compound container** that nests its files via the existing `service ──CONTAINS──▶ file` hierarchy (§2). This is grouping chrome over the hierarchy the graph already carries, not a rollup: files stay the primary visible nodes, and the service is a box drawn around them. Collapsed by default so the hairball stays dead; the selected service (and its one-hop neighbors) auto-expands so selection always reveals file-level context; tiny services (a handful of files) may render expanded.

Because the canvas is a view onto the file-first graph, §3's hard lines bind the rendering too — reaffirmed here at the rendering layer:

- **Never collapse file edges into service-level edges.** Edges stay file→file / file→target. The compound container groups nodes; it never aggregates their edges into a service-to-service line.
- **Never render a service as a leaf node that hides its files.** Compound-grouping yes; a service blob standing in for its files no. The container exists to *reveal* files, not to replace them.
- **Render service-coarse OBSERVED fallback edges honestly.** When an edge falls back to a service node — the parent-fallback case (#536) — it renders as the honest coarse fallback (dashed into the service container, with a marker), never as a confident file→file precision line. The canvas never fakes file-grain it does not have. **The grain is now a stored fact, not a re-derivation (ADR-142):** every OBSERVED edge carries `grain: 'file' | 'service'`, set at mint in `upsertObservedEdge` — `'file'` for a `file:` source (call site captured), `'service'` for the coarse fallback. The canvas, MCP, REST, and divergence all read that field instead of re-deriving the grain from the source prefix four different ways; "service-grained only as a labeled fallback" (connector gate #803) is thereby a queryable property, not a convention.

The compound container is rendering chrome only. The graph, the queries, traversal, divergence, and capture remain exactly as §1–§9 define them — file-first, no rollup, no service-level view.
