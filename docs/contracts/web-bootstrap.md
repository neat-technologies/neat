---
name: web-bootstrap
description: neatd start launches the web UI on port 6328 by default. NEAT_WEB_PORT overrides. Fail loudly on collision. Web UI inherits NEAT_API_URL from the parent daemon. Shutdown cascades.
governs:
  - "packages/core/src/neatd.ts"
  - "packages/web/package.json"
  - "packages/neat.is/package.json"
adr: [ADR-059, ADR-049, ADR-052]
enforcement: [lint, review]
---

# Web UI bootstrap contract

The fourth of four web-shell contracts. Sibling contracts: [`web-completeness.md`](./web-completeness.md), [`web-multi-project.md`](./web-multi-project.md), [`web-debugging.md`](./web-debugging.md).

Closes the operational gap that bites every external user: today, `neatd start` boots the daemon but doesn't bring up the web UI. The user has to know the right `npm run dev --workspace @neat.is/web` invocation, fight the Next.js default port 3000 (which collides with everything else they have running), and configure `NEAT_API_URL` themselves.

For ADR-027's MVP-success-PR experiment, this is a non-starter. The fix is for `neatd start` to launch everything the operator needs in one command, on a port designed not to clash.

## Binding rules

### 1. `neatd start` launches the web UI

After the REST API and OTel receivers are listening, `neatd` spawns the web UI as a child process. Web UI runs in production mode (`next start`), not dev mode. Lifecycle is tied to the parent daemon.

### 2. Default port: `6328`

NEAT in T9 phone keypad (N=6, E=3, A=2, T=8). Memorable, narratable, not in `/etc/services` or any common-port list. Avoids the universal collisions on `3000`, `5000`, `8000`, `8080`.

### 3. Port override: `NEAT_WEB_PORT`

Env variable; reads at start time. CI environments, port-already-in-use scenarios, multi-instance setups — set this. neatd respects it.

### 4. Fail loudly on collision

If port 6328 (or `NEAT_WEB_PORT`) is already in use and the parent process can't bind, `neatd start` aborts with the clear-error pattern from ADR-049:

```
neatd: web UI port 6328 in use; set NEAT_WEB_PORT to override or stop the conflicting process
```

No silent fallback to a random port — the user has to know what URL to open.

### 5. Port table

| Service | Default port | Env override |
|---|---|---|
| REST API (neat-core) | `8080` | `PORT` |
| OTel HTTP receiver | `4318` | `OTEL_PORT` |
| OTel gRPC receiver (opt-in) | `4317` | `NEAT_OTLP_GRPC_PORT` |
| Web UI | `6328` | `NEAT_WEB_PORT` |

Each port has one job. Each is overridable independently.

### 6. `NEAT_API_URL` inheritance

When neatd spawns the web UI process, it sets `NEAT_API_URL=http://localhost:${restPort}` in the child's environment. The web shell consumes that env var to point its proxy routes at the same daemon that launched it. The user doesn't configure this twice.

If `NEAT_API_URL` is already set in the parent's env (operator pre-configured), neatd respects it and forwards.

### 7. Shutdown cascades

When `neatd stop` is invoked or `SIGTERM` reaches the daemon, the spawned web UI process is also stopped. Process group kill or explicit child termination. No orphaned web UI processes.

### 8. Distribution: `@neat.is/web` becomes publishable

The web package is currently `private: true` and stays at version `0.2.0`, out of lockstep. To ship it as part of `npm install -g neat.is`, this changes:

- Flip `private: false` and add `publishConfig.access: public` to `packages/web/package.json`.
- Bring `@neat.is/web` into the publish-system contract's lockstep set (per ADR-052 #2). The five-package lockstep becomes six-package.
- Add `@neat.is/web` to the `neat.is` umbrella's `dependencies` so `npm install -g neat.is` pulls it.
- Update CI publish workflow `.github/workflows/publish.yml`'s dependency-order list: `types → core → mcp → claude-skill → web → neat.is`.
- Update `scripts/publish.sh` similarly.

This is a structural change to the publish surface. ADR-052 amendment may be needed, or a successor ADR — flag in implementation PR.

### 9. Distribution: `neatd` resolves the web UI's location

`neatd.ts` uses `require.resolve('@neat.is/web/package.json')` to find the installed web UI's location. Spawns its `start` script (`next start --port ${webPort}`). This works whether neatd is run from the monorepo (`packages/web/` is a workspace symlink) or from a global install (`@neat.is/web` is a regular dependency).

## Out of scope

- **Static-export bundling into `@neat.is/core`.** Considered (single port, single process, simpler). Rejected for MVP because it would require rewriting Jed's existing Next.js API routes as direct fetches to the backend (loses the proxy abstraction layer), and forks Jed's existing dev workflow (`next dev` for live-reload). The child-process approach preserves Jed's track unchanged. If real-user signal demands single-port simplicity, that's a successor ADR.
- **Process supervision / restart-on-crash for the web UI.** Per ADR-049, the daemon doesn't auto-restart on crash; same rule applies to the spawned web UI.
- **Authentication on the web UI.** Localhost-only, MVP. Future ADR if multi-user / hosted instances become a thing.
- **HTTPS for the web UI.** Localhost-only HTTP is sufficient for MVP. Reverse-proxy for HTTPS is the operator's job in deployed environments.

## Authority

- **Spawn logic:** `packages/core/src/neatd.ts` (`cmdStart`)
- **Web UI start script:** `packages/web/package.json` `scripts.start` (`next start`)
- **Distribution / lockstep:** `packages/neat.is/package.json` (`dependencies`), publish workflow + script
- **Port collision check:** new helper in `neatd.ts` or `server.ts` — best-effort `net.createServer().listen()` test before spawning

## Enforcement

`it.todo` block in `contracts.test.ts` for ADR-059:

- `neatd.ts` spawns a web UI child process during `cmdStart`.
- The child process runs on `process.env.NEAT_WEB_PORT ?? '6328'`.
- The child inherits `NEAT_API_URL=http://localhost:${restPort}` (or respects pre-existing parent env).
- Port collision on the configured web port aborts neatd with a clear error and non-zero exit.
- `neatd stop` (and SIGTERM / SIGINT) kills the spawned web UI process.
- `@neat.is/web` is no longer `private: true` and version-matches the lockstep.
- The `neat.is` umbrella's `dependencies` includes `@neat.is/web`.
- The publish workflow + local script include `@neat.is/web` in their dependency order.

The publish-system regression tests (ADR-052) need updating to expect a six-package lockstep, not five. That change is queued for the implementing agent — flag for Contract Author review whether it warrants an ADR-052 amendment or a successor ADR.

Full rationale: [ADR-059](../decisions.md#adr-059--web-ui-bootstrap-from-neatd).
