# Core concepts

NEAT keeps a single live graph of your system and tells you where the parts of it disagree. Four ideas carry the whole model: the **graph**, **provenance**, **divergence**, and the **file as the unit**. Understand these and everything else in NEAT follows.

## The graph

Everything NEAT knows is one graph of typed **nodes** connected by typed **edges**.

Nodes are the things in your system:

| Node | What it is |
|------|------------|
| `FileNode` | A source file. The primary node — relationships originate here. |
| `ServiceNode` | A deployable unit (a repo root or monorepo package) that owns files. |
| `DatabaseNode` | A database your code connects to. |
| `FrontierNode` | An external host your code calls but doesn't own (an API, a third party). |
| `ConfigNode` | A config file (`.env`, yaml). NEAT records that it exists, never its contents. |
| `InfraNode` | An infrastructure target (a container, a runtime). |

Edges are the relationships:

| Edge | Meaning |
|------|---------|
| `CALLS` | One file calls a service or external host. |
| `CONNECTS_TO` | A file connects to a database. |
| `IMPORTS` | One file imports another within the same service. |
| `CONTAINS` | A service owns a file. |
| `CONFIGURED_BY` | A file is configured by a config file. |
| `RUNS_ON` | A service runs on an infrastructure target. |

You don't have to memorize these — the dashboard draws them and the [API reference](../api-reference.md) lists the full schema. The thing to hold onto: **a relationship runs from a file to its target.** `src/billing.ts ──CALLS──▶ api.stripe.com`, not "the billing service does something with Stripe."

## Provenance: how NEAT knows what it knows

Every edge carries a `provenance` tag — a label for *where the claim came from* and therefore how much to trust it. There are four states.

- **`EXTRACTED`** — read from your source code. NEAT parsed a file and saw the call. It doesn't decay; source is source.
- **`OBSERVED`** — seen in a production span. NEAT watched the call actually happen. Carries `lastObserved` (when it last fired) and `callCount` (how often).
- **`INFERRED`** — derived by the trace stitcher where OTel coverage has gaps, to bridge two observed edges that must be connected. Confidence is capped, because it's a reasoned guess, not a sighting.
- **`STALE`** — was `OBSERVED`, but the runtime stopped reporting it. NEAT preserves the original `lastObserved` so you can see *when* it went quiet. A `CALLS` edge goes stale after an hour of silence; slower relationships get longer windows.

Provenance is what makes NEAT honest. When it tells you `src/worker.ts` talks to Redis, it also tells you whether it knows that because your code says so, because it watched it happen, or because it inferred it. A consumer — you, or an AI agent — weights the claim accordingly. The full ranking and how confidence travels along a path is in [PROVENANCE.md](../../PROVENANCE.md).

## Divergence: the load-bearing idea

Static analysis alone tells you what your code *says*. Runtime telemetry alone tells you what your system *did*. NEAT holds both in one graph, and the interesting part is where they don't match. That mismatch is a **divergence**, and it's the finding NEAT exists to surface.

Two shapes matter most:

- **`missing-extracted`** — production *observed* a call that static analysis never surfaced. Your code reaches a host it doesn't visibly name. Usually dynamic dispatch, reflection, or a client library NEAT's extractor doesn't yet recognize. Worth knowing: your service has a dependency that isn't legible in the source.
- **`missing-observed`** — your code *declares* a relationship that no traffic exercised. A database connection that's configured but idle, a branch behind an off feature flag, an unshipped path. The declared dependency might be dead weight — or a path you believed was live and isn't.

The other types (`stale`, `confidence-mismatch`, and grain differences) refine the same idea: compare what's declared against what's observed, and report where they part.

Because relationships originate from files, a divergence is sharp: it names *this file*, declaring or observing *this call*, to *this target*. That's the difference between "checkout seems flaky" and "`src/checkout/tax.ts` calls a tax API your code never declares, and it's the slowest edge in the path."

## The file as the unit

NEAT is file-first. The `FileNode` is the primary node, and relationships originate from files rather than from a coarse service blob. This is a deliberate design choice with one payoff: **precision**.

When the declared side and the observed side both name a file and line, a divergence compares them at the same grain — declared call site versus observed call site, for the same pair. That's the sharpest a finding gets. A service is still in the graph (it's how files are grouped and the fallback when a call can't be pinned to a file), but it's a grouping of files, not a layer the graph rolls up into. There's no service-level summary that blurs which file did what.

Practically: when NEAT finds something, it hands you a file path and a line, not a service name and a shrug.

## How it all runs

NEAT runs as a daemon (`neatd`) that holds the graph for one or more projects and serves it three ways:

- a **REST API** on `:8080` (the [API reference](../api-reference.md) has every endpoint),
- a **dashboard** on `:6328` that draws the live graph,
- an **OTLP receiver** on `:4318` that ingests your app's spans.

It also speaks **MCP**, so an AI agent can query the graph as a set of tools — see [Using NEAT with an AI agent](./ai-agents.md). The static graph updates as your files change; the observed graph updates as your spans arrive; divergences are computed on demand by comparing the two.

## Next

- **[Querying the graph](./querying.md)** — turn these concepts into answers with the CLI.
- **[Using NEAT with an AI agent](./ai-agents.md)** — let an agent walk the graph for you.
