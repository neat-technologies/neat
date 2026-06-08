# Using NEAT with an AI agent

This is where NEAT earns its keep. The CLI is for you; the graph is also for the agent sitting next to you. Wire NEAT into Claude Code (or any MCP client) and the agent can walk the graph the same way you would — except it does the walking, and it answers in plain language with the provenance attached.

## MCP in one line

MCP (Model Context Protocol) is the standard way an AI agent calls external tools. NEAT ships an MCP server that exposes the graph as a set of tools the agent can invoke on its own.

## Wire it into Claude Code

The fast path:

```bash
claude mcp add neat -- neat-mcp
```

Or edit `~/.claude/settings.json` by hand:

```json
{
  "mcpServers": {
    "neat": {
      "command": "neat-mcp",
      "env": { "NEAT_CORE_URL": "http://localhost:8080" }
    }
  }
}
```

`NEAT_CORE_URL` points the MCP server at your running daemon — the same daemon `npx neat.is` started. The MCP server is a thin bridge: it doesn't hold the graph, it forwards the agent's tool calls to the daemon's REST API. So the daemon has to be up (see [Querying the graph](./querying.md#before-you-start-the-daemon-has-to-be-up)), and the agent sees whatever your live graph currently knows.

Restart Claude Code after editing the config so it picks up the new server.

## The sixteen tools

NEAT exposes sixteen tools, in two groups.

### Ten read tools — query the graph

These are the same questions the [CLI query verbs](./querying.md) answer, handed to the agent as callable tools:

| Tool | What it answers |
|------|-----------------|
| `get_divergences` | Where does code disagree with production? The most NEAT-shaped query — start here on an unfamiliar codebase. |
| `get_root_cause` | A node is failing — which upstream component is the actual culprit? |
| `get_blast_radius` | What breaks downstream if this node fails or is redeployed? |
| `get_dependencies` | What does this node depend on, transitively, static and runtime? |
| `get_observed_dependencies` | What did this node actually call in production (OBSERVED only)? |
| `get_incident_history` | Recent error events recorded against a node. |
| `semantic_search` | Find a node by natural-language description. |
| `get_graph_diff` | What changed in the architecture between a saved snapshot and now? |
| `get_recent_stale_edges` | Which integrations have gone quiet? |
| `check_policies` | What architectural assertions are currently violated — or would be, for a hypothetical change? |

### Six `neat extend` tools — close instrumentation gaps

NEAT instruments the common runtimes out of the box (see [installer scope](../installer-scope.md)). But the long tail — a less common client library, a niche ORM — sometimes needs its own OpenTelemetry instrumentation package before it emits spans. Rather than make you hand-wire that, NEAT hands the job to the agent. Backed by a versioned instrumentation registry, the agent can find the gap, look up the right package, and splice it in:

| Tool | What it does |
|------|--------------|
| `neat_list_uninstrumented` | List libraries in the project that need instrumentation beyond the bundled set. |
| `neat_lookup_instrumentation` | Look up the registry entry for a library — the canonical package, version, and registration snippet. |
| `neat_describe_project_instrumentation` | Report the current OTel state: which hook files exist, whether `.env.neat` is present, which deps are installed. |
| `neat_dry_run_extension` | Preview an install — the exact file diff, deps to add, install command — without changing anything. |
| `neat_apply_extension` | Install the instrumentation package and splice its registration into the existing OTel hook file. Idempotent. |
| `neat_rollback_extension` | Undo the last `apply` for a library. |

These only touch instrumentation files, `package.json`, and the lockfile — never your application logic. The pattern an agent follows is `list → lookup → dry-run → apply`: find the gap, confirm the fix, preview the diff, then apply. After an `apply` or `rollback`, run your package manager's install to sync the lockfile.

## A worked example

You're staring at a flaky checkout. You ask:

> Why is checkout failing?

The agent doesn't guess. It calls the tools:

1. **`semantic_search("checkout")`** to resolve the node — `service:checkout`.
2. **`get_root_cause("service:checkout")`** to walk upstream. It comes back with a path, the provenance of each edge crossed, and a confidence number.
3. If the answer is thin, **`get_divergences(node: "service:checkout")`** to check whether checkout is doing something its code never declared.

Then it answers you in plain language — and because every edge carried its provenance, so does the answer:

> Checkout fails because `src/checkout/tax.ts` calls `tax-api.example.com`, and that call is the slowest hop in the path. I watched it happen — the `CALLS` edge is `OBSERVED`, confidence 1.0, last seen 4 seconds ago. Notably, your code never declares this call (it shows up as a `missing-extracted` divergence), so it's likely dynamic dispatch or a client library the static extractor doesn't recognize. Fix: pin a timeout on the tax client, and consider declaring the dependency so it's legible in source.

That's the part worth dwelling on. The agent's answer distinguishes **"your code says so"** from **"I watched it happen."** A claim built on `OBSERVED` edges is reproducible from real traffic. A claim built on `EXTRACTED`-only edges is a hypothesis from the source. The agent reads provenance the way you'd read a citation, and it tells you which kind of claim it's making — so you know whether you're looking at a fact or a guess. The full ranking and how confidence travels along a path is in [PROVENANCE.md](../../PROVENANCE.md).

## Next

- **[Querying the graph](./querying.md)** — the same questions from the command line, so you can sanity-check what the agent reports.
- **[Troubleshooting](./troubleshooting.md)** — if the agent's answers are all `EXTRACTED` and never `OBSERVED`, your spans aren't landing; start here.
