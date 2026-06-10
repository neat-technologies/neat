# Querying the graph

Once NEAT has a graph, you ask it questions from the command line. Every query verb is a question you'd otherwise ask a senior engineer: *what would break if this dies? what does this depend on? where did the failure start?* This page is the reference — each verb, a real example, and what the answer looks like.

## Before you start: the daemon has to be up

The query verbs talk to the running daemon over HTTP. They don't read your snapshot off disk — they ask the live graph. So `neatd` has to be running. If you went through [Getting started](./getting-started.md), it already is: `npx neat.is` (or `npx neat.is <path>`) starts the daemon and leaves it running, and `neat watch <path>` keeps it up while you work.

If the daemon isn't running, every verb exits with code 3 and tells you so:

```
neat divergences: fetch failed. Is the daemon running? (NEAT_API_URL=http://localhost:8080)
```

## Node ids: where they come from

Most verbs take a node id — something like `service:checkout`, `database:payments-db`, or `src/services/billing.ts`. You don't have to memorize the format. Two ways to get one:

- **`neat search <query>`** — type what you're looking for in plain language and it hands back the matching ids.
- **the dashboard** — every node on the graph at `http://localhost:6328` shows its id when you select it.

Grab the id from either, then feed it to the verb you want.

## The verbs

### `divergences` — where code and production disagree

The query that needs both halves of the graph at once. It compares what your code declares (`EXTRACTED`) against what production did (`OBSERVED`) and reports where they part ways — the natural first question on an unfamiliar system.

```bash
npx neat.is divergences --min-confidence 0.7
```

```
[missing-extracted] src/services/prices.ts ──CALLS──▶ folio-api.example.com   confidence 0.87
  Production observed this call, but static analysis never surfaced the edge.

[missing-observed]  src/db/client.ts ──CONNECTS_TO──▶ postgres:primary        confidence 0.85
  Code declares this connection, but no production traffic has exercised it.
```

Flags: `--type <list>` (comma-separated — `missing-observed`, `missing-extracted`, `version-mismatch`, `host-mismatch`, `compat-violation`), `--min-confidence <0..1>` to drop low-confidence findings, `--node <id>` to scope to one node. Start here when you don't yet know what's wrong — see [Core concepts](./concepts.md#divergence-the-load-bearing-idea) for what each shape means.

### `root-cause <id>` — what broke first

You have a failing node. Walk its inbound edges to find the upstream component that's the actual culprit.

```bash
npx neat.is root-cause database:payments-db
```

```
Root cause for database:payments-db is service:billing. Version mismatch: billing pins pg@7.4.0; payments-db speaks the 14 wire protocol. Recommended fix: bump pg to ^8.

Traversal path: database:payments-db ← service:billing
Edge provenances: OBSERVED, INFERRED
Recommended fix: bump pg to ^8
```

The traversal carries a confidence number that cascades from the provenance of the edges it crossed — a path of all-`OBSERVED` edges reports `1.0`; an `EXTRACTED`-only path reports `0.5`. A `null` root cause is a clean answer, not an error: nothing upstream diverged.

### `blast-radius <id>` — what would break if this dies

The reverse direction. BFS outbound from a node to find everything downstream of it — the cost of taking it down or redeploying it.

```bash
npx neat.is blast-radius database:payments-db
```

```
Blast radius for database:payments-db: 3 affected nodes reachable downstream.
  • service:billing (distance 1, OBSERVED)
  • service:checkout (distance 2, OBSERVED)
  • service:notifications (distance 2, STALE — last seen too long ago)
```

Flag: `--depth N` (default 10, max 20). The reported confidence is the weakest link — it multiplies across each hop, so a node four hops out is only as trustworthy as the chain that reaches it.

### `dependencies <id>` — what this depends on

Transitive outbound walk. Everything a node reaches, grouped by distance, with both static and runtime edges.

```bash
npx neat.is dependencies service:checkout --depth 2
```

```
service:checkout has 5 dependencies reachable to depth 2 (2 direct).
Direct (distance 1):
  • service:billing — CALLS (OBSERVED)
  • database:sessions — CONNECTS_TO (EXTRACTED)
Distance 2:
  • database:payments-db — CONNECTS_TO (OBSERVED)
```

Flag: `--depth N` (default 3, max 10). `--depth 1` gives you direct dependencies only. Each line carries its edge type and provenance, so you can see at a glance which dependencies your code declares versus which ones production actually exercised.

### `observed-dependencies <id>` — runtime only

The same outbound view, but filtered to `OBSERVED` edges. This is "what did this node actually call in production," with no static declarations mixed in.

```bash
npx neat.is observed-dependencies service:checkout
```

```
service:checkout has 2 runtime dependencies confirmed by OTel.
  • service:billing — CALLS [callCount=412, lastObserved=2026-06-07T18:22:04.118Z]
  • database:payments-db — CONNECTS_TO [spans=88, age=3s]
```

If you get *no* `OBSERVED` dependencies but the node has `EXTRACTED` ones, the output says so and asks whether OTel is running — that's usually the [no-observed-edges](./troubleshooting.md#no-observed-edges-after-running-the-app) case.

### `incidents` — recent errors

Recent error events, pulled from OTel exception spans. Bare, it's the global log; with a node id, it's that node's incidents.

```bash
npx neat.is incidents service:billing --limit 5
```

```
service:billing has 12 recorded incidents; showing the 5 most recent.
  2026-06-07T18:21:55.004Z — billing: ECONNREFUSED 10.0.0.4:5432
    trace=4bf92f3577b34da6a3ce929d0e0e4736 span=00f067aa0ba902b7
```

Flag: `--limit N` (default 20).

### `search <query>` — find a node

Semantic match on node names and ids — phrase it the way you'd describe what you want. This is also how you discover node ids to feed the other verbs.

```bash
npx neat.is search "checkout"
```

```
Found 2 matches for "checkout" via transformers provider.
  • service:checkout (ServiceNode) — checkout [score=0.91]
  • src/checkout/tax.ts (FileNode) — tax [score=0.74]
```

Search uses an embedding provider when one's available (Ollama, then an in-process model) and falls back to substring matching otherwise; the summary tells you which provider answered.

### `policies` — current violations

Architectural assertions from your project's `policy.json`, and what's currently violating them.

```bash
npx neat.is policies --node service:billing --json
```

Flags: `--node <id>` to scope to one node, `--hypothetical-action <json>` to dry-run a change ("what would fire if I added this edge?") without applying it. If the project has no `policy.json`, the verb says so.

### `diff` — compare against a saved snapshot

Compare the live graph to a snapshot you saved earlier. Useful for change reviews and post-incident reconstruction — "what moved in the architecture since this baseline?"

```bash
npx neat.is diff --against ./snapshots/baseline.json
```

```
Diff against ./snapshots/baseline.json: 2 changes between the snapshot and the live graph.
  base exportedAt:    2026-06-01T09:00:00.000Z
  current exportedAt: 2026-06-07T18:30:00.000Z

Added:
  + edge CALLS:OBSERVED:service:checkout->service:billing — service:checkout -> service:billing (CALLS, OBSERVED)
```

Flag: `--against <snapshot-path>` (required).

### `stale-edges` — what went quiet

Recent `OBSERVED → STALE` transitions. A `CALLS` edge that just went stale usually means an upstream stopped calling — a signal to look, not proof of a problem.

```bash
npx neat.is stale-edges --edge-type CALLS
```

Flags: `--limit N`, `--edge-type CALLS|CONNECTS_TO|...` to filter by edge type.

## Two flags every query verb honors

- **`--json`** — emit machine-readable JSON instead of human text. Use this when you're piping a result into another tool. The human format is the default.
- **`--project <name>`** — target a registered project by name. Without it, the verb hits the `default` project. You can also set `NEAT_PROJECT` in the environment instead of passing the flag every time. List your registered projects with `neat list`.

## Exit codes

Every verb branches its exit code so you can script around it:

| Code | Meaning |
|------|---------|
| `0` | Success. |
| `1` | Server error — the daemon answered with a 4xx/5xx; the body is printed to stderr. |
| `2` | Misuse — a missing argument or bad flag, caught before any network call. |
| `3` | Environmental — the daemon is unreachable, or a port it needs is held by another process. |

Results go to stdout; diagnostics go to stderr. They never mix, so `neat divergences --json | jq` stays clean even when something goes wrong.

## Going deeper

Every verb here is a thin wrapper over a REST endpoint, and each one mirrors an MCP tool of the same shape. The exact request and response types — including fields the human output summarizes — are in the [API reference](../api-reference.md). If you want an AI agent to call these instead of you, see [Using NEAT with an AI agent](./ai-agents.md).
