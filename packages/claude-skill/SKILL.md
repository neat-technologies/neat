# NEAT — Claude Code skill

This skill exposes NEAT's live semantic graph to Claude Code over MCP. Once installed, Claude can ask the running NEAT daemon (`neatd`) about a project's services, dependencies, recent errors, and policy violations — same as any other agent NEAT supports.

## What you get

NEAT exposes graph queries, instrumentation helpers, and hosted connector actions over MCP. The tool names come from `MCP_TOOL_NAMES` and the descriptions below are generated from the server registrations. Query the graph first when you need to understand behavior, dependencies, incidents, or change impact.

<!-- MCP_TOOL_TABLE_START -->
| Tool | Server description |
| --- | --- |
| `get_root_cause` | When a named node is failing, trace its dependency graph toward likely root-cause candidates. Returns a provenance-scored cause chain, including recorded error context when available, that file search cannot establish from runtime evidence. |
| `get_blast_radius` | Before changing or redeploying a node, see its downstream dependents and evidence-bearing paths. Returns the bounded blast radius so an edit plan includes affected services, routes, data, and callers. |
| `get_dependencies` | When you know a node id, map what it depends on across code, data, and infrastructure. Returns a bounded outgoing traversal (default depth 3, max 10) with distance, edge type, provenance, and confidence; depth=1 shows direct dependencies. |
| `get_observed_dependencies` | When you need evidence of what a node actually called, return only its OBSERVED outgoing dependencies from runtime or supported provider signals. Compare with get_dependencies or get_divergences to distinguish declared intent from seen behavior. |
| `get_incident_history` | When a node has failed, read its recorded error events, most recent first. The incident ledger preserves failure evidence and timestamps that a source search cannot reveal. |
| `get_incident_card` | When something is failing, get one work order for a service, file, or symbol: the recorded incident, likely cause chain, blast radius, governing policies, and divergences with provenance on each claim. Omit errorId for the latest incident or pin a specific one, then use expand/relate to verify the path. |
| `semantic_search` | When you cannot name a graph node, find candidate nodes by a natural-language description. Searches node labels through Ollama nomic-embed-text when reachable, then in-process MiniLM, then substring fallback; it does not search arbitrary source contents. MiniLM can download a multi-hundred-megabyte model on a cold cache; set NEAT_SEARCH_PROVIDER=substring before daemon startup to avoid model initialization and download. |
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

Graph queries read the daemon's live graph. Instrumentation tools can change local instrumentation files and dependencies. Hosted connector actions call the control plane and can change connection state. NEAT does not call an LLM to answer graph questions.

`semantic_search` uses Ollama (`nomic-embed-text`) when reachable, otherwise it can initialize the in-process `Xenova/all-MiniLM-L6-v2` model. MiniLM may require a multi-hundred-megabyte download on a cold cache. Set `NEAT_SEARCH_PROVIDER=substring` for search without model initialization or download, `ollama` to use only Ollama, or `transformers` to use MiniLM explicitly. An unset value keeps automatic selection. The same setting applies to the daemon and `neat watch`.

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

<!-- GRAPH_FIRST_START -->
<!-- NEAT graph-first directive. Paste this block into your agent's project
     instructions — CLAUDE.md, AGENTS.md, .cursorrules, or the equivalent —
     so the agent queries NEAT's graph before it scans files by hand.
     Agent-agnostic: it is plain guidance, no Claude Code features required. -->

## Query the graph FIRST

This project has NEAT wired in: a live, fused semantic graph of the system —
code, infrastructure, and runtime behaviour (OpenTelemetry) in one model. Every
fact carries provenance — `EXTRACTED` from source, `OBSERVED` from OTel,
`INFERRED` where the trace stitcher bridges a gap, `STALE` when runtime goes
quiet — plus a confidence, so you know how much to trust each answer.

**For ANY question about this system's behaviour, dependencies, failures, root
cause, or blast radius, call the MCP `ask` tool (`mcp__neat__ask`) FIRST — before Read, Grep, Glob, or
Bash.** You do not need to know which tool or the exact node id: `ask` is the
front door. It resolves the entities in your question to graph nodes and routes
it to the right traversal, returning one compact, provenance-tagged answer.

```
npx neat.is ask "why is checkout failing?"
npx neat.is ask "what breaks if I change the orders table?"
npx neat.is ask "what does the payments service depend on at runtime?"
```

Use the CLI examples when MCP is not configured.

When something is failing, ask what failed, get its `get_incident_card`, then
use `expand` and `relate` to walk the root-cause chain. The card gives the
incident locus, root cause, blast radius, policies, and divergence in one work
order. Check the provenance and confidence of each claim before acting.

The graph is live and fused: it is faster and more accurate than
`grep`/`glob`/`find`, and it can tell you what the system *actually does at
runtime*, not only what the source declares.

When you already have a node id and want one specific traversal, the structured
tools answer directly:

- `semantic_search` — find code/nodes by a natural-language description.
- `get_dependencies` — a node's transitive outgoing dependencies (`EXTRACTED`).
- `get_observed_dependencies` — only what a node calls *in production* (`OBSERVED`).
- `get_divergences` — where the code (`EXTRACTED`) and production (`OBSERVED`) disagree.
- `get_root_cause` — trace a failing node up its dependency graph to the culprit.
- `get_blast_radius` — everything downstream: what breaks if a node changes or fails.
- `get_incident_history` — recent OTel error events recorded against a node.
- `get_incident_card` — an incident work order with cause, impact, policies, and divergence.
- `expand` / `relate` — walk the graph around a failure and test whether two nodes are connected by the failure signal.
- `get_graph_diff` — compare a saved graph snapshot with the live graph.
- `get_recent_stale_edges` — find observed integrations that have gone quiet.
- `check_policies` — the project's `policy.json` violations, actual or hypothetical.

Fall back to text search only when the graph does not have what you need —
comments, string literals, config minutiae, a file NEAT does not model. The rule
is order: ask the graph first, then scan.

If the tools are not available, check the daemon with `npx neat.is list` or
restart it with `npx neat.is up`. Wire MCP with `npx neat.is skill --apply`.
<!-- GRAPH_FIRST_END -->

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
