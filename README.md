# NEAT

> **⚠️ Work in progress.** This is an MVP under active development. A handful of architectural choices were made for shipping speed, not for permanence.

[![CI](https://github.com/NEAT-Technologies/Neat/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/NEAT-Technologies/Neat/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/NEAT-Technologies/Neat)](BSL)
[![Release](https://img.shields.io/github/v/release/NEAT-Technologies/Neat)](https://github.com/NEAT-Technologies/Neat/releases)
[![Website](https://img.shields.io/badge/website-neat.is-black)](https://neat.is)

A unified runtime that holds a live semantic graph of your code, your infrastructure, and what's happening in production. Query it. Assert policies against it. Point agents at it.

The story behind it: https://neat.is/blog/architecture-is-all-you-need

---

## What it does

NEAT keeps a working model of your system up to date from two streams at once:

- **Static analysis** of source files, `package.json`, and yaml/env config.
- **Runtime telemetry** from OpenTelemetry spans.

Every edge is tagged with a `provenance` (EXTRACTED, INFERRED, OBSERVED, STALE, FRONTIER) so a consumer reading the graph knows exactly how much weight an individual claim deserves. The full model is documented in [`PROVENANCE.md`](./PROVENANCE.md).

The graph is exposed to AI agents through nine MCP tools: `get_root_cause`, `get_blast_radius`, `get_dependencies`, `get_observed_dependencies`, `get_incident_history`, `semantic_search`, `get_graph_diff`, `get_recent_stale_edges`, `check_policies`.

---

## Quickstart — reproduce the demo locally in under ten minutes

The demo wires up two Node services in front of a Postgres 15 database. `service-b` is locked to `pg` 7.4.0, which is too old to negotiate SCRAM auth — every call fails at runtime. NEAT's job is to follow that failure back through the graph and pin the cause two hops upstream.

### 1. Clone and install

```bash
git clone https://github.com/NEAT-Technologies/Neat
cd Neat
npm install
npm run build
```

Node 20.x is required. If you use nvm, `nvm use` will pick up `.nvmrc`.

### 2. Start the stack

```bash
docker compose up --build
```

Five containers come up: `payments-db` (Postgres 15), `service-a`, `service-b`, `otel-collector`, and `neat-core`. Spans flow from the collector into core on `:4318`. Core's REST API listens on `:8080`.

### 3. Generate traffic

```bash
for i in {1..10}; do curl -s localhost:3000/data; done
```

Every one of those requests will 500. That's the point — the failures are what feed the graph.

### 4. Confirm the graph saw it

```bash
curl -s localhost:8080/graph | jq '.edges[] | select(.id | contains("OBSERVED"))'
curl -s localhost:8080/incidents | jq '.[0]'
```

You should find an `OBSERVED` `CALLS` edge from `service:service-a` to `service:service-b`, an `INFERRED` `CONNECTS_TO` edge from `service:service-b` to `database:payments-db` (the trace stitcher backfills the gap left by the missing pg auto-instrumentation — `docs/decisions.md` ADR-014 has the reasoning), and an incident attributed to `database:payments-db`.

### 5. Wire NEAT into Claude Code

```bash
claude mcp add neat -- node "$(pwd)/packages/mcp/dist/index.cjs"
```

Or, if you'd rather edit `~/.claude/settings.json` by hand:

```json
{
  "mcpServers": {
    "neat": {
      "command": "node",
      "args": ["/absolute/path/to/Neat/packages/mcp/dist/index.cjs"],
      "env": { "NEAT_CORE_URL": "http://localhost:8080" }
    }
  }
}
```

### 6. Ask Claude

In any Claude Code session:

> **Why is payments-db failing?**

What you'll see back:

```
Root cause identified: service:service-b.
PostgreSQL 14+ requires scram-sha-256 auth by default; pg < 8.0.0 only speaks md5.

Traversal path: database:payments-db ← service:service-b ← service:service-a
Edge provenances: INFERRED, OBSERVED
Confidence: 0.70

Recommended fix: Upgrade service-b pg driver to >= 8.0.0
```

Confidence lands at 0.7 because one hop on the path (`CONNECTS_TO`) is INFERRED — pg 7.4.0 is too old for OTel's pg instrumenter, so the stitcher reaches into the static graph to fill the gap. Run the same demo with a modern driver and every edge is OBSERVED, confidence 1.0.

---

## CLI

`neat init <path>` walks a directory, builds the static graph, and writes a snapshot:

```bash
node packages/core/dist/cli.cjs init ./demo
```

Output is a per-type breakdown of nodes and edges plus anything the compat matrix flagged as incompatible. The snapshot lands at `<path>/neat-out/graph.json` unless `NEAT_OUT_PATH` says otherwise.

---

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

`NEAT_AUTH_TOKEN` is required on every public interface — the daemon refuses to bind on non-loopback addresses without one. REST and SSE callers send it in `Authorization: Bearer <token>`; OTel exporters send the same header. Rotate the OTLP token independently by setting `NEAT_OTEL_TOKEN`.

---

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

---

## Repository layout

```
packages/
  types/   shared Zod schemas — node, edge, event, result types
  core/    graph engine, tree-sitter extraction, OTel ingest, REST API, neat CLI
  mcp/     stdio MCP server exposing nine tools to AI agents
  web/     Next.js shell — wordmark + /api/health (dashboard is post-MVP)

demo/
  service-a/      express + axios. Calls service-b.
  service-b/      express + pg 7.4.0. Talks to payments-db (PG 15).
  collector/      OpenTelemetry collector config.
```

---

## Documentation

- [`PROVENANCE.md`](./PROVENANCE.md) — the five edge states and how confidence travels along a path.
- [`CLAUDE.md`](./CLAUDE.md) — guide for agents and contributors working in this repo.
- [`docs/architecture.md`](./docs/architecture.md) — short reference to package boundaries and data flow.
- [`docs/decisions.md`](./docs/decisions.md) — ADR log.
- [`docs/milestones.md`](./docs/milestones.md) — sprint status; the canonical record of what's done.
- [`docs/runbook.md`](./docs/runbook.md) — day-to-day commands and recovery recipes.
- [`docs/railway.md`](./docs/railway.md) — deploying the demo to Railway.
- [`packages/mcp/skill.md`](./packages/mcp/skill.md) — Claude Code skill metadata for the MCP tools.

---

## License

Apache 2.0.
