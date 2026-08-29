// Connectors plane — provider-agnostic types (docs/contracts/connectors.md,
// docs/connectors/README.md, ADR-124).
//
// OTLP ingest has had exactly one path onto the OBSERVED layer: an app
// pushing spans it was instrumented to emit. A connector is the second path
// — a provider that already runs its own server-side telemetry (a hosted
// Postgres platform's query stats, a hosting platform's request logs) gets
// pulled from instead, so OBSERVED edges exist with zero app instrumentation.
//
// This file declares the one shape every provider implements. The
// provider-specific fetch + target-resolution logic lives under
// packages/core/src/connectors/<provider>/ — none shipped yet; this PR is
// the shared pull/map/fuse scaffold those provider modules plug into
// (Supabase first, per ADR-124; Railway/Firebase/Cloudflare designs are
// merged as prose-only docs and land their own connector modules next).

import type { SpanAttributes } from '@neat.is/types'

/**
 * A connector implements exactly one method. Everything downstream of
 * `poll()` — resolving a static call site, minting the OBSERVED edge — is
 * shared, generic code in connectors/index.ts.
 */
export interface ObservedConnector {
  readonly provider: string
  poll(ctx: ConnectorContext): Promise<ObservedSignal[]>
}

/**
 * Everything a connector's `poll()` needs, resolved once at connector setup
 * — never re-derived at poll time.
 *
 * `credentials` is opaque here on purpose: its shape is entirely provider-
 * and profile-defined (local vs hosted — docs/contracts/connectors.md §3).
 * It flows through to `poll()` only. Never log it, never write it into a
 * node or edge, never let it reach the graph snapshot (contract §6, and the
 * `.env`-contents rule docs/contracts.md Rule 4 already states for local
 * config).
 */
export interface ConnectorContext {
  // Absolute path to the project root being polled — the same anchor
  // `reconcileObservedRelPath` (ingest.ts) uses to fuse a signal's callSite
  // onto the EXTRACTED service-relative path.
  projectDir: string
  credentials: Record<string, unknown>
  // ISO8601 — the last successful poll's high-water mark. A connector must
  // treat an absent `since` as "no prior poll", bounded by whatever lookback
  // window the provider's own API caps (README.md §Poll cadence and
  // backfill) — never an unbounded full-history query.
  since?: string
  // The project's incident ledger (`errors.ndjson`), for the incident-emitting
  // shape (connectors.md §10, ADR-185). Threaded from the daemon slot's paths
  // so `runConnectorPoll` knows where to append an incident-bearing signal's
  // ErrorEvent. Absent for a traffic-only setup or a programmatic caller that
  // opts out — an incident signal then drops honestly, the same no-op an
  // unresolved target is. `poll()` never reads it; the shared pipeline does.
  errorsPath?: string
  // The project the poll belongs to, threaded so an incident-emitting connector's
  // ErrorEvent fires the `incident` push event (ADR-221) on the same bus
  // OTLP-derived incidents use. Absent for a programmatic caller that opts out —
  // the incident is still written to the ledger, it just isn't pushed.
  project?: string
}

/**
 * `file:line` the provider's own signal carries, when it does (rare — see
 * docs/connectors/README.md §Provider interface, which notes this is
 * "usually resolved by the mapping layer below, not here"). Reconciled onto
 * the EXTRACTED service-relative path by the shared fuse step the same way
 * an OTel span's call site is (file-awareness.md §4).
 */
export interface ConnectorCallSite {
  file: string
  line: number
}

/**
 * A failure the provider already recorded, carried on a signal so the shared
 * pipeline can mint it as an OBSERVED incident on the repo node the failure
 * implicates — the incident-emitting connector shape (connectors.md §10,
 * ADR-185). EAS is the first user: an `ERRORED` build becomes one of these.
 *
 * It is a *pre-built* incident minus its `affectedNode`: the connector's
 * mapping layer fills every field here, and the shared pipeline sets the
 * `affectedNode` from `resolveTarget` and derives the `traceId`/`spanId` the
 * `ErrorEvent` shape requires from the stable `id`. So the terminal write is
 * an `ErrorEvent` on the incident ledger (the same store OTLP-derived
 * incidents use), not an `upsertObservedEdge`.
 */
export interface ConnectorIncident {
  // Stable dedupe key for this one failure, e.g. `eas:build:<buildId>`. The
  // incident ledger is append-only, so a re-poll of the same failure must
  // carry the same id to collapse to one incident (ingest.ts `dedupeIncidents`).
  id: string
  // The failure's own event time (ISO8601) — never poll-arrival time.
  timestamp: string
  // The NEAT service the failure belongs to; the edge/incident's originating
  // service, resolved onto the fused ServiceNode by the shared pipeline.
  service: string
  // A short, stable classifier for the incident surface (e.g.
  // 'eas-build-failure'), the connector analog of ingest.ts's 'http-failure'.
  errorType: string
  // The human-readable failure line the incident surface shows.
  errorMessage: string
  // Provider context passed through verbatim so an agent can read it off the
  // incident — the failure phase, the commit, the (capped) logs, a docs URL.
  // Same JSON-safe shape ErrorEvent.attributes carries.
  attributes?: SpanAttributes
}

/**
 * One provider-agnostic observation. `targetKind`/`targetName` are the
 * provider's own vocabulary (`'supabase-table'`/`'orders'`,
 * `'route'`/`'GET /users/:id'`, ...) — resolving that pair to a NEAT node id
 * is the one genuinely provider-specific step (README.md's pipeline
 * diagram), supplied to `runConnectorPoll` (connectors/index.ts) as a
 * `resolveTarget` callback. Everything downstream of that resolution — file
 * grain fusion, OBSERVED mint — is shared.
 */
export interface ObservedSignal {
  targetKind: string
  targetName: string
  callCount: number
  errorCount: number
  // The provider's own event time — never poll-arrival time (README.md
  // §Poll cadence and backfill).
  lastObservedIso: string
  callSite?: ConnectorCallSite
  // The columns this observation touched, for a table-grain target (ADR-157 §2).
  // Set by a connector whose signal came from SQL query text it can parse
  // (Neon / Supabase `pg_stat_statements`, via the shared
  // `columnsFromSqlStatement`); absent for a signal with no statement to read
  // (a REST-path or route target). The shared pipeline merges these onto the
  // resolved table node as OBSERVED column attributes.
  columns?: string[]
  // A failure the provider recorded (connectors.md §10, ADR-185). When set, the
  // shared pipeline writes an OBSERVED incident (an ErrorEvent) onto the
  // resolved node instead of minting an edge — the terminal write is the only
  // thing that differs from a traffic signal. Additive and optional: a
  // traffic-only connector never sets it and is unaffected.
  incident?: ConnectorIncident
}
