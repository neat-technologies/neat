# Getting started

This walks you from nothing to your first divergence — the moment NEAT shows you a place where your code and your running system disagree. It takes about five minutes plus however long it takes to exercise your app.

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

> **One setup note.** The OpenTelemetry SDK's default wire protocol is `http/protobuf`, and NEAT's generated instrumentation pins `http/json` for you so spans land correctly out of the box. If you supply your own OTel config, set `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` so NEAT sees your traffic.

## 3. Find your first divergence

Now the point of all this. Once your app has run, ask NEAT where your code and your traffic disagree:

```bash
npx neat.is divergences
```

A divergence is a place where the static graph (what your code declares) and the observed graph (what production did) don't line up. Two common shapes:

```
[missing-extracted] src/services/prices.ts ──CALLS──▶ folio-api.example.com   confidence 0.87
  Production observed this call, but static analysis never surfaced the edge.

[missing-observed]  src/db/client.ts ──CONNECTS_TO──▶ postgres:primary        confidence 0.85
  Code declares this connection, but no production traffic has exercised it.
```

The first is a call your code makes without visibly naming it — often dynamic dispatch, or a client library NEAT's static extractor doesn't yet recognize. The second is a dependency your code carries but never actually used in this run — a dead path, a feature flag that's off, or a branch you thought was live.

Both findings come from comparing the *same file* against itself: what it says it does, versus what it did. That file-level precision is what makes a divergence a lead worth chasing instead of a vague "something's off with this service."

## Where to go next

- **[Core concepts](./concepts.md)** — the graph model, provenance, and how to read a divergence with confidence.
- **[Querying the graph](./querying.md)** — `root-cause`, `blast-radius`, `dependencies`, and the rest of the CLI.
- **[Using NEAT with an AI agent](./ai-agents.md)** — wire the graph into Claude Code (or any MCP client) and ask questions in plain language.
- **[Troubleshooting](./troubleshooting.md)** — no OBSERVED edges? Daemon won't start? Start here.

## If you got stuck

- **No `OBSERVED` edges after running your app?** The most common cause is the OTel protocol — see the setup note in step 2. Also confirm your app actually started cleanly and that you exercised code paths that make external calls.
- **`npx neat.is` printed help instead of running?** You're likely on an older version. NEAT's one-command behavior ships in `neat.is@0.4.16` and later — `npx neat.is@latest` pulls the current release.
- **Daemon won't start / port in use?** NEAT uses `:8080` (REST), `:4318` (OTLP), and `:6328` (dashboard). If one's taken, free it or set `PORT` / `OTEL_PORT` / `NEAT_WEB_PORT`.

More in [Troubleshooting](./troubleshooting.md).
