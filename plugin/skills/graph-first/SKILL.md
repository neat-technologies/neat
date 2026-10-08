---
name: graph-first
description: Query NEAT's live semantic graph before searching files.
---

# NEAT — Claude Code skill

NEAT gives a coding agent a live semantic graph of the software system it is
working in. It fuses declarations from code, data schemas and infrastructure
with runtime traffic, incidents and supported provider telemetry, at the finest
grain the evidence permits. An agent can ask how a feature fits together, what
actually runs, where a failure began, and what an edit could affect before it
searches files or guesses from names. Every graph claim has provenance and
confidence; an unseen path is not proof that it never runs.

## What you get

The MCP server answers plain-language questions and exposes structured walks,
incident work orders, change impact, divergence and policy checks. It also
reports instrumentation gaps and, when hosted control-plane access is configured,
can manage supported provider connections. The table below is generated from the
registered tool descriptions, so its inventory follows the shipped server.

<!-- MCP_TOOL_TABLE_START -->
| Tool | Server description |
| --- | --- |
| `get_root_cause` | When a named node is failing, trace its dependency graph toward likely root-cause candidates. Returns a provenance-scored cause chain, including recorded error context when available, that file search cannot establish from runtime evidence. |
| `get_blast_radius` | Before changing or redeploying a node, see its downstream dependents and evidence-bearing paths. Returns the bounded blast radius so an edit plan includes affected services, routes, data, and callers. |
| `get_dependencies` | When you know a node id, map what it depends on across code, data, and infrastructure. Returns a bounded outgoing traversal (default depth 3, max 10) with distance, edge type, provenance, and confidence; depth=1 shows direct dependencies. |
| `get_observed_dependencies` | When you need evidence of what a node actually called, return only its OBSERVED outgoing dependencies from runtime or supported provider signals. Compare with get_dependencies or get_divergences to distinguish declared intent from seen behavior. |
| `get_incident_history` | When a node has failed, read its recorded error events, most recent first. The incident ledger preserves failure evidence and timestamps that a source search cannot reveal. |
| `get_incident_card` | When something is failing, get one work order for a service, file, or symbol: the recorded incident, likely cause chain, blast radius, governing policies, and divergences with provenance on each claim. Omit errorId for the latest incident or pin a specific one, then use expand/relate to verify the path. |
| `semantic_search` | When you cannot name a graph node, find candidate nodes by a natural-language description. Searches node labels through Ollama nomic-embed-text when reachable, then in-process MiniLM, then substring fallback; it does not search arbitrary source contents. MiniLM downloads a ~23 MB quantized model on a cold cache; set NEAT_SEARCH_PROVIDER=substring before daemon startup to avoid model initialization and download. |
| `get_graph_diff` | When reviewing a change or incident timeline, compare a saved snapshot with the live graph. Returns added, removed, and changed nodes and edges plus both timestamps, so architecture drift is visible beyond a file diff. |
| `get_recent_stale_edges` | When traffic or an integration seems to have disappeared, list recent OBSERVED → STALE edge transitions. Returns the edges that went quiet and when; quiet is a signal to investigate, not proof the dependency is healthy or removed. |
| `check_policies` | Before an edit, ask which architectural policies apply to its node; before a proposed action, dry-run its policy effect. Returns advisory rules or violations across structure, compatibility, provenance, ownership, and blast radius. Policies inform the agent; this tool does not block changes. |
| `get_divergences` | When you need to find drift between declared code/config and observed behavior, return ranked divergences: missing edges, version or host mismatches, compatibility violations, symbol/field mismatches, and observed failures. Each result carries confidence and severity; use this for a broad audit before choosing a specific failing node. |
| `expand` | After an incident card points to a locus, walk one evidence-bearing hop. "up" finds callers/dependents and "down" finds callees/dependencies; each neighbor is classified primary-failure, symptom-only, or unrelated so you can separate cause from downstream symptoms. |
| `relate` | Test a suspected cause-and-symptom pair. Returns a bounded connecting path, direction, per-hop provenance, and whether error/latency signal carries end to end. No path within the bound is reported as such, not as proof the nodes are unrelated. |
| `ask` | Ask the graph a question in plain language — the front door to NEAT. Reach for this FIRST, before Read/Grep/Bash, for any question about this system's behaviour, dependencies, failures, root cause, or blast radius. You do NOT need to know which tool or the exact node id: `ask` resolves the entities in your question to graph nodes and routes it to the right traversal (root cause, dependencies, observed runtime calls, incidents, divergences, blast radius), returning one compact answer with every fact provenance-tagged (EXTRACTED/OBSERVED/INFERRED/STALE) and confidence-scored. Ask what a node talks to, connects to, uses, hits, calls, reads from, or writes to for dependencies; add actually, in production, or at runtime for observed calls. Ask who calls or depends on a node, or for its consumers or callers, for blast radius. Ask about slow, latency, p95, or timing for runtime evidence; a why/failure question leads with root cause. Use the structured tools (get_root_cause, get_dependencies, …) when you already have a node id and want just that one traversal. |
| `neat_list_uninstrumented` | When the graph lacks expected runtime evidence, list project libraries outside automatic instrumentation coverage. Returns first-party, third-party, and gap libraries that may need an explicit instrumentation package. |
| `neat_lookup_instrumentation` | When a library is an instrumentation gap, look up its supported registry recipe. Returns the instrumentation package, matching version range, and registration snippet when one exists. |
| `neat_describe_project_instrumentation` | When OBSERVED evidence is missing, inspect this project's instrumentation wiring. Returns hook-file presence, .env.neat presence, and installed OTel dependencies before you change code. |
| `neat_apply_extension` | After reviewing an instrumentation gap and preferably previewing it, apply the chosen library extension. Installs the package and updates the OTel hook, package.json, and lockfile; repeating the same extension is a no-op. |
| `neat_dry_run_extension` | Before filling an instrumentation gap, preview the extension. Returns the exact file diff, dependencies, and install command without changing the project. |
| `neat_rollback_extension` | If a library extension needs reversing, remove its package.json dependency and hook registration. Returns the rollback result; run the package manager afterward because this tool does not refresh the lockfile. |
| `neat_list_connectable` | When a hosted graph lacks provider-side evidence, list the providers this project can connect. Returns control-plane options, or a configuration note when NEAT_CP_URL and a neat_pat_ NEAT_API_KEY are unavailable. |
| `neat_connect` | When authorized to add hosted provider evidence, connect a listed provider with its API credential. The control plane verifies and seals the credential; the daemon then polls or receives the supported telemetry into OBSERVED. Hosted only. |
| `neat_connection_status` | When provider evidence is absent or stale in a hosted graph, inspect connections and their connecting, healthy, error, or needs-reconnect status. Returns control-plane state, not a live graph traversal. |
| `neat_disconnect` | When authorized to remove a hosted provider integration, disconnect it and drop its stored connection. Returns the control-plane result; this changes future provider evidence, not source code. |
<!-- MCP_TOOL_TABLE_END -->

Hosted connector tools need `NEAT_CP_URL` and `NEAT_API_KEY`, a `neat_pat_` NEAT API key. Keys are minted by the control plane's `POST /me/tokens`; the app.neat.is console doesn't offer them yet. `neat login` stores a daemon token for graph queries; it does not configure control-plane connector tools.

Graph queries read the daemon's live graph. Instrumentation tools can change local instrumentation files and dependencies. Hosted connector actions call the control plane and can change connection state. NEAT does not call an LLM to answer graph questions.

`semantic_search` uses Ollama (`nomic-embed-text`) when reachable, otherwise it can initialize the in-process `Xenova/all-MiniLM-L6-v2` model. MiniLM downloads its ~23 MB quantized model on a cold cache. Set `NEAT_SEARCH_PROVIDER=substring` for search without model initialization or download, `ollama` to use only Ollama, or `transformers` to use MiniLM explicitly. An unset value keeps automatic selection. The same setting applies to the daemon and `neat watch`.

## Where OBSERVED comes from

The observed-facing read tools — `get_observed_dependencies`, `get_divergences`, `get_incident_history`, `get_recent_stale_edges` — reflect two OBSERVED sources, not one:

- **OTel spans** — pushed by the instrumented app at runtime. The `/neat extend` tools above are how that gets wired up.
- **Provider connectors** — NEAT polls supported provider APIs or receives their telemetry through a configured drain, then folds that data into the OBSERVED layer. Run `npx neat.is connector --help` for the current provider list; its usage text reads the connector registry. A provider can supply observed edges, incidents, and staleness even without an app span.

Connectors are configured out of band, not through this skill: `npx neat.is connector add <provider>` / `list` / `remove <id>` / `test <id>` (ADR-130). Credentials are stored as an env-var reference (`$VAR`) resolved at run time and redacted everywhere, so the agent reads the resulting OBSERVED data but never sees a secret. `GET /:project/connectors` reports each connector's poll health over REST if you need it.

A `ServiceNode` may carry a static `platform` hint inferred from repository configuration. It is an EXTRACTED claim, separate from connector observations; inspect the node's provenance rather than assuming a provider is connected.

## Install

For an npx-based setup, run:

```bash
npx neat.is skill --apply
```

This merges the `neat` MCP server into `~/.claude.json` without replacing other entries. To inspect and merge the configuration manually, run `npx neat.is skill --print-config`. If `neat` is installed globally, the same commands work without `npx`.

<!-- GRAPH_FIRST_START -->
<!-- NEAT graph-first directive. Paste this block into your agent's project
     instructions — CLAUDE.md, AGENTS.md, .cursorrules, or the equivalent.
     Agent-agnostic: it is plain guidance, no Claude Code features required. -->

## Query NEAT before searching files

This project has a live NEAT graph: code, data and infrastructure declarations
fused with runtime traffic, incidents and supported provider telemetry. It can
show what exists, what actually ran, where a failure began, and what may break
when a node changes. The graph is deterministic: the agent supplies the model;
NEAT resolves named nodes and traverses recorded evidence rather than asking an
LLM to infer architecture from file names.

Every claim carries provenance and confidence. `EXTRACTED` comes from recognized
source or configuration, `OBSERVED` from spans or supported provider signals,
`INFERRED` from a bridged relationship, and `STALE` marks an observed edge that
went quiet. Missing runtime evidence does not prove a path never runs.

**For questions about this system's behavior, structure, data dependencies,
failures, or change impact, call the MCP `ask` tool (`mcp__neat__ask`) before
Read/Grep/Glob/Bash.** You do not need an exact node id. `ask` resolves names
and routes to the relevant graph traversal, returning provenance-tagged facts.
When MCP is unavailable, use the same door through the CLI:

```
npx neat.is ask "why is checkout failing?"
npx neat.is ask "what breaks if I change the orders table?"
npx neat.is ask "what does the payments service depend on at runtime?"
```

For a failure, ask first, then call `get_incident_card` on the named service,
file or symbol. The card combines the incident, likely cause, blast radius,
policies and divergence into a work order. Use `expand` one hop at a time and
`relate` to test whether the suspected cause and symptom share a signal. Check
provenance and confidence before acting.

Before a change, use `get_blast_radius` and `check_policies` to see dependents
and advisory architectural rules. Use `get_divergences` to compare declared
intent with observed behavior, `get_graph_diff` to compare a saved snapshot
with the live graph, and `get_recent_stale_edges` when traffic goes quiet.
`get_dependencies` maps a node's outgoing graph; `get_observed_dependencies`
shows only seen runtime/provider calls. `semantic_search` finds node labels,
not arbitrary source text.

Read source when the graph does not model what you need: comments, arbitrary
string literals, config details, unsupported syntax, or a repository that has
not been extracted or connected. If a graph answer is empty, check the daemon
with `npx neat.is list` or restart it with `npx neat.is up`; wire MCP with
`npx neat.is skill --apply`.
<!-- GRAPH_FIRST_END -->

## Prerequisites

- Build a graph from this project with `npx neat.is` (or run `npx neat.is init . --apply` when setting it up manually). The first-run door starts a per-project daemon in the background.
- Run `npx neat.is skill --apply` to wire this MCP server into Claude Code. Use `npx neat.is list` to see the project's live daemon and its port; `npx neat.is up` restarts it if needed.

## What's not in MVP

- Auto-detection of an alternate Claude Code config path. The installer assumes `~/.claude.json`.
- Per-project skill overrides. The skill is user-scoped; project-level MCP config can be added later as a follow-up.
- Tool-level disable flags. Every tool is wired in; if you want to hide one, edit the snippet by hand.

## Where to look when it doesn't work

- `npx neat.is list` — shows registered projects and their daemon status/ports.
- `~/.claude.json` — the config file. Look for `mcpServers.neat`.
- `claude mcp list` — Claude Code's built-in inventory of MCP servers.
