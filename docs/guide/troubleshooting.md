# Troubleshooting

The real failure modes, with the cause and the fix. Each one below is something that's actually bitten someone, not a hypothetical. If your symptom isn't here, the [API reference](../api-reference.md) documents every error envelope the daemon returns.

## No OBSERVED edges after running the app

You ran `npx neat.is`, started your app, exercised it — and the dashboard still shows only `EXTRACTED` edges. Nothing tagged `OBSERVED`.

**Most common cause: the OTel wire protocol.** The OpenTelemetry SDK defaults to `http/protobuf`. NEAT's generated instrumentation pins `http/json` so spans land on the receiver out of the box. But if you supply your *own* OTel config, it'll default back to protobuf, and the receiver mints nothing from traffic it can't decode.

```env
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
```

Set that in your app's environment and the spans start landing.

**Other causes, in order of likelihood:**

- **The app didn't actually start.** Instrumentation only produces data when the code runs. Confirm your service came up cleanly — a crash on boot emits no spans.
- **You didn't exercise the external-call paths.** A span fires when your code calls a database, queue, or external host. If you started the app but never hit an endpoint that makes those calls, there's nothing to observe. Click through a real flow.

Confirm spans are arriving at all by checking a node's runtime edges: `neat observed-dependencies <id>`. If it reports static dependencies but no observed ones and asks "is OTel running?", you're in this case.

## `npx neat.is` printed help instead of running

You ran `npx neat.is` from inside your project expecting it to go zero-to-graph, and it printed the usage screen instead.

**Cause:** you're on an older version. The one-command behavior — bare `npx neat.is` running the whole orchestrator — ships in `neat.is@0.4.16` and later. Earlier versions treated a bare invocation as "show help."

**Fix:** pull the current release.

```bash
npx neat.is@latest
```

## Daemon won't start / port in use

The daemon needs three ports: `:8080` (REST API), `:4318` (OTLP receiver), and `:6328` (dashboard). If one's already held, the daemon can't bind it, and `neat <path>` exits with code 3.

**Fix:** free the port, or point NEAT at a different one. Each is independently overridable:

```bash
PORT=9090 OTEL_PORT=4319 NEAT_WEB_PORT=6329 npx neat.is
```

`PORT` moves the REST API, `OTEL_PORT` moves the OTLP receiver, `NEAT_WEB_PORT` moves the dashboard. If you override the REST port, remember the query verbs look for the daemon at `http://localhost:8080` by default — set `NEAT_API_URL` to match.

## Stale registry lock

A previous daemon died without cleaning up, and now `neat init` reports that the registry is locked by another process.

**Cause:** NEAT guards `~/.neat/projects.json` with a lock file so two daemons don't write it at once. If the holder crashed, the lock can outlive it.

**Fix:** check whether the reported PID is actually alive. If it's dead, the lock is stale — remove it.

```bash
rm ~/.neat/projects.json.lock
```

Only do this once you've confirmed no live daemon holds the lock; removing it out from under a running process is how you get a corrupted registry.

## Dashboard shows the graph but never updates live

The dashboard drew your graph fine on first load, but as you keep exercising the app, nothing new appears.

**Cause, and a known limitation:** the daemon pushes updates to the dashboard over SSE, but only for *genuinely new* nodes and edges. When traffic re-drives an edge that already exists — say the same `CALLS` edge fires again and its `callCount` ticks up — that update doesn't push today. The edge is already on the graph; only its counter moved, and a counter bump isn't streamed.

So a quiet dashboard during steady traffic over known paths is expected. To confirm the data is in fact updating, query it directly: `neat observed-dependencies <id>` shows the live `callCount` and `lastObserved`, refreshed on every call. New edges and new nodes *do* stream and will appear without a refresh.

## Observed file paths look like `dist/...` not `src/...`

Your `OBSERVED` edges attribute calls to files under `dist/` (or `build/`) rather than the `src/` files you actually wrote.

**Cause:** source maps are absent. NEAT attributes a span back to the file and line that made the call, using whatever the runtime reports — which is the compiled output unless a source map exists to map it back to source. NEAT warns once per service when it can't reconcile to `src/`.

**Fix:** emit source maps from your build. In `tsconfig.json`:

```json
{
  "compilerOptions": {
    "sourceMap": true
  }
}
```

Rebuild, run again, and NEAT reconciles the observed edges to your `src/` files — which is what makes a file-level divergence land on the line you'd actually edit.

## Still stuck?

- The [getting-started](./getting-started.md) flow walks the happy path end to end — retrace it to find where yours diverges.
- The [API reference](../api-reference.md) documents the error envelope every endpoint returns, so a raw 4xx/5xx from a query verb is decodable.
- If you've found a genuine bug, open an issue at [NEAT-Technologies/Neat](https://github.com/NEAT-Technologies/Neat/issues).
