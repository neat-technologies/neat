/**
 * Multi-project daemon (ADR-049).
 *
 * Single long-lived process watching every project in the machine-level registry.
 * Per-project graph isolation: each registered project owns its own
 * `MultiDirectedGraph` slot keyed by name (ADR-026), and a failure during
 * one project's bootstrap is logged + marked `broken` without taking down
 * the rest of the daemon.
 *
 * MVP scope (v0.2.5):
 *  - Read registry; refuse to boot when it's missing.
 *  - Write PID at `~/.neat/neatd.pid` for external supervisors.
 *  - Per project: load any existing snapshot, run initial extraction,
 *    start a per-project persist loop.
 *  - SIGHUP triggers a reload — re-reads the registry, picks up new
 *    projects, drops removed ones, leaves untouched ones in place.
 *  - Provide `routeSpanToProject(serviceName, projects)` for OTel ingest
 *    to dispatch by `service.name` across registered projects, falling
 *    back to `default` for unknown services per ADR-033.
 *
 * Out of MVP scope (deferred):
 *  - Live OTel listener wiring per project — daemon exposes the routing
 *    primitive; the actual receiver attachment lands alongside v0.2.6.
 *  - Policy reload on `policy.json` mtime — `startWatch` already does this
 *    per-project; the daemon-level loop reuses that machinery in a follow-up.
 *  - Auto-restart on crash. PID file is the supervisor handoff.
 */

import { promises as fs, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { DEFAULT_PROJECT, getGraph, resetGraph, type NeatGraph } from './graph.js'
import { extractFromDirectory } from './extract.js'
import { loadGraphFromDisk, startPersistLoop } from './persist.js'
import { Projects, pathsForProject, type ProjectPaths } from './projects.js'
import { buildApi } from './api.js'
import { buildOtelReceiver } from './otel.js'
import { attachGraphToEventBus } from './events.js'
import { handleSpan, makeErrorSpanWriter } from './ingest.js'
import {
  listProjects,
  pruneRegistry,
  registryPath,
  setStatus,
  touchLastSeen,
  writeAtomically,
} from './registry.js'
import { assertBindAuthority, readAuthEnv } from './auth.js'
import {
  appendUnroutedSpan,
  buildUnroutedSpanRecord,
  unroutedErrorsPath,
} from './unrouted.js'
import type { RegistryEntry } from '@neat.is/types'

export interface DaemonOptions {
  // Defaults to `~/.neat/`. Honors NEAT_HOME the same way registry.ts does.
  // Tests override via NEAT_HOME and don't pass this directly.
  neatHome?: string
  // ADR-063 — bind targets. Defaults to PORT (8080) / OTEL_PORT (4318) env
  // vars, matching server.ts. Tests pass 0 to get ephemeral ports.
  restPort?: number
  otlpPort?: number
  // ADR-063 — bind host. Defaults to HOST env (0.0.0.0).
  host?: string
  // ADR-063 — opt out of binding entirely (e.g. integration tests that
  // exercise daemon slots without needing the listeners). Production
  // `neatd start` never sets this.
  bindListeners?: boolean
}

export interface ProjectSlot {
  entry: RegistryEntry
  graph: NeatGraph
  outPath: string
  paths: ProjectPaths
  stopPersist: () => void
  // #475 — removes the event-bus listeners attachGraphToEventBus installed
  // on this slot's graph. No-op for broken slots. Must run wherever the slot
  // is torn down or replaced, or a reloaded slot's old graph keeps emitting.
  detachEvents: () => void
  status: 'active' | 'broken'
  errorReason?: string
}

// Best-effort slot teardown — stop the persist loop and detach the slot's
// graph from the event bus (#475). Every path that drops or replaces a slot
// (registry removal, daemon stop, bind-failure rollback, broken-slot
// recovery) goes through here so no path leaks listeners.
function teardownSlot(slot: ProjectSlot): void {
  try {
    slot.stopPersist()
  } catch {
    // best-effort
  }
  try {
    slot.detachEvents()
  } catch {
    // best-effort
  }
}

// Issue #340 — per-project bootstrap state surface. The REST listener
// flips to live the moment `app.listen()` returns; per-project routes
// branch on this rather than waiting for every registered project's
// extractFromDirectory pass to finish.
export type BootstrapPhase = 'bootstrapping' | 'active' | 'broken'

export interface BootstrapTracker {
  status: (name: string) => BootstrapPhase | undefined
  list: () => Array<{ name: string; status: BootstrapPhase; elapsedMs: number }>
}

export interface DaemonHandle {
  // The slots currently being managed, keyed by project name. Tests inspect
  // this to assert isolation properties.
  slots: Map<string, ProjectSlot>
  // Re-read the registry. New entries get bootstrapped, removed ones get
  // their persist loops stopped, existing ones stay running.
  reload: () => Promise<void>
  // Graceful shutdown — stop every project's persist loop and remove the
  // PID file.
  stop: () => Promise<void>
  // Path to the PID file the daemon owns. Useful for test assertions.
  pidPath: string
  // ADR-063 — addresses where consumers reach the daemon. Empty string when
  // bindListeners is false. REST is the Fastify app's listening address;
  // OTLP is the receiver's.
  restAddress: string
  otlpAddress: string
  // Issue #340 — per-project bootstrap status, surfaced for orchestrator
  // poll loops and tests.
  bootstrap: BootstrapTracker
  // Resolves when the daemon's initial bootstrap pass has settled. Tests
  // that probe project-scoped routes immediately after startDaemon await
  // this; production callers use /health.
  initialBootstrap: Promise<void>
}

function neatHomeFor(opts: DaemonOptions): string {
  if (opts.neatHome && opts.neatHome.length > 0) return path.resolve(opts.neatHome)
  const env = process.env.NEAT_HOME
  if (env && env.length > 0) return path.resolve(env)
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  return path.join(home, '.neat')
}

/**
 * Resolve which project's graph an OTel span belongs to. Looks up the
 * `service.name` against the registry and returns the matching project's
 * name, or `DEFAULT_PROJECT` for unknown services so the FrontierNode
 * auto-creation flow keeps working per ADR-033.
 *
 * Pure function. Daemon callers pass a snapshot of the registry to avoid
 * per-span fs reads.
 *
 * Matching order (ADR-072 — real-world `service.name` rarely equals project
 * name; monorepos publish per-package names like `brief-api` under a
 * project named `brief`):
 *
 *   1. Exact: `entry.name === serviceName`.
 *   2. Hyphen/underscore-separated prefix: `entry.name` is a leading token
 *      of `serviceName` (`brief` matches `brief-api`, `brief_worker`).
 *      Longest-match wins so `brief-api` beats `brief` when both are
 *      registered.
 *   3. Containment as a separator-delimited token (`api` inside
 *      `brief-api-staging`).
 *
 * Routing eligibility (ADR-071):
 * - `active` matches at every pass (the steady-state path).
 * - `broken` also matches — the daemon needs the span to reach the broken
 *   slot so the ingest-time auto-recover path can attempt a bootstrap and
 *   lift the project back to `active`. The router only chooses the target;
 *   whether the span actually lands is the ingest handler's decision.
 * - `paused` is intentionally not routed; the operator paused it on
 *   purpose, so the span falls through to the default-project flow.
 *
 * Falls back to `DEFAULT_PROJECT` when nothing matches.
 */
export function routeSpanToProject(
  serviceName: string | undefined,
  projects: ReadonlyArray<RegistryEntry>,
): string {
  if (!serviceName) return DEFAULT_PROJECT
  // Pass 1 — exact match.
  for (const entry of projects) {
    if (entry.status === 'paused') continue
    if (entry.name === serviceName) return entry.name
  }
  // Pass 2 — hyphen/underscore-separated prefix. Longest project name wins
  // so a registered `brief-api` outranks a registered `brief` when the
  // span's service.name is `brief-api-staging`.
  const candidates: RegistryEntry[] = []
  for (const entry of projects) {
    if (entry.status === 'paused') continue
    if (isTokenPrefix(entry.name, serviceName)) candidates.push(entry)
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.name.length - a.name.length)
    return candidates[0]!.name
  }
  // Pass 3 — containment as a separator-delimited token. Last-resort match
  // for `api` inside `brief-api-staging` when only `api` is registered.
  for (const entry of projects) {
    if (entry.status === 'paused') continue
    if (isTokenContained(entry.name, serviceName)) return entry.name
  }
  return DEFAULT_PROJECT
}

// True when `prefix` matches the first hyphen/underscore-separated token(s)
// of `full`. `brief` matches `brief-api`, `brief_worker`, but not `briefcase`.
function isTokenPrefix(prefix: string, full: string): boolean {
  if (prefix.length >= full.length) return false
  if (!full.startsWith(prefix)) return false
  const sep = full.charAt(prefix.length)
  return sep === '-' || sep === '_'
}

// True when `needle` appears in `haystack` bordered by separators on both
// sides (so it's a complete token, not a substring of a longer word).
function isTokenContained(needle: string, haystack: string): boolean {
  if (!haystack.includes(needle)) return false
  const tokens = haystack.split(/[-_]/)
  return tokens.includes(needle)
}

async function bootstrapProject(entry: RegistryEntry): Promise<ProjectSlot> {
  const paths = pathsForProject(entry.name, path.join(entry.path, 'neat-out'))

  // Path missing on disk → mark broken and surface the reason. Daemon
  // continues with the rest of the registry.
  try {
    const stat = await fs.stat(entry.path)
    if (!stat.isDirectory()) {
      throw new Error(`registered path ${entry.path} is not a directory`)
    }
  } catch (err) {
    await setStatus(entry.name, 'broken').catch(() => {})
    return {
      entry,
      // Empty graph is fine — `slots` keeps the entry visible in `status`
      // output; nothing routes to it because it's not 'active'.
      graph: getGraph(`__broken__:${entry.name}`),
      outPath: '',
      paths,
      stopPersist: () => {},
      detachEvents: () => {},
      status: 'broken',
      errorReason: (err as Error).message,
    }
  }

  // Use the project name as the in-memory graph key. Any prior contents
  // are wiped because the daemon owns the slot for the lifetime of this
  // bootstrap (ADR-030 — mutation authority).
  resetGraph(entry.name)
  const graph = getGraph(entry.name)
  const outPath = paths.snapshotPath

  await loadGraphFromDisk(graph, outPath)
  // #475 — wire graph mutations into the event bus (ADR-051) before extract
  // begins so the initial pass also produces node/edge events, mirroring
  // startWatch. Without this the daemon's SSE stream carries heartbeats and
  // nothing else: handleSse subscribes to a bus no producer feeds, and the
  // dashboard only catches up on a manual refresh.
  const detachEvents = attachGraphToEventBus(graph, { project: entry.name })
  try {
    await extractFromDirectory(graph, entry.path)
    const stopPersist = startPersistLoop(graph, outPath)
    await touchLastSeen(entry.name).catch(() => {})

    return {
      entry,
      graph,
      outPath,
      paths,
      stopPersist,
      detachEvents,
      status: 'active',
    }
  } catch (err) {
    // Bootstrap died after the attach — detach before surfacing so a failed
    // slot can't leave listeners behind on its orphaned graph.
    detachEvents()
    throw err
  }
}

function resolveRestPort(opts: DaemonOptions): number {
  if (typeof opts.restPort === 'number') return opts.restPort
  const env = process.env.PORT
  if (env && env.length > 0) {
    const n = Number.parseInt(env, 10)
    if (Number.isFinite(n)) return n
  }
  return 8080
}

function resolveOtlpPort(opts: DaemonOptions): number {
  if (typeof opts.otlpPort === 'number') return opts.otlpPort
  const env = process.env.OTEL_PORT
  if (env && env.length > 0) {
    const n = Number.parseInt(env, 10)
    if (Number.isFinite(n)) return n
  }
  return 4318
}

function resolveHost(opts: DaemonOptions, authTokenSet: boolean): string {
  if (opts.host && opts.host.length > 0) return opts.host
  const env = process.env.HOST
  if (env && env.length > 0) return env
  // Issue #341 — loopback-only default when the operator hasn't set a token.
  // Public-bind on a clean install demanded one before binding could
  // succeed, so the npx-`neat .` first-touch path used to refuse to come up;
  // pinning to 127.0.0.1 lets that path bind cleanly. Anyone wanting a
  // public bind sets `NEAT_AUTH_TOKEN` (and `HOST=0.0.0.0` if they want it
  // spelled out). `assertBindAuthority` stays exactly as it is — the
  // contract is right; the default was wrong.
  if (!authTokenSet) return '127.0.0.1'
  return '0.0.0.0'
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const home = neatHomeFor(opts)
  const regPath = registryPath()
  // Graceful degradation per ADR-049 #6: missing registry refuses to boot
  // with a clear error rather than silently coming up empty.
  try {
    await fs.access(regPath)
  } catch {
    throw new Error(
      `neatd: registry not found at ${regPath}. Run \`neat init <path>\` to register a project before starting the daemon.`,
    )
  }

  const pidPath = path.join(home, 'neatd.pid')
  await writeAtomically(pidPath, `${process.pid}\n`)

  const slots = new Map<string, ProjectSlot>()
  // Projects registry mirrors slots for the REST listener (ADR-063). buildApi
  // reads from this; we keep it in sync as slots come and go.
  const registry = new Projects()
  // Issue #340 — per-project bootstrap status. Populated from the registry
  // before the listener binds so the REST handlers can return 503 instead of
  // 404 for projects still extracting.
  const bootstrapStatus = new Map<string, BootstrapPhase>()
  const bootstrapStartedAt = new Map<string, number>()

  // Rate-limit the dropped-span warning to one log line per project per
  // 60 seconds. OTel exporters retry on a tight cadence; without this we
  // flood the console with the same line per batch when a broken project
  // is sitting in the registry.
  const DROP_WARN_INTERVAL_MS = 60_000
  const lastDropWarnAt = new Map<string, number>()
  function warnDroppedSpan(project: string, reason: string): void {
    const now = Date.now()
    const prev = lastDropWarnAt.get(project) ?? 0
    if (now - prev < DROP_WARN_INTERVAL_MS) return
    lastDropWarnAt.set(project, now)
    console.warn(
      `[neatd] dropping span for project "${project}" — project status: broken (${reason}). Run \`neatd reload\` to retry bootstrap.`,
    )
  }

  // v0.4.1 / refs #339 — when a span's `service.name` doesn't match any
  // registered project AND no `default` project is registered, the span has
  // nowhere to land. We still return 200 on the receiver (OTel spec) but the
  // event lands in <NEAT_HOME>/errors.ndjson so the next operator can see
  // what happened instead of the daemon's stderr being the only signal.
  // Same rate limit as the broken-project warning, keyed by service.name.
  const unroutedPath = unroutedErrorsPath(home)
  const lastUnroutedWarnAt = new Map<string, number>()
  async function recordUnroutedSpan(
    serviceName: string | undefined,
    traceId: string | undefined,
  ): Promise<void> {
    const key = serviceName ?? '<missing>'
    const now = Date.now()
    try {
      await appendUnroutedSpan(home, buildUnroutedSpanRecord(serviceName, traceId, new Date(now)))
    } catch {
      // best-effort — failing to log shouldn't cascade into receiver failure.
    }
    const prev = lastUnroutedWarnAt.get(key) ?? 0
    if (now - prev < DROP_WARN_INTERVAL_MS) return
    lastUnroutedWarnAt.set(key, now)
    console.warn(
      `[neatd] dropping span — service.name "${key}" matches no registered project and no \`default\` project exists. See ${unroutedPath}.`,
    )
  }

  function upsertRegistryFromSlot(slot: ProjectSlot): void {
    if (slot.status !== 'active') return
    registry.set(slot.entry.name, {
      scanPath: slot.entry.path,
      paths: slot.paths,
      graph: slot.graph,
    })
  }

  // Attempt to bring a broken slot back online. Used both on SIGHUP reload
  // and inline on ingest when a span arrives for a broken project. Returns
  // the new slot status so callers can decide whether to deliver the span.
  async function tryRecoverSlot(entry: RegistryEntry): Promise<ProjectSlot> {
    try {
      const fresh = await bootstrapProject(entry)
      // The slot being replaced must release its graph's bus listeners
      // (#475) — a stale attach on the prior graph would double-emit.
      const prior = slots.get(entry.name)
      if (prior) teardownSlot(prior)
      slots.set(entry.name, fresh)
      upsertRegistryFromSlot(fresh)
      if (fresh.status === 'active') {
        await setStatus(entry.name, 'active').catch(() => {})
        console.log(
          `neatd: project "${entry.name}" recovered from broken — active`,
        )
      }
      return fresh
    } catch (err) {
      console.warn(
        `neatd: project "${entry.name}" still broken after recovery attempt — ${(err as Error).message}`,
      )
      // Leave the existing broken slot in place; nothing changed.
      return slots.get(entry.name)!
    }
  }

  async function bootstrapOne(entry: RegistryEntry): Promise<void> {
    bootstrapStatus.set(entry.name, 'bootstrapping')
    bootstrapStartedAt.set(entry.name, Date.now())
    try {
      const slot = await bootstrapProject(entry)
      // Same replacement rule as tryRecoverSlot (#475).
      const prior = slots.get(entry.name)
      if (prior) teardownSlot(prior)
      slots.set(entry.name, slot)
      upsertRegistryFromSlot(slot)
      bootstrapStatus.set(entry.name, slot.status === 'broken' ? 'broken' : 'active')
      if (slot.status === 'broken') {
        console.warn(`neatd: project "${entry.name}" broken — ${slot.errorReason}`)
      } else {
        console.log(`neatd: project "${entry.name}" active (${entry.path})`)
      }
    } catch (err) {
      bootstrapStatus.set(entry.name, 'broken')
      console.warn(
        `neatd: project "${entry.name}" failed to bootstrap — ${(err as Error).message}`,
      )
      await setStatus(entry.name, 'broken').catch(() => {})
    }
  }

  async function loadAll(): Promise<void> {
    // #463 — drop long-dead entries before bootstrapping the rest. An entry
    // whose path is gone (definite ENOENT) and that's been quiet past the TTL
    // gets removed instead of marked `broken` and logged forever. Conservative
    // by design: a transient stat error or a fresh ENOENT entry stays, and the
    // staleness TTL is the safety margin. Best-effort — a prune failure never
    // blocks the daemon from coming up.
    try {
      const pruned = await pruneRegistry()
      for (const entry of pruned) {
        console.log(
          `neatd: pruned project "${entry.name}" — registered path ${entry.path} is gone`,
        )
        slots.delete(entry.name)
        bootstrapStatus.delete(entry.name)
        bootstrapStartedAt.delete(entry.name)
      }
    } catch (err) {
      console.warn(`neatd: registry prune skipped — ${(err as Error).message}`)
    }

    const projects = await listProjects()
    const seen = new Set<string>()
    const pending: Promise<void>[] = []
    for (const entry of projects) {
      seen.add(entry.name)
      const existing = slots.get(entry.name)
      if (existing) {
        if (existing.status === 'broken') {
          pending.push(tryRecoverSlot(entry).then(() => {}))
        }
        continue
      }
      pending.push(bootstrapOne(entry))
    }
    for (const [name, slot] of [...slots.entries()]) {
      if (seen.has(name)) continue
      teardownSlot(slot)
      slots.delete(name)
      bootstrapStatus.delete(name)
      bootstrapStartedAt.delete(name)
      console.log(`neatd: project "${name}" removed from registry — stopped`)
    }
    await Promise.allSettled(pending)
  }

  // Issue #340 — pre-populate bootstrap status from the registry so the REST
  // listener can answer 503 for projects whose slot hasn't loaded yet. Actual
  // bootstrap moves to the background after `listen()` returns.
  const initialEntries = await listProjects().catch(() => [] as RegistryEntry[])
  for (const entry of initialEntries) {
    bootstrapStatus.set(entry.name, 'bootstrapping')
    bootstrapStartedAt.set(entry.name, Date.now())
  }

  // ADR-063 — bind the REST host and the OTLP HTTP receiver. One listener
  // each, multi-tenant by project name in the URL (REST) and by service.name
  // dispatch (OTLP). Failure on either listen aborts startDaemon with a
  // surfacing error rather than letting the supervisor sit half-up.
  const bind = opts.bindListeners !== false
  let restApp: FastifyInstance | null = null
  let otlpApp:
    | (FastifyInstance & { flushPending: () => Promise<void> })
    | null = null
  let restAddress = ''
  let otlpAddress = ''

  if (bind) {
    // ADR-073 §3 — fail-loud before binding. Loopback-only without a token is
    // fine (laptop dev); a public bind without one is not. Resolved here
    // ahead of the host so the loopback-default branch (issue #341) reads
    // the same token state the bind-authority gate does.
    const auth = readAuthEnv()
    const host = resolveHost(opts, Boolean(auth.authToken))
    const restPort = resolveRestPort(opts)
    const otlpPort = resolveOtlpPort(opts)

    assertBindAuthority(host, auth.authToken)

    try {
      restApp = await buildApi({
        projects: registry,
        authToken: auth.authToken,
        trustProxy: auth.trustProxy,
        publicRead: auth.publicRead,
        bootstrap: {
          status: (name) => bootstrapStatus.get(name),
          list: () => {
            const now = Date.now()
            return [...bootstrapStatus.entries()].map(([name, status]) => ({
              name,
              status,
              elapsedMs: now - (bootstrapStartedAt.get(name) ?? now),
            }))
          },
        },
      })
      restAddress = await restApp.listen({ port: restPort, host })
      console.log(`neatd: REST listening on ${restAddress}`)
    } catch (err) {
      // Roll back anything we started so far before surfacing the error.
      for (const slot of slots.values()) {
        teardownSlot(slot)
      }
      if (restApp) await restApp.close().catch(() => {})
      await fs.unlink(pidPath).catch(() => {})
      throw new Error(
        `neatd: failed to bind REST on port ${restPort} — ${(err as Error).message}`,
      )
    }

    // Resolve a span's target slot — running the broken-state recovery
    // when the routed slot is currently broken. Returns null when the span
    // can't be delivered after the recovery attempt; the caller drops with
    // a rate-limited warning. v0.4.1 / refs #339 — when nothing matches and
    // no default slot exists, the no-project-match event lands in
    // <NEAT_HOME>/errors.ndjson before we return null.
    async function resolveTargetSlot(
      serviceName: string | undefined,
      traceId: string | undefined,
    ): Promise<ProjectSlot | null> {
      const liveEntries = await listProjects().catch(() => [])
      const target = routeSpanToProject(serviceName, liveEntries)
      let slot = slots.get(target) ?? slots.get(DEFAULT_PROJECT)
      if (!slot) {
        await recordUnroutedSpan(serviceName, traceId)
        return null
      }
      if (slot.status === 'broken') {
        const entry = liveEntries.find((e) => e.name === slot!.entry.name)
        if (entry) {
          slot = await tryRecoverSlot(entry)
        }
        if (slot.status !== 'active') {
          warnDroppedSpan(slot.entry.name, slot.errorReason ?? 'unknown')
          return null
        }
      }
      return slot.status === 'active' ? slot : null
    }

    // Resolve a project slot by its registered name — the path the
    // project-scoped OTLP route (issue #367) takes. URL-extracted project
    // names sidestep the service.name heuristic; we still want the broken
    // -slot recovery + unrouted-span logging so the route's failure modes
    // match the legacy path's.
    async function resolveSlotByName(
      project: string,
      serviceName: string | undefined,
      traceId: string | undefined,
    ): Promise<ProjectSlot | null> {
      const liveEntries = await listProjects().catch(() => [])
      let slot = slots.get(project)
      if (!slot) {
        await recordUnroutedSpan(serviceName, traceId)
        return null
      }
      if (slot.status === 'broken') {
        const entry = liveEntries.find((e) => e.name === slot!.entry.name)
        if (entry) {
          slot = await tryRecoverSlot(entry)
        }
        if (slot.status !== 'active') {
          warnDroppedSpan(slot.entry.name, slot.errorReason ?? 'unknown')
          return null
        }
      }
      return slot.status === 'active' ? slot : null
    }

    try {
      otlpApp = await buildOtelReceiver({
        authToken: auth.otelToken,
        trustProxy: auth.trustProxy,
        onSpan: async (span) => {
          // ADR-049 OTel routing — dispatch by service.name. Broken slots
          // get a single inline recovery attempt before the span is dropped
          // with a rate-limited log line. Unknown services route to
          // DEFAULT_PROJECT so the FrontierNode auto-creation flow keeps
          // working (ADR-033); when DEFAULT_PROJECT isn't registered either,
          // resolveTargetSlot writes a no-project-match event to
          // <NEAT_HOME>/errors.ndjson (refs #339).
          const slot = await resolveTargetSlot(span.service, span.traceId)
          if (!slot) return
          await handleSpan(
            {
              graph: slot.graph,
              errorsPath: slot.paths.errorsPath,
              scanPath: slot.entry.path,
              project: slot.entry.name,
              // Receiver already wrote the error event synchronously below.
              writeErrorEventInline: false,
            },
            span,
          )
        },
        onErrorSpanSync: async (span) => {
          const slot = await resolveTargetSlot(span.service, span.traceId)
          if (!slot) return
          await makeErrorSpanWriter(slot.paths.errorsPath)(span)
        },
        // Project-scoped route (issue #367) — the URL already named the
        // project. Resolution is a direct slot lookup; service.name resolves
        // the ServiceNode inside the slot's graph instead of which project
        // owns the span.
        onProjectSpan: async (project, span) => {
          const slot = await resolveSlotByName(project, span.service, span.traceId)
          if (!slot) return
          await handleSpan(
            {
              graph: slot.graph,
              errorsPath: slot.paths.errorsPath,
              scanPath: slot.entry.path,
              project: slot.entry.name,
              writeErrorEventInline: false,
            },
            span,
          )
        },
        onProjectErrorSpanSync: async (project, span) => {
          const slot = await resolveSlotByName(project, span.service, span.traceId)
          if (!slot) return
          await makeErrorSpanWriter(slot.paths.errorsPath)(span)
        },
      })
      otlpAddress = await otlpApp.listen({ port: otlpPort, host })
      console.log(`neatd: OTLP listening on ${otlpAddress}/v1/traces`)
    } catch (err) {
      for (const slot of slots.values()) {
        teardownSlot(slot)
      }
      if (restApp) await restApp.close().catch(() => {})
      if (otlpApp) await otlpApp.close().catch(() => {})
      await fs.unlink(pidPath).catch(() => {})
      throw new Error(
        `neatd: failed to bind OTLP on port ${otlpPort} — ${(err as Error).message}`,
      )
    }
  }

  // Issue #340 — listeners are live; kick off per-project bootstrap in the
  // background. Polled callers watch /health for transitions.
  const initialBootstrap = loadAll().catch((err) => {
    console.warn(`neatd: initial bootstrap pass failed — ${(err as Error).message}`)
  })

  let reloading: Promise<void> | null = initialBootstrap
  const reload = async (): Promise<void> => {
    if (reloading) return reloading
    reloading = (async () => {
      try {
        await loadAll()
      } finally {
        reloading = null
      }
    })()
    return reloading
  }
  void initialBootstrap.finally(() => {
    if (reloading === initialBootstrap) reloading = null
  })

  const tracker: BootstrapTracker = {
    status: (name) => bootstrapStatus.get(name),
    list: () => {
      const now = Date.now()
      return [...bootstrapStatus.entries()].map(([name, status]) => ({
        name,
        status,
        elapsedMs: now - (bootstrapStartedAt.get(name) ?? now),
      }))
    },
  }

  // SIGHUP — external "reload your config" signal. ADR-049 #2.
  const sighupHandler = (): void => {
    void reload().catch((err) => {
      console.warn(`neatd: SIGHUP reload failed — ${(err as Error).message}`)
    })
  }
  process.on('SIGHUP', sighupHandler)

  // Issue #382 — registry watcher. The orchestrator writes new projects to
  // the registry file while the daemon is already running; without an explicit
  // `neatd reload`, the slot map stays stale and every span for the freshly-
  // registered project gets rejected as no-project-match. Watching the
  // registry's directory (more robust against the tmp+rename atomic-write
  // pattern from ADR-048 than file-path watches on some platforms) and
  // filtering by basename catches every change. Debounce collapses the 2-3
  // events the rename pattern fires per write into a single reload.
  const REGISTRY_RELOAD_DEBOUNCE_MS = 500
  let registryWatcher: FSWatcher | null = null
  let reloadTimer: NodeJS.Timeout | null = null
  try {
    const regDir = path.dirname(regPath)
    const regBase = path.basename(regPath)
    registryWatcher = watch(regDir, (_eventType, filename) => {
      // filename can be null on some platforms — fall back to firing every
      // event, the debounce + reload's idempotency cover any over-fire.
      if (filename !== null && filename !== regBase) return
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => {
        reloadTimer = null
        void reload().catch((err) => {
          console.warn(
            `neatd: registry-watch reload failed — ${(err as Error).message}`,
          )
        })
      }, REGISTRY_RELOAD_DEBOUNCE_MS)
    })
  } catch (err) {
    // Watching the registry is a best-effort optimisation over SIGHUP — if
    // the kernel refuses (e.g. inotify quota exhausted) we surface the
    // failure but let the daemon keep running.
    console.warn(
      `neatd: failed to watch registry at ${regPath} — ${(err as Error).message}. ` +
        `Run \`neatd reload\` (or send SIGHUP) after registering new projects.`,
    )
  }

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    process.off('SIGHUP', sighupHandler)
    if (reloadTimer) {
      clearTimeout(reloadTimer)
      reloadTimer = null
    }
    if (registryWatcher) {
      try {
        registryWatcher.close()
      } catch {
        // best-effort
      }
      registryWatcher = null
    }
    if (otlpApp) await otlpApp.close().catch(() => {})
    if (restApp) await restApp.close().catch(() => {})
    for (const slot of slots.values()) {
      teardownSlot(slot)
    }
    await fs.unlink(pidPath).catch(() => {})
  }

  return {
    slots,
    reload,
    stop,
    pidPath,
    restAddress,
    otlpAddress,
    bootstrap: tracker,
    initialBootstrap,
  }
}
