# Runbook

How to do the things you'll do over and over.

## First-time setup

```bash
nvm use                                  # honors .nvmrc → Node 20
npm install                              # one-shot, hoists everything
npx turbo build test lint                # confirms the workspace is healthy
```

If `npm install` fails with a tsup-not-found error, you've got leftover `packages/*/node_modules/` from a previous pnpm setup. `rm -rf node_modules packages/*/node_modules` and try again.

## Run core locally against the demo

```bash
NEAT_SCAN_PATH=./demo \
  npm run dev --workspace @neat.is/core
# → http://localhost:8080
```

Defaults: `PORT=8080`, `HOST=0.0.0.0`, snapshot path `./neat-out/graph.json`. Override any of those with env vars.

## Add a compat rule

`packages/core/compat.json` is the data. Edit it, restart core, re-scan:

```json
{
  "pairs": [
    { "driver": "pg", "engine": "postgresql",
      "minDriverVersion": "8.0.0", "engineVersions": ["14", "15", "16"],
      "reason": "scram-sha-256 auth required from PostgreSQL 14+" }
  ]
}
```

No code change needed. The lookup is data-driven by design.

## Run tests

```bash
npx turbo test                         # all packages
npm test --workspace @neat.is/types       # one package
npm run build --workspace @neat.is/core   # build only one
```

`@neat.is/mcp` and `@neat.is/web` use `vitest run --passWithNoTests` until real test files land.

## Smoke-test the MCP server

```bash
npm run build --workspace @neat.is/mcp

(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'; sleep 1) \
  | node packages/mcp/dist/index.cjs
```

You should see two JSON-RPC responses: `serverInfo` from `initialize`, then a tool list with all sixteen tools (ten read + six `/neat extend`).

## Enable OTLP/gRPC ingest

Most NEAT installs land OTLP traffic over HTTP/JSON on `:4318`. If your collector or SDK exports over gRPC instead, flip the gRPC receiver on:

```bash
NEAT_SCAN_PATH=./demo \
  NEAT_OTLP_GRPC=true \
  npm run dev --workspace @neat.is/core
# → http://localhost:8080  (REST API)
# → http://localhost:4318  (OTLP/HTTP)
# → 0.0.0.0:4317           (OTLP/gRPC)
```

`NEAT_OTLP_GRPC_PORT` overrides the default `:4317`. The HTTP receiver always stays on; gRPC is purely additive. Both transports go through the same `parseOtlpRequest` decoder so a span looks identical to ingest no matter which transport delivered it.

## Common failure modes

- **`tsup` build fails with `Cannot find module '.../packages/<pkg>/node_modules/tsup/dist/cli-default.js'`** — leftover per-package node_modules from a different package manager. Wipe and reinstall (see "First-time setup").
- **`npx turbo build` says `Could not resolve workspaces. Missing packageManager field in package.json`** — the root `package.json` lost its `"packageManager": "npm@x.y.z"` line. Turbo 2.x requires it.
- **README CI badge 404s** — the workflow path changed. The badge URL must match `/.github/workflows/<file>.yml`.
- **`npm install` adds 80 packages out of nowhere** — someone added `demo/*` back into root `workspaces` before M2 is ready. Drop it again until `docker-compose.demo.yml` actually launches the services.

## Publishing to npm

CI does the publish on tag push. From a clean working tree on `main`:

```bash
# Bump versions across all five publishable packages, then:
git commit -am "Bump to X.Y.Z" && git push origin main
git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
gh run watch --repo NEAT-Technologies/Neat
```

`.github/workflows/publish.yml` handles the rest. Local fallback: `bash scripts/publish.sh` (or `--dry-run` to simulate).

Full process + troubleshooting tree: [`runbook-publish.md`](./runbook-publish.md).

## Branch / commit / PR flow

- One issue → one branch `<num>-<slug>` → one PR.
- `Refs #N` in the PR body, not `Closes #N`. User closes issues manually after verifying.
- No `Co-Authored-By: Claude` trailers.
- Plain-English commit messages — colleague tone, not release notes.

## Milestone end-of-session checklist

1. Update `docs/milestones.md` — flip status, tick verification boxes, add date.
2. Add an ADR to `docs/decisions.md` for any decision that wasn't already there.
3. Make sure `CLAUDE.md` references are still accurate.
4. Open PRs ready for human review — don't merge automatically.
