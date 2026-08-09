// PlanetScale connector — provider-specific types (docs/connectors/planetscale.md,
// ADR-175). PlanetScale is a hosted MySQL/Vitess platform that runs its own
// query telemetry (Query Insights), so like Neon (ADR-156) it is a data-grain
// connector: the signal fuses onto the `sql-table` nodes the static SQL/ORM
// extractor already builds. It is *simpler* than Neon's `pg_stat_statements`
// path in two ways the Insights API hands us for free:
//
//   - tables come already parsed (the `tables` array), so there is no
//     FROM-clause regex, and
//   - counts are windowed to the poll interval (`query_count` is the count
//     over `[from, to]`), so there is no cumulative-counter delta bookkeeping.
//
// Surface + field names are sourced from PlanetScale's public API reference
// (planetscale.com/docs/api/reference/list_branch_queries;
// planetscale.com/changelog/query-insights-api-endpoints), not from a live
// authenticated introspection — PlanetScale is a paid product with no free
// tier, so this connector carries no live account to probe against. Where the
// real response layout differs from the documented one, the mapping layer
// (map.ts) drops the row honestly rather than guessing. See
// docs/connectors/planetscale.md §"What is verified" for exactly what remains
// unconfirmed pending a real branch.

export const PLANETSCALE_SQL_TABLE_TARGET_KIND = 'sql-table'

/**
 * Config resolved once at connector setup (docs/connectors/planetscale.md
 * §Fusion, "resolved once, never guessed") — the `(organization, database,
 * branch)` triple that scopes the Insights query, plus the NEAT service the
 * signals fuse onto. Never re-derived from a PlanetScale API response at poll
 * time, the same way Railway resolves `(environmentId, serviceId)` once.
 */
export interface PlanetscaleConnectorConfig {
  // PlanetScale's REST API base. Defaults to the public API
  // (planetscale.com/docs/api); overridable for tests and any proxy.
  apiUrl?: string
  // The PlanetScale organization slug the Insights path is scoped to.
  organization: string
  // The PlanetScale database the Insights path is scoped to. Also this
  // connector's rate-limit bucket key (ADR-131), the closest thing
  // PlanetScale's config carries to "one customer's account".
  database: string
  // The database branch whose Insights this connector polls (e.g. `main`).
  branch: string
  // The NEAT manifest service name this connector fuses onto — the name that
  // owns the `sql-table` nodes a query row lands on. Supplied once at
  // connector setup; never inferred from a PlanetScale API response.
  serviceName: string
  // Rows requested per page. Insights paginates `page`/`per_page`; 100 keeps a
  // busy branch's window bounded per tick without over-fetching.
  perPage?: number
  // Bounded number of pages to follow per poll — Insights paginates by
  // `next_page`, so an unbounded follow could walk the whole window on a busy
  // branch. Capped so a single tick stays bounded (connectors.md §"Poll
  // cadence and backfill").
  maxPages?: number
  // Bounded lookback cap in ms for a first poll (no prior `since`) or a gap
  // wider than this window. PlanetScale's Insights retention isn't published
  // as a single number; 24h is a conservative chosen default, not a
  // provider-confirmed value — overridable once a live branch confirms the
  // real window.
  maxLookbackMs?: number
}

// ── credential ──────────────────────────────────────────────────────────────
//
// A PlanetScale service token is two parts: an id and the secret itself. The
// least-privilege grant is a per-database `read_database` scope, read-only
// (planetscale.com/docs/api/reference/service-tokens). Both parts are read
// from `ConnectorContext.credentials` at poll time, never logged, never
// written into a node or edge (connectors.md §6).
export interface PlanetscaleCredentials {
  serviceTokenId: string
  serviceToken: string
}

export function readPlanetscaleCredentials(input: Record<string, unknown>): PlanetscaleCredentials {
  const serviceTokenId = input.serviceTokenId
  const serviceToken = input.serviceToken
  if (typeof serviceTokenId !== 'string' || serviceTokenId.length === 0) {
    throw new Error('planetscale connector: credentials.serviceTokenId is required')
  }
  if (typeof serviceToken !== 'string' || serviceToken.length === 0) {
    throw new Error('planetscale connector: credentials.serviceToken is required')
  }
  return { serviceTokenId, serviceToken }
}

/**
 * PlanetScale's service-token auth header is NOT a Bearer token — it is the
 * token id, a colon, then the token
 * (planetscale.com/docs/api/reference/service-tokens). This is the one place
 * that shape is constructed, shared between the poll path (client.ts) and the
 * add-time auth probe (registry.ts) so the two can't drift.
 *
 * (The auto-generated API reference renders a generic `Bearer {token}`
 * example for its OAuth2 flow; a service token uses this `id:token` form.
 * docs/connectors/planetscale.md §"What is verified" records that this is
 * taken from the docs, not confirmed against a live token.)
 */
export function planetscaleAuthHeader(
  serviceTokenId: string,
  serviceToken: string,
): { Authorization: string } {
  return { Authorization: `${serviceTokenId}:${serviceToken}` }
}

// ── raw provider response shapes ────────────────────────────────────────────
//
// One entry in the `data[]` array of a Query Insights response
// (planetscale.com/docs/api/reference/list_branch_queries). Only the fields
// this connector reads are typed; the response carries many more latency /
// bytes / shard metrics this connector ignores. Every field is optional here
// because the mapping layer treats a missing/garbage field as "drop this row
// honestly" rather than trusting the documented shape blindly.
export interface PlanetscaleInsightRow {
  // The tables this query fingerprint touched, already parsed by PlanetScale —
  // the fusion key. One ObservedSignal is emitted per name. A multi-table
  // query genuinely touched each table, so it fans out.
  tables?: string[]
  // Keyspace-qualified table names (`keyspace.table`) — the fallback fusion
  // key when `tables` is absent or empty.
  qualified_tables?: string[]
  // The keyspace this fingerprint ran in — disambiguates table identity across
  // keyspaces; carried for diagnostics.
  keyspace?: string
  // The normalized (literal-stripped) SQL — diagnostic only; this connector
  // does not parse it (Insights already parsed `tables`), and stays at table
  // grain (ADR-175 — no column grain).
  normalized_sql?: string
  // The number of times this fingerprint ran over the poll window → callCount.
  // Windowed, not cumulative — read directly, no baseline.
  query_count?: number
  // How many of those runs errored over the window → errorCount. A real
  // failure signal the pg_stat_statements path (Neon/Supabase) has none of.
  error_count?: number
  // PlanetScale's own last-run time for this fingerprint → lastObservedIso.
  // Provider event time, never poll-arrival time (README.md §Poll cadence).
  last_run_at?: string | null
}

/** One Query Insights response page. */
export interface PlanetscaleInsightsResponse {
  data?: PlanetscaleInsightRow[]
  // The next page number, or null on the last page — the pagination cursor
  // this connector follows up to `maxPages`.
  next_page?: number | null
  current_page?: number
}
