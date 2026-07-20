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

## Where OBSERVED comes from

The observed-facing read tools — `get_observed_dependencies`, `get_divergences`, `get_incident_history`, `get_recent_stale_edges` — reflect two OBSERVED sources, not one:

- **OTel spans** — pushed by the instrumented app at runtime. The `/neat extend` tools above are how that gets wired up.
- **Pull connectors** — NEAT polls a provider's own API and folds what it finds into the same OBSERVED layer. Supabase, Railway, Cloudflare, and Firebase are supported. So an integration NEAT never saw a span for can still carry OBSERVED edges, incidents, and staleness — sourced from the platform, not the trace.

Connectors are configured out of band, not through this skill: `neat connector add <provider>` / `list` / `remove <id>` / `test <id>` (ADR-130). Credentials are stored as an env-var reference (`$VAR`) resolved at run time and redacted everywhere, so the agent reads the resulting OBSERVED data but never sees a secret. `GET /:project/connectors` reports each connector's poll health over REST if you need it.

A `ServiceNode` also carries a `platform` string when the extractor recognized the host — `'cloudflare'`, `'vercel'`, `'railway'`, or `'supabase'`, read from a `wrangler.toml` / `vercel.json` / `railway.toml` / `supabase/config.toml`. It's a static (EXTRACTED) signal, surfaced as the provider badge on the dashboard's service nodes.

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
- Tool-level disable flags. All sixteen tools are wired in; if you want to hide one, edit the snippet by hand.

## Where to look when it doesn't work

- `neatd status` — confirms the daemon is running and which projects are registered.
- `~/.claude.json` — the config file. Look for `mcpServers.neat`.
- `claude mcp list` — Claude Code's built-in inventory of MCP servers.
