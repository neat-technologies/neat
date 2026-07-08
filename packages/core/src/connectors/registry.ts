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
import { createSupabaseConnector, type SupabaseConnectorConfig } from './supabase/index.js'
import {
  createRailwayConnector,
  createRailwayResolveTarget,
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
  },
  cloudflare: {
    provider: 'cloudflare',
    primaryCredentialKey: 'apiToken',
    requiredCredentialFields: ['apiToken'],
    requiredOptionFields: ['accountId', 'workers'],
    build(_graph, options) {
      const config = options as unknown as CloudflareConnectorConfig
      // Class + separate resolveTarget factory; resolveTarget needs no graph.
      return {
        connector: new CloudflareConnector(config),
        resolveTarget: createCloudflareResolveTarget(config),
      }
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

  // Resolve env-ref credential to in-memory values (contract §2, §6). An
  // unset variable is a distinct, named failure — never a silent empty-poll.
  let credentials: Record<string, unknown>
  try {
    const resolved = resolveCredential(entry.credential, env)
    credentials =
      resolved.kind === 'single'
        ? { [dispatch.primaryCredentialKey]: resolved.value }
        : { ...resolved.fields }
  } catch (err) {
    if (err instanceof EnvRefUnsetError) return { ok: false, reason: err.message }
    return { ok: false, reason: (err as Error).message }
  }

  const missingCreds = dispatch.requiredCredentialFields.filter((k) => !credentials[k])
  if (missingCreds.length > 0) {
    return {
      ok: false,
      reason: `credential missing required field(s): ${missingCreds.join(', ')}`,
    }
  }

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
      connector: built.connector,
      credentials,
      resolveTarget: built.resolveTarget,
      ...(intervalMs !== undefined ? { intervalMs } : {}),
    },
  }
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
