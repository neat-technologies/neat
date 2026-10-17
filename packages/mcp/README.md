# @neat.is/mcp

The MCP server that does your coding agent's investigation for it.

Agents are strong at writing code once they have the right context, and weak at the investigation and reasoning it takes to get there. [NEAT](https://github.com/neat-technologies/neat) keeps a live semantic graph of a software system — static code (`EXTRACTED` via tree-sitter) fused with runtime behavior (`OBSERVED` from OpenTelemetry and supported provider telemetry) — and this package puts that graph in front of the agent over the [Model Context Protocol](https://modelcontextprotocol.io). So instead of grepping files and reconstructing how the system works, the agent asks NEAT and gets an answer with provenance on every claim, then spends its effort on the fix. The repo shows what the code says; NEAT also carries what it did in production, fused onto the same file, symbol, and service — the one thing no file you can open shows you.

The clearest form of that is the **incident card**: one work order for an incident — the locus, the root-cause chain, the blast radius, the governing policies, and where code and production diverge, each claim stamped `EXTRACTED` / `OBSERVED` / `INFERRED` / `STALE` so the agent knows how far to trust it. NEAT hands your agent a card when it detects a failure worth one; you can also ask NEAT to compose the incident for a node yourself (`get_incident_card` — today, a node that has a recorded incident). Either way the investigation is done and the agent writes the code — it is the shape of the answer, not something you poll for.

## It needs a running NEAT daemon

This server is a **bridge**, not a standalone graph. It talks to a NEAT daemon over the daemon's local REST API; on its own, with no daemon behind it, its tools have nothing to answer from. So the order matters: **start NEAT in your project first, then wire in this server.**

## Quickstart

1. **Start NEAT in your project.** From your project root:

   ```bash
   npx neat.is
   ```

   This extracts the static graph, attaches OpenTelemetry without editing your source (ADR-232), and starts the daemon (REST on `http://localhost:8080`). See the [main README](https://github.com/neat-technologies/neat) for the full flow and a global install (`npm i -g neat.is`).

2. **Start your app with NEAT's instrumentation so the `OBSERVED` layer fills.** Attachment is a preload — it only takes effect when the app is launched with it loaded, not by running the app the usual way. NEAT writes a `.env.neat` and prints the exact start command; it is:

   - **Node:** load `.env.neat` (it sets `NODE_OPTIONS` to preload `@neat.is/otel-node`) before your start command —

     ```bash
     set -a; . ./.env.neat; set +a
     npm start
     ```

   - **Python:** run under the OpenTelemetry launcher —

     ```bash
     opentelemetry-instrument python your_app.py
     ```

   Exercise the app (or its tests) and the `OBSERVED` edges populate.

3. **Wire this server into your MCP client.** Most clients take a `command` + `args`:

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

25 tools in all. Every graph result is a **graph fact**, not a live call to the underlying system, and carries a provenance — `OBSERVED`, `INFERRED`, `EXTRACTED`, `STALE`, or `FRONTIER` (a staged proposal) — plus a confidence, so the agent knows how far to trust it.

**Start here**
- `ask` — the front door. Ask in plain language; NEAT resolves the names in your question to graph nodes and routes it to the right traversal. Reach for this before Read/Grep when you don't already have a node id.

**Investigate a failure**
- `investigate` — the first call for a failing, slow, or crashing system. Give it a service name, a symptom, or a node id; NEAT resolves it and returns the composed incident card in one call. The symptom-first form of `get_incident_card`.
- `get_incident_card` — compose the incident for an exact node id (a service/file/symbol): locus, cause chain, blast radius, policies, and divergences in one work order, each claim provenance-stamped — the same card NEAT pushes when it detects a failure.
- `get_root_cause` — trace a failing node up its dependency graph to the likely cause, with a provenance-scored chain.
- `get_incident_history` — the recorded OTel error events on a node, most recent first.
- `expand` — walk one evidence-bearing hop from a node ("up" to callers, "down" to callees); each neighbour is classified primary-failure / symptom-only / unrelated.
- `relate` — test a suspected cause→symptom pair: is there a path, which way, and does the error/latency signal carry end to end?

**Understand the structure**
- `get_dependencies` — what a node depends on across code, data, and infra (transitive, with provenance).
- `get_observed_dependencies` — only what the node actually called at runtime (`OBSERVED`). Compare with `get_dependencies` to see declared-vs-real.
- `get_blast_radius` — everything a change to a node could reach. Run it before an edit.
- `semantic_search` — find candidate nodes by description when you can't name one.
- `get_graph_diff` — how the architecture changed between a saved snapshot and now.
- `get_recent_stale_edges` — integrations that were `OBSERVED` and have gone quiet.

**Find drift and policy**
- `get_divergences` — where declared code/config and observed reality disagree: missing edges, version/host mismatches, compatibility violations, symbol/field mismatches, observed failures. The broad audit before you pick a failing node.
- `check_policies` — the architectural policies that apply where you're working (advisory, surfaced as context), the current violations, or a dry-run of a proposed action. It informs; it does not block.

**Fill instrumentation gaps** (`/neat extend`, ADR-081/086 — your agent reasons, NEAT operates; NEAT never calls an LLM)
- `neat_list_uninstrumented` — libraries the runtime layer can't yet see.
- `neat_lookup_instrumentation` — the registry recipe for a library (package, version, registration snippet).
- `neat_describe_project_instrumentation` — what OTel is wired up (hook files, `.env.neat`, installed deps).
- `neat_dry_run_extension` / `neat_apply_extension` / `neat_rollback_extension` — preview, apply, and undo an instrumentation change.

**Hosted connectors** (the only tools that call the control plane, not the daemon; need `NEAT_CP_URL` + a `NEAT_API_KEY`)
- `neat_list_connectable` — providers you can connect to a hosted project.
- `neat_connect` / `neat_disconnect` — connect a provider by API token (the headless path) or drop it. Writes connection state, never the graph.
- `neat_connection_status` — the status of each connected provider.

### A typical flow

For a failure, query the incident — `get_incident_history` and `get_root_cause` on the failing node (or `ask` to find which node), then `expand`/`relate` to confirm the cause; `get_incident_card` composes all of that into one work order, the same one NEAT hands you on detection. For anything else, start with `ask`. Before an edit, `get_blast_radius` and `check_policies`; to find trouble on an unfamiliar codebase, `get_divergences`. Trust a result by its provenance and stop once the fault is localized — a provenance-stamped answer is the answer, not a cue to re-confirm it by reading source.

### When not to use NEAT

The graph answers architecture-level questions — how the system is wired, what actually ran, what failed, what a change reaches. Fall back to Read/Grep for comments, arbitrary string literals, config minutiae, syntax the extractor doesn't cover, and any repo that has no graph yet. If a query comes back empty, confirm the daemon is up before reading files — an empty answer during the first scan means "not indexed yet," not "nothing there."

## Links

- [NEAT on GitHub](https://github.com/neat-technologies/neat) — the CLI, the daemon, and how the graph is built.
- [Model Context Protocol](https://modelcontextprotocol.io)

## License

Apache License 2.0 — see [LICENSE](https://github.com/neat-technologies/neat/blob/main/LICENSE) in the repository.
