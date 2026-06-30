---
name: one-command-cli
description: NEAT's CLI reaches a one-command shape — `neat <path>` orchestrates discovery + extraction + apply + daemon + browser + summary in one verb. `neat deploy` emits substrate-appropriate artifacts. Auth at the daemon boundary is delegated via `NEAT_AUTH_TOKEN`; loopback-only without one. OTLP honors the same bearer with `NEAT_OTEL_TOKEN` rotation. `.env.neat` keeps the localhost default and rides OTel SDK env precedence in production. `neat-out/` is appended to `.gitignore` automatically.
governs:
  - "packages/core/src/cli.ts"
  - "packages/core/src/server.ts"
  - "packages/core/src/daemon.ts"
  - "packages/core/src/otel.ts"
  - "packages/core/src/otel-grpc.ts"
  - "packages/core/src/neatd.ts"
  - "packages/core/src/registry.ts"
  - "Dockerfile"
adr: [ADR-073, ADR-046, ADR-047, ADR-049, ADR-051, ADR-052, ADR-058, ADR-063, ADR-069, ADR-070]
enforcement: [lint, review]
---

# One-command CLI + deployment + delegated auth contract

The first v0.3.8 contract. Locks the shape of `neat <path>`, `neat deploy`, and the bearer-token boundary at the daemon before the implementation bundles land in A1 / A2 / A3.

Six sections, one rule each. Each maps to one of the six ADR-073 numbered decisions.

## 1. `neat <path>` is a one-command orchestrator

When the first positional argument resolves to a directory and does **not** match a registered verb, the CLI dispatches to the orchestrator. The orchestrator runs, in order:

1. Discovery + extraction (per [`static-extraction.md`](./static-extraction.md)).
2. Project registration (per [`project-registry.md`](./project-registry.md)).
3. SDK install **apply** (per [`sdk-install.md`](./sdk-install.md)) — mutates manifests, writes `otel-init`, writes `.env.neat`.
4. Daemon spawn (per [`daemon.md`](./daemon.md)) — `neatd start` if no daemon is already running.
5. Browser open against the web UI (per [`web-bootstrap.md`](./web-bootstrap.md)).
6. Summary block — what landed on disk, plus the OTel env-vars block the operator pastes into their deploy platform (matches §5 below).

Defaults: instrument yes, open dashboard yes. Overrides:

- `--no-instrument` — skip step 3. Useful for read-only first-look runs.
- `--no-open` — skip step 5. Useful for headless / CI invocations.

`npx neat.is <path>` is the documented shorthand. It forwards through `@neat.is/cli`'s bin entry into the same orchestrator dispatch — no second code path.

The orchestrator is **distinct from `neat init`**. `neat init` keeps its patch-by-default contract (ADR-046 §5): no manifest mutation without `--apply`. The orchestrator runs apply unconditionally because the bare-`<path>` shape's user intent is "make this work end-to-end."

## 2. `neat deploy` emits substrate-appropriate artifacts

Second top-level verb. Detects substrate, generates a fresh `NEAT_AUTH_TOKEN`, prints the OTel env-vars block.

Detection order:

1. **Docker present** (`docker version` resolves within 2 seconds) → emit a `docker-compose.yml` snippet binding the daemon image, the OTLP receiver port (`:4318`), the REST port (`:8080`), and the web UI port (`:6328`). Declares `NEAT_AUTH_TOKEN` as a required env-var.
2. **Raw machine / systemd-aware host** (no Docker, `systemctl --version` resolves) → emit a `neatd.service` systemd unit running `neatd start --foreground` under a service user. `EnvironmentFile=/etc/neat/neatd.env` holds the token.
3. **Fallback** (neither) → emit a single `docker run` snippet adaptable to the operator's substrate.

Token generation: 32 bytes cryptographically random, base64url-encoded. Printed once. The artifact written to disk names the env-var but **never** embeds the token value.

`neat deploy` also prints the OTel env-vars block ready to paste into the operator's application services:

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://<host>:4318
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>
OTEL_SERVICE_NAME=<service>
```

The token in the printed block matches `NEAT_AUTH_TOKEN` unless `--otel-token <value>` overrides it (see §4).

## 3. Auth at the daemon boundary is delegated via `NEAT_AUTH_TOKEN`

The token is the daemon-side configuration surface. NEAT does not issue, rotate, or distribute it — that is the deploy platform's job.

**`NEAT_AUTH_TOKEN` set:**

- Middleware on the REST host requires `Authorization: Bearer <token>` on every request under `/api/*` and on the SSE stream at `/events` (per [`frontend-api.md`](./frontend-api.md)).
- Missing header → `401 Unauthorized` with a JSON error body.
- Wrong token → `401`. Constant-time comparison only.
- The bundled web UI carries the token via the same header, reading it from an env-injected config payload at `/api/config`.
- Lifecycle probes `/healthz` and `/readyz` stay unauthenticated — orchestrator probes need to reach them.
- Mounted **before** any project router; no per-project bypass.
- The read/write split is opt-in via `NEAT_PUBLIC_READ` — see §3a below.

**`NEAT_AUTH_TOKEN` unset:**

- Daemon refuses to bind on any address other than `127.0.0.1`.
- Setting any future bind-override env-var to a non-loopback value with no token → `neatd start` exits non-zero with: `NEAT_AUTH_TOKEN is required when binding outside loopback`.
- Loopback-only binds remain unauthenticated. The laptop dev experience is unchanged.

## 3a. `NEAT_PUBLIC_READ` — read-anonymous, write-authenticated

Reference deployments (e.g. `try.neat.is`) want the dashboard publicly readable without losing the bearer gate on writes. `NEAT_PUBLIC_READ=true` (or `=1`) flips that split:

- The bearer hook lets `GET` / `HEAD` / `OPTIONS` through anonymously. SSE `/events` is a GET, so the live event stream passes through too.
- Every other verb (`POST` / `PUT` / `PATCH` / `DELETE`) keeps the existing `401`-without-token treatment. Constant-time comparison still applies.
- OTLP ingest at `:4318` (and `:4317` when opt-in) is **not** part of the split — that surface mounts its own middleware against `NEAT_AUTH_TOKEN` / `NEAT_OTEL_TOKEN` and stays gated unconditionally. Randoms can't push spans into a publicly readable reference daemon.
- The bind-authority gate is unchanged. `NEAT_PUBLIC_READ=true` does **not** unlock public binding without a token — `NEAT_HOST=0.0.0.0` plus `NEAT_AUTH_TOKEN` unset still throws `BindAuthorityError`. Public-read enables anonymous reads on top of an already-bound, token-authorized daemon.
- Default: `false`. Anything other than literal `'true'` or `'1'` reads as off. The laptop dev path and the existing reference-implementation auth posture are unchanged.

### `/api/config` — the negotiation surface

`GET /api/config` is **always unauthenticated** — even when the daemon is fully token-gated. It returns exactly two booleans and nothing else:

```json
{ "publicRead": true, "authProxy": false }
```

- `publicRead` mirrors the `NEAT_PUBLIC_READ` env.
- `authProxy` mirrors `NEAT_AUTH_PROXY` so the web shell knows when an upstream reverse proxy terminates auth.
- No project list, no version, no environment info, no whoami. The web UI uses the two booleans to decide whether to push the operator through `/login` and which mutation affordances to render disabled; nothing else belongs on this surface.

The web shell hits `/api/config` before any bearer-carrying call, caches the result in a module-level singleton, and renders `public read-only` in the StatusBar when `publicRead === true`. The dashboard mounts read-only; mutation buttons disable; the login redirect on 401 is suppressed.

## 4. OTLP ingest honors the same bearer; `NEAT_OTEL_TOKEN` rotates independently

The OTLP HTTP receiver at `:4318` checks `Authorization: Bearer <token>` against `NEAT_AUTH_TOKEN` by default.

For rotation independence, the operator may set `NEAT_OTEL_TOKEN` — when set, OTLP validates against that value while the REST host keeps validating against `NEAT_AUTH_TOKEN`. The two are rotated on independent schedules.

When neither is set, OTLP ingest is unauthenticated and inherits the loopback-only refusal from §3.

The OTLP/gRPC receiver on `:4317` (opt-in via `NEAT_OTLP_GRPC=true` per ADR-049) honors the same precedence.

## 5. `.env.neat` keeps the localhost default; production overrides through OTel SDK env precedence

The SDK installer (ADR-047 §3) continues to write `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` into each instrumented service's `.env.neat`. Localhost stays the default — that is what makes the orchestrator's "one command and it works" property hold.

Production redirects through whichever deploy platform the operator picked. Setting `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` on the platform's env dashboard overrides the file-based default per the OTel SDK's documented precedence (process env > `.env`-loaded vars on most runtimes).

NEAT does **not** codegen a second `.env.neat` for prod. NEAT does **not** edit the operator's deploy-platform config. The orchestrator summary (§1) and `neat deploy` (§2) both surface the exact override block — same format — so the operator never composes the headers by hand.

## 6. `neat-out/` is appended to `<path>/.gitignore` automatically

When the orchestrator (or `neat init`) writes the snapshot under `<projectDir>/neat-out/`, it also ensures `.gitignore` at the project root contains a `neat-out/` line.

Rules:

- **Idempotent.** If the line already exists (exact match against `neat-out/` or `neat-out`, ignoring surrounding whitespace), no write occurs.
- **Created when absent.** If `.gitignore` is missing, it is created with the single line.
- **One file outside `neat-out/` itself** that the init flow may modify without an `--apply` opt-in — an un-ignored `neat-out/` leaks the snapshot into git history within one commit, which is a foot-gun no operator wants.
- **Surfaced in dry-run.** `neat init --dry-run` lists the planned `.gitignore` write in the summary alongside the other planned writes.

## Authority

- `packages/core/src/cli.ts` — bare-path dispatch, `neat deploy` verb, summary-block renderer, `.gitignore` append composition.
- `packages/core/src/server.ts` — bearer middleware on `/api/*` and `/events`.
- `packages/core/src/daemon.ts` — pre-bind validation (`NEAT_AUTH_TOKEN` vs bind address), OTLP bearer wiring.
- `packages/core/src/otel.ts` / `otel-grpc.ts` — `NEAT_OTEL_TOKEN` precedence at the receivers.
- `packages/core/src/neatd.ts` — `neatd start` exit-code branch on the loopback-only refusal.
- `packages/core/src/registry.ts` — the `.gitignore` append helper composes onto the existing init path.
- `Dockerfile` — the deploy-image surface that `neat deploy`'s docker-compose snippet binds against.

## Enforcement

`describe('ADR-073 — one-command CLI + deployment-target + delegated auth')` in `packages/core/test/audits/contracts.test.ts`. Assertions land alongside their implementing PRs; pre-implementation rows surface as `it.todo`. Six families, one per section above.

Full rationale: [ADR-073](../decisions.md#adr-073--one-command-cli-neat-deploy-and-delegated-auth-at-the-daemon-boundary).
