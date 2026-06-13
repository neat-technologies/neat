# e2e/tart — fresh-macOS-VM install pipeline

A throwaway-VM harness that runs NEAT's genuine **first-install** experience on a
virgin Mac, every time, from a clean baseline.

## Why this exists

The maintainer's dev machine has accumulated NEAT state — a global `neat`, a
populated `~/.neat`, built artifacts, sometimes an orphaned daemon lock. That
state quietly masks a whole class of first-run bugs: a stale global shadowing the
pinned version, an orphaned lock blocking the daemon, version skew between a
global install and `npx`. None of those reproduce on the machine that carries the
state. They only show up on a Mac that has never seen NEAT.

So this harness spins up exactly that: a fresh macOS VM (via
[Tart](https://github.com/cirruslabs/tart)) with Node 20.x, git, and chromium —
and **nothing from NEAT**. It runs `npx neat.is@<version>` against a bundled
sample app, drives traffic, asserts the graph NEAT builds, captures dashboard
screenshots, collects everything back to the host, and deletes the VM. Repeatable
across a version matrix.

It does three jobs:

1. **First-install reproduction** — the path the stateful dev machine masks.
2. **Version-regression harness** — run a matrix (`./run.sh 0.4.16 0.4.17
   0.4.18`) and diff the per-version artifacts to catch a UX or graph-shape
   regression between releases.
3. **Validation harness for the per-project-daemon refactor** — see
   `docs/contracts/project-daemon.md`. That refactor moves to one daemon per
   project, with the project served at the REST root (no `/projects/<name>`
   prefix, no `default` resolution) and a bare `neat divergences` resolving to
   the single project. The scenario asserts exactly that bare-verb behavior and
   probes both the bare `/graph` and the prefixed `/projects/<name>/graph`, so it
   stays green across the migration and turns red if either side breaks.

## The pipeline flow

```
neat-base (baked once)
   │  tart clone
   ▼
t-<version>  ──tart run --dir neat=<repo>──►  [ fresh macOS VM ]
   │                                              │ scenario.sh:
   │   ssh admin@<ip> scenario.sh <version>       │  npx neat.is@<v> <fixture>
   │                                              │  start app, drive traffic
   │                                              │  neat divergences / search /
   │                                              │    root-cause / blast-radius
   │                                              │  curl :8080/.../graph → OBSERVED>0
   │                                              │  Playwright chromium screenshots
   │   ◄── collect artifacts (mounted dir) ───────┘
   ▼
tart stop + tart delete   (the VM kills itself)
```

## Prerequisites

```bash
brew install cirruslabs/cli/tart                 # Tart (Apple Silicon)
brew install hudochenkov/sshpass/sshpass         # unattended SSH (optional but
                                                 # needed for a hands-off matrix)
```

## 1. Build the base image (once)

```bash
./base-image.sh
```

This clones `ghcr.io/cirruslabs/macos-sequoia-base:latest` to `neat-base`,
boots it, and provisions it over SSH: Node 20.x + git via Homebrew, Playwright's
bundled chromium (a fresh Mac has no system Chrome), and a hard check that there
is **no** global `neat` and **no** `~/.neat`. The result is a reusable virgin
baseline. Re-run only when you want to rebuild it (`tart delete neat-base`
first). Default VM creds are the cirrus-image `admin`/`admin`; override with
`VM_USER` / `VM_PASS`.

## 2. Run a version (or a matrix)

```bash
./run.sh 0.4.18                    # single version
./run.sh 0.4.16 0.4.17 0.4.18      # version matrix
./run.sh latest                    # npm 'latest'
```

For each version `run.sh` clones `neat-base` → `t-<version>`, boots it with the
repo mounted (`--dir neat=<repo-root>`), ssh's in to run `scenario.sh`, collects
the artifacts, then `tart stop` + `tart delete`. Teardown is trapped, so a failed
scenario never leaks a VM. The matrix keeps going on a per-version failure and
exits non-zero if any version failed.

## Where artifacts land

The scenario writes into the mounted tree at
`e2e/tart/artifacts/<version>/`, and `run.sh` mirrors that to
`e2e/tart/artifacts/<version>/` on the host (same path; the mount makes them one
place). Per version you get:

| File                       | What it is                                            |
|----------------------------|-------------------------------------------------------|
| `summary.txt`              | The PASS/FAIL line for every assertion + RESULT       |
| `01-npx-neat.log`          | Full `npx neat.is@<v>` output — banner, summary, token |
| `02-npm-install.log`       | The OTel-dep install neat's patch asks for            |
| `03-fixture-app.log`       | The instrumented fixture's stdout                     |
| `05a-divergences.txt/.json`| `neat divergences` (bare verb) output                 |
| `05b-search.txt`           | `neat search server`                                  |
| `05c-root-cause.txt`       | `neat root-cause <node>`                              |
| `05d-blast-radius.txt`     | `neat blast-radius <node>`                            |
| `06-observed.txt`          | The OBSERVED-edge assertion report + VERDICT          |
| `graph.json`               | The raw graph the assertions read                     |
| `dashboard-graph.png`      | The cytoscape graph canvas                            |
| `dashboard-full.png`       | Full-page dashboard (chrome + legend + canvas)        |
| `dashboard-inspector.png`  | Inspector/divergence view, when reachable             |

## What each assertion proves

The scenario reuses the correctness approach of `e2e/capture`: it reads the graph
from the daemon's REST and asserts OBSERVED edges, the load-bearing tier.

- **fresh-state** — `~/.neat` absent and no global `neat`. Proves the VM is
  virgin, i.e. this is the first-install path. A non-empty state here means the
  base image drifted.
- **orchestrator** — `npx neat.is@<version> <fixture>` exits 0. This is the
  headline one-command UX (discover → instrument → daemon → dashboard on :6328 →
  token line), not a hand-assembled path.
- **divergences (bare verb)** — `neat divergences` with **no** `--project`
  resolves to the single registered project instead of 404'ing on a missing
  `default`. This is the bare-verb fix, and the exact shape the
  per-project-daemon refactor formalizes (the daemon *is* the project).
- **search / root-cause / blast-radius** — the query verbs run cleanly against
  the fresh daemon; blast-radius reaches the database node downstream.
- **observed** — the correctness core: the graph carries **> 0 OBSERVED edges**,
  including a `CALLS → frontier` (the fixture's outbound HTTP) and a
  `CONNECTS_TO → database` (the fixture's SQLite). File-grained where NEAT's
  call-site processor landed `code.*`.
- **screenshots** — Playwright (chromium) renders the loopback dashboard on
  :6328 and captures the graph canvas. Best-effort: a render miss is a warning,
  not a gate — the REST assertions are the gate.

## The fixture (`fixture/`)

A self-contained Brief-like Express service with zero external dependencies, so
it runs on a virgin Mac with no Postgres, no creds, no internet:

- **`CALLS → frontier`** — `/quote`, `/enrich`, `/report` make a real http
  client call to a named upstream. By default that upstream is a tiny local stub
  the same process starts, so the call always succeeds offline and the frontier
  node has a name. Point `UPSTREAM_URL` at a real httpbin-style endpoint to
  exercise the genuine-internet path.
- **`CONNECTS_TO → database`** — `/items` and `/report` open a `better-sqlite3`
  connection (in-process, file under the temp dir). The bundled OTel set has no
  SQLite instrumentation, so the fixture closes that gap the way `neat extend`
  does for any uncovered library: it emits a **real** CLIENT span carrying
  `db.system`/`server.address` at the call site. NEAT's call-site processor
  stamps `code.*` on it, so the edge lands file-grained.

`neat init` injects `otel-init.cjs` and patches `package.json` with the OTel
deps; the scenario runs `npm install` afterward (the orchestrator leaves the
install to the caller) so the instrumentation is live when the app boots.

## What's validated locally vs. needs Tart

The **scenario logic** — the fixture forming the OBSERVED graph, the query verbs,
the OBSERVED-edge assertion, and the Playwright capture — is validated on the
maintainer's machine in full isolation (a throwaway `NEAT_HOME` + alternate
ports, never the live daemon). The fixture forms both OBSERVED edges
(`CALLS → frontier`, `CONNECTS_TO → database`) and `screenshot.mjs` captures the
graph canvas.

The **Tart-VM orchestration** (`base-image.sh`, `run.sh`) needs Tart + macOS
virtualization, which can't run in CI here — the maintainer runs that side. The
scenario it drives is the same one validated locally.

## Notes / gotchas

- **chromium, not Chrome.** A fresh Mac has no system Chrome; `screenshot.mjs`
  launches Playwright's bundled chromium and `base-image.sh` bakes the browser
  binary in.
- **The dashboard login wall.** On the loopback dev path the REST API is open
  (no token), but the dashboard's client gate still redirects to `/login` unless
  the daemon reports `publicRead`. The scenario exports `NEAT_PUBLIC_READ=true`
  so the headless screenshot reaches the canvas. (See `docs/contracts/` —
  ADR-073 §3 / the auth surface.)
- **Ports.** A fresh VM has exactly one daemon, so it takes the canonical
  defaults: REST `:8080`, OTLP `:4318`, dashboard `:6328`.
- **CLI base URL.** The query verbs reach the daemon via `NEAT_API_URL`
  (default `http://localhost:8080`); the daemon's bind `PORT` only controls where
  it listens. In the single-daemon VM the default is correct.
