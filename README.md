# NEAT

[![CI](https://github.com/NEAT-Technologies/Neat/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/NEAT-Technologies/Neat/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/NEAT-Technologies/Neat)](https://github.com/NEAT-Technologies/Neat/releases)
[![Website](https://img.shields.io/badge/website-neat.is-black)](https://neat.is)

NEAT builds a live graph of your system from two sources at once — your source code and your production traces — and surfaces where the two disagree. Your code declares it calls one service; production shows it calling another. A database your code connects to never sees traffic. An API your code never mentions handles every request. That gap is where the bugs live, and NEAT finds it at the granularity of a single file and line.

NEAT is in active development. Capability ships as patch releases on the `npx neat.is` surface; see [open issues](https://github.com/NEAT-Technologies/Neat/issues) for what's on deck.

## One command

```bash
npx neat.is
```

Run it from inside your project (or `npx neat.is <path>`). It discovers your services, extracts the static graph, wires in OpenTelemetry, starts the daemon, and opens the dashboard — no config. Then run your app and watch the live edges populate.

## What it does

NEAT keeps a working architecture model of your system up to date from two streams at once:

- **Static analysis** — tree-sitter over your source (JavaScript, TypeScript, Python), `package.json`, and yaml / env config. Every source file becomes a node; imports between them become edges; the calls each file makes to databases, queues, and external hosts are extracted from the code.
- **Runtime telemetry** — OpenTelemetry spans, attributed back to the exact file and line that made the call. NEAT wires the instrumentation for you, so the runtime edge lands on the same file node the static edge does.

**The file is the primary unit.** A relationship in the graph runs from a file — `src/services/billing.ts ──CALLS──▶ api.stripe.com` — not from a vague service blob. That's what makes a divergence precise: declared call site versus observed call site, for the same pair, at the same grain.

Every edge carries a `provenance` tag so a consumer knows exactly how much weight a claim deserves:

- `EXTRACTED` from source. No clock decay.
- `OBSERVED` from a span. Carries `lastObserved` and `callCount`.
- `INFERRED` by the trace stitcher where OTel coverage has gaps. Confidence is capped.
- `STALE` because runtime stopped speaking. Preserves the original `lastObserved`.

The graph is exposed to AI agents through sixteen MCP tools. Ten read the graph — `get_root_cause`, `get_blast_radius`, `get_dependencies`, `get_observed_dependencies`, `get_incident_history`, `get_divergences`, `get_graph_diff`, `get_recent_stale_edges`, `check_policies`, `semantic_search` — and six (`neat extend`) let an agent close instrumentation gaps for libraries the bundled OTel set doesn't cover, driven by a versioned [instrumentation registry](./docs/installer-scope.md).

## CLI

The same `neat` binary handles every verb. After a global install (`npm i -g neat.is`) or via `npx neat.is`:

```
neat <path>              orchestrator: extract, instrument, spawn daemon, open dashboard
neat init <path>         extract only; patch-by-default, --apply to write
neat watch <path>        keep the graph live as files change
neat deploy              emit deployment artifacts for a hosted target
neat sync --to <url>     push the local EXTRACTED snapshot to a remote daemon (v0.3.9)
neat divergences         where your code and your production traffic disagree
neat root-cause <id>     walk inbound edges to find what broke first
neat blast-radius <id>   BFS outbound; what would break if this node dies
neat dependencies <id>   transitive outbound dependencies
neat incidents           recent error events
neat policies            current policy violations
neat search <query>      semantic match on node names and ids
```

Every query verb honors `--json` and `--project <name>`. Exit codes branch on success (0), server error (1), misuse (2), and daemon unreachable (3).

## What a divergence looks like

Once your app has run, `neat divergences` reports where declared intent and observed behavior part ways:

```
[missing-extracted] src/services/prices.ts ──CALLS──▶ folio-api.example.com   confidence 0.87
  Production observed this call, but static analysis never surfaced the edge.
  → dynamic dispatch or a coverage gap. The code reaches a host it doesn't visibly name.

[missing-observed]  src/db/client.ts ──CONNECTS_TO──▶ postgres:primary        confidence 0.85
  Code declares this connection, but no production traffic has exercised it.
  → dead path, feature flag, or an unshipped branch. The declared dependency is idle.
```

Two findings, two different bugs. The first is a call your code makes without saying so — worth knowing before it surprises you. The second is a dependency your code carries but never uses — dead weight, or a path you thought was live and isn't. Both come from comparing the same file against itself: what it says, versus what it did.

## Run NEAT on a server

The container image at `ghcr.io/neat-technologies/neat:latest` boots `neatd start` and exposes REST on `:8080`, OTLP on `:4318`, and the web UI on `:6328`. Generate a token, run the image, point your OTel SDKs at it:

```bash
NEAT_AUTH_TOKEN=$(openssl rand -hex 32)
docker run -d --name neat \
  -e NEAT_AUTH_TOKEN="$NEAT_AUTH_TOKEN" \
  -p 8080:8080 -p 4318:4318 -p 6328:6328 \
  -v /var/lib/neat:/neat-out \
  ghcr.io/neat-technologies/neat:latest
```

`NEAT_AUTH_TOKEN` is required on every public interface. The daemon refuses to bind on non-loopback addresses without one. REST and SSE callers send the token in `Authorization: Bearer <token>`; OTel exporters send the same header. Rotate the OTLP token independently with `NEAT_OTEL_TOKEN`.

Easier path: `neat deploy` generates the token, writes a `docker-compose.neat.yml`, and prints the env block your application's deploy platform needs:

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://<your-host>:4318
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <generated-token>
```

## Behind a reverse proxy

When TLS termination and authentication already live in a proxy upstream, set `NEAT_AUTH_PROXY=true` so the daemon skips the request-side bearer check. The bind-authority gate still refuses public binds without `NEAT_AUTH_TOKEN`, so set both:

```caddyfile
neat.example.com {
  reverse_proxy localhost:8080 {
    header_up Authorization "Bearer {env.NEAT_AUTH_TOKEN}"
  }
  reverse_proxy /events localhost:8080
  @otlp path /v1/traces
  reverse_proxy @otlp localhost:4318 {
    header_up Authorization "Bearer {env.NEAT_AUTH_TOKEN}"
  }
}
```

Then `docker run … -e NEAT_AUTH_TOKEN=… -e NEAT_AUTH_PROXY=true …` and let Caddy gate the public surface.

## Wire NEAT into Claude Code

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

In any Claude Code session, ask: *"Why is checkout-svc failing?"* NEAT walks the graph and answers with a traversal path, edge provenances, a confidence score, and a recommended fix.

## Repository layout

```
packages/
  types/          shared Zod schemas: node, edge, event, result types
  core/           graph engine, tree-sitter extraction, OTel ingest, REST API, neat CLI
  mcp/            stdio MCP server exposing the sixteen tools to AI agents
  web/            Next.js dashboard
  claude-skill/   Claude Code skill metadata
  neat.is/        umbrella package
```

## Documentation

- [`PROVENANCE.md`](./PROVENANCE.md): the four edge states and how confidence travels along a path.
- [`CLAUDE.md`](./CLAUDE.md): guide for agents and contributors working in this repo.
- [`docs/architecture.md`](./docs/architecture.md): package boundaries and data flow.
- [`docs/api-reference.md`](./docs/api-reference.md): REST endpoints and MCP tool signatures.
- [`docs/runbook.md`](./docs/runbook.md): day-to-day commands and recovery recipes.
- [`docs/contracts.md`](./docs/contracts.md): the binding rules every PR must hold to.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md): branch convention, PR shape, dev setup.
- [`SECURITY.md`](./SECURITY.md): how to report vulnerabilities.

## Contributing

PRs welcome. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first for the branch convention, PR shape, and the contracts framework that gates every change.

## License

Apache 2.0. See [`LICENSE`](./LICENSE).
