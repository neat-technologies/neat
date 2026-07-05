// Supabase connector — provider-specific types (docs/connectors/supabase.md,
// ADR-124). First connectors-plane provider; the shared pull/map/fuse
// scaffold (connectors/index.ts) and the three sibling providers (Railway,
// Firebase, Cloudflare) already landed on main — this module follows their
// fetch/map/resolve split.
//
// Scope per supabase.md: Supabase Cloud only, two surfaces —
//   1. the Management API's log-query endpoint over edge_logs (table/RPC
//      grain from the REST request path, both credential profiles)
//   2. a direct, read-only Postgres connection reading pg_stat_statements
//      (local profile from day one; hosted is a fast-follow pending a
//      customer-provisioned least-privilege role — supabase.md §Scope)
//
// Every field name below was confirmed against Supabase's own live docs
// during this connector's build, not recalled from training data:
//   - endpoint + request/response envelope (GET, not POST — confirmed
//     against the live OpenAPI spec at https://api.supabase.com/api/v1-json,
//     operationId `v1-get-project-logs-all`, `deprecated: true` but still the
//     documented and currently-working surface): query params `sql` /
//     `iso_timestamp_start` / `iso_timestamp_end`, response `{ result, error }`
//   - edge_logs row shape (`metadata[].request.{method,path}`,
//     `metadata[].response.status_code`): supabase.com/docs/guides/telemetry/logs,
//     .../advanced-log-filtering, and
//     .../troubleshooting/discovering-and-interpreting-api-errors-in-the-logs-7xREI9
//     (all fetched during this build — each shows a worked `cross join
//     unnest(...)` query selecting exactly these fields)
//   - 24h window cap + 1000-row cap: the logs guide's own "LIMIT and result
//     row limitations" section ("a maximum of 1000 rows per run") and the
//     OpenAPI description's "timestamp range must be no more than 24 hours"
//   - pg_stat_statements column names: postgresql.org/docs/current/pgstatstatements.html
// Anything not directly confirmed by those pages is flagged inline as
// needs-endpoint-testing, the same discipline railway/types.ts uses.

/**
 * `ConnectorContext.credentials` shape for this provider. Both fields are
 * genuine secrets (contracts.md §6 — never logged, never written to a node
 * or edge, never reaches the snapshot):
 *
 * - `managementToken` — a bearer token for the Management API's log-query
 *   surface. The connector doesn't need to know which kind: a developer's own
 *   personal access token (`sbp_...`) locally, or an OAuth-app token scoped to
 *   `analytics:read` for the hosted profile (confirmed as the real scope name
 *   on the live OpenAPI spec's `x-oauth-scope` field for this endpoint).
 * - `postgresConnectionString` — optional. Present only when this connector
 *   instance should also poll pg_stat_statements (the local profile, which
 *   already holds a full database credential for its own project). Its
 *   absence is exactly how the hosted profile's "log-surface-only" first cut
 *   (supabase.md §Scope) falls out of this same code path, with no
 *   profile-conditional branch in the connector logic itself (connectors.md
 *   §3 — profile changes credential source, never pull/map/fuse logic).
 */
export interface SupabaseCredentials {
  managementToken: string
  postgresConnectionString?: string
}

export function readSupabaseCredentials(raw: Record<string, unknown>): SupabaseCredentials {
  const managementToken = raw['managementToken']
  if (typeof managementToken !== 'string' || managementToken.length === 0) {
    throw new Error('supabase connector: credentials.managementToken must be a non-empty string')
  }
  const postgresConnectionString = raw['postgresConnectionString']
  if (
    postgresConnectionString !== undefined &&
    (typeof postgresConnectionString !== 'string' || postgresConnectionString.length === 0)
  ) {
    throw new Error(
      'supabase connector: credentials.postgresConnectionString must be a non-empty string when present',
    )
  }
  return {
    managementToken,
    ...(postgresConnectionString ? { postgresConnectionString } : {}),
  }
}

/**
 * Config resolved once at connector setup (never re-derived from a response
 * at poll time, the same "resolved once, never guessed" discipline ADR-127
 * states for Railway's serviceNameById).
 */
export interface SupabaseConnectorConfig {
  // The real Supabase project ref — a 20-character lowercase string
  // (confirmed against the live OpenAPI path-parameter schema:
  // `minLength: 20, maxLength: 20, pattern: "^[a-z]+$"`) — used as the `{ref}`
  // path segment calling the Management API. This is NOT necessarily the same
  // string as `nodeRef` below; see that field's own doc comment for why the
  // two are kept separate.
  apiProjectRef: string
  // The exact node-identity token this project resolves to under
  // `extract/calls/supabase.ts`'s own scheme (supabase.md §Fusion): either
  // the literal `*.supabase.co` host from a `createClient(...)` call
  // (`"<apiProjectRef>.supabase.co"` in the common case, since a Supabase
  // project's URL is always that shape) or the literal string `'env'` when
  // the app's code passes a non-literal URL (`process.env.SUPABASE_URL`).
  // Kept as an explicit, separate field — never derived by string-
  // concatenating `apiProjectRef` + `.supabase.co` here — because that
  // derivation would silently be wrong for the (very common) env-driven case,
  // and this identity has to match the extractor's own resolution exactly or
  // fusion never lands (identity.md — ids constructed via the shared
  // `infraId` helper, never guessed at by a second producer).
  nodeRef: string
  // The NEAT manifest service name this connector's signals attribute the
  // OBSERVED CALLS edge's source to. Supabase's own telemetry carries no
  // caller-service dimension at all on either surface (both are project- or
  // database-scoped, not per-caller), unlike Railway's per-service httpLogs
  // or Firebase's per-resource Cloud Logging entries — so there is no signal
  // to map from; this is supplied once, honestly, rather than guessed.
  serviceName: string
  // Management API base URL override, for tests. Defaults to the real host.
  managementApiUrl?: string
  // Cap on how far an absent `since` (or a gap wider than this window, e.g. a
  // laptop off for a week) backfills, ms. Hard-capped at 24h regardless of
  // this value — the Management API's own documented maximum query window
  // (supabase.md §Surfaces, confirmed against the live OpenAPI description
  // above) — a caller passing a larger value here still only ever gets a
  // last-24h query.
  maxLookbackMs?: number
  // Rows requested per log query. Defaults to 1000, the Logs Explorer's own
  // documented per-run maximum (see this file's header) — raising this above
  // 1000 has no effect since the provider caps it there regardless.
  logLimit?: number
  // Max pg_stat_statements rows read per poll (surface 2), ordered by `calls`
  // descending so the busiest statements are never starved by an unbounded
  // table falling off a smaller cap. A defensive bound, not a documented
  // Postgres limit — pg_stat_statements can grow to `pg_stat_statements.max`
  // (default 5000) distinct statements on a busy project.
  statementLimit?: number
}

// ── Surface 1: Management API log query ────────────────────────────────────

// AnalyticsResponse per the live OpenAPI spec's `components.schemas` — `result`
// is typed `array of {}` there (an intentionally untyped passthrough of
// whatever the underlying query returns); the concrete row shape below is
// this connector's own SQL's flat projection (see client.ts's query string),
// not the full nested `edge_logs` row.
export interface SupabaseLogsAllResponse {
  result?: SupabaseEdgeLogRow[]
  error?:
    | string
    | {
        code: number
        message: string
        status: string
        errors: { domain: string; location: string; locationType: string; message: string; reason: string }[]
      }
}

/**
 * One row of this connector's own flat SQL projection over `edge_logs`
 * (client.ts) — not the raw nested log row Supabase stores (which nests
 * `request`/`response` inside a repeated `metadata` field, requiring
 * `cross join unnest(...)` to reach). `timestamp` is formatted to a strict
 * ISO8601 UTC string inside the SQL itself (`FORMAT_TIMESTAMP(...)`) so this
 * connector never has to guess a timezone client-side.
 *
 * needs-endpoint-testing: Supabase's own docs (surfaced during this build)
 * disagree with themselves on the query dialect this endpoint accepts —
 * every worked example on supabase.com/docs uses BigQuery syntax
 * (`cross join unnest`, `regexp_contains`, `cast(... as datetime)`), which is
 * what the query in client.ts is written in, but at least one indexed source
 * describes this endpoint as running "ClickHouse SQL" instead. Both dialects
 * support `cross join unnest`-style array flattening, but the exact function
 * names (`FORMAT_TIMESTAMP` vs a ClickHouse equivalent) could differ. Build
 * this against a live Supabase project before treating the query string as
 * locked, exactly as railway/types.ts's own needs-endpoint-testing notes ask
 * for every other unconfirmed surface in this codebase.
 */
export interface SupabaseEdgeLogRow {
  timestamp: string
  method: string
  path: string
  status_code: number
}

// ── Surface 2: pg_stat_statements ───────────────────────────────────────────

/**
 * One row of `pg_stat_statements`, the subset this connector reads
 * (postgresql.org/docs/current/pgstatstatements.html, Table F.22). Reading
 * `query`/`queryid` for statements another role executed requires the
 * connecting role to hold `pg_read_all_stats` or superuser — exactly the
 * built-in role supabase.md §Surfaces names as available on every Supabase
 * Cloud project without needing `service_role` or the project's admin
 * `postgres` role.
 *
 * `queryid`, `calls`, and `rows` are Postgres `bigint` columns; node-postgres
 * returns `bigint` as a JS `string` by default (no custom type parser
 * configured here) to avoid silent precision loss on values past
 * `Number.MAX_SAFE_INTEGER` — map.ts's diffing logic accounts for this.
 * `total_exec_time` is `double precision`, which node-postgres does return as
 * a native JS `number`.
 */
export interface PgStatStatementsRow {
  queryid: string
  query: string
  calls: string
  total_exec_time: number
  rows: string
}

// Provider vocabulary for ObservedSignal.targetKind/targetName (connectors.md
// §1 — "the provider's own vocabulary"; only this connector's own map.ts /
// resolve.ts ever interpret these strings). Matches the `infraId` kind
// literals ADR-124 §5 specifies for Supabase sub-resources.
export const SUPABASE_TABLE_TARGET_KIND = 'supabase-table'
export const SUPABASE_RPC_TARGET_KIND = 'supabase-rpc'
