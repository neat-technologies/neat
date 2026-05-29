# e2e/capture — layered file-first capture smoke

The make-or-break gate for trusting file-first OBSERVED on a published artifact.
Where `e2e/brief` proves OBSERVED edges land at all, this proves the **layered
capture mechanism** (file-awareness.md §4, ADR-090) attributes a file to *every*
emitted CLIENT/PRODUCER/SERVER span under **real** auto-instrumentations — not
just the synchronous-wrapper majority.

Self-contained: the sample service lives under [`app/`](./app), so the harness
needs no external repo. Its routes each exercise one capture tier:

| Route       | Tier                          | Mechanism layer                         |
|-------------|-------------------------------|-----------------------------------------|
| `/sync-pg`  | pg query                      | 1 — synchronous stack walk              |
| `/http`     | http client call              | 1 — synchronous stack walk              |
| `/floor`    | handler, no facade call       | 2 — handler-entry stamps the SERVER span|
| `/fetch`    | undici / built-in `fetch`     | 3 — off-stack facade (channel-based)    |
| `/prisma`   | `@prisma/instrumentation`     | 3 — off-stack facade (backdated)        |
| `/aws`      | aws-sdk v3 SQS (placeholder)  | 1 — sync-wrapper, live datapoint        |

The Postgres the `/sync-pg` and `/prisma` routes reach is throwaway (trust auth,
no schema pushed) — the queries fail and the spans still emit, which is all the
assertion needs. The `/aws` call fails at auth; its CLIENT span still emits.

## What it asserts

Every OBSERVED `CALLS` / `CONNECTS_TO` edge from `service:neat-capture-app` must
originate from a **file** node (`file:neat-capture-app:…`), never the service
node. One service-level edge is a failure — it means a tier's span reached
ingest without `code.*`. Both a DB-tier (`CONNECTS_TO`) and a call-tier
(`CALLS`) file-grained edge must be present, so the gate spans tiers.

## Gate behaviour

- **Fails on `neat.is@0.4.10`** — there the off-stack tiers (`/fetch`, `/prisma`)
  produce only service-level edges, so the service-level count is non-zero.
- **Passes after the layered mechanism (#425) lands** — every tier is
  file-grained.

This is the new make-or-break smoke; it runs in CI alongside `brief-observed`.

## Running locally

```bash
# 1. build + start neatd
npx turbo build
node packages/core/dist/cli.cjs > /tmp/neatd.log 2>&1 &

# 2. install the sample app and inject the layered otel-init
npm --prefix e2e/capture/app install
node packages/core/dist/cli.cjs init "$(pwd)/e2e/capture/app"
( cd e2e/capture/app && npx prisma generate )

# 3. start the app (point it at a throwaway Postgres + neatd's OTLP receiver)
DATABASE_URL=postgresql://capture:capture@localhost:5432/capture \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  npm --prefix e2e/capture/app start > /tmp/capture-app.log 2>&1 &

# 4. drive + assert
./e2e/capture/run.sh
```

Env knobs:

| Var                 | Default                   | Notes                                  |
|---------------------|---------------------------|----------------------------------------|
| `NEAT_BASE`         | `http://localhost:8080`   | neatd REST host                        |
| `CAPTURE_APP_BASE`  | `http://127.0.0.1:8082`   | sample app host                        |
| `CAPTURE_PROJECT`   | auto-discovered           | project name `neat init` registered    |
| `CAPTURE_SERVICE`   | `neat-capture-app`        | ServiceNode id (the app's pkg.name)    |
| `LOAD_N`            | `8`                       | iterations per tier                    |
| `ASSERT_TIMEOUT_MS` | `30000`                   | polling budget for file-grained edges  |

## CI gating

Like `e2e-brief`, the workflow is gated behind the `CAPTURE_E2E_ENABLED` repo
variable so it doesn't run red before the supporting infrastructure is wired.
Set it to `true` once the maintainer has run the harness green on a branch.
