# NEAT — Claude Code skill

This skill exposes NEAT's live semantic graph to Claude Code over MCP. Once installed, Claude can ask the running NEAT daemon (`neatd`) about a project's services, dependencies, recent errors, and policy violations — same as any other agent NEAT supports.

## What you get

Sixteen MCP tools, served by `@neat.is/mcp` over stdio — ten read-only graph queries plus six `/neat extend` tools for instrumentation. The canonical list lives in `MCP_TOOL_NAMES` (`@neat.is/types`); the server registrations are the source for every description below.

### Read tools

| Tool | What it does |
|------|--------------|
| `get_root_cause` | Trace a failing node up its dependency graph to the underlying cause. Use when something is breaking and you want the upstream culprit. |
| `get_blast_radius` | List every node downstream of a node — what would break if it failed or was redeployed. |
| `get_dependencies` | Transitive outgoing dependencies, BFS to depth N, each carrying distance, edge type, and provenance (EXTRACTED vs OBSERVED). |
| `get_observed_dependencies` | Only the runtime (OBSERVED via OTel) outgoing dependencies — compare what code declares against what production does. |
| `get_incident_history` | Recent OTel error events recorded against a node, most recent first. |
| `get_divergences` | Places where the code (EXTRACTED) and production (OBSERVED) disagree, ranked by confidence × severity. The most NEAT-shaped query — reach for it on "is anything weird?" |
| `get_graph_diff` | Diff a saved graph snapshot against the current live graph — added/removed/changed nodes and edges. |
| `get_recent_stale_edges` | Most recent OBSERVED → STALE transitions — integrations that have gone quiet. |
| `check_policies` | Inspect or dry-run the project's `policy.json`. Returns current violations, or violations a hypothetical action would cause. |
| `semantic_search` | Search nodes by natural-language query (embedding vectors when available, substring fallback otherwise). |

### Extend tools (`/neat extend`, ADR-081 / ADR-086)

| Tool | What it does |
|------|--------------|
| `neat_list_uninstrumented` | List libraries that need instrumentation beyond the auto-instrumentations bundle. |
| `neat_lookup_instrumentation` | Look up the registry entry for a library — canonical instrumentation package, version, registration snippet. |
| `neat_describe_project_instrumentation` | Describe the current OTel state: which hook files exist, whether `.env.neat` is present, which OTel deps are installed. |
| `neat_dry_run_extension` | Preview what an apply would do — the exact file diff, deps to add, install command — without changing anything. |
| `neat_apply_extension` | Install an instrumentation package and splice its registration into the OTel hook file. Idempotent. |
| `neat_rollback_extension` | Undo the last apply for a library — removes the dep and registration. |

The ten read tools read from the live graph the daemon maintains in memory. No fs reads of `graph.json` at request time. The extend tools modify instrumentation files, `package.json`, and the lockfile only; NEAT never calls an LLM and the agent reasons over their output (ADR-084).

## Install

The simplest path: add the snippet from `claude_code_config.json` to your Claude Code MCP config.

**macOS / Linux:**

```bash
# Print the snippet
cat node_modules/@neat.is/claude-skill/claude_code_config.json

# Or, with the neat CLI:
neat skill --print-config
```

Merge `mcpServers.neat` into your existing `~/.claude.json`.

**One-shot install** via the NEAT CLI:

```bash
neat skill --apply
```

This merges the `neat` server into `~/.claude.json` without touching other entries.

## Prerequisites

- `neat init <repo>` has registered at least one project.
- `neatd start` is running (or you're OK with `npx -y @neat.is/mcp` spawning per request — slower, but works).
- The `NEAT_API_URL` env var points at the running daemon's REST endpoint. Default is `http://localhost:8080`, which matches the daemon's default port.

## What's not in MVP

- Auto-detection of an alternate Claude Code config path. The installer assumes `~/.claude.json`.
- Per-project skill overrides. The skill is user-scoped; project-level MCP config can be added later as a follow-up.
- Tool-level disable flags. All sixteen tools are wired in; if you want to hide one, edit the snippet by hand.

## Where to look when it doesn't work

- `neatd status` — confirms the daemon is running and which projects are registered.
- `~/.claude.json` — the config file. Look for `mcpServers.neat`.
- `claude mcp list` — Claude Code's built-in inventory of MCP servers.
