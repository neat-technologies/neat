---
name: graph-first
description: Query NEAT's live semantic graph before searching files.
---

# NEAT — Claude Code skill

This skill exposes NEAT's live semantic graph to Claude Code over MCP. Once installed, Claude can ask the running NEAT daemon (`neatd`) about a project's services, dependencies, recent errors, and policy violations — same as any other agent NEAT supports.

## What you get

NEAT exposes graph queries, instrumentation helpers, and hosted connector actions over MCP. The tool names come from `MCP_TOOL_NAMES` and the descriptions below are generated from the server registrations. Query the graph first when you need to understand behavior, dependencies, incidents, or change impact.

<!-- MCP_TOOL_TABLE_START -->
| Tool | Server description |
| --- | --- |
| `get_root_cause` | Trace a failing node up its dependency graph to find the underlying cause. Use this when something is breaking and you want to know which upstream component is the actual culprit. |
| `get_blast_radius` | List every node that depends on the given node — what would break if this node failed or was redeployed. |
| `get_dependencies` | List the transitive outgoing dependencies of a node, BFS to depth N (default 3, max 10). Each result carries distance, edge type, and provenance — both static (EXTRACTED) and runtime (OBSERVED). Pass depth=1 for direct-only. |
| `get_observed_dependencies` | List only the runtime (OBSERVED via OTel) outgoing dependencies of a node. Use this to compare what code SAYS the service depends on vs what production actually does. |
| `get_incident_history` | Return recent OTel error events recorded against a node, most recent first. |
| `get_incident_card` | One self-sufficient work order for an incident on a node (ADR-221): the incident fused with its root-cause chain, blast radius, governing policies, and node divergence — each claim provenance-stamped, so you can act without grepping. Give a node id (a service, file, or symbol); omit errorId for the node's most-recent incident, or pass errorId to pin one. |
| `semantic_search` | Search nodes by natural-language query. Uses embedding vectors when an embedder is available (Ollama nomic-embed-text → in-process MiniLM → substring fallback) — phrase the query the way you would describe what you want. |
| `get_graph_diff` | Diff a saved graph snapshot against the current live graph. Useful for change reviews and post-incidents — answers "what changed in the architecture between then and now." Returns added/removed/changed nodes and edges with both snapshot timestamps. |
| `get_recent_stale_edges` | List the most recent OBSERVED → STALE edge transitions. Use this to spot integrations that have gone quiet — a CALLS edge that just went stale typically means an upstream stopped calling, not that the link is healthy. |
| `check_policies` | Inspect, dry-run, or get the soft guardrail for the project's policy.json. With applicableTo, returns the policies that apply where you are working — surfaced as context so you stay inside the lines (informs, never blocks). Without hypotheticalAction or applicableTo, returns currently-recorded violations. With hypotheticalAction, returns violations that would result if the action were applied. Architectural assertions in five shapes (structural / compatibility / provenance / ownership / blast-radius). |
| `get_divergences` | Returns places where what the code declares (EXTRACTED) doesn't match what production observed (OBSERVED). The single most NEAT-shaped query — the one that justifies the whole graph. Use when the user asks 'is anything weird?' or 'what does production do that the code doesn't?' or 'find me a bug' on an unfamiliar codebase. Returns divergences ranked by confidence × severity. Prefer this over `get_root_cause` when no specific node is failing. |
| `expand` | Take one navigation step from a node and classify the neighbourhood (ADR-189). direction "up" walks to callers/dependents (who calls this), "down" walks to callees/dependencies (what this calls). Each neighbour comes back classified primary-failure / symptom-only / unrelated. Use this to navigate a failure one hop at a time instead of trusting a single verdict — a symptom-only node is a downstream victim, so walk "up" from it toward the real cause. |
| `relate` | Confirm whether two nodes are connected, which way, and whether the connecting path carries the failure (ADR-189). Returns the direction (a→b or b→a), the path with per-hop provenance, and carriesSignal — whether errors/latency run end to end, which turns "a path exists" into "a is actually causing b". No path within the depth bound returns "no path within N hops", never a false "unrelated". |
| `ask` | Ask the graph a question in plain language — the front door to NEAT. Reach for this FIRST, before Read/Grep/Bash, for any question about this system's behaviour, dependencies, failures, root cause, or blast radius. You do NOT need to know which tool or the exact node id: `ask` resolves the entities in your question to graph nodes and routes it to the right traversal (root cause, dependencies, observed runtime calls, incidents, divergences, blast radius), returning one compact answer with every fact provenance-tagged (EXTRACTED/OBSERVED/INFERRED/STALE) and confidence-scored. Ask what a node talks to, connects to, uses, hits, calls, reads from, or writes to for dependencies; add actually, in production, or at runtime for observed calls. Ask who calls or depends on a node, or for its consumers or callers, for blast radius. Ask about slow, latency, p95, or timing for runtime evidence; a why/failure question leads with root cause. Use the structured tools (get_root_cause, get_dependencies, …) when you already have a node id and want just that one traversal. |
| `neat_list_uninstrumented` | List libraries in the project that need instrumentation beyond the auto-instrumentations bundle. Returns first-party, third-party, and gap libraries that require an explicit instrumentation package. |
| `neat_lookup_instrumentation` | Look up the registry entry for a specific library. Returns the canonical instrumentation package, version, and registration snippet if one exists. |
| `neat_describe_project_instrumentation` | Describe the current state of OTel instrumentation in the project: which hook files exist, whether .env.neat is present, which OTel deps are installed. |
| `neat_apply_extension` | Install an instrumentation package and splice its registration into the existing OTel hook file. Idempotent — calling twice with the same args is a no-op. Only modifies instrumentation files, package.json, and the lockfile (via the project package manager). |
| `neat_dry_run_extension` | Preview what neat_apply_extension would do without making any changes. Returns the exact file diff, deps to add, and install command. |
| `neat_rollback_extension` | Undo the last neat_apply_extension for a given library. Removes the dep from package.json and the registration from the hook file. Does not re-run the package manager — run install manually to sync the lockfile. |
| `neat_list_connectable` | List the providers you can connect to this hosted project (Supabase, Railway, …). Hosted only — needs NEAT_CP_URL and a NEAT_API_KEY (neat_pat_); returns a "not configured" note otherwise. |
| `neat_connect` | Connect a provider to this hosted project by pasting its API token — the headless path, no browser needed. NEAT verifies the token against the provider, seals it, and pulls the provider into the project graph as OBSERVED. Hosted only. |
| `neat_connection_status` | List the providers connected to this hosted project and each connection's status (connecting / healthy / error / needs reconnect). Hosted only. |
| `neat_disconnect` | Disconnect a provider from this hosted project — drops its stored connection(s). Hosted only. |
<!-- MCP_TOOL_TABLE_END -->

Graph queries read the daemon's live graph. Instrumentation tools can change local instrumentation files and dependencies. Hosted connector actions call the control plane and can change connection state. NEAT does not call an LLM to answer graph questions.

## Where OBSERVED comes from

The observed-facing read tools — `get_observed_dependencies`, `get_divergences`, `get_incident_history`, `get_recent_stale_edges` — reflect two OBSERVED sources, not one:

- **OTel spans** — pushed by the instrumented app at runtime. The `/neat extend` tools above are how that gets wired up.
- **Provider connectors** — NEAT polls supported provider APIs or receives their telemetry through a configured drain, then folds that data into the OBSERVED layer. Run `npx neat.is connector --help` for the current provider list; its usage text reads the connector registry. A provider can supply observed edges, incidents, and staleness even without an app span.

Connectors are configured out of band, not through this skill: `neat connector add <provider>` / `list` / `remove <id>` / `test <id>` (ADR-130). Credentials are stored as an env-var reference (`$VAR`) resolved at run time and redacted everywhere, so the agent reads the resulting OBSERVED data but never sees a secret. `GET /:project/connectors` reports each connector's poll health over REST if you need it.

A `ServiceNode` may carry a static `platform` hint inferred from repository configuration. It is an EXTRACTED claim, separate from connector observations; inspect the node's provenance rather than assuming a provider is connected.

## Install

For an npx-based setup, run:

```bash
npx neat.is skill --apply
```

This merges the `neat` MCP server into `~/.claude.json` without replacing other entries. To inspect and merge the configuration manually, run `npx neat.is skill --print-config`. If `neat` is installed globally, the same commands work without `npx`.

## Reach for the graph first

Wiring the tools in is half the job; the other half is getting your agent to
*use* them instead of falling straight to text search. NEAT ships two nudges:

```bash
neat hooks --apply
```

That installs both:

1. **A Claude Code search-nudge hook.** A `PreToolUse` hook (materialised to
   `~/.neat/hooks/neat-search-nudge.mjs`, wired into `~/.claude/settings.json`)
   that fires when the agent reaches for `Grep`, `Glob`, or a Bash
   `grep`/`rg`/`find`. It injects a short note steering the agent to
   `semantic_search` / `get_dependencies` / `get_divergences` first. It is a
   **gentle, non-blocking nudge** — the search still runs; the agent just sees
   the graph as the better first move. Your existing hooks are left in place,
   and re-running is idempotent.

2. **Agent-agnostic graph-first guidance** (`GRAPH_FIRST.md`, also written to
   `~/.neat/neat-graph-first.md`). A markdown block you paste into your project
   instructions — `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, whatever your agent
   reads — so the same "ask the graph before grepping" steer reaches agents on
   any harness.

The hook is Claude-Code-specific; agents on other harnesses (Codex, Gemini,
Cursor, …) don't get the `PreToolUse` interception, but the guidance block
gives them the same instruction. Preview either without installing:

```bash
neat hooks --print-hook       # the hook script
neat hooks --print-guide      # the graph-first guidance
neat hooks --print-settings   # the settings.json block --apply merges
```

## Prerequisites

- `neat init <repo>` has registered at least one project.
- `neatd start` is running (or you're OK with `npx -y @neat.is/mcp` spawning per request — slower, but works).
- The `NEAT_API_URL` env var points at the running daemon's REST endpoint. Default is `http://localhost:8080`, which matches the daemon's default port.

## What's not in MVP

- Auto-detection of an alternate Claude Code config path. The installer assumes `~/.claude.json`.
- Per-project skill overrides. The skill is user-scoped; project-level MCP config can be added later as a follow-up.
- Tool-level disable flags. Every tool is wired in; if you want to hide one, edit the snippet by hand.

## Where to look when it doesn't work

- `neatd status` — confirms the daemon is running and which projects are registered.
- `~/.claude.json` — the config file. Look for `mcpServers.neat`.
- `claude mcp list` — Claude Code's built-in inventory of MCP servers.
