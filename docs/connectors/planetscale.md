# PlanetScale connector

Governed by [`../contracts/connectors.md`](../contracts/connectors.md) (ADR-124) and
[`../contracts/connector-config.md`](../contracts/connector-config.md) (ADR-130). Decision:
[ADR-175](../decisions.md#adr-175--the-planetscale-connector-reads-query-insights-and-fuses-onto-table-grain).

PlanetScale is a hosted MySQL/Vitess platform that runs its own per-query telemetry — **Query
Insights** — independent of whether the application is OTel-instrumented. This connector pulls
that telemetry and fuses per-table query stats onto the `sql-table` nodes the static SQL/ORM
extractor already builds. It is the data-grain sibling of the [Neon](./neon.md) and
[Supabase](./supabase.md) connectors, and simpler than both.

## Why simpler than Neon/Supabase

Neon and Supabase read `pg_stat_statements`, which forces two fragile steps this connector
skips because the Insights API does them server-side:

- **No FROM-clause regex.** Each query object carries a `tables` array PlanetScale already
  parsed. One `ObservedSignal` is emitted per table name — a multi-table query genuinely
  touched each table, so it fans out. `qualified_tables` (`keyspace.table`) is the fallback
  fusion key when `tables` is bare.
- **No cumulative-delta bookkeeping.** `query_count` is windowed to the poll interval, not a
  lifetime counter. The connector passes the poll window (`from` = the last high-water mark
  from `since`, `to` = now) and reads `query_count` directly as the count for the tick. There
  is no baseline, no first-poll-emits-nothing, no reset detection.

## Poll

```
GET https://api.planetscale.com/v1/organizations/{org}/databases/{db}/branches/{branch}/insights
    ?from=<ISO8601>&to=<ISO8601>&per_page=100&page=<n>
```

Paginated by `page`/`per_page`, always bounded by the `[from, to]` poll window — never an
unbounded full-history read. `from` is the connector's own high-water mark (`since`) capped by
a conservative 24h max lookback for a first poll or a wide gap; the walk follows `next_page`
up to a bounded page cap so a busy branch stays bounded per tick.

`(organization, database, branch)` is resolved **once** at connector setup (like Railway's
`(environmentId, serviceId)`), never re-derived from an API response at poll time.

### Fields read from each `data[]` query object

| Insights field | ObservedSignal | Notes |
|---|---|---|
| `tables` (array) | `targetName` (one signal each) | the fusion key; `qualified_tables` is the fallback |
| `query_count` | `callCount` | windowed count, read directly |
| `error_count` | `errorCount` | a real per-window failure signal the `pg_stat_statements` path has none of |
| `last_run_at` | `lastObservedIso` | the provider's own event time, never poll-arrival time |
| `keyspace`, `normalized_sql` | — | carried in the raw row for diagnostics; `normalized_sql` is **not** parsed (table grain only) |

## Credential

A PlanetScale **service token**, least-privilege scoped to **`read_database`** on the specific
database — read-only, grantable per database, the narrowest grant PlanetScale's auth model
offers (planetscale.com/docs/api/reference/service-tokens). This satisfies the hosted-profile
least-privilege requirement (`connectors.md` §3) directly.

The token is two parts, carried as a multi-field credential:

```jsonc
"credential": { "serviceTokenId": "$PLANETSCALE_TOKEN_ID", "serviceToken": "$PLANETSCALE_TOKEN" }
```

**The auth header is NOT a Bearer token.** PlanetScale service tokens authenticate with
`Authorization: <SERVICE_TOKEN_ID>:<SERVICE_TOKEN>` — the token id, a colon, then the token.
Both parts are read from `ConnectorContext.credentials` at poll time, never logged, never
written into a node or edge (`connectors.md` §6).

## Options

```jsonc
"options": {
  "organization": "my-org",
  "database": "my-db",
  "branch": "main",
  "serviceName": "api",        // the NEAT manifest service the signals fuse onto
  "perPage": 100,              // optional
  "maxPages": 20,              // optional
  "maxLookbackMs": 86400000    // optional; conservative 24h default
}
```

## Fusion

`targetKind = 'sql-table'`, `targetName = <table>`. `resolveTarget` prefers the existing
`infraId('sql-table', table)` node the static SQL/ORM extractor already minted from application
code, and mints an OBSERVED `CALLS` edge onto it. That is the exact id the Neon and Supabase
table-grain connectors resolve onto and the id the SQLAlchemy / Django / Drizzle / Prisma table
extractors build, so:

- the edge **sharpens to file grain automatically** wherever that table node carries a real
  file:line static call site — the shared pipeline attributes the observation to the single
  file that statically calls the table (ADR-124's compounding payoff, no connector-side change),
- when several files call the table, or none, it stays service-coarse, honestly — never a guess.

**Honest miss.** When no `sql-table` node exists yet — the static extractor hasn't run against
this code, or doesn't parse the shape — the connector does **not** fabricate a table. It falls
back to a provider-level `planetscale-database` InfraNode (`connectors.md` §4a's declared
`ensureInfraNode` fallback, the same shape Cloud Run's `cloud-run-service` fallback uses), so
production traffic on an un-extracted table surfaces as a `missing-extracted` divergence rather
than a silent drop. A future PlanetScale schema extractor that mints the `sql-table` node makes
these edges sharpen onto it with no change here.

The connector has no mutation authority (ADR-030): `resolveTarget` only names ids and declares
the fallback; every node/edge write flows through the shared pipeline's ingest primitives.

## Honest ceiling — table grain

Insights aggregates per query fingerprint, so there is **no row or column grain** to emit, and
file grain appears only transitively (via the resolved table node's own call site). Unlike
Neon/Supabase this connector does not parse columns off the SQL — it stays at table grain by
design.

Like Neon (`connectors.md` §7's bounded exception), an Insights row is an aggregate counter
snapshot, not an individual invocation record, so the mapping layer emits only the counter
`ObservedSignal` and **no `LogEntry`** — synthesizing per-event log lines from a windowed
fingerprint aggregate would fabricate events that never individually existed.

## What is verified

PlanetScale is a paid product with no free tier, so this connector was built against the public
API reference (planetscale.com/docs/api/reference/list_branch_queries;
planetscale.com/changelog/query-insights-api-endpoints;
planetscale.com/docs/api/reference/service-tokens), **not** a live authenticated branch. Two
things must get the confirm-the-response-not-the-pitch treatment (ADR-150, ADR-152) against a
real `read_database` token before this connector is trusted in production:

1. **The exact response shape** — that `tables` / `qualified_tables` / `query_count` /
   `error_count` / `last_run_at` are present and named as documented, and that pagination
   follows `next_page`. Where the real layout differs, the mapping layer drops the row honestly
   rather than guessing.
2. **The auth header form** — the auto-generated API reference renders a generic
   `Authorization: Bearer {token}` example for its OAuth2 flow, while PlanetScale's service-token
   documentation specifies the `id:token` form this connector sends. If a live token proves the
   Bearer form is required for service tokens too, only `planetscaleAuthHeader` (one function in
   `types.ts`) changes.
