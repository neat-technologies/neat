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
// Live-confirmed via schema introspection against backboard.railway.com/
// graphql/v2 (2026-07-08, issue #738): `httpLogs`/`networkFlowLogs` are
// literal top-level query names, as guessed. `HttpLog`'s field names matched
// the original doc-sourced guess exactly. `NetworkFlowLog` did not — see its
// own doc comment above. The bigger miss was the query *arguments*, not the
// row shape: `httpLogs` takes `deploymentId`, not `environmentId`/
// `serviceId` (client.ts resolves one fresh each poll), and
// `networkFlowLogs` takes no date/limit args at all. Which auth header these
// queries need depends on the token family: a project token uses Railway's
// dedicated `Project-Access-Token` header, an account/team token uses
// `Authorization: Bearer` (#868). client.ts resolves the working one per token
// on first use rather than assuming a single header for both families.

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

/**
 * One row of `networkFlowLogs` — an L4 flow record between two services.
 * Live-confirmed against `NetworkFlowLog` (2026-07-08): `peerKind`/
 * `direction`/`byteCount`/`packetCount` are non-null (the original guess had
 * them nullable); only `peerServiceId`/`dropCause` are ever absent. `timestamp`
 * isn't the row's real field name (aliased from `captureStart` in the query,
 * client.ts) but is kept as the type's field name so the rest of the
 * connector doesn't care about the alias.
 */
export interface RailwayNetworkFlowLogEntry {
  timestamp: string
  // Null when the peer isn't another Railway service on the same project
  // (public internet egress, say) — dropped honestly rather than guessed
  // (docs/connectors/railway.md §Fusion).
  peerServiceId: string | null
  peerKind: string
  direction: string
  byteCount: number
  packetCount: number
  // Non-null names why a flow was dropped (Railway's `@drop_cause` /
  // `dropCause` field) — the closest signal networkFlowLogs carries to an
  // "error" on a connection with no HTTP status of its own.
  dropCause: string | null
}
