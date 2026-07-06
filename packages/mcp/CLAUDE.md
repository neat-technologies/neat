# @neat.is/mcp

The NEAT MCP server. Stdio JSON-RPC, seventeen tools and two resources, talks to a running `@neat.is/core` instance over HTTP. The tool surface is single-sourced from `MCP_TOOL_NAMES` in `@neat.is/types` (ADR-091) — eleven read-only graph/log queries plus six `/neat extend` tools.

## When to use these tools

Reach for NEAT before grepping or reading source for **architecture-level questions** about a running system: dependencies, runtime traffic, recent failures, what would break if X changed. The graph already knows the answer; reading code reconstructs the answer from scratch each time.

Rule of thumb: if the question would take more than two file reads to answer from source, try a NEAT tool first.

| Question shape                                       | Tool                       |
|------------------------------------------------------|----------------------------|
| "Is anything weird?" / "find me a bug"               | `get_divergences`          |
| "Why is X failing?" / "What's the root cause of …"   | `get_root_cause`           |
| "What breaks if I redeploy X?" / blast assessment    | `get_blast_radius`         |
| "What does X depend on?" / dependency tree           | `get_dependencies`         |
| "What does X actually call at runtime?"              | `get_observed_dependencies`|
| "Show me recent errors on X"                         | `get_incident_history`     |
| "Find nodes matching …"                              | `semantic_search`          |
| "What changed since the last snapshot?"              | `get_graph_diff`           |
| "Which integrations have gone quiet?"                | `get_recent_stale_edges`   |
| "Any policy violations right now?"                   | `check_policies`           |
| "What did this service log around the incident?"     | `get_logs`                 |

If a tool returns "not found" or empty, check that core is running (`curl $NEAT_CORE_URL/health`) before falling back to source reads.

## Extend tools

Six `/neat extend` tools sit alongside the read tools for filling instrumentation gaps (ADR-081 / ADR-086). Three diagnose, three operate; NEAT never calls an LLM and never auto-applies — the agent reasons over their output.

| Tool                                    | What it does                                                              |
|-----------------------------------------|---------------------------------------------------------------------------|
| `neat_list_uninstrumented`              | Libraries needing instrumentation beyond the auto-instrumentations bundle |
| `neat_lookup_instrumentation`           | Registry entry for a library — package, version, registration snippet     |
| `neat_describe_project_instrumentation` | Current OTel state: hook files, `.env.neat`, installed OTel deps           |
| `neat_dry_run_extension`                | Preview an apply — file diff, deps, install command — no changes           |
| `neat_apply_extension`                  | Install an instrumentation package and splice in its registration (idempotent) |
| `neat_rollback_extension`               | Undo the last apply for a library                                         |

## Resources

Two MCP resources sit alongside the tools — same data, different access pattern:

- **`neat://node/<id>`** (templated) — one resource per graph node. Read returns `{ node, outboundEdges }` as JSON. Listing enumerates every node currently in the graph. Use it when you want the raw attributes rather than a formatted answer.
- **`neat://incidents/recent`** (static) — most recent error events as JSON `{ count, total, events[] }`. Subscribe to be notified (`notifications/resources/updated`) when new incidents land. The server polls `/incidents` every 5s by default; override with `NEAT_RESOURCE_POLL_MS` (set to `0` to disable polling).

## Configuration

`NEAT_CORE_URL` — base URL for the daemon's REST API. When set, it wins outright (that's how the hosted substrate pins the MCP server at a fixed daemon). `NEAT_API_URL` is honored as an alias for back-compat with older `neat skill` configs; `NEAT_CORE_URL` wins when both are set.

When neither env var is set, the server resolves the **per-project daemon** for the project it was launched in (ADR-096 / `docs/contracts/project-daemon.md`): it walks up from the cwd to the nearest `neat-out/daemon.json` and talks to `http://localhost:<ports.rest>`. A missing, malformed, or `status: "stopped"` record falls through to the canonical `http://localhost:8080` default — resolution never throws.

`NEAT_RESOURCE_POLL_MS` — interval in ms for the `neat://incidents/recent` change-detection poll. Default `5000`. `0` disables it.

`NEAT_DEFAULT_PROJECT` — the project this MCP instance reports against when a tool call doesn't pass `project`. Unset means "the core's `default` project" via legacy unprefixed URLs (back-compat with pre-#83 cores). Set this when one neat-core hosts multiple projects and a given Claude Code session should pin to one.

## Multi-project

Every tool takes an optional `project` arg. Resources route via the configured project too. Three behaviours, in priority order:

1. The tool call passes `project: 'alpha'` → URLs go to `/projects/alpha/...`.
2. `NEAT_DEFAULT_PROJECT=alpha` is set → calls without `project` route through `/projects/alpha/...`.
3. Neither → calls hit the legacy unprefixed URLs (`/traverse/root-cause/...`), which the core resolves to its `default` project.

## Smoke-test the handshake

```bash
npm run build --workspace @neat.is/mcp
node packages/mcp/dist/index.cjs
# then send `{"jsonrpc":"2.0","id":1,"method":"initialize",…}` over stdin
```

## Provenance, briefly

Every edge and result carries a provenance:

- **OBSERVED** — seen in production via OTel. Trustworthy.
- **INFERRED** — computed from other edges (e.g. on error spans where the static graph fills in for missing instrumentation). Confidence ≈ 0.6.
- **EXTRACTED** — derived from source code or config. Always available, lowest authority.
- **STALE** — was OBSERVED, hasn't been seen recently. Treat with suspicion.

Tools surface this in their output so a result reading "INFERRED CONNECTS_TO" gets the right amount of trust from the consumer.
