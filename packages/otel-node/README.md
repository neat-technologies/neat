# @neat.is/otel-node

Attaches NEAT's OpenTelemetry instrumentation to a Node app at process start, with no edit to the app's source (ADR-232).

It starts the OTel Node SDK with the standard auto-instrumentations and adds NEAT's call-site span processor, so each span carries `code.file.path`, `code.line.number` and `code.function.name`. NEAT uses those to fuse an `OBSERVED` span onto the exact symbol the static graph declares.

`neat init --apply` and the bare `npx neat.is` run add this package and write the preload into `.env.neat`. To attach it by hand:

```bash
# CommonJS app
NODE_OPTIONS="--require @neat.is/otel-node/register" node app.js

# ESM app — also installs the import-in-the-middle loader hook
NODE_OPTIONS="--import @neat.is/otel-node/register" node app.mjs
```

`NODE_OPTIONS` is read once at process start, so set it in the shell, the process manager, or the platform's environment before launching the app. Forked workers inherit it.

Exporter settings follow the standard `OTEL_*` variables. When no endpoint is set, the preload walks up from the working directory to the project's `neat-out/daemon.json` and sends spans to that daemon's OTLP port, scoped to its project, so each local project's app reaches its own daemon. Without a record it falls back to `http://localhost:4318/projects/$NEAT_PROJECT/v1/traces`. `NEAT_OTEL_TOKEN` becomes an `Authorization: Bearer` header, and the protocol defaults to `http/json`. An explicit `OTEL_EXPORTER_OTLP_*` setting always wins.

It also instruments [postgres.js](https://github.com/porsager/postgres) (the `postgres` package), which has no upstream OpenTelemetry instrumentation: one CLIENT span per executed query, with the statement, the database and the call site that built the query.

Libraries the auto-instrumentations bundle doesn't cover (Prisma, Nest 11) are named in `NEAT_OTEL_INSTRUMENTATIONS` as `<package>#<export>` pairs; the installer adds each package to the app and the preload loads them from the app's own `node_modules`.

If the OTel packages are missing or the SDK fails to start, the app keeps running and logs one `[neat]` warning; instrumentation never crashes the host process.
