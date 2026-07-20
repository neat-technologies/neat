// Vercel connector types (docs/contracts/connectors.md §9, ADR-146). Vercel is
// the connectors plane's first *push* provider: its runtime traces have no pull
// API, so instead of a `poll()` this connector provisions a Vercel **Drain**
// that forwards traces as OTLP/HTTP to the daemon's own `/v1/traces` receiver.
// These types describe the drain's configuration and the two Drains REST API
// responses the client reads.

/**
 * Non-secret configuration for a Vercel trace drain — the `options` half of the
 * connector entry (connectors.md §9). Everything here is safe at rest in
 * `~/.neat/connectors.json`; the two secrets live in the entry's `credential`
 * (see {@link VercelCredentials}), never here.
 */
export interface VercelConnectorConfig {
  // The Vercel team the projects live under. Sent as the `teamId` query param
  // on every Drains API call — Drains are a team/Pro surface (ADR-146).
  teamId: string
  // Which projects the drain forwards traces from. Omitted or empty → every
  // project in the team (`projects: 'all'`); a non-empty list → `projects:
  // 'some'` scoped to exactly these ids.
  projectIds?: string[]
  // The publicly-reachable OTLP/HTTP endpoint the drain delivers to — the
  // daemon's `/v1/traces`. A local daemon is fronted by a tunnel; a hosted
  // daemon exposes its own URL. Reachability is proven by `validate` before
  // the drain is ever provisioned (connectors.md §9).
  endpoint: string
  // Set by `provision` once the drain exists (the POST /v1/drains response
  // `id`); read by `deprovision` to tear the drain down. Absent until the
  // connector has been added.
  drainId?: string
  // The human-facing name on the Vercel side. Defaults to `neat-otlp`.
  drainName?: string
  // Vercel API base, overridable so tests point the client at a fake. Defaults
  // to `https://api.vercel.com`.
  apiBaseUrl?: string
  // Optional signing secret Vercel echoes as the `x-vercel-signature` header on
  // every delivery. Left unset, Vercel generates one; NEAT does not verify it
  // (the OTLP receiver's bearer is the auth gate), so this is opt-in only.
  secret?: string
}

/**
 * The two secrets a Vercel drain needs, resolved into memory from the entry's
 * multi-field `credential` (connectors.md §9) and never written to disk.
 */
export interface VercelCredentials {
  // Authenticates the Drains REST API — provision, deprovision, validate. The
  // Vercel access token (`$VERCEL_TOKEN` by convention).
  token: string
  // Becomes the drain's delivery `Authorization: Bearer` header so the daemon's
  // OTLP receiver — bearer-gated per ADR-073 §4 — accepts the pushed spans.
  // This is the *target daemon's* OTLP ingest token (`$NEAT_OTEL_TOKEN`), not a
  // Vercel secret.
  otelToken: string
}

/** The fields we read from a POST /v1/drains (create) response. */
export interface VercelDrainCreated {
  id: string
  status?: 'disabled' | 'enabled' | 'errored'
  disabledReason?: string
}

/** The POST /v1/drains/test (validate delivery) response shape. */
export interface VercelDrainTestResult {
  // 'success' → the endpoint was reached and accepted a sample event;
  // 'failure' → reached-but-rejected or unreachable (see `error`).
  status?: string
  error?: string
  endpoint?: string
}
