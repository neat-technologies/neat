// Railway connector — provider-specific types (docs/connectors/railway.md,
// ADR-127). Second connectors-plane provider after the Supabase scaffold
// (ADR-124); ADR-127's own scope note applies here too: Railway is SaaS-only,
// so there is no self-hosted-vs-Cloud branch to carry through these types the
// way a future Supabase self-hosted cut might need.

/**
 * Config resolved once at connector setup (docs/connectors/railway.md
 * §Fusion, "resolved once, never guessed") — never re-derived from a Railway
 * API response at poll time.
 */
export interface RailwayConnectorConfig {
  // Railway's GraphQL endpoint. Defaults to the public API
  // (docs.railway.com/integrations/api/graphql-overview confirms
  // `https://backboard.railway.com/graphql/v2`); overridable for tests and
  // any self-hosted proxy in front of it.
  apiUrl?: string
  // The Railway environment httpLogs/networkFlowLogs are scoped to — both
  // surfaces are environment-scoped per docs.railway.com/cli/logs (a
  // Project-Access-Token is itself minted per environment, not per account —
  // docs/connectors/railway.md §Scope).
  environmentId: string
  // The Railway serviceId this connector instance polls httpLogs for. Railway
  // names a service by its own GraphQL id, which carries no relationship to
  // NEAT's manifest-derived `serviceId(name)` (packages/types/src/identity.ts)
  // — the two are different naming authorities with no shared source of
  // truth (docs/connectors/railway.md §Fusion, "Service identity mapping").
  serviceId: string
  // Explicit map from a Railway serviceId — this connector's own `serviceId`
  // above, and any peer serviceId a networkFlowLogs record's `peerServiceId`
  // names — to the NEAT manifest service name that resolves `serviceId(name)`.
  // Supplied once at connector setup; never inferred or pattern-matched from
  // a Railway API response (docs/connectors/railway.md §Fusion).
  serviceNameById: Record<string, string>
  // Bounded lookback cap in ms for a first poll (no prior `since`) or a gap
  // wider than this window. Railway's docs don't publish a retention/lookback
  // cap for httpLogs/networkFlowLogs as of this writing
  // (docs/connectors/railway.md flags the neighbouring "plan-tier" question
  // the same way) — this is a conservative chosen default, not a
  // provider-confirmed value. Overridable once a live project confirms the
  // real window (docs/contracts/connectors.md §"Poll cadence and backfill").
  maxLookbackMs?: number
  // Max rows requested per query. Same "needs-endpoint-testing" caveat as
  // the lookback cap — Railway's own pagination shape for these two queries
  // isn't confirmed (docs/connectors/railway.md §1).
  limit?: number
}

// ── raw provider response shapes ────────────────────────────────────────────
//
// NEEDS-ENDPOINT-TESTING (docs/connectors/railway.md §1 / §2): the field
// names below are sourced from Railway's own published log-explorer
// attribute list (docs.railway.com/cli/logs — the `@method`/`@path`/...
// filter keys, confirmed to map 1:1 onto camelCase JSON field names the docs
// show verbatim), not from a live GraphQL schema introspection — this
// sandbox has no live Railway project/token to introspect against. Whether
// `httpLogs`/`networkFlowLogs` are literal top-level query names, or a
// filtered view over the confirmed `deploymentLogs`/`environmentLogs`
// queries, could not be confirmed without hitting `railway.com/graphiql`
// with a real token. Build this poller against a live Railway project before
// treating the shape below as locked, exactly as railway.md's own
// "needs-endpoint-testing" notes ask for every other unconfirmed surface.

/** One row of `httpLogs` — Railway's edge/ingress per-request record. */
export interface RailwayHttpLogEntry {
  timestamp: string
  method: string
  path: string
  httpStatus: number
  totalDuration: number
  requestId: string
  deploymentId: string
  edgeRegion: string
}

/** One row of `networkFlowLogs` — an L4 flow record between two services. */
export interface RailwayNetworkFlowLogEntry {
  timestamp: string
  // Null when the peer isn't another Railway service on the same project
  // (public internet egress, say) — dropped honestly rather than guessed
  // (docs/connectors/railway.md §Fusion).
  peerServiceId: string | null
  peerKind: string | null
  direction: string | null
  byteCount: number | null
  packetCount: number | null
  // Non-null names why a flow was dropped (Railway's `@drop_cause` /
  // `dropCause` field) — the closest signal networkFlowLogs carries to an
  // "error" on a connection with no HTTP status of its own.
  dropCause: string | null
}
