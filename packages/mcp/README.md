# @neat.is/mcp

The MCP server that puts NEAT's fused code graph in front of your coding agent.

[NEAT](https://github.com/neat-technologies/neat) keeps a live semantic graph of a software system — static code (`EXTRACTED` via tree-sitter) and runtime behavior (`OBSERVED` from OpenTelemetry) fused into one model. This package exposes that graph over the [Model Context Protocol](https://modelcontextprotocol.io) as a stdio server, so an agent can ask about dependencies, blast radius, root cause, and where declared intent diverges from production traffic — and get an answer with provenance on every edge, instead of grepping files and guessing.

## It needs a running NEAT daemon

This server is a **bridge**, not a standalone graph. It talks to a NEAT daemon over the daemon's local REST API; on its own, with no daemon behind it, its tools have nothing to answer from. So the order matters: **start NEAT in your project first, then wire in this server.**

## Quickstart

1. **Start NEAT in your project.** From your project root:

   ```bash
   npx neat.is
   ```

   This extracts the static graph, wires in OpenTelemetry, and starts the daemon (REST on `http://localhost:8080`). Leave it running, and run your app so the `OBSERVED` edges populate. See the [main README](https://github.com/neat-technologies/neat) for the full flow and a global install (`npm i -g neat.is`).

2. **Wire this server into your MCP client.** Most clients take a `command` + `args`:

   ```json
   {
     "mcpServers": {
       "neat": {
         "command": "npx",
         "args": ["-y", "@neat.is/mcp"],
         "env": { "NEAT_CORE_URL": "http://localhost:8080" }
       }
     }
   }
   ```

   With a global install, the `neat-mcp` binary is equivalent to `npx -y @neat.is/mcp`. In Claude Code: `claude mcp add neat -- neat-mcp`.

   The server depends on `@neat.is/core` so it finds a project's daemon the same way the CLI does, which means it installs NEAT's engine with it. A fresh `npx -y @neat.is/mcp` installs about 560 MB of `node_modules` — about 300 MB without optional dependencies (`--omit=optional` drops the in-process embedding model) — and the first run pays that download. A global `neat.is` install already has the engine, so `neat-mcp` adds nothing.

## How it finds the daemon

The base URL resolves in this order:

1. **`NEAT_CORE_URL`** (or the `NEAT_API_URL` alias) if set — this is how you pin the server at a specific or hosted daemon.
2. Otherwise, the registered project the working directory sits in (its own path or nearest ancestor in `~/.neat/projects.json`) and that project's daemon discovery record — the same lookup the CLI uses, so a server launched from inside a project finds that project's daemon and REST port automatically.
3. Only when the working directory isn't in a registered project, the nearest `neat-out/daemon.json` walking up from it.
4. Otherwise, the default `http://localhost:8080`.

Setting `NEAT_CORE_URL` explicitly is the reliable choice when the client launches the server from a directory other than your project.

## The tools

Every result is a **graph fact**, not a live call to the underlying system, and carries a provenance — `OBSERVED`, `INFERRED`, `EXTRACTED`, or `STALE` — plus a confidence, so the agent knows how far to trust it.

**Graph & traversal**
- `get_dependencies` — what a node depends on (static structure).
- `get_observed_dependencies` — the same, but from runtime traffic.
- `get_blast_radius` — everything a change to a node could reach.
- `get_root_cause` — trace a failure back through the graph.
- `semantic_search` — find nodes by meaning, not just name.
- `get_graph_diff` — how the graph changed between two points.

**Divergence & provenance**
- `get_divergences` — where declared code and observed reality disagree.
- `check_policies` / `get_policy_violations` — evaluate and list policy breaches over the graph.
- `get_incident_history` — past failures recorded against nodes.
- `get_recent_stale_edges` — edges that were `OBSERVED` and have gone quiet.

**Instrumentation**
- `neat_describe_project_instrumentation` — what's wired for OTel and what isn't.
- `neat_list_uninstrumented` — code the runtime layer can't yet see.
- `neat_lookup_instrumentation` — find the instrumentation recipe for a dependency.
- `neat_dry_run_extension` / `neat_apply_extension` / `neat_rollback_extension` — preview, apply, and undo an instrumentation change.

## Links

- [NEAT on GitHub](https://github.com/neat-technologies/neat) — the CLI, the daemon, and how the graph is built.
- [Model Context Protocol](https://modelcontextprotocol.io)

## License

Apache License 2.0 — see [LICENSE](https://github.com/neat-technologies/neat/blob/main/LICENSE) in the repository.
