# Supabase connector

First implementation of the [connectors plane](./README.md) (ADR-124). Pulls Supabase's own
server-side telemetry and mints OBSERVED edges fused onto the `supabase-js` static call sites
`packages/core/src/extract/calls/supabase.ts` recognizes, at file grain — no app
instrumentation required.

## Scope for this cut

- **Target: Supabase Cloud only.** Self-hosted Supabase runs no Management API and no OAuth
  apps, so the primary surface below doesn't exist there; the connector's provider interface
  doesn't yet branch on target flavor. Self-hosted support is a near-free fast-follow once
  the direct-Postgres reader below exists — the same `pg_stat_statements` query works
  unchanged against a self-hosted connection string; the fast-follow is wiring it in for
  hosted-profile use, not building new plumbing.
- **Hosted profile ships log-surface-only.** Supabase's OAuth Apps give a genuinely scoped,
  revocable read grant over the Management API (§Surfaces below), but Supabase's own docs
  state an OAuth token cannot substitute for a database password — reading
  `pg_stat_statements` always requires a Postgres credential the customer either hands over
  directly or self-provisions via SQL. Neither is a narrow-enough grant for hosted
  infrastructure to hold on a customer's behalf as a day-one default. The hosted profile's
  first cut therefore runs on the Management API log surface only; a customer-provisioned
  least-privilege Postgres role (`CREATE ROLE ...; GRANT pg_read_all_stats TO ...;`, brokered
  connection string) is a fast-follow, not a blocker for the first hosted release. The local
  profile isn't affected — a developer already holds full DB credentials for their own
  project, so it gets both surfaces from day one.

## Surfaces used

### 1. Management API log query (both profiles, Cloud target)

`POST https://api.supabase.com/v1/projects/{ref}/analytics/endpoints/logs.all` runs a
BigQuery-backed query over `edge_logs`. The request path carries the table/RPC/route the
call hit — `/rest/v1/orders` → table `orders`, `/rest/v1/rpc/get_totals` → RPC `get_totals`
— which is the grain this connector needs. Constraints the poller must respect: max 24h
window per query, no `SELECT *`/subqueries/`JOIN`, 1000-row cap, an open bug where
`function_logs` queries beyond 48h silently no-op (irrelevant here since this cut doesn't
query `function_logs`).

- **Local profile auth:** the developer's own personal access token (`sbp_...`).
- **Hosted profile auth:** an OAuth App token scoped to the `Analytics: Read` (or nearest
  available) scope for the customer's project — confirm the exact scope name against the
  live OAuth-scopes list before wiring the broker, since the scope taxonomy may have moved
  since this was surveyed.
- **Poll cadence:** local — on daemon tick / `neat sync`, querying since the last high-water
  mark capped at 24h lookback. Hosted — fixed interval, candidate 5 minutes (Logflare
  ingest lag order of magnitude); confirm against a live rate-limit test before locking this
  in, since the documented rate limit for this specific endpoint is unconfirmed.

### 2. `pg_stat_statements` / `pg_stat_user_tables` direct read (local profile; hosted fast-follow)

Enabled by default on every Supabase Cloud project. A role carrying Postgres's built-in
`pg_read_all_stats` can read query text, queryid, call count, and per-table stats without
`service_role` or the project's admin `postgres` role. Local profile: the developer's own
connection string already has (or can trivially be granted) this access. Hosted profile
fast-follow: broker a customer-provisioned `neat_reader` role's connection string, never the
account `postgres` role's.

## Fusion — node identity

Both the static extractor and this connector resolve a Supabase project the same way the
extractor already does today: the literal `*.supabase.co` host from the `createClient(...)`
call, or the `env` sentinel when the URL isn't a literal. Sub-resource nodes extend the
existing `infraId` pattern (the same one `extract/calls/kafka.ts` uses for topics):

```
infraId('supabase-table', `${projectRef}/${table}`)  → infra:supabase-table:<ref>/<table>
infraId('supabase-rpc',   `${projectRef}/${fn}`)      → infra:supabase-rpc:<ref>/<fn>
```

Edge type is `CALLS`, minted the same way `kafka.ts` mints `PUBLISHES_TO`/`CONSUMES_FROM` —
file-grained when a static call site resolves (`.from('orders')` at a known `file:line`),
service-level when it doesn't (the extractor punch-list below is exactly the gap between
those two cases). No new `NodeType`; this is additive schema growth the same way GraphQL
operations and gRPC methods were (ADR-031).

## Static extractor gap this connector exposes

`extract/calls/supabase.ts` today recognizes only the client-construction call
(`createClient`/`createServerClient`/`createBrowserClient`) — it does not parse `.from()`,
`.rpc()`, `.storage`, `.auth`, `.channel()`, or `.functions.invoke()`. Every table/RPC-grain
OBSERVED edge this connector mints will therefore land service-level, not file-grained, until
the extractor grows call-site parsing for at least `.from()` and `.rpc()` (the two shapes
this connector's v1 surfaces cover). That gap is itself a missing-extracted divergence the
graph should surface honestly, not something this connector works around — the fusion payoff
compounds once a follow-up issue extends the extractor to match.

## Out of scope for this cut

Storage/Auth/Edge-Functions call grain (needs `storage_logs`/`auth_logs`/`function_*_logs`,
none wired yet), Realtime (no surveyed telemetry surface carries per-channel/per-message
signal — `realtime_logs` is connection-level only), the Metrics API (aggregate-only, no
per-table or per-endpoint breakdown), and native OTel export (nothing Supabase ships today
covers traces or metrics, only a Pro-gated log sink).
