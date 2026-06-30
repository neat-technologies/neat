---
name: extend-skill
description: "/neat extend is a set of six MCP surgical tools for long-tail instrumentation — three diagnostic (read-only), three operative (file-scope-restricted, idempotent, reversible, observable). The user's MCP agent reasons; NEAT operates. NEAT holds no LLM key and never auto-applies. No standalone CLI variant. Discovery is explicit: the orchestrator surfaces libraries needing extension at init/sync time, single-sourced from one registry-coverage classifier shared with the dashboard and the MCP tools."
governs:
  - "packages/mcp/src/index.ts"
  - "packages/core/src/extend/**"
  - "packages/core/src/orchestrator.ts"
adr: [ADR-081, ADR-086, ADR-080]
enforcement: [lint, review]
---

# `/neat extend` skill contract

`/neat extend` exposes NEAT's instrumentation surface to the user's MCP-capable agent as surgical tools. The agent provides intelligence; NEAT provides scoped, reversible primitives. This contract supersedes ADR-081's standalone-CLI and operator-LLM-key portions per ADR-086.

## 1. Six tools, two roles

**Diagnostic (read-only):** `neat_list_uninstrumented(project)`, `neat_lookup_instrumentation(library, installed_version?)`, `neat_describe_project_instrumentation(project)`.

**Operative (mutate the instrumentation surface):** `neat_apply_extension(library, instrumentation_package, version, registration_snippet)`, `neat_dry_run_extension(...)`, `neat_rollback_extension(library)`.

Each operative tool does exactly one thing. No macro tool applies multiple extensions in one call.

## 2. NEAT holds no LLM key; the agent reasons

There is no `NEAT_LLM_API_KEY` and no LLM call originating from NEAT during the skill's execution. Registry hits resolve deterministically through the registry loader (see [`instrumentation-registry.md`](./instrumentation-registry.md)). Registry misses are reasoned about by the agent's own model; the agent drafts a proposal and the user confirms via `neat_dry_run_extension` before any `neat_apply_extension` call.

## 3. No standalone CLI variant

Users without an MCP agent get the deterministic `npx neat.is` install. Extension requires an MCP-capable agent. There is no `npx @neat.is/instrument` fallback.

## 4. File-scope restricted

Operative tools modify only `instrumentation*.ts` / `otel-init*`, `.env.neat`, `package.json`, and the lockfile (via the project's package manager). Any write attempt outside this surface returns an error.

## 5. Idempotent, reversible, observable

`apply` called twice with the same args is a no-op the second time. Every apply logs its diff to `~/.neat/extend-log.ndjson` so `rollback` can undo it. Apply returns the exact files touched, deps added, and install-command output.

## 6. NEAT never auto-applies

Every operative call is an explicit MCP invocation. The daemon's background processes — file watch, OTel ingest, staleness loop — are read-only against the user's repository and never trigger an extension.

## 7. Discovery — the user is told what needs extending

The user never has to guess that extension is needed. After computing the install plan, the orchestrator classifies every detected dependency against the registry and surfaces the libraries that need more than the bundle or the HTTP fallback. Three surfaces, same source:

- **Init/sync-time hint (CLI).** The orchestrator emits a closing block naming each library whose coverage is `first-party`, `third-party`, or `gap`, and distinguishes two cases: a **registry hit** ("`@prisma/client` → registered; run `/neat extend` and it's deterministic") from a **registry miss** ("`some-orm` → no registry entry; `/neat extend` can reason about it"). It points the user's agent at the skill. Libraries that are `bundled` or `http-only` are **not** surfaced — they already work, and noise there would erode the signal.
- **Dashboard coverage view.** A row per detected library with its coverage glyph and a "click to extend" affordance (lands with the frontend work).
- **MCP self-description.** `neat_list_uninstrumented(project)` returns the same set on demand for the agent.

This is distinct from out-of-scope **runtime** detection ([`installer-scope.md`](./installer-scope.md) §3), which fires on Bun / Deno / Workers and points at the BYO-OTel path. §7 fires on libraries *within* an in-scope runtime that need instrumentation beyond the bundle. Together they cover everything NEAT detects it cannot deterministically instrument on contact.

## 8. One classifier, every surface

The init-time hint, the dashboard coverage view, and `neat_list_uninstrumented` all derive from a single coverage-classification function over the registry (`resolve(library, version).coverage`). No surface computes coverage independently, so the CLI, the dashboard, and the agent never disagree about what needs extending.

Boundary (stated so it isn't a silent omission): **runtime** coverage-gap detection — a `bundled` library that produces no OBSERVED spans despite live traffic — is a separate, future surface. It needs runtime observation rather than static dependency classification and is out of scope for this contract.
