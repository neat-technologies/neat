// Render connector — provider-specific types (docs/connectors/render.md,
// ADR-166). Render is a hosting platform, so like Railway (ADR-127) it names
// nothing in application code: the signal comes entirely from Render's own
// edge layer (its HTTP request logs), and fusion binds onto the RouteNode
// `extract/routes.ts` already builds. Render is SaaS-only, so there is no
// self-hosted-vs-Cloud branch to carry through these types.
//
// Surface + field names are sourced from Render's public API docs
// (api-docs.render.com/reference/list-logs; render.com/docs/logging and
// render.com/docs/log-streams), not from a live authenticated introspection —
// this connector has no Render account to probe against. The request-log
// attributes (method / statusCode / path / host) are the documented log-query
// filter parameters, carried on each entry as `labels` per Render's log
// object shape; where the real entry layout differs from the documented one,
// the mapping layer (index.ts) drops the row honestly rather than guessing.
// See docs/connectors/render.md §"What is verified" for exactly what remains
// unconfirmed pending a live project.

/**
 * Config resolved once at connector setup (docs/connectors/render.md §Fusion,
 * "resolved once, never guessed") — never re-derived from a Render API
 * response at poll time.
 */
export interface RenderConnectorConfig {
  // Render's REST API base. Defaults to the public API
  // (api-docs.render.com/reference/introduction confirms
  // `https://api.render.com/v1`); overridable for tests and any proxy.
  apiUrl?: string
  // The Render workspace (owner) id the `GET /v1/logs` query is scoped to —
  // `ownerId` is a required query parameter (api-docs.render.com/reference/
  // list-logs). Also this connector's rate-limit bucket key (ADR-131), the
  // closest thing Render's config carries to "one customer's account".
  ownerId: string
  // The Render service id whose request logs this connector instance polls —
  // the `resource` filter on the logs query. Render names a service by its own
  // `srv-...` id, which carries no relationship to NEAT's manifest-derived
  // `serviceId(name)` (packages/types/src/identity.ts); the two are different
  // naming authorities with no shared source of truth.
  resourceId: string
  // The NEAT manifest service name this connector fuses onto — the name that
  // resolves `serviceId(name)` and owns the RouteNodes a request log lands on.
  // Supplied once at connector setup; never inferred from a Render API
  // response (docs/connectors/render.md §Fusion).
  serviceName: string
  // Max rows requested per page. Render caps `limit` at 100
  // (api-docs.render.com/reference/list-logs); values above are clamped.
  limit?: number
  // Bounded number of pages to follow per poll — Render paginates request logs
  // by `hasMore` + `nextStartTime`/`nextEndTime`, so an unbounded follow could
  // walk the whole window on a busy service. Capped so a single tick stays
  // bounded (docs/contracts/connectors.md §"Poll cadence and backfill").
  maxPages?: number
  // Bounded lookback cap in ms for a first poll (no prior `since`) or a gap
  // wider than this window. Render's request-log retention varies by plan and
  // isn't published as a single number; 24h is a conservative chosen default,
  // not a provider-confirmed value — overridable once a live project confirms
  // the real window.
  maxLookbackMs?: number
}

// ── raw provider response shapes ────────────────────────────────────────────
//
// Sourced from Render's public API docs (api-docs.render.com/reference/
// list-logs), not from a live introspection. `GET /v1/logs` returns a page of
// entries plus timestamp cursors; each entry carries a `labels` array, and a
// request log's method/statusCode/path/host live in those labels (the same
// names the log-query filter parameters use). What remains unconfirmed against
// a real response — whether every request attribute is a label vs a top-level
// field, and the exact retention window — is flagged in docs/connectors/
// render.md §"What is verified".

/** One `{ name, value }` label on a Render log entry. */
export interface RenderLogLabel {
  name: string
  value: string
}

/** One entry in the `logs` array of a `GET /v1/logs` response. */
export interface RenderLogEntry {
  // Render's own event time for the log line — never poll-arrival time.
  timestamp: string
  // The formatted log line; unused for fusion (the structured attributes come
  // from `labels`), carried for the LogEntry emit (ADR-132) a later cut adds.
  message?: string
  id?: string
  // Structured attributes. For a request log: `type=request`, `method`,
  // `statusCode`, `path`, `host` (render.com/docs/logging). Absent or
  // partial → the row is dropped honestly by the mapping layer.
  labels?: RenderLogLabel[]
}

/** A `GET /v1/logs` response page. */
export interface RenderLogsResponse {
  hasMore: boolean
  // Timestamp cursors for the next page — passed back as the next query's
  // `startTime`/`endTime` (api-docs.render.com/reference/list-logs).
  nextStartTime?: string
  nextEndTime?: string
  logs: RenderLogEntry[]
}

// A Render API key is the single credential this connector carries — a Bearer
// token created from Render's account settings (render.com/docs/api). Read from
// `ConnectorContext.credentials` at poll time, never logged, never written into
// a node or edge (docs/contracts/connectors.md §6).
export function readRenderToken(credentials: Record<string, unknown>): string {
  const token = credentials.token
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Render connector requires ctx.credentials.token (a Render API key)')
  }
  return token
}

// Read a single label's value off an entry, or undefined when absent. The
// request-log attributes (method/statusCode/path/host) live here per Render's
// log object shape; a missing label means the mapping layer drops the row
// rather than guessing (connectors.md §4).
export function renderLabelValue(entry: RenderLogEntry, name: string): string | undefined {
  if (!Array.isArray(entry.labels)) return undefined
  const label = entry.labels.find((l) => l && typeof l === 'object' && l.name === name)
  return label && typeof label.value === 'string' ? label.value : undefined
}
