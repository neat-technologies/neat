// Hosted-profile credential sourcing for the connectors plane (connectors.md §3, INFRA-ADR-011).
//
// The local profile reads a connector's credential from ~/.neat/connectors.json (an env-ref resolved at
// slot bootstrap). The hosted profile has no such file — the credential is brokered on the customer's
// behalf by the control plane, which holds the sealed OAuth grant and mints a short-lived access token on
// demand. This module is the daemon's side of that broker: it discovers which providers a project has
// connected from the CP, and for each runs the SAME lifecycle the local path runs — the poll loop for a
// pull provider, `validate → provision` for a push provider (a Vercel drain, ADR-146) — differing only in
// where the credential comes from: the CP delivery endpoint instead of connectors.json.
//
// This is exactly the local↔hosted swap point hosted-platform.md names ("the only swap point is the
// profile source + the bearer"): nothing about pull/map/fuse or provision changes, only the credential
// source. A pull credential lives in `ctx.credentials` for one tick; a push credential is used once to
// provision and then discarded. Neither reaches the snapshot (connectors.md §6). Delivery auth is the
// project auth token the daemon was already provisioned with — the same bearer it uses everywhere else —
// which the CP verifies against the project's sealed auth envelope.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { NeatGraph } from '../graph.js'
import type { FirebaseServiceMap } from './firebase/resolve.js'
import { startConnectorPollLoop } from './index.js'
import { decodeRailwayTargetRef } from './railway/target-ref.js'
import { PROVIDER_DISPATCH, getPushProviderDispatch, type PushProviderDispatch } from './registry.js'

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
  /** This daemon's externally reachable base URL (NEAT_PUBLIC_URL, injected by the provisioner). A push
   *  provider's drain delivers to `<publicUrl>/v1/traces`; without it no drain can be provisioned. */
  publicUrl?: string
  /** The bearer this daemon's OTLP receiver expects (NEAT_OTEL_TOKEN). Falls back to `daemonToken`, which
   *  the receiver honours too (one-command-cli.md). */
  otelToken?: string
  fetchImpl?: typeof fetch
}

/** Renew a token this long before its stated expiry, so a poll never fires with a just-expired token. */
const CREDENTIAL_REFRESH_SKEW_MS = 60_000
/** Cap a CP delivery call so a slow control plane can't stall a connector's ticks. */
const CP_REQUEST_TIMEOUT_MS = 10_000

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

// ── Push providers (a drain, not a poll) ────────────────────────────────────────────────────────────────
//
// A push provider has no `poll()`. Its lifecycle is `validate → provision` once, after which the provider
// forwards telemetry to this daemon's OTLP receiver on its own (connectors.md, push section). The hosted
// path runs that lifecycle through the SAME dispatch `neat connector add` uses (PUSH_PROVIDER_DISPATCH),
// with the credential brokered by the CP. The one thing it must remember across restarts is the handle
// `provision` returned — Vercel's `{ drainId }` — so a restarted daemon re-validates the existing drain
// instead of creating a second one.

/** The handle a push provider's `provision` returned, kept per provider beside the snapshot. Holds no
 *  credential (connectors.md §6) — only the provider-side resource id and the endpoint it delivers to. */
interface HostedPushHandle {
  endpoint: string
  options: Record<string, unknown>
  provisionedAt: string
}

function pushHandlesPath(projectDir: string): string {
  return join(projectDir, 'neat-out', 'connectors-hosted.json')
}

async function readPushHandles(projectDir: string): Promise<Record<string, HostedPushHandle>> {
  try {
    const parsed = JSON.parse(await readFile(pushHandlesPath(projectDir), 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, HostedPushHandle>) : {}
  } catch {
    return {}
  }
}

async function writePushHandle(projectDir: string, provider: string, handle: HostedPushHandle): Promise<void> {
  const path = pushHandlesPath(projectDir)
  const handles = await readPushHandles(projectDir)
  handles[provider] = handle
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(handles, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/**
 * The credential record a push provider's dispatch reads. Vercel's drain needs two secrets: the customer's
 * Vercel token (brokered by the CP) and the bearer the drain presents to this daemon's OTLP receiver — the
 * daemon's own, never the customer's.
 */
function pushCredentialRecord(
  provider: string,
  cred: DeliveredCredential,
  deps: HostedConnectorDeps,
): Record<string, unknown> {
  switch (provider) {
    case 'vercel':
      return { token: cred.accessToken, otelToken: deps.otelToken ?? deps.daemonToken }
    default:
      return { token: cred.accessToken }
  }
}

/**
 * Options for a push provider's provision. A Vercel drain is team-scoped and delivers to a URL, so both
 * must be known: the CP captures the team id at connect time (delivered as `projectRef`), and the
 * provisioner tells this daemon its own public URL. Absent either, the drain has no scope or nowhere to
 * deliver — the caller skips with the reason rather than provisioning something half-addressed.
 */
function hostedPushOptions(
  provider: string,
  summary: DaemonConnectionSummary,
  deps: HostedConnectorDeps,
): { options: Record<string, unknown>; endpoint: string } | { skip: string } {
  switch (provider) {
    case 'vercel': {
      if (!deps.publicUrl) {
        return { skip: 'no public URL for this daemon (NEAT_PUBLIC_URL) — a drain has nowhere to deliver' }
      }
      if (!summary.projectRef) return { skip: 'no Vercel team selected yet — drains are team-scoped' }
      const endpoint = `${deps.publicUrl.replace(/\/+$/, '')}/v1/traces`
      return { options: { teamId: summary.projectRef, endpoint }, endpoint }
    }
    default:
      return { skip: 'no hosted option mapping for this push provider' }
  }
}

/**
 * Run a push provider's lifecycle for one hosted connection: the SAME `validate → provision` that
 * `neat connector add <provider>` runs locally, with the credential brokered by the control plane. Provisions
 * once — a recorded handle for the same endpoint means the drain already exists, so a restart only
 * re-validates delivery. Never throws; every failure lands in `onSkip` with its reason, and `onProvisioned`
 * fires only once the provider has confirmed the drain reaches this daemon.
 */
async function provisionHostedPushProvider(
  summary: DaemonConnectionSummary,
  dispatch: PushProviderDispatch,
  input: StartHostedConnectorsInput,
): Promise<void> {
  const { deps, projectDir, onSkip, onProvisioned } = input
  const provider = summary.provider
  const mapped = hostedPushOptions(provider, summary, deps)
  if ('skip' in mapped) {
    onSkip?.(provider, mapped.skip)
    return
  }
  let cred: DeliveredCredential
  try {
    cred = await cpGet<DeliveredCredential>(
      `/internal/projects/${deps.projectId}/connections/${provider}/credential`,
      deps,
    )
  } catch (err) {
    onSkip?.(provider, `credential delivery failed — ${(err as Error).message}`)
    return
  }
  const credentials = pushCredentialRecord(provider, cred, deps)
  const existing = (await readPushHandles(projectDir))[provider]
  const alreadyProvisioned = existing !== undefined && existing.endpoint === mapped.endpoint
  const options = alreadyProvisioned ? { ...mapped.options, ...existing.options } : mapped.options
  const seam = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}

  const validation = await dispatch.validate({ credentials, options, ...seam })
  if (!validation.ok) {
    onSkip?.(provider, `drain delivery test failed — ${validation.reason}`)
    return
  }
  if (alreadyProvisioned) {
    onProvisioned?.(provider, 'drain already provisioned — delivery re-validated')
    return
  }
  const result = await dispatch.provision({ credentials, options, ...seam })
  if (!result.ok) {
    onSkip?.(provider, `drain provisioning failed — ${result.reason}`)
    return
  }
  await writePushHandle(projectDir, provider, {
    endpoint: mapped.endpoint,
    options: result.options ?? {},
    provisionedAt: new Date().toISOString(),
  })
  onProvisioned?.(provider, result.note)
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
  /** Test seam: the push-dispatch lookup (defaults to getPushProviderDispatch), so a drain's
   *  `validate → provision` can be asserted without a real provider call. */
  pushDispatch?: typeof getPushProviderDispatch
  /** Fires once a push provider's drain is confirmed reaching this daemon — provisioned, or re-validated on
   *  a restart. The signal the hosted side reads as "connected", as opposed to "a token is stored". */
  onProvisioned?: (provider: string, note?: string) => void
}

/**
 * Discover this project's connected providers from the control plane and start a poll loop for each,
 * sourcing every one's credential from the CP per tick (INFRA-ADR-011). Returns one stop that tears every
 * loop down. Never throws: a discovery failure logs via `onSkip` and starts nothing, so the daemon slot
 * survives a control plane that's briefly unreachable exactly as it survives a malformed connectors.json.
 */
export async function startHostedConnectors(input: StartHostedConnectorsInput): Promise<() => void> {
  const { deps, graph, projectDir, project, errorsPath, onSkip } = input
  const startLoop = input.startLoop ?? startConnectorPollLoop
  let connections: DaemonConnectionSummary[]
  try {
    connections = await cpGet<DaemonConnectionSummary[]>(`/internal/projects/${deps.projectId}/connections`, deps)
  } catch (err) {
    onSkip?.('(all)', `control plane connection list unreadable — ${(err as Error).message}`)
    return () => {}
  }
  if (!Array.isArray(connections)) return () => {}

  const stops: Array<() => void> = []
  const lookupPush = input.pushDispatch ?? getPushProviderDispatch
  for (const c of connections) {
    // A push provider provisions a drain instead of being polled — same dispatch `neat connector add` uses.
    // Nothing to stop afterwards: the drain lives provider-side until it's deprovisioned.
    const push = lookupPush(c.provider)
    if (push) {
      await provisionHostedPushProvider(c, push, input)
      continue
    }
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
  }
  return () => {
    for (const stop of stops) stop()
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
    deps: {
      cpUrl,
      projectId,
      daemonToken,
      ...(env.NEAT_PUBLIC_URL ? { publicUrl: env.NEAT_PUBLIC_URL } : {}),
      ...(env.NEAT_OTEL_TOKEN ? { otelToken: env.NEAT_OTEL_TOKEN } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    },
    graph: input.graph,
    projectDir: input.projectDir,
    project: input.project,
    ...(parseFirebaseServiceMap(env.NEAT_FIREBASE_SERVICE_MAP)
      ? { firebaseServiceMap: parseFirebaseServiceMap(env.NEAT_FIREBASE_SERVICE_MAP) }
      : {}),
    ...(input.errorsPath ? { errorsPath: input.errorsPath } : {}),
    ...(input.onSkip ? { onSkip: input.onSkip } : {}),
  })
}
