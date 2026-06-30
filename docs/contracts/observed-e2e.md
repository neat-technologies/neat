---
name: observed-e2e
description: The OBSERVED tier earns a live end-to-end test against Brief. The harness drives synthetic journeys, neatd's OBSERVED layer materializes spans into edges, and the contract names the shape the assertions read.
governs:
  - "e2e/brief/**"
  - "packages/core/src/ingest.ts"
  - "packages/core/src/otel.ts"
  - "packages/core/src/otel-grpc.ts"
  - "packages/core/src/extract/**"
  - ".github/workflows/e2e-brief.yml"
adr: [ADR-075, ADR-033, ADR-068, ADR-073]
enforcement: [lint, breaker, review]
---

# OBSERVED e2e contract

NEAT's thesis is that OBSERVED carries the load. The EXTRACTED path is covered
end-to-end by the contract suite + the in-tree fixtures. The OBSERVED tier
earns its keep when spans from a real codebase land in neatd's graph and the
divergence query reads them back. Brief is the canonical demonstrator.

## Surface

The harness lives at `e2e/brief/` with one shell entry point and two tsx
scripts:

```
e2e/brief/
  run.sh         # entry: probes daemon + Brief, runs load, runs assertions
  load.ts        # five journeys driven N times each with jitter
  assertions.ts  # polls /projects/brief/graph, asserts OBSERVED shape
  .brief-sha     # 40-hex pinned revision of brief-app/api for CI checkout
  README.md      # local-run instructions and env knobs
```

`run.sh` is executable. Both `.ts` files run via `npx tsx` from the repo
root.

## Journeys (binding)

Five journeys, run sequentially, N=20 by default (override via `LOAD_N`),
~50ms jitter between requests (override via `LOAD_JITTER_MS`):

| Journey            | Endpoint                                           | Purpose                                |
|--------------------|----------------------------------------------------|----------------------------------------|
| `health`           | `GET /health`                                      | Lowest-cost span, always available     |
| `signup`           | `POST /auth/signup`                                | Hits supabase auth + prisma            |
| `login`            | `POST /auth/login`                                 | Hits supabase auth on a known-bad cred |
| `community-threads`| `GET /community/threads?topic=…`                   | Hits prisma read path                  |
| `briefing-today`   | `GET /briefing/today`                              | Hits prisma + mongo                    |

The journeys are correctness, not benchmarking. The point is variety of
spans, not throughput.

## OBSERVED shape (binding)

`assertions.ts` polls `/projects/brief/graph` until the expected shape
materializes, with a 30 second budget (override via `ASSERT_TIMEOUT_MS`).

1. `service:brief-api` is present as a ServiceNode.
2. At least one edge with `provenance: 'OBSERVED'` originates from brief-api —
   either `service:brief-api` (no call site) or a `file:brief-api:<relPath>`
   source (call site captured). File-first (ADR-089): brief-api's outbound
   CLIENT spans land on a FileNode when the injected call-site processor
   captured a user frame.
3. At least one of those edges carries `signal.spanCount > 0` and a
   `lastObserved` ISO8601 timestamp within the last 60 seconds.
4. At least one OBSERVED edge originates from a brief-api **source file**
   (`file:brief-api:<relPath>`) — the file-first claim under live test
   (file-awareness.md §4). Only service-level OBSERVED edges means the
   call-site processor isn't landing `code.*` on outbound spans.
5. `/projects/brief/graph/divergences` returns 200 (per ADR-060).

Failure to satisfy any of these within the timeout exits non-zero with a
specific message naming what's missing. `expected OBSERVED edge from
service:brief-api, found none within 30000ms — the OTLP path between Brief
and neatd is silent` is the canonical failure line for the silent-OTLP case;
the file-grained failure names the call-site processor (point 4).

## Scoped out (intentional)

- **`brief-api → brief-db` CONNECTS_TO**: Brief's Prisma client doesn't
  currently emit `db.system` spans through
  `@opentelemetry/auto-instrumentations-node`. The harness asserts on
  CALLS-family edges from `service:brief-api` rather than the more specific
  DB shape. Adding Prisma instrumentation belongs on Brief's roadmap.
- **Multi-service edges (`brief-web → brief-api`)**: Brief's frontend is
  Next.js + a React Native app — bringing them up under CI is its own track.
  The harness assertions are scoped to `service:brief-api` only.
- **Performance budgets**: N=20 is correctness. The harness does not assert
  on edge counts beyond the floor of one.

These widen as Brief's instrumentation widens. The contract change rides on
the same PR.

## CI gating

`.github/workflows/e2e-brief.yml` triggers on PRs that touch
`packages/core/src/{ingest,otel,otel-grpc}.ts`, anything under
`packages/core/src/extract/**`, `e2e/brief/**`, or the workflow file itself.

The job short-circuits with a skip message unless the `BRIEF_E2E_ENABLED`
repo variable is set to `true`. Until the supporting secrets land
(`BRIEF_REPO_TOKEN`, `BRIEF_SUPABASE_URL`, `BRIEF_SUPABASE_ANON_KEY`,
`BRIEF_SUPABASE_SERVICE_ROLE_KEY`), the gating prevents PRs from going red
on a configuration gap. Postgres 16 and Mongo 7 ride as service containers;
the workflow seeds Brief's schema via `prisma db push` before booting Brief.

## Bumping the pinned Brief SHA

The pinned SHA in `e2e/brief/.brief-sha` lives at exactly one place so the
harness's expected shape doesn't drift when Brief changes. Update procedure:

1. Make the change in `brief-app/api` first; land it on Brief's default
   branch.
2. Bring the harness up locally against the new Brief commit. Confirm the
   assertions still pass.
3. Update `e2e/brief/.brief-sha` to the new 40-hex revision.
4. If the API surface moved, update the journeys in `load.ts` and the
   matching shape in this contract.

A SHA bump that breaks an assertion is the contract telling you the OBSERVED
shape changed — either Brief intentionally moved (update the assertion) or
Brief's instrumentation regressed (file against Brief).

## Enforcement

`packages/core/test/audits/contracts.test.ts` adds (per the e2e-brief block):

- `e2e/brief/run.sh` exists, is executable, references `tsx`.
- `e2e/brief/.brief-sha` exists and matches `^[0-9a-f]{40}$`.
- `e2e/brief/load.ts` and `e2e/brief/assertions.ts` exist.
- `.github/workflows/e2e-brief.yml` exists, references `e2e/brief/run.sh`,
  and scopes itself via `paths:` to the OBSERVED-tier source files named in
  the §CI gating section.

## Rationale (ADR-075)

Static extraction is what every other tool already does. The provenance
contract (ADR-029 + ADR-068) treats OBSERVED as the highest-trust tier
because it carries direct observation; that trust is only earned when the
OBSERVED layer actually fires on a real codebase, not just on the in-tree
fixture. Brief is the smallest real-world surface NEAT instruments, runs
under the orchestrator (ADR-073 §1), and shares Deniz's hardware — so it's
the cheapest place to put the OBSERVED tier under a live test.

The harness pulls a sibling repo and runs Postgres + Mongo containers; it
costs minutes per run, not seconds. Path-scoped triggering keeps it from
running on PRs that can't move the OBSERVED layer, which is most of them.
