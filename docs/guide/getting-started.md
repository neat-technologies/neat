# Getting started

This walks you from nothing to a live, queryable graph of your system — and then shows you the range of what you can ask it. It takes about five minutes plus however long it takes to exercise your app.

## What you need

- Node 20.x
- A JavaScript, TypeScript, or Python service you can run locally
- Nothing else — no account, no config file, no API key

## 1. Run the one command

From inside your project:

```bash
npx neat.is
```

That single command does everything: it discovers your services, reads your source into a graph, wires OpenTelemetry into your app, starts the NEAT daemon, and opens the dashboard. You'll see the banner, then a summary like this:

```
=== summary ===
graph: 18 nodes, 19 edges
  ConfigNode: 3
  DatabaseNode: 1
  FileNode: 11
  InfraNode: 1
  ServiceNode: 2
  CONFIGURED_BY: 3
  CONNECTS_TO: 1
  CONTAINS: 11
  IMPORTS: 2
  RUNS_ON: 2

dashboard: http://localhost:6328
running locally — open the dashboard, no token needed
```

The dashboard opens in your browser. Running locally, it needs no login — the daemon binds to loopback only, so there's nothing to gate. (When you [run NEAT on a server](../../README.md#run-neat-on-a-server), a token guards every public interface.)

What you're looking at is the **static graph**: every source file is a node, imports between files are edges, and the calls your code makes to databases, queues, and external hosts are extracted straight from the source. Every edge here is `EXTRACTED` — read from your code, no runtime involved yet.

If you'd rather point NEAT at a project elsewhere on disk:

```bash
npx neat.is /path/to/your/project
```

## 2. Run your app

NEAT instrumented your app in step 1, but instrumentation only produces data when the code runs. Start your service the way you normally would:

```bash
npm start      # or your dev command — node dist/index.js, etc.
```

Then exercise it. Hit some endpoints, run a job, click through a flow — whatever makes your code actually call its databases and external services. Each call your app makes emits an OpenTelemetry span, and NEAT attributes that span back to the exact file and line that made the call.

Within a few seconds, watch the dashboard. New edges appear, tagged `OBSERVED` — these are relationships NEAT *saw happen*, not just ones it read in your source. An `OBSERVED` edge carries a `lastObserved` timestamp and a `callCount`.

**What produces `OBSERVED` edges.** NEAT sees what OpenTelemetry instruments. Calls that cross a boundary mint OBSERVED edges: an HTTP call from one service to another becomes a service→service `CALLS` edge, and a query through an auto-instrumented database driver (Postgres/`pg` and the other drivers in the registry) becomes a service→database `CONNECTS_TO` — each with a real call count and, for a DB, the actual host it connected to. The fullest picture comes from an app that makes real cross-service and database calls under load. A single service that does its work in-process, without crossing a network boundary, will show mostly the static graph — there's little for the runtime layer to observe — and coverage for in-process work, message queues, and GraphQL/WebSocket surfaces is expanding.

> **On OpenTelemetry wire formats.** NEAT's receiver decodes both `http/protobuf` — the OpenTelemetry SDK's default — and `http/json`, sampled spans included, so telemetry from a standard exporter lands out of the box. NEAT's generated instrumentation needs no protocol override, and if you supply your own OTel config it works as-is.

## 3. Ask the graph

Now you have what NEAT is really about: one graph holding what your code *declares* and what your system *does*, side by side. The dashboard is the easiest way in — it's already open from step 1, and it shows the live graph with both kinds of edges drawn on it. From here the graph answers a range of questions:

- **Divergence** — where do declared intent and observed reality part ways? The question that needs both streams at once, so it's the natural one to start with.
- **Root cause** — a node is failing; walk the failing calls to the component that broke first, across service boundaries when the failure originated downstream.
- **Blast radius** — what breaks if this node changes, fails, or is removed? Every node that depends on it — so a database or a shared library returns everything that would feel the change.
- **Policies** — which architectural rules would a change violate? (See [policies](#where-to-go-next) below.)

### Your first divergence

A divergence is a place where the static graph (what your code declares) and the observed graph (what production did) don't line up. The dashboard surfaces them on the graph itself — look for the flagged edges once your app has run. Two common shapes:

```
[missing-extracted] src/services/prices.ts ──CALLS──▶ folio-api.example.com   confidence 0.87
  Production observed this call, but static analysis never surfaced the edge.

[missing-observed]  src/db/client.ts ──CONNECTS_TO──▶ postgres:primary        confidence 0.85
  Code declares this connection, but no production traffic has exercised it.
```

The first is a call your code makes without visibly naming it — often dynamic dispatch, or a client library NEAT's static extractor doesn't yet recognize. The second is a dependency your code carries but never actually used in this run — a dead path, a feature flag that's off, or a branch you thought was live.

Both findings come from comparing the *same file* against itself: what it says it does, versus what it did. That file-level precision is what makes a divergence a lead worth chasing instead of a vague "something's off with this service."

You can also ask from the command line. The query verbs target a registered project by name — the project NEAT just created is registered under your directory's name, so pass it explicitly:

```bash
npx neat.is divergences --project <your-project-name>
```

`npx neat.is list` shows the registered project names. The verbs also honor `--json` for piping into other tools. See [Querying the graph](./querying.md) for the full set.

## Where to go next

- **[Core concepts](./concepts.md)** — the graph model, provenance, divergence, and policies.
- **[Querying the graph](./querying.md)** — `root-cause`, `blast-radius`, `dependencies`, `policies`, and the rest of the CLI.
- **[Policies](./concepts.md#policies-rules-over-the-graph)** — declare architectural rules as assertions over the graph and have NEAT surface what violates them as the system moves.
- **[Using NEAT with an AI agent](./ai-agents.md)** — wire the graph into Claude Code (or any MCP client) and ask questions in plain language.
- **[Troubleshooting](./troubleshooting.md)** — no OBSERVED edges? Daemon won't start? Start here.

## If you got stuck

- **No `OBSERVED` edges after running your app?** Confirm your app started cleanly and that you exercised code paths that cross a boundary — an HTTP call to another service or a query through an instrumented database driver. Work that stays in-process, or runs over a transport NEAT doesn't yet instrument (message queues, GraphQL resolvers, WebSocket handlers), won't mint OBSERVED edges yet — see "What produces `OBSERVED` edges" in step 2.
- **`npx neat.is` printed help instead of running?** You're likely on an older version. NEAT's one-command behavior ships in `neat.is@0.4.16` and later — `npx neat.is@latest` pulls the current release.
- **Daemon won't start?** NEAT prefers `:8080` (REST), `:4318` (OTLP), and `:6328` (dashboard), but steps to the next free port when one is taken and records the port it bound in `neat-out/daemon.json` — the CLI and your instrumentation both read the live ports from there. Set `PORT` / `OTEL_PORT` / `NEAT_WEB_PORT` to pin specific ports.

More in [Troubleshooting](./troubleshooting.md).
