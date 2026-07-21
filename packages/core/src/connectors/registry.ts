// Provider dispatch table — the one place a connector provider registers
// (docs/contracts/connector-config.md §5, ADR-130).
//
// The shipped provider factories deliberately differ in shape: Supabase and
// Firebase hand back `{ connector, resolveTarget }` from one call, Railway
// pairs `createRailwayConnector(graph, config)` with a separate
// `createRailwayResolveTarget(config)`, and Cloudflare constructs its
// connector class directly alongside `createCloudflareResolveTarget(config)`.
// This table is the normalization seam that adapts all of them into the one
// uniform `ConnectorRegistration` the daemon's poll loop consumes — the same
// data-driven discipline `compat.json` holds for driver logic (CLAUDE.md
// § Don't do). A new provider adds one entry here; daemon.ts and cli.ts never
// grow a per-provider branch.
//
// `buildRegistration` turns one resolved config entry into a registration;
// `loadConnectorRegistrations` reads the whole file (via connectors-config.ts)
// and builds every entry that matches a project. The daemon calls the latter
// at slot bootstrap.

import type { NeatGraph } from '../graph.js'
import type { ConnectorRegistration, ObservedConnector, ResolveConnectorTarget } from './index.js'
import { bearerAuthHeader, junctionFetch } from './junction.js'
import { createSupabaseConnector, DEFAULT_SUPABASE_MANAGEMENT_API_URL, type SupabaseConnectorConfig } from './supabase/index.js'
import {
  createRailwayConnector,
  createRailwayResolveTarget,
  resolveLatestRailwayDeploymentId,
  type RailwayConnectorConfig,
} from './railway/index.js'
import { createFirebaseConnector, type FirebaseServiceMap } from './firebase/index.js'
import {
  CloudflareConnector,
  createCloudflareResolveTarget,
  type CloudflareConnectorConfig,
} from './cloudflare/index.js'
import {
  createVercelDrain,
  deleteVercelDrain,
  testVercelDrainDelivery,
  type VercelConnectorConfig,
  type VercelCredentials,
} from './vercel/index.js'
import {
  connectorMatchesProject,
  EnvRefUnsetError,
  readConnectorsConfig,
  resolveCredential,
  type ConnectorEntry,
} from '../connectors-config.js'

/** What a provider's factory pairing produces once normalized. */
interface BuiltConnector {
  connector: ObservedConnector
  resolveTarget: ResolveConnectorTarget
}

/**
 * The verdict of a provider's cheap auth round-trip (contract §4). `ok` means
 * the resolved credential authenticated against the provider; a failure names
 * why in plain terms the CLI can print verbatim — never echoing the credential
 * itself.
 */
export type ConnectorValidation = { ok: true } | { ok: false; reason: string }

/** What a dispatch-table validator receives — already-resolved credentials. */
export interface ValidateInput {
  // env-refs already resolved to their in-memory values (contract §2). Keyed
  // the way this provider's `poll()` reads them.
  credentials: Record<string, unknown>
  // Non-secret provider config from the entry's `options`.
  options: Record<string, unknown>
  // Dependency-injection seam for tests — a fake `fetch` stands in for the live
  // provider so validate-on-add never needs a real account (contract §4's
  // round-trip is exercised against a stub, mirroring each connector's own
  // `fetchImpl` test seam).
  fetchImpl?: typeof fetch
}

// The Cloudflare API host, defaulted here rather than importing a private const
// out of the connector's client — the same value cloudflare/client.ts uses.
const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4'

/**
 * One authenticated GET/POST through the shared junction (ADR-131), interpreted
 * as a validation verdict. A 2xx means the credential authenticated; a 401/403
 * means the provider rejected it (the "creds present but wrong" case the
 * contract keeps distinct from an unset env-ref); any other status or a
 * transport failure is reported as an inability to confirm, never a false
 * "valid". The bearer token flows into the Authorization header and nowhere
 * else — the reason strings below carry only the provider name and HTTP status,
 * never the secret (contract §2, connectors.md §6).
 */
async function authProbe(input: {
  provider: string
  accountKey: string
  url: string | URL
  token: string
  init?: RequestInit
  fetchImpl?: typeof fetch
}): Promise<ConnectorValidation> {
  const { provider, accountKey, url, token, init, fetchImpl } = input
  try {
    const res = await junctionFetch(
      url,
      {
        ...(init ?? {}),
        headers: { ...bearerAuthHeader(token), ...((init?.headers as Record<string, string>) ?? {}) },
      },
      { provider, accountKey, ...(fetchImpl ? { fetchImpl } : {}) },
    )
    if (res.ok) return { ok: true }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: `${provider} rejected the credential (HTTP ${res.status})` }
    }
    return {
      ok: false,
      reason: `${provider} auth check returned HTTP ${res.status} ${res.statusText} — could not confirm the credential`,
    }
  } catch (err) {
    return {
      ok: false,
      reason: `${provider} auth check could not reach the provider: ${(err as Error).message}`,
    }
  }
}

/**
 * The field-schema surface `neat connector add` reads to know what to prompt
 * for and validate structurally (contract §5). Shared by pull providers
 * ({@link ProviderDispatch}) and push providers ({@link PushProviderDispatch})
 * so the CLI's credential/option handling never branches on provider shape —
 * it reads this and dispatches the rest.
 */
export interface ProviderFieldSchema {
  provider: string
  // The credential-record key a single-string credential resolves into (this
  // provider's primary secret field). A multi-field credential carries its
  // own keys and ignores this.
  primaryCredentialKey: string
  // Credential-record keys this provider requires. Checked before any network
  // call so a missing field fails honestly rather than silently downstream.
  requiredCredentialFields: readonly string[]
  // `options` keys this provider requires.
  requiredOptionFields: readonly string[]
}

/**
 * One *pull* provider's dispatch-table entry. Beyond the field schema it
 * carries the factory the daemon's poll loop consumes (contract §5) — declared
 * here so provider specifics live in data the table reads, never scattered
 * across the CLI and daemon.
 */
export interface ProviderDispatch extends ProviderFieldSchema {
  // Adapt (graph, non-secret options) into the uniform connector pairing.
  build(graph: NeatGraph, options: Record<string, unknown>): BuiltConnector
  // The cheap auth round-trip `neat connector add`/`test` run before writing
  // (contract §4, §5). Data-driven like everything else on this entry: the CLI
  // never hand-rolls a per-provider auth check, it dispatches here.
  validate(input: ValidateInput): Promise<ConnectorValidation>
}

/**
 * One *push* provider's dispatch-table entry (connectors.md §9, ADR-146). A
 * push provider has no `poll()` — its telemetry arrives at the daemon's OTLP
 * receiver because `provision` configured the provider to forward it. Beyond
 * the shared field schema and `validate`, it carries a provision/deprovision
 * lifecycle the pull shape has no need for. Registered in
 * {@link PUSH_PROVIDER_DISPATCH}, parallel to {@link PROVIDER_DISPATCH}.
 */
export interface PushProviderDispatch extends ProviderFieldSchema {
  // The same cheap round-trip §4 names — for a drain, it authenticates the
  // provider credential *and* confirms the daemon's OTLP endpoint is reachable
  // and accepts the drain's bearer. Run by `add` (pre-provision) and `test`.
  validate(input: ValidateInput): Promise<ConnectorValidation>
  // Create the provider-side resource (the drain). On success returns an opaque
  // handle merged into the entry's `options` (e.g. `{ drainId }`) so a later
  // `remove` can tear it down, plus an optional operator-facing note.
  provision(input: ValidateInput): Promise<ProvisionResult>
  // Delete the provider-side resource. Idempotent — an already-gone resource is
  // a success, not an error (connectors.md §9).
  deprovision(input: ValidateInput): Promise<DeprovisionResult>
}

export type ProvisionResult =
  | { ok: true; options?: Record<string, unknown>; note?: string }
  | { ok: false; reason: string }

export type DeprovisionResult = { ok: true; note?: string } | { ok: false; reason: string }

// ── The table. Five providers are designed; four are built and register
// here. Vercel's Drains connector (#724) is a push connector still awaiting a
// `receive()` amendment to connectors.md — it adds its entry when it lands.
export const PROVIDER_DISPATCH: Record<string, ProviderDispatch> = {
  supabase: {
    provider: 'supabase',
    primaryCredentialKey: 'managementToken',
    requiredCredentialFields: ['managementToken'],
    requiredOptionFields: ['apiProjectRef', 'nodeRef', 'serviceName'],
    build(graph, options) {
      // createSupabaseConnector already returns the pairing.
      return createSupabaseConnector(graph, options as unknown as SupabaseConnectorConfig)
    },
    // GET /v1/projects — the Management API's own auth-gated list endpoint, the
    // cheapest confirmation the management token is live (the same surface
    // client.ts polls, minus the heavy log query).
    validate({ credentials, options, fetchImpl }) {
      const cfg = options as Partial<SupabaseConnectorConfig>
      const baseUrl = cfg.managementApiUrl ?? DEFAULT_SUPABASE_MANAGEMENT_API_URL
      return authProbe({
        provider: 'supabase',
        accountKey: cfg.apiProjectRef ?? 'validate',
        url: `${baseUrl}/v1/projects`,
        token: String(credentials.managementToken ?? ''),
        ...(fetchImpl ? { fetchImpl } : {}),
      })
    },
  },
  railway: {
    provider: 'railway',
    primaryCredentialKey: 'token',
    requiredCredentialFields: ['token'],
    requiredOptionFields: ['environmentId', 'serviceId', 'serviceNameById'],
    build(graph, options) {
      const config = options as unknown as RailwayConnectorConfig
      // Split factories — connector and resolveTarget are built separately.
      return {
        connector: createRailwayConnector(graph, config),
        resolveTarget: createRailwayResolveTarget(config),
      }
    },
    // Runs the same `deployments` lookup the poller itself needs
    // (railway/client.ts's resolveLatestRailwayDeploymentId) rather than a
    // trivial `{ __typename }` probe. That trivial form is a false positive
    // for this provider: `Authorization: Bearer <token>` authenticates at
    // Railway's HTTP gateway (any well-formed token gets a 2xx on a query
    // that touches no real data) but is not authorized for the connector's
    // actual queries, which come back as an HTTP-200 response carrying a
    // GraphQL-level "Not Authorized" error — invisible to authProbe's
    // status-code-only check. Probing with the real lookup, through the same
    // Project-Access-Token header client.ts sends, catches both failure
    // modes: an HTTP-level rejection (thrown as a fetch/status error) and a
    // GraphQL-level one (thrown by railwayGraphQL's own body.errors check).
    async validate({ credentials, options, fetchImpl }) {
      const cfg = options as Partial<RailwayConnectorConfig>
      if (!cfg.environmentId || !cfg.serviceId) {
        return { ok: false, reason: 'railway: environmentId and serviceId are required to validate' }
      }
      const config: RailwayConnectorConfig = {
        environmentId: cfg.environmentId,
        serviceId: cfg.serviceId,
        serviceNameById: cfg.serviceNameById ?? {},
        ...(cfg.apiUrl ? { apiUrl: cfg.apiUrl } : {}),
      }
      try {
        await resolveLatestRailwayDeploymentId(config, String(credentials.token ?? ''), fetchImpl)
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: `railway auth check failed: ${(err as Error).message}` }
      }
    },
  },
  firebase: {
    provider: 'firebase',
    // Firebase reads both projectId and accessToken from the credential; the
    // single-string form maps to the secret, and the required-fields check
    // below catches a projectId that was never supplied.
    primaryCredentialKey: 'accessToken',
    requiredCredentialFields: ['projectId', 'accessToken'],
    requiredOptionFields: [],
    build(graph, options) {
      // options is the FirebaseServiceMap; createFirebaseConnector returns the
      // pairing.
      return createFirebaseConnector(graph, options as unknown as FirebaseServiceMap)
    },
    // GET the project's Cloud Logging log-name list (pageSize 1) — within the
    // same `roles/logging.viewer` grant the connector polls under, and the
    // lightest call that still fails 401/403 on a bad or wrong-scoped token.
    validate({ credentials, fetchImpl }) {
      const projectId = String(credentials.projectId ?? '')
      return authProbe({
        provider: 'firebase',
        accountKey: projectId || 'validate',
        url: `https://logging.googleapis.com/v2/projects/${projectId}/logs?pageSize=1`,
        token: String(credentials.accessToken ?? ''),
        ...(fetchImpl ? { fetchImpl } : {}),
      })
    },
  },
  cloudflare: {
    provider: 'cloudflare',
    primaryCredentialKey: 'apiToken',
    requiredCredentialFields: ['apiToken'],
    // `workers` dropped as a required field (ADR-133) — the mapping is now
    // derived from the extracted graph's platform tag; an `options.workers`
    // entry still works as an explicit override
    // (CloudflareConnectorConfig.workers).
    requiredOptionFields: ['accountId'],
    build(graph, options) {
      const config = options as unknown as CloudflareConnectorConfig
      // Class + separate resolveTarget factory; resolveTarget now closes over
      // the graph to resolve against the platform tag (ADR-133).
      return {
        connector: new CloudflareConnector(config),
        resolveTarget: createCloudflareResolveTarget(config, graph),
      }
    },
    // GET /accounts/{accountId}/tokens/verify — the *account-scoped* token-verify
    // endpoint. A Workers connector token is scoped to the account, and the
    // user-level `GET /user/tokens/verify` returns 401 "Invalid API Token" for
    // such a token even though it authenticates fine against the account's own
    // resources (confirmed live). Probing the account-scoped verify endpoint —
    // `accountId` is already required for this provider — returns 200
    // `{status:"active"}` for a working token and 401 for a bad one, so a valid
    // Workers token is no longer falsely rejected at `neat connector add`.
    validate({ credentials, options, fetchImpl }) {
      const cfg = options as Partial<CloudflareConnectorConfig>
      const baseUrl = cfg.baseUrl ?? CLOUDFLARE_API_BASE_URL
      return authProbe({
        provider: 'cloudflare',
        accountKey: cfg.accountId ?? 'validate',
        url: `${baseUrl}/accounts/${cfg.accountId ?? ''}/tokens/verify`,
        token: String(credentials.apiToken ?? ''),
        ...(fetchImpl ? { fetchImpl } : {}),
      })
    },
  },
}

export function getProviderDispatch(provider: string): ProviderDispatch | undefined {
  return PROVIDER_DISPATCH[provider]
}

// Read the two secrets a Vercel drain needs out of an already-resolved
// credential record (registry keeps them env-refs until this point, §2/§6).
function vercelCredsFrom(credentials: Record<string, unknown>): VercelCredentials {
  return { token: String(credentials.token ?? ''), otelToken: String(credentials.otelToken ?? '') }
}

// Rebuild the typed Vercel config from an entry's opaque `options`. `projectIds`
// tolerates both an array and a comma-separated string (the shape a `--project-
// ids` CLI flag lands as); everything absent stays absent.
function vercelConfigFromOptions(options: Record<string, unknown>): VercelConnectorConfig {
  const raw = options.projectIds
  let projectIds: string[] | undefined
  if (Array.isArray(raw)) projectIds = raw.filter((p): p is string => typeof p === 'string')
  else if (typeof raw === 'string' && raw.trim().length > 0) {
    projectIds = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  }
  return {
    teamId: String(options.teamId ?? ''),
    endpoint: String(options.endpoint ?? ''),
    ...(projectIds && projectIds.length > 0 ? { projectIds } : {}),
    ...(typeof options.drainId === 'string' ? { drainId: options.drainId } : {}),
    ...(typeof options.drainName === 'string' ? { drainName: options.drainName } : {}),
    ...(typeof options.apiBaseUrl === 'string' ? { apiBaseUrl: options.apiBaseUrl } : {}),
    ...(typeof options.secret === 'string' ? { secret: options.secret } : {}),
  }
}

// ── The push table. One provider so far — Vercel (ADR-146). A push provider
// registers here instead of PROVIDER_DISPATCH: it provisions a drain rather
// than exposing a poll(), so it carries a provision/deprovision lifecycle and
// no `build`. `neat connector add/remove/test` dispatch through it exactly as
// they dispatch pull providers through PROVIDER_DISPATCH.
export const PUSH_PROVIDER_DISPATCH: Record<string, PushProviderDispatch> = {
  vercel: {
    provider: 'vercel',
    // The Vercel access token is the "primary" secret a single `--token`
    // populates; `otelToken` (the daemon's OTLP bearer) is the second field.
    primaryCredentialKey: 'token',
    requiredCredentialFields: ['token', 'otelToken'],
    // teamId scopes every Drains call; endpoint is where the drain delivers.
    // projectIds is optional (absent → the drain covers the whole team).
    requiredOptionFields: ['teamId', 'endpoint'],
    // POST /v1/drains/test — authenticates the token and pings the endpoint
    // with a sample event, so `success` means the credential is live *and* the
    // daemon's OTLP endpoint is reachable and accepted the drain's bearer.
    async validate({ credentials, options, fetchImpl }) {
      const result = await testVercelDrainDelivery(
        vercelConfigFromOptions(options),
        vercelCredsFrom(credentials),
        fetchImpl,
      )
      if (result.status === 'success') return { ok: true }
      return {
        ok: false,
        reason: result.error ?? `vercel drain delivery test returned "${result.status ?? 'no status'}"`,
      }
    },
    // POST /v1/drains — creates the trace drain, returns its id to store in
    // `options.drainId`. A created-but-not-enabled drain is surfaced as a note,
    // not a failure (the entry still points at a real drain).
    async provision({ credentials, options, fetchImpl }) {
      try {
        const created = await createVercelDrain(
          vercelConfigFromOptions(options),
          vercelCredsFrom(credentials),
          fetchImpl,
        )
        const note =
          created.status && created.status !== 'enabled'
            ? `the drain was created but its status is "${created.status}"${created.disabledReason ? ` (${created.disabledReason})` : ''} — check the Vercel dashboard`
            : undefined
        return { ok: true, options: { drainId: created.id }, ...(note ? { note } : {}) }
      } catch (err) {
        return { ok: false, reason: (err as Error).message }
      }
    },
    // DELETE /v1/drains/{id} — idempotent (deleteVercelDrain treats 404 as
    // success). No recorded drainId → nothing to delete, still a success.
    async deprovision({ credentials, options, fetchImpl }) {
      const drainId = typeof options.drainId === 'string' ? options.drainId : ''
      if (!drainId) {
        return { ok: true, note: 'no drain id was recorded — nothing to delete on the Vercel side' }
      }
      try {
        await deleteVercelDrain(
          vercelConfigFromOptions(options),
          drainId,
          vercelCredsFrom(credentials),
          fetchImpl,
        )
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: (err as Error).message }
      }
    },
  },
}

export function getPushProviderDispatch(provider: string): PushProviderDispatch | undefined {
  return PUSH_PROVIDER_DISPATCH[provider]
}

/** Whether a provider provisions a drain (push) rather than being polled (pull). */
export function isPushProvider(provider: string): boolean {
  return provider in PUSH_PROVIDER_DISPATCH
}

/**
 * The field schema for a provider from *either* table — what the CLI reads to
 * prompt for and structurally check credentials/options without caring whether
 * the provider is pull or push.
 */
export function getProviderFieldSchema(provider: string): ProviderFieldSchema | undefined {
  return PROVIDER_DISPATCH[provider] ?? PUSH_PROVIDER_DISPATCH[provider]
}

/** Every registered provider name, pull and push — for CLI "known providers" hints. */
export function knownProviderNames(): string[] {
  return [...Object.keys(PROVIDER_DISPATCH), ...Object.keys(PUSH_PROVIDER_DISPATCH)].sort()
}

export type BuildResult =
  | { ok: true; registration: ConnectorRegistration }
  // `push: true` marks a benign skip — the entry is a push provider with no
  // poll registration to build (connectors.md §9), not a broken entry.
  | { ok: false; reason: string; push?: boolean }

/**
 * Resolve an entry's env-ref credential to in-memory values keyed the way this
 * provider reads them (contract §2, §6), and confirm every required credential
 * field is present. The `unset-env` failure is kept distinct from every other
 * kind so a caller can tell "you forgot to `export`" apart from "your token is
 * malformed" (contract §4). Shared by `buildRegistration` (daemon read) and
 * `validateConnectorEntry` (the CLI) so both resolve credentials identically.
 */
type CredentialResolution =
  | { ok: true; credentials: Record<string, unknown> }
  | { ok: false; kind: 'unset-env' | 'error' | 'missing-field'; reason: string }

function resolveEntryCredentials(
  dispatch: ProviderFieldSchema,
  entry: ConnectorEntry,
  env: NodeJS.ProcessEnv,
): CredentialResolution {
  let credentials: Record<string, unknown>
  try {
    const resolved = resolveCredential(entry.credential, env)
    credentials =
      resolved.kind === 'single'
        ? { [dispatch.primaryCredentialKey]: resolved.value }
        : { ...resolved.fields }
  } catch (err) {
    if (err instanceof EnvRefUnsetError) return { ok: false, kind: 'unset-env', reason: err.message }
    return { ok: false, kind: 'error', reason: (err as Error).message }
  }
  const missingCreds = dispatch.requiredCredentialFields.filter((k) => !credentials[k])
  if (missingCreds.length > 0) {
    return {
      ok: false,
      kind: 'missing-field',
      reason: `credential missing required field(s): ${missingCreds.join(', ')}`,
    }
  }
  return { ok: true, credentials }
}

/**
 * Turn one resolved config entry into a `ConnectorRegistration`, or a skip
 * reason. Never throws — a bad entry (unknown provider, unset env-ref,
 * missing required field, provider factory rejecting its config) resolves to
 * `{ ok: false, reason }` so one broken connector never takes the daemon slot
 * down with it (contract §6).
 */
export function buildRegistration(
  entry: ConnectorEntry,
  graph: NeatGraph,
  env: NodeJS.ProcessEnv = process.env,
): BuildResult {
  const dispatch = PROVIDER_DISPATCH[entry.provider]
  if (!dispatch) {
    // A push provider (ADR-146) has no poll registration — it provisioned a
    // drain and its data arrives via the OTLP receiver. Flag that as a benign,
    // expected skip, distinct from a genuinely unknown provider, so the daemon
    // never treats a configured Vercel connector as a broken entry
    // (connectors.md §9).
    if (isPushProvider(entry.provider)) {
      return {
        ok: false,
        push: true,
        reason: `push provider "${entry.provider}" ingests via the OTLP receiver — nothing to poll`,
      }
    }
    return { ok: false, reason: `unknown provider "${entry.provider}"` }
  }

  const creds = resolveEntryCredentials(dispatch, entry, env)
  if (!creds.ok) return { ok: false, reason: creds.reason }
  const credentials = creds.credentials

  const options = entry.options ?? {}
  const missingOpts = dispatch.requiredOptionFields.filter((k) => !(k in options))
  if (missingOpts.length > 0) {
    return {
      ok: false,
      reason: `options missing required field(s): ${missingOpts.join(', ')}`,
    }
  }

  let built: BuiltConnector
  try {
    built = dispatch.build(graph, options)
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }

  const intervalMs = typeof options.intervalMs === 'number' ? options.intervalMs : undefined
  return {
    ok: true,
    registration: {
      // Carry the entry id so the daemon can key this connector's poll-status
      // records to it (ADR-136).
      id: entry.id,
      connector: built.connector,
      credentials,
      resolveTarget: built.resolveTarget,
      ...(intervalMs !== undefined ? { intervalMs } : {}),
    },
  }
}

/**
 * The verdict `neat connector add` (validate-on-add) and `neat connector test`
 * both report (contract §4). Five distinct outcomes so the CLI can speak
 * plainly: `ok` (authenticated), `unset-env` (a `$VAR` credential's variable
 * isn't set — resolution failure, *not* the provider rejecting a token),
 * `rejected` (creds resolved but the provider's auth path turned them down),
 * `unknown-provider`, and `missing-field` (a required credential/option is
 * absent — caught before any network call).
 */
export type ValidateOutcome =
  | { status: 'ok' }
  | { status: 'unset-env'; reason: string }
  | { status: 'rejected'; reason: string }
  | { status: 'unknown-provider'; reason: string }
  | { status: 'missing-field'; reason: string }

/**
 * Run the provider's cheap auth round-trip against an entry — resolving its
 * env-ref credential first, so an unset variable short-circuits as `unset-env`
 * before any request goes out (contract §4). Dispatches the actual round-trip
 * through the table's `validate` (§5), so no per-provider auth logic lives in
 * the CLI. `fetchImpl` is the test seam that stands a fake provider in for the
 * live one.
 */
export async function validateConnectorEntry(
  entry: ConnectorEntry,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): Promise<ValidateOutcome> {
  // Either table — a pull provider's auth probe and a push provider's
  // drain-delivery test are the same `validate` shape (contract §4, §9), so
  // `neat connector test` reads one and dispatches without branching.
  const dispatch = PROVIDER_DISPATCH[entry.provider] ?? PUSH_PROVIDER_DISPATCH[entry.provider]
  if (!dispatch) {
    return { status: 'unknown-provider', reason: `unknown provider "${entry.provider}"` }
  }
  const creds = resolveEntryCredentials(dispatch, entry, env)
  if (!creds.ok) {
    if (creds.kind === 'unset-env') return { status: 'unset-env', reason: creds.reason }
    return { status: 'missing-field', reason: creds.reason }
  }
  const options = entry.options ?? {}
  const missingOpts = dispatch.requiredOptionFields.filter((k) => !(k in options))
  if (missingOpts.length > 0) {
    return {
      status: 'missing-field',
      reason: `options missing required field(s): ${missingOpts.join(', ')}`,
    }
  }
  const result = await dispatch.validate({
    credentials: creds.credentials,
    options,
    ...(fetchImpl ? { fetchImpl } : {}),
  })
  return result.ok ? { status: 'ok' } : { status: 'rejected', reason: result.reason }
}

export interface LoadConnectorsInput {
  // The project this daemon slot is bootstrapping — only entries that match
  // it (or omit `project`) load.
  project: string
  // The slot's live graph; resolveTarget closes over it.
  graph: NeatGraph
  // Resolved NEAT_HOME; defaults to the env-based resolution in
  // connectors-config.ts.
  home?: string
  env?: NodeJS.ProcessEnv
  // Called once per skipped entry (unknown provider, unset env-ref, missing
  // field, ...) so the daemon can log it. A skip is never fatal.
  onSkip?: (entry: ConnectorEntry, reason: string) => void
}

/**
 * Read `~/.neat/connectors.json` and build a registration for every entry
 * that matches `project`. The daemon calls this at slot bootstrap and hands
 * the result to `startConnectorPollLoop`. A missing file yields an empty
 * list; a malformed file yields an empty list plus one skip callback, never a
 * throw — the daemon must survive a hand-edited config.
 */
export async function loadConnectorRegistrations(
  input: LoadConnectorsInput,
): Promise<ConnectorRegistration[]> {
  const { project, graph, home, env = process.env, onSkip } = input
  let connectors: ConnectorEntry[]
  try {
    connectors = (await readConnectorsConfig(home)).connectors
  } catch (err) {
    onSkip?.(
      { id: '(file)', provider: '(all)', credential: '' },
      `connectors.json unreadable — ${(err as Error).message}`,
    )
    return []
  }

  const registrations: ConnectorRegistration[] = []
  for (const entry of connectors) {
    if (!connectorMatchesProject(entry, project)) continue
    const result = buildRegistration(entry, graph, env)
    if (result.ok) registrations.push(result.registration)
    // A push provider (ADR-146) is not a poll connector — its absence from the
    // registration list is expected, not a fault, so it never fires the
    // error-oriented onSkip (connectors.md §9). Its drain delivers via the OTLP
    // receiver regardless of this loop.
    else if (!result.push) onSkip?.(entry, result.reason)
  }
  return registrations
}

/**
 * The outcome of a push provider's provision/deprovision (connectors.md §9),
 * shaped like {@link ValidateOutcome} so `neat connector add`/`remove` report
 * both with one vocabulary. `ok` optionally carries `options` — an opaque
 * handle to merge into the entry (e.g. `{ drainId }`) — and an operator `note`.
 * `not-push` names the caller error of asking a pull provider to provision.
 */
export type PushActionOutcome =
  | { status: 'ok'; options?: Record<string, unknown>; note?: string }
  | { status: 'unset-env'; reason: string }
  | { status: 'missing-field'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'unknown-provider'; reason: string }
  | { status: 'not-push'; reason: string }

type PushResolved =
  | { ok: true; dispatch: PushProviderDispatch; credentials: Record<string, unknown>; options: Record<string, unknown> }
  | { ok: false; outcome: PushActionOutcome }

// Shared front half of provision/deprovision: find the push dispatch, resolve
// the entry's env-ref credential, and confirm required options are present —
// the same pre-flight `validateConnectorEntry` runs, kept identical so a push
// `add`/`remove` fails on a missing field exactly where `test` would.
function resolvePushEntry(entry: ConnectorEntry, env: NodeJS.ProcessEnv): PushResolved {
  const dispatch = PUSH_PROVIDER_DISPATCH[entry.provider]
  if (!dispatch) {
    return PROVIDER_DISPATCH[entry.provider]
      ? {
          ok: false,
          outcome: {
            status: 'not-push',
            reason: `provider "${entry.provider}" is polled, not provisioned — there is no drain to manage`,
          },
        }
      : { ok: false, outcome: { status: 'unknown-provider', reason: `unknown provider "${entry.provider}"` } }
  }
  const creds = resolveEntryCredentials(dispatch, entry, env)
  if (!creds.ok) {
    const status = creds.kind === 'unset-env' ? 'unset-env' : creds.kind === 'missing-field' ? 'missing-field' : 'failed'
    return { ok: false, outcome: { status, reason: creds.reason } }
  }
  const options = entry.options ?? {}
  const missingOpts = dispatch.requiredOptionFields.filter((k) => !(k in options))
  if (missingOpts.length > 0) {
    return {
      ok: false,
      outcome: { status: 'missing-field', reason: `options missing required field(s): ${missingOpts.join(', ')}` },
    }
  }
  return { ok: true, dispatch, credentials: creds.credentials, options }
}

/**
 * Provision a push provider's drain (connectors.md §9) — run by `neat connector
 * add` after validation, before the entry is written. On success the returned
 * `options` (the drain handle) is merged into the entry so `remove` can undo it.
 */
export async function provisionConnector(
  entry: ConnectorEntry,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): Promise<PushActionOutcome> {
  const resolved = resolvePushEntry(entry, env)
  if (!resolved.ok) return resolved.outcome
  const result = await resolved.dispatch.provision({
    credentials: resolved.credentials,
    options: resolved.options,
    ...(fetchImpl ? { fetchImpl } : {}),
  })
  if (!result.ok) return { status: 'failed', reason: result.reason }
  return { status: 'ok', ...(result.options ? { options: result.options } : {}), ...(result.note ? { note: result.note } : {}) }
}

/**
 * Deprovision a push provider's drain — run by `neat connector remove` before
 * the entry is dropped, so a stored entry never outlives its live drain. The
 * provider's `deprovision` is idempotent (an already-gone drain is a success).
 */
export async function deprovisionConnector(
  entry: ConnectorEntry,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): Promise<PushActionOutcome> {
  const resolved = resolvePushEntry(entry, env)
  if (!resolved.ok) return resolved.outcome
  const result = await resolved.dispatch.deprovision({
    credentials: resolved.credentials,
    options: resolved.options,
    ...(fetchImpl ? { fetchImpl } : {}),
  })
  if (!result.ok) return { status: 'failed', reason: result.reason }
  return { status: 'ok', ...(result.note ? { note: result.note } : {}) }
}
