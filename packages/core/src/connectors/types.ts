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
  // The NEAT project name this poll's `LogEntry` emissions are scoped to
  // (docs/contracts/logs.md, connectors.md §7, ADR-132) — the same
  // `RegistryEntry.name` `daemon.ts` already keys the graph, staleness loop,
  // and `GET /logs` by. Optional because `poll()`'s signature/shape can't
  // change and a caller outside `daemon.ts` (a direct test, a one-shot
  // script) may have no registry entry to hand in; a connector reading this
  // falls back to `path.basename(projectDir)` — the same "no explicit name
  // given" convention `cli.ts` already uses — rather than leaving
  // `LogEntry.projectName` unset.
  projectName?: string
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
}
