// Hosted-profile credential sourcing for the connectors plane (connectors.md §3, INFRA-ADR-011).
//
// The local profile reads a connector's credential from ~/.neat/connectors.json (an env-ref resolved at
// slot bootstrap). The hosted profile has no such file — the credential is brokered on the customer's
// behalf by the control plane, which holds the sealed OAuth grant and mints a short-lived access token on
// demand. This module is the daemon's side of that broker: it discovers which providers a project has
// connected from the CP, and for each starts the SAME poll loop the local path uses, differing only in
// where the credential comes from — the CP delivery endpoint, pulled fresh per tick.
//
// This is exactly the local↔hosted swap point hosted-platform.md names ("the only swap point is the
// profile source + the bearer"): nothing about pull/map/fuse changes, only the credential source. The
// short-lived token lives in `ctx.credentials` for one tick and never reaches the snapshot (connectors.md
// §6). Delivery auth is the project auth token the daemon was already provisioned with — the same bearer
// it uses everywhere else — which the CP verifies against the project's sealed auth envelope.

import type { NeatGraph } from '../graph.js'
import type { FirebaseServiceMap } from './firebase/resolve.js'
import { startConnectorPollLoop } from './index.js'
import { decodeRailwayTargetRef } from './railway/target-ref.js'
import { PROVIDER_DISPATCH } from './registry.js'

// The control-plane delivery shapes (INFRA-ADR-011). Mirror of the CP's DeliveredCredential /
// DaemonConnectionSummary — kept structural here so neat-core takes no dependency on the CP package.
interface DeliveredCredential {
  provider: string
  accessToken: string
  /** ISO expiry for a minted token; null for a long-lived (token-paste) credential. */
  expiresAt: string | null
  scopes?: string[]
  subject?: string
  projectRef?: string
}

interface DaemonConnectionSummary {
  provider: string
  subject?: string
  status?: string
  scopes?: string[]
  projectRef?: string
  /** True when the provider is project-scoped and no project is bound yet — not pullable until it is. */
  needsProjectSelection?: boolean
}

export interface HostedConnectorDeps {
  /** Control-plane base URL (NEAT_CP_URL). The daemon calls its `/internal` delivery routes here. */
  cpUrl: string
  /** The control-plane project id (`prj_…`, NEAT_CP_PROJECT_ID) these connections belong to. */
  projectId: string
  /** The project auth token the daemon was provisioned with (NEAT_AUTH_TOKEN) — proves "I am this
   *  project's daemon" to the CP delivery routes. Never logged, never written to the snapshot. */
  daemonToken: string
  fetchImpl?: typeof fetch
}

/** Renew a token this long before its stated expiry, so a poll never fires with a just-expired token. */
const CREDENTIAL_REFRESH_SKEW_MS = 60_000
/** Cap a CP delivery call so a slow control plane can't stall a connector's ticks. */
const CP_REQUEST_TIMEOUT_MS = 10_000
/** Re-list the project's connections on this cadence so a provider connected after boot is picked up without
 *  an instance restart (#1217). One authed GET to the CP; 60s is well within the connect→first-sync budget. */
const DEFAULT_RELIST_INTERVAL_MS = 60_000

async function cpGet<T>(path: string, deps: HostedConnectorDeps): Promise<T> {
  const f = deps.fetchImpl ?? fetch
  const res = await f(`${deps.cpUrl.replace(/\/+$/, '')}${path}`, {
    headers: { authorization: `Bearer ${deps.daemonToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(CP_REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`control plane ${path} → HTTP ${res.status}`)
  return (await res.json()) as T
}

/**
 * Map a delivered credential into the credential record the provider's connector reads at poll time — the
 * hosted counterpart of `resolveEntryCredentials` (registry.ts). Provider-specific because the credential
 * *key* is (Supabase's `managementToken`, etc.); the mapping never touches poll/map logic (connectors.md §3).
 */
function credentialRecord(provider: string, cred: DeliveredCredential): Record<string, unknown> {
  switch (provider) {
    case 'supabase':
      return { managementToken: cred.accessToken }
    case 'gcp':
      // One Google grant serves the GCP-scoped connectors, and they all read the same `{ projectId,
      // accessToken }` off the credential; the picked GCP project id rides in `projectRef`. Without it there
      // is nothing to poll, so fail the tick rather than send a half-credential.
      if (!cred.projectRef) throw new Error('gcp credential delivered without a project ref')
      return { projectId: cred.projectRef, accessToken: cred.accessToken }
    default:
      // A provider whose hosted delivery lands as a plain bearer under `token` (Railway, etc.).
      return { token: cred.accessToken }
  }
}

/**
 * Derive the connector `options` for a hosted connection from what the CP knows (the picked project) plus
 * the daemon's own project identity. Returns null when the connection can't be turned into a runnable
 * connector yet (e.g. no project picked). Never a profile-branch on mapping logic — only option assembly.
 */
function hostedOptions(
  provider: string,
  summary: DaemonConnectionSummary,
  serviceName: string,
  firebaseServiceMap?: FirebaseServiceMap,
): Record<string, unknown> | null {
  switch (provider) {
    case 'supabase': {
      const ref = summary.projectRef
      if (!ref) return null
      // `nodeRef` is the Supabase host the static `createClient()` extractor keys the project InfraNode on —
      // `<ref>.supabase.co` in the common case (SupabaseConnectorConfig.nodeRef). `serviceName` is this
      // project's own service, the origin of the observed edge. If the app connects to a custom host, the
      // edge simply doesn't resolve — an honest miss, exactly as the local profile's would be.
      return { apiProjectRef: ref, nodeRef: `${ref}.supabase.co`, serviceName }
    }
    case 'railway': {
      // Railway's pull target is an (environmentId, serviceId) pair, not a single ref — the picker packs both
      // into `projectRef` as a base64url composite (railway/target-ref.ts). Decode it into the two ids the
      // connector needs; `serviceNameById` maps the *Railway* serviceId to this daemon's own NEAT service name
      // (`serviceName`, the observed edge's origin), the same role the Supabase case's `serviceName` plays —
      // never the Railway service's own label, which names a different authority (railway/types.ts §Fusion).
      const target = summary.projectRef ? decodeRailwayTargetRef(summary.projectRef) : null
      if (!target) return null
      return {
        environmentId: target.environmentId,
        serviceId: target.serviceId,
        serviceNameById: { [target.serviceId]: serviceName },
      }
    }
    case 'firebase': {
      // No per-tenant setup: the connector works out which service a resource belongs to from the graph
      // (`inferServices`: a name match, else the one service that declares the requested route), and an
      // ambiguous or unknown resource stays an honest miss. NEAT_FIREBASE_SERVICE_MAP is only an optional
      // override for a tenant whose resource names can't be inferred; its explicit entries win.
      // Cloud Run (also fanned out from a gcp grant) reads the `cloud_run_revision` request logs, so
      // Firebase leaves that resource type to it rather than counting each request twice.
      return { inferServices: true, excludeCloudRun: true, ...(firebaseServiceMap ?? {}) }
    }
    case 'cloud-run':
    case 'gcp-lb':
      // Same no-setup rule as Firebase: infer the owning service from the graph; an unknown one stays coarse.
      return { inferServices: true }
    default:
      return null
  }
}

/** Parse the optional NEAT_FIREBASE_SERVICE_MAP override (JSON: { functions?, cloudRun?, hosting? }, each name
 *  -> NEAT service). Returns undefined for absent or malformed input rather than throwing — a bad override is
 *  ignored and inference still runs; it never takes the daemon slot down. */
export function parseFirebaseServiceMap(raw: string | undefined): FirebaseServiceMap | undefined {
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const out: FirebaseServiceMap = {}
    for (const key of ['functions', 'cloudRun', 'hosting'] as const) {
      const group = (parsed as Record<string, unknown>)[key]
      if (group === undefined) continue
      if (!group || typeof group !== 'object' || Array.isArray(group)) return undefined
      const entries = Object.entries(group as Record<string, unknown>)
      if (entries.some(([, v]) => typeof v !== 'string' || v.length === 0)) return undefined
      out[key] = Object.fromEntries(entries) as Record<string, string>
    }
    return Object.keys(out).length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

/**
 * The pull connectors one control-plane connection drives. The control plane holds a single `gcp` grant for
 * the whole provider (INFRA-ADR-010: one consent, not one per connector), so the daemon fans it out to every
 * GCP connector, all of which read Cloud Logging `entries.list` with the same `{ projectId, accessToken }`.
 * A tenant with no load balancer, say, simply gets an empty poll from that one.
 */
const HOSTED_CONNECTORS_FOR: Record<string, readonly string[]> = {
  gcp: ['firebase', 'cloud-run', 'gcp-lb'],
}

/**
 * A per-tick credential source for one hosted provider: pull a short-lived credential from the CP and
 * cache it until just before its expiry, so a poll always runs with a live token but the CP is hit only
 * when the token is (near) stale, not every tick. A token-paste credential carries no expiry and is fetched
 * once. Handed to `startConnectorPollLoop` as `refreshCredentials`.
 */
export function createHostedCredentialSource(
  provider: string,
  deps: HostedConnectorDeps,
): () => Promise<Record<string, unknown>> {
  let cached: { record: Record<string, unknown>; expiresAtMs: number } | null = null
  return async () => {
    if (cached && cached.expiresAtMs - CREDENTIAL_REFRESH_SKEW_MS > Date.now()) return cached.record
    const cred = await cpGet<DeliveredCredential>(
      `/internal/projects/${deps.projectId}/connections/${provider}/credential`,
      deps,
    )
    const record = credentialRecord(provider, cred)
    const parsed = cred.expiresAt ? Date.parse(cred.expiresAt) : Number.NaN
    cached = { record, expiresAtMs: Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY }
    return record
  }
}

export interface StartHostedConnectorsInput {
  deps: HostedConnectorDeps
  graph: NeatGraph
  /** The project's working directory, handed to each poll as ctx.projectDir. */
  projectDir: string
  /** The daemon's project name — ctx.project and the derived serviceName the observed edge originates from. */
  project: string
  /** The slot's incident ledger, for an incident-emitting connector (ADR-185). */
  errorsPath?: string
  /** Optional explicit Firebase resource-name -> NEAT-service overrides; inference covers the rest. */
  firebaseServiceMap?: FirebaseServiceMap
  onSkip?: (provider: string, reason: string) => void
  /** Test seam: the poll-loop starter (defaults to startConnectorPollLoop), so wiring can be asserted
   *  without firing a real provider poll. Mirrors api.ts's injectable `runPoll`. */
  startLoop?: typeof startConnectorPollLoop
  /** How often to re-list connections from the control plane (default 60s). Test seam / tunable. */
  intervalMs?: number
}

/** A connection currently running its loops, tracked so a re-list pass can diff against it (#1217). */
interface RunningConnection {
  /** The project-selection fields whose change forces a stop-and-restart; see `connectionSignature`. */
  signature: string
  /** Tears down every loop this connection drives. */
  stop: () => void
}

/**
 * The fields that decide whether a connection is runnable and against which project. When this changes for a
 * provider already running (the customer picked a different project, or a pending selection resolved), the
 * connection is torn down and restarted against the new target. Provider is the running-map key, so it isn't
 * part of the signature.
 */
function connectionSignature(c: DaemonConnectionSummary): string {
  return `${c.projectRef ?? ''}|${c.needsProjectSelection ? 1 : 0}`
}

/**
 * Start every poll loop one control-plane connection drives, and return a single stop that tears them all
 * down. This is the per-connection body of a discovery pass, factored out so the re-list loop can start and
 * stop connections one at a time (#1217). A connection that starts zero loops (no project picked, unknown
 * provider) still returns a no-op stop and is still recorded by the caller, so its skip is logged once rather
 * than on every re-list, and a later project pick registers as a signature change.
 */
function startConnectionLoops(
  c: DaemonConnectionSummary,
  input: StartHostedConnectorsInput,
  startLoop: typeof startConnectorPollLoop,
): () => void {
  const { deps, graph, projectDir, project, errorsPath, onSkip } = input
  const stops: Array<() => void> = []
  // One credential source per connection, shared by every connector it drives, so a fan-out of three
  // connectors is one control-plane fetch per token lifetime, not three.
  const credentialSource = createHostedCredentialSource(c.provider, deps)
  for (const name of HOSTED_CONNECTORS_FOR[c.provider] ?? [c.provider]) {
    const dispatch = PROVIDER_DISPATCH[name]
    if (!dispatch) {
      onSkip?.(name, 'no pull connector for this provider')
      continue
    }
    if (c.needsProjectSelection || !c.projectRef) {
      onSkip?.(name, 'no project selected yet — not pullable')
      continue
    }
    const options = hostedOptions(name, c, project, input.firebaseServiceMap)
    if (!options) {
      onSkip?.(name, 'no hosted option mapping for this provider')
      continue
    }
    let built
    try {
      built = dispatch.build(graph, options)
    } catch (err) {
      onSkip?.(name, (err as Error).message)
      continue
    }
    stops.push(
      startLoop(
        built.connector,
        { projectDir, project, credentials: {}, ...(errorsPath ? { errorsPath } : {}) },
        graph,
        built.resolveTarget,
        {
          connectorId: `hosted:${name}`,
          // The credential is fetched by the CONNECTION's provider (`gcp`), not the connector's name.
          refreshCredentials: credentialSource,
        },
      ),
    )
  }
  return () => {
    for (const stop of stops) stop()
  }
}

/**
 * One discovery pass: list the project's connections from the control plane and reconcile them against the
 * running set — start loops for new connections, stop loops for removed ones, restart a connection whose
 * project selection changed, and leave unchanged ones running (#1217). Never throws: a control-plane read
 * failure logs via `onSkip` and leaves the running set intact, so a transient CP blip doesn't tear down
 * working loops — the slot survives exactly as it does a malformed connectors.json.
 */
async function runHostedConnectorsPass(
  input: StartHostedConnectorsInput,
  startLoop: typeof startConnectorPollLoop,
  running: Map<string, RunningConnection>,
): Promise<void> {
  const { deps, onSkip } = input
  let connections: DaemonConnectionSummary[]
  try {
    connections = await cpGet<DaemonConnectionSummary[]>(`/internal/projects/${deps.projectId}/connections`, deps)
  } catch (err) {
    onSkip?.('(all)', `control plane connection list unreadable — ${(err as Error).message}`)
    return
  }
  if (!Array.isArray(connections)) return

  const seen = new Set<string>()
  for (const c of connections) {
    // Keyed by provider: the CP models one grant per provider (INFRA-ADR-010), and the credential route is
    // per-provider too. A duplicate provider in the list is degenerate — the last one seen wins.
    seen.add(c.provider)
    const signature = connectionSignature(c)
    const existing = running.get(c.provider)
    if (existing && existing.signature === signature) continue
    if (existing) existing.stop() // signature changed (e.g. project re-picked) — restart against the new one
    running.set(c.provider, { signature, stop: startConnectionLoops(c, input, startLoop) })
  }
  for (const [provider, rc] of running) {
    if (seen.has(provider)) continue
    rc.stop() // gone from the control plane — stop its loops
    running.delete(provider)
  }
}

/**
 * Discover this project's connected providers from the control plane and start a poll loop for each, then
 * re-list on a cadence so a provider connected (or disconnected, or re-pointed at another project) after boot
 * is reconciled without an instance restart (#1217). Every connector's credential is still sourced from the
 * CP per tick (INFRA-ADR-011). Returns one stop that halts the schedule and tears every loop down. Never
 * throws: a discovery failure logs via `onSkip` and starts nothing that pass, and the next re-list recovers —
 * so the daemon slot survives a briefly unreachable control plane exactly as it survives a bad connectors.json.
 */
export async function startHostedConnectors(input: StartHostedConnectorsInput): Promise<() => void> {
  const startLoop = input.startLoop ?? startConnectorPollLoop
  const intervalMs = input.intervalMs ?? DEFAULT_RELIST_INTERVAL_MS
  const running = new Map<string, RunningConnection>()
  let stopped = false
  let inPass = false
  const tick = async () => {
    if (stopped || inPass) return
    inPass = true
    try {
      await runHostedConnectorsPass(input, startLoop, running)
    } finally {
      inPass = false
    }
  }
  // The boot pass is awaited (unlike hosted-repos' fire-and-forget boot) so the caller — and the tests, which
  // assert the started set synchronously — see the first discovery's loops up by the time this resolves.
  await tick()
  const timer = setInterval(() => {
    void tick()
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return () => {
    stopped = true
    clearInterval(timer)
    for (const rc of running.values()) rc.stop()
    running.clear()
  }
}

export interface MaybeStartHostedConnectorsInput {
  graph: NeatGraph
  projectDir: string
  project: string
  errorsPath?: string
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  onSkip?: (provider: string, reason: string) => void
  /** How often to re-list connections (default 60s). Test seam; daemon.ts leaves it at the default. */
  intervalMs?: number
}

/**
 * The daemon slot calls this unconditionally; it starts hosted connectors only when the hosted-profile env
 * is present (NEAT_CP_URL + NEAT_CP_PROJECT_ID + NEAT_AUTH_TOKEN, all injected by the provisioner). Absent
 * — the local daemon — it's a no-op stop. This keeps daemon.ts one additive line rather than a hosted
 * branch inside the slot (hosted-platform.md: hosted wraps, never forks).
 */
export async function maybeStartHostedConnectors(input: MaybeStartHostedConnectorsInput): Promise<() => void> {
  const env = input.env ?? process.env
  const cpUrl = env.NEAT_CP_URL
  const projectId = env.NEAT_CP_PROJECT_ID
  const daemonToken = env.NEAT_AUTH_TOKEN
  if (!cpUrl || !projectId || !daemonToken) return () => {}
  return startHostedConnectors({
    deps: { cpUrl, projectId, daemonToken, ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) },
    graph: input.graph,
    projectDir: input.projectDir,
    project: input.project,
    ...(parseFirebaseServiceMap(env.NEAT_FIREBASE_SERVICE_MAP)
      ? { firebaseServiceMap: parseFirebaseServiceMap(env.NEAT_FIREBASE_SERVICE_MAP) }
      : {}),
    ...(input.errorsPath ? { errorsPath: input.errorsPath } : {}),
    ...(input.onSkip ? { onSkip: input.onSkip } : {}),
    ...(input.intervalMs !== undefined ? { intervalMs: input.intervalMs } : {}),
  })
}
