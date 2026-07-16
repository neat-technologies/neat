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
 * One provider's dispatch-table entry. Beyond the factory this carries the
 * schema the CLI (`neat connector add`) reads to know what to prompt for
 * (contract §5) — declared here so provider specifics live in data the table
 * reads, never scattered across the CLI and daemon.
 */
export interface ProviderDispatch {
  provider: string
  // The credential-record key a single-string credential resolves into (this
  // provider's primary secret field). A multi-field credential carries its
  // own keys and ignores this.
  primaryCredentialKey: string
  // Credential-record keys this provider's `poll()` requires. Checked at
  // build time so a missing field fails honestly at daemon-read rather than
  // silently at the first poll.
  requiredCredentialFields: readonly string[]
  // `options` keys this provider's factory requires.
  requiredOptionFields: readonly string[]
  // Adapt (graph, non-secret options) into the uniform connector pairing.
  build(graph: NeatGraph, options: Record<string, unknown>): BuiltConnector
  // The cheap auth round-trip `neat connector add`/`test` run before writing
  // (contract §4, §5). Data-driven like everything else on this entry: the CLI
  // never hand-rolls a per-provider auth check, it dispatches here.
  validate(input: ValidateInput): Promise<ConnectorValidation>
}

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
    // GET /user/tokens/verify — Cloudflare's own purpose-built "is this API
    // token live" endpoint. 200 on a valid token, 401 on an invalid one.
    validate({ credentials, options, fetchImpl }) {
      const cfg = options as Partial<CloudflareConnectorConfig>
      const baseUrl = cfg.baseUrl ?? CLOUDFLARE_API_BASE_URL
      return authProbe({
        provider: 'cloudflare',
        accountKey: cfg.accountId ?? 'validate',
        url: `${baseUrl}/user/tokens/verify`,
        token: String(credentials.apiToken ?? ''),
        ...(fetchImpl ? { fetchImpl } : {}),
      })
    },
  },
}

export function getProviderDispatch(provider: string): ProviderDispatch | undefined {
  return PROVIDER_DISPATCH[provider]
}

export type BuildResult =
  | { ok: true; registration: ConnectorRegistration }
  | { ok: false; reason: string }

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
  dispatch: ProviderDispatch,
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
  const dispatch = PROVIDER_DISPATCH[entry.provider]
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
    else onSkip?.(entry, result.reason)
  }
  return registrations
}
