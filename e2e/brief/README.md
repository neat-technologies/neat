# e2e/brief — OBSERVED-tier live test

NEAT's thesis is that OBSERVED carries the load. This harness exercises that
surface against Brief, the canonical OBSERVED demonstrator. It boots (or
reuses) `neatd`, drives a small set of synthetic user journeys against Brief's
API, waits for the spans to land, and asserts the OBSERVED edges Brief is
expected to produce show up on `service:brief-api` in the live graph.

## Running locally

```bash
# Assumes neatd is running on http://localhost:8080 (or will be spawned),
# Brief API is running on http://localhost:8081 (override via BRIEF_BASE).
./e2e/brief/run.sh
```

Env knobs:

| Var              | Default                                 | Notes                                                 |
|------------------|-----------------------------------------|-------------------------------------------------------|
| `NEAT_BASE`      | `http://localhost:8080`                 | neatd REST host                                       |
| `BRIEF_BASE`     | `http://localhost:8081`                 | Brief API host                                        |
| `NEAT_HOME`      | `~/.neat`                               | registry + errors.ndjson location                     |
| `LOAD_N`         | `20`                                    | iterations per journey                                |
| `LOAD_JITTER_MS` | `50`                                    | sleep between requests                                |
| `ASSERT_TIMEOUT_MS` | `30000`                              | polling budget for OBSERVED edges                     |

## What it asserts

The full shape lives in [docs/contracts/observed-e2e.md](../../docs/contracts/observed-e2e.md).
Summary:

1. `service:brief-api` is present in the project graph.
2. At least one OBSERVED edge originates from `service:brief-api` with non-zero
   `signal.spanCount` and a `lastObserved` within the last 60s.
3. `/graph/divergences` returns 200 and yields a shape consistent with the
   OBSERVED tier carrying graded confidence per ADR-066.

Brief-side instrumentation gaps (e.g. Prisma DB spans) are scoped out of this
harness — they ride on Brief's own roadmap.

## Pinning Brief

`./e2e/brief/.brief-sha` pins a commit of `brief-app/api`. CI clones at that
SHA so the harness's expected shape doesn't drift when Brief changes. Bump
the file in the same PR that updates the assertions when Brief's API surface
moves.
