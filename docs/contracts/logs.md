---
name: logs
description: One unified logs surface — native OTLP logs signal (structured-logger output, no bare console.log capture) and connector-sourced OCloud logs (Supabase/Railway/Firebase/Cloudflare/Vercel), merged into one bounded per-project, per-source ring buffer. One REST endpoint (GET /logs) is the single data path every consumer (MCP get_logs, CLI neat logs, the frontend Logs page) reads through, filtered by the same source/service/limit/since params everywhere.
governs:
  - "packages/core/src/otel-logs.ts"
  - "packages/core/src/logs-store.ts"
  - "packages/core/src/api.ts"
  - "packages/mcp/src/**"
  - "packages/core/src/cli.ts"
adr: [ADR-132]
enforcement: [review]
---

# Logs contract

Sibling to [`otel-ingest.md`](./otel-ingest.md) (owns the native-logs receiver half) and [`connectors.md`](./connectors.md) (owns the OCloud-logs half). This contract is the third piece: where both halves land, and the one surface every reader — REST, MCP, CLI, frontend — reads through.

## 1. `LogEntry` is the one shape every source produces

```ts
interface LogEntry {
  id: string
  projectName: string
  source: 'native' | 'supabase' | 'railway' | 'firebase' | 'cloudflare' | 'vercel'
  serviceName?: string
  nodeId?: string
  timestamp: string        // ISO8601, the event's own time — never ingest/poll time
  severity?: string        // normalized: 'debug' | 'info' | 'warn' | 'error'
  message: string
  attributes?: Record<string, unknown>
}
```

`source` is extensible — a future connector provider adds its own string, same as the provider dispatch table in `connector-config.md` grows one entry per provider.

## 2. Native logs come from a real OTLP logs receiver, not a span derivation

`packages/core/src/otel-logs.ts` accepts `/v1/logs` (JSON + protobuf), the same non-blocking-receiver and bearer-token discipline `otel-ingest.md` states for `/v1/traces`. Full rationale and the installer-wiring implications (a logs-export counterpart to the four-deps invariant, log-library auto-instrumentation, the stated no-bare-`console.log`-capture limitation) live in `otel-ingest.md`'s own amendment for this ADR — this contract only names the receiver's existence and its role as one of the two `LogEntry` producers.

## 3. OCloud logs come from the same connector mapping layer that already produces `ObservedSignal`s

Each connector's `map.ts` emits a `LogEntry` (tagged with its own `source`) alongside the `ObservedSignal` it already produces for the graph — an addition, not a replacement. `poll()`'s signature and existing signal-mapping tests are unaffected. Full rationale lives in `connectors.md`'s own amendment for this ADR.

## 4. One bounded, per-project, per-source ring buffer — never unbounded

`packages/core/src/logs-store.ts` holds entries in memory, capped per `(project, source)` pair (default: last 1,000 entries or 24h, whichever is smaller) so one noisy source can never evict another's entries. No ndjson sidecar, no retention/rotation policy — a daemon restart loses the buffer, the same trade-off NEAT already accepts for the in-memory graph between snapshots. This is a deliberate scope boundary: NEAT is not becoming a log-aggregation platform.

## 5. One REST endpoint is the only data path

`GET /logs` / `GET /projects/:project/logs` (dual-mount per ADR-026), query params `source` (repeatable), `service`, `limit` (capped), `since`. Envelope per ADR-061: `{ count, total, logs: [...] }`. No consumer below reads `logs-store.ts` directly — MCP, CLI, and the frontend all call this endpoint.

## 6. MCP `get_logs`, CLI `neat logs`, and the frontend's filter chips all set the identical query parameters

`get_logs(source?, service?, limit?, since?)` is how an agent scopes a read to one provider — a parameter on a read-only tool call, not a stored, mutated, cross-surface filter state. `neat logs [--source <name>] [--service <name>] [--limit N] [--since <date>]` mirrors it at the terminal (the CLI's eleventh verb, per ADR-132/`cli-surface.md`'s successor-ADR allowance). The frontend's Logs page filter UI sets the same `source` param against the same endpoint. All three are thin clients over one data path — none of them talk to each other or to a shared filter-state store.

## Authority

`otel-logs.ts` and `logs-store.ts` own ingestion and storage. `api.ts` owns the REST endpoint. `packages/mcp/src/` owns `get_logs`. `cli.ts` owns `neat logs`. `packages/web/` owns the Logs page. No module bypasses the REST endpoint to read the store directly.

## Enforcement

`enforcement: [review]` — no code has landed yet (this contract lands with ADR-132, ahead of implementation). Once built, a `contracts.test.ts` assertion should check: the per-`(project, source)` cap is actually enforced (a burst from one source never evicts another's entries), the REST envelope shape (`{ count, total, logs }`), and that MCP/CLI both call the REST endpoint rather than importing `logs-store.ts` directly. At that point this contract's enforcement tag moves to `[lint, review]`, the same graduation `connectors.md` took once its scaffold shipped.

Full rationale: [ADR-132](../decisions.md#adr-132--a-unified-logs-surface-native-otlp-logs-signal--connector-log-retention-one-bounded-store-filterable-by-source).
