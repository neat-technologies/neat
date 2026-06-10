---
name: neat
description: Query a live semantic graph of a running software system — dependencies, runtime traffic, root-cause analysis, blast radius, and incident history. Use this for architecture-level questions before reading source code.
---

# NEAT skill

NEAT keeps a continuously updated graph of a software system from static analysis + OpenTelemetry. This skill exposes it over sixteen MCP tools: ten read-only graph queries plus six `/neat extend` tools for instrumentation. The canonical list is `MCP_TOOL_NAMES` in `@neat.is/types`.

## When to invoke

Reach for these tools when a question would take multiple file reads to answer from source. The graph already has the answer.

| Prompt                                                  | Tool                       |
|---------------------------------------------------------|----------------------------|
| "Is anything weird?" / "find me a bug"                  | `get_divergences`          |
| "Why is payments-db failing?"                           | `get_root_cause`           |
| "What breaks if I redeploy service-a?"                  | `get_blast_radius`         |
| "What does service-a depend on?"                        | `get_dependencies`         |
| "What does service-b actually call at runtime?"         | `get_observed_dependencies`|
| "Show me recent errors on database:payments-db"         | `get_incident_history`     |
| "What changed since the last snapshot?"                 | `get_graph_diff`           |
| "Which integrations have gone quiet?"                   | `get_recent_stale_edges`   |
| "Any policy violations right now?"                      | `check_policies`           |
| "Find nodes matching pg"                                | `semantic_search`          |

## Read tools

### `get_root_cause`

Trace upstream from a failing node to find the actual cause. Walks incoming dependency edges, prefers OBSERVED → INFERRED → EXTRACTED, runs the compatibility matrix at each ServiceNode against the originating DatabaseNode.

Inputs: `errorNode` (graph node id, e.g. `database:payments-db`), optional `errorId` (a specific incident id from `get_incident_history`).

### `get_blast_radius`

Walk outgoing dependencies from a node and list every downstream component with distance + the provenance of the edge that brought us to it.

Inputs: `nodeId`, optional `depth` (default 10, max 20).

### `get_dependencies`

Outgoing dependency tree, deduped to the most trustworthy provenance per (target, edge type) pair. BFS to depth N (default 3, max 10); `depth=1` returns direct dependencies only.

Inputs: `nodeId`, optional `depth`.

### `get_observed_dependencies`

OBSERVED-only outgoing edges — services and databases the node actually contacted in production. Useful for spotting drift between code and reality.

Inputs: `nodeId`.

### `get_incident_history`

Recent OTel error events recorded against a node, newest first.

Inputs: `nodeId`, optional `limit` (default 20, max 100).

### `get_divergences`

Places where what the code declares (EXTRACTED) doesn't match what production observed (OBSERVED), ranked by confidence × severity. The single most NEAT-shaped query — reach for it on "is anything weird?" or "find me a bug" on an unfamiliar codebase, before `get_root_cause` when no specific node is failing.

Inputs: all optional — `type` (one or more of `missing-observed`, `missing-extracted`, `version-mismatch`, `host-mismatch`, `compat-violation`), `minConfidence` (0.0–1.0), `node` (scope to one node id).

### `get_graph_diff`

Diff a saved graph snapshot against the current live graph — added/removed/changed nodes and edges, with both snapshot timestamps. For change reviews and post-incidents.

Inputs: `againstSnapshot` (path or http(s) URL of the "before" snapshot).

### `get_recent_stale_edges`

Most recent OBSERVED → STALE edge transitions — integrations that have gone quiet. A `CALLS` edge that just went stale usually means an upstream stopped calling.

Inputs: optional `limit` (default 50, max 200), optional `edgeType` filter (e.g. `CALLS`).

### `check_policies`

Inspect or dry-run the project's `policy.json` — architectural assertions in five shapes (structural / compatibility / provenance / ownership / blast-radius). Without `hypotheticalAction` it returns currently-recorded violations; with one, the violations the action would cause.

Inputs: optional `scope`, optional `hypotheticalAction`.

### `semantic_search`

Search nodes by natural-language query. Uses embedding vectors when an embedder is available (Ollama `nomic-embed-text` → in-process MiniLM → substring fallback) — phrase the query the way you'd describe what you want.

Inputs: `query`.

## Extend tools (`/neat extend`)

Six surgical tools for filling instrumentation gaps (ADR-081 / ADR-086). Three are read-only diagnostics; three modify instrumentation files, `package.json`, and the lockfile only. NEAT never calls an LLM — the agent reasons over their output and NEAT never auto-applies.

### `neat_list_uninstrumented`

List first-party, third-party, and gap libraries that need an explicit instrumentation package beyond the auto-instrumentations bundle.

Inputs: none (optional `project`).

### `neat_lookup_instrumentation`

Look up the registry entry for a library — canonical instrumentation package, version, and registration snippet if one exists.

Inputs: `library` (npm package name), optional `installedVersion`.

### `neat_describe_project_instrumentation`

Describe the project's current OTel state: which hook files exist, whether `.env.neat` is present, which OTel deps are installed.

Inputs: none (optional `project`).

### `neat_dry_run_extension`

Preview what `neat_apply_extension` would do — the exact file diff, deps to add, install command — without making any changes.

Inputs: `library`, `instrumentation_package`, `version`, `registration_snippet`.

### `neat_apply_extension`

Install an instrumentation package and splice its registration into the existing OTel hook file. Idempotent — calling twice with the same args is a no-op.

Inputs: `library`, `instrumentation_package`, `version`, `registration_snippet`.

### `neat_rollback_extension`

Undo the last `neat_apply_extension` for a library — removes the dep from `package.json` and the registration from the hook file. Run the package manager manually afterward to sync the lockfile.

Inputs: `library`.

## Provenance and confidence

Every edge in the graph — and every result that comes out of these tools — carries a provenance: OBSERVED (live OTel traffic, confidence 1.0), INFERRED (derived from other edges, confidence 0.6), EXTRACTED (read from source, confidence 0.5), or STALE (was OBSERVED, hasn't been seen recently, confidence 0.3). Tools surface this in their text output so you can weight claims accordingly. See [PROVENANCE.md](../../PROVENANCE.md) at the repo root for the full model.

## Configuration

Set `NEAT_CORE_URL` if `@neat.is/core` is not running on `http://localhost:8080`.

## Install

```bash
npm install -g @neat.is/mcp
neat install
```

This registers the server with Claude Code and all sixteen tools become available in any session.
