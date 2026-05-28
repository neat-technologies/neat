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
adr: [ADR-087, ADR-089]
---

# File-awareness contract

An agent consuming NEAT gets a deterministic answer when the result names *where in the code* a relationship originates. NEAT reaches that by making the file the subject of the graph.

## 1. The file is the primary node

`FileNode` is a first-class node, identified by `fileId(service, relPath)` → `file:<service>:<relPath>` (service-scoped so a shared relative path across monorepo packages stays distinct). Relationships originate from files: a `CALLS` edge runs `file:<svc>:<path>` ──▶ target. Function-level nodes are deferred — file grain now.

File-node existence is independent of edge-target precision. A matched call site is a parsed fact: the `FileNode` and its owning `service ──CONTAINS──▶ file` edge materialize for every site, whatever the confidence in the resolved target. The precision floor (ADR-066 §3) gates the file→target edge alone — a sub-floor target is recorded as a drop and the resolved relationship stays out of the graph, but the certain file fact still surfaces. A file that originates only low-confidence calls is present in the graph; what's withheld is the claim about what it calls, not the file itself.

## 2. A service is a grouping of files, not a layer above them

A service is a repo root dir / monorepo package, recovered by static analysis (two packages → two services). It owns its files through a `CONTAINS` edge (`service ──CONTAINS──▶ file`) and serves as the fallback identity where a relationship cannot be attributed to a file. It is not an aggregation the graph rolls up to.

## 3. No service rollup, no service view

The graph, the queries, and the dashboard are file-grained. File edges are never collapsed into service edges. Service-level nodes and edges exist **only** as the honest fallback (§4), never as a summary of file edges. Consumers — traversal, divergence, the REST reads — walk the file-grained graph generically and return file-grained answers.

Traversal walks file nodes as first-class members of the path: `getRootCause`, `getBlastRadius`, and `getTransitiveDependencies` neither filter to service nodes nor roll file edges up. Where a root-cause shape needs the service that carries a compatibility property (declared dependencies, node engine), it resolves a `FileNode` on the path to its owning service through the inbound `CONTAINS` edge (§2) — the file stays on the traversal path, and the service is named as the carrier. A `FileNode` origin resolves the same way before the service shape runs. The result schemas accept file node ids, and MCP surfaces them verbatim, so an agent asking root-cause or blast-radius over a file-first graph gets file-grained answers. FrontierNode-skip and the `PROV_RANK` best-edge selection (provenance contract) are unchanged.

## 4. OBSERVED is file-first where a call site exists, service-fallback otherwise

The injected instrumentation carries a call-site `SpanProcessor` that, on CLIENT/PRODUCER spans, captures the first user-code frame and sets `code.filepath` / `code.lineno` / `code.function`. The frame is read **synchronously at span creation**, where the instrumentation patches the client method and the user's calling frame is on the stack — `node_modules` and `@opentelemetry/*` frames are skipped. Ingest joins the runtime path against the service root to land the edge on a `FileNode`. Inbound SERVER spans, un-instrumented services, and the callee side of any edge carry no call site and stay service-level. The injected template is version-stamped so a re-run upgrades an existing install onto the current template.

## 5. The mechanism is synchronous stack capture, not profiling

NEAT needs the *call site* of an outbound call, which is on the synchronous stack when the CLIENT/PRODUCER span is created. It does not need CPU-time-to-span correlation (the profiler/sampling approach), and that approach is out of scope.

## 6. Evidence is never fabricated

Evidence is populated only from a real origin — a parsed `code.*` attribute or a matched extractor call site. Spans without `code.*` and config/infra edges without a line carry partial or absent evidence honestly. No synthesized file paths or line numbers.

## 7. Divergence compares at the shared grain

`get_divergences` compares a declared relationship against its observed twin at whichever grain both sides share: file-to-file when both carry a call site, service-level when the observed side has none. The file-grained case — declared call site vs. observed call site for the same pair — is the divergence finding at its sharpest.

## 8. Service-graph completeness precedes this

Multi-service attribution by `resource.service.name` is a prerequisite — files belong to services, so service attribution must be correct before file grain hangs on it. The make-or-break — does call-site capture land on the user's frame on real async Node code — is validated by a capture spike on the Brief harness before the file-node model is built on it.

## 9. File-native is server-side; the browser tier is deferred

The file in a file-native edge is the file in the **instrumented runtime** — the server process whose call-site processor captured the frame (§4). Server-side code is fully file-native: handlers, server actions / RSC, cron jobs, and workers all run where the processor sees the call site. The client/browser tier is not instrumented, so a pure client interaction attributes to the server file it reaches, not the frontend file.

Browser/client-tier file attribution — capturing the `.tsx` that issued a request — is a **deferred, demand-gated tier**: OTel-web instrumentation plus source-map resolution, additive on the same call-site model with no rework to the server-side graph. It is out of scope for the v0.5 arc and is built only when a concrete client-tier user story warrants its cost (source-map resolution, sampling the high-volume firehose, the added surface). This is consistent with the installer's runtime-kind detection, which already treats browser-bundle / React-Native packages as cleanly skipped and browser-OTel as a future feature, not a gap.
