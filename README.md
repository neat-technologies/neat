# NEAT

[![CI](https://github.com/NEAT-Technologies/Neat/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/NEAT-Technologies/Neat/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/NEAT-Technologies/Neat)](https://github.com/NEAT-Technologies/Neat/releases)
[![Website](https://img.shields.io/badge/website-neat.is-black)](https://neat.is)

A live semantic architecture of your code, your infrastructure, and what's actually happening in production. Query it. Assert policies against it. Point agents at it.

Warning: ⚠️ NEAT Is currently in its MVP State. Therefore, It is unstable, and all engineering decisions where made to optimise dev speed and rapid prototyping. 

## One command

```bash
npx neat.is
```

## What it does

NEAT keeps a working architecture model of your system up to date from two streams at once:

- **Static analysis** of source files, `package.json`, and yaml / env config.
- **Runtime telemetry** from OpenTelemetry spans.

Every edge in the graph carries a `provenance` tag so a consumer reading the graph knows exactly how much weight an individual claim deserves:

- `EXTRACTED` from source. No clock decay.
- `OBSERVED` from a span. Carries `lastObserved` and `callCount`.
- `INFERRED` by the trace stitcher where OTel coverage has gaps. Confidence is capped.
- `STALE` because runtime stopped speaking. Preserves the original `lastObserved`.

The graph is exposed to AI agents through ten MCP tools: `get_root_cause`, `get_blast_radius`, `get_dependencies`, `get_observed_dependencies`, `get_incident_history`, `get_divergences`, `get_graph_diff`, `get_recent_stale_edges`, `check_policies`, and `semantic_search`.

## CLI

The same `neat` binary handles every verb. After a global install (`npm i -g neat.is`) or via `npx neat.is`:

```
neat <path>              orchestrator: extract, instrument, spawn daemon, open dashboard
neat init <path>         extract only; patch-by-default, --apply to write
neat watch <path>        keep the graph live as files change
neat deploy              emit deployment artifacts for a hosted target
neat sync --to <url>     push the local EXTRACTED snapshot to a remote daemon (v0.3.9)
neat root-cause <id>     walk inbound edges to find what broke first
neat blast-radius <id>   BFS outbound; what would break if this node dies
neat dependencies <id>   transitive outbound dependencies
neat divergences         where EXTRACTED and OBSERVED disagree
neat incidents           recent error events
neat policies            current policy violations
neat search <query>      semantic match on node names and ids
```

Every query verb honors `--json` and `--project <name>`. Exit codes branch on success (0), server error (1), misuse (2), and daemon unreachable (3).

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
  mcp/            stdio MCP server exposing the ten tools to AI agents
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
