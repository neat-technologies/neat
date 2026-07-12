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

import {
  promises as fs,
  watch,
  renameSync,
  unlinkSync,
  writeFileSync,
  type FSWatcher,
} from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { FastifyInstance } from 'fastify'
import { DEFAULT_PROJECT, getGraph, resetGraph, type NeatGraph } from './graph.js'
import { extractFromDirectory } from './extract.js'
import { loadGraphFromDisk, saveGraphToDisk, startPersistLoop } from './persist.js'
import { Projects, pathsForProject, type ProjectPaths } from './projects.js'
import { buildApi } from './api.js'
import { buildOtelReceiver, listenSteppingOtlp } from './otel.js'
import { attachGraphToEventBus } from './events.js'
import { handleSpan, makeErrorSpanWriter, startStalenessLoop } from './ingest.js'
import { startConnectorPollLoop, type ConnectorRegistration } from './connectors/index.js'
import { loadConnectorRegistrations } from './connectors/registry.js'
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
import { NodeType, type RegistryEntry, type ServiceNode } from '@neat.is/types'

// ── Per-project daemon self-description (ADR-096 / project-daemon contract) ──
//
// A project's daemon owns one file — `<project>/neat-out/daemon.json` — that
// records where it bound and what it is serving. This is the single source of
// truth for "where is this project's daemon," read by the instrumentation (to
// resolve its OTLP endpoint), the MCP config, the dashboard, and `neat ps`.
//
// The shape is pinned: the orchestrator persists `ports` here on first spawn
// and reuses them on restart (§3), and the generated otel-init reads
// `ports.otlp` to build its exporter endpoint. Anything that drifts from this
// shape breaks the OBSERVED layer silently, so the read/write helpers live in
// one place and every producer/consumer goes through them.

export interface DaemonPorts {
  rest: number
  otlp: number
  web: number
}

export interface DaemonRecord {
  project: string
  projectPath: string
  pid: number
  status: 'running' | 'stopped'
  ports: DaemonPorts
  startedAt: string
  neatVersion: string
}

// `<project>/neat-out/daemon.json` — the authoritative per-project record.
export function daemonJsonPath(scanPath: string): string {
  return path.join(scanPath, 'neat-out', 'daemon.json')
}

// Machine-wide discovery directory. Honors NEAT_HOME exactly as registry.ts /
// neatHomeFor do so tests sandboxing under a temp home land here too.
export function daemonsDiscoveryDir(home?: string): string {
  const base = home && home.length > 0 ? home : neatHomeFromEnv()
  return path.join(base, 'daemons')
}

// `~/.neat/daemons/<project>.json` — a lock-free discovery copy (§6). Each
// daemon owns only its own file; losing the directory costs `neat ps`
// convenience, never correctness.
export function daemonDiscoveryPath(project: string, home?: string): string {
  return path.join(daemonsDiscoveryDir(home), `${sanitizeDiscoveryName(project)}.json`)
}

// Keep the discovery filename to a safe single path segment. Project names are
// basenames in practice, but a name carrying a separator must never escape the
// daemons/ directory.
function sanitizeDiscoveryName(project: string): string {
  return project.replace(/[^A-Za-z0-9._-]/g, '_')
}

function neatHomeFromEnv(): string {
  const env = process.env.NEAT_HOME
  if (env && env.length > 0) return path.resolve(env)
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  return path.join(home, '.neat')
}

// Best-effort read of a project's daemon.json. Returns null when the file is
// absent or malformed — callers treat that as "no daemon recorded here" rather
// than failing, so a corrupt record never wedges spawn-vs-reuse.
export async function readDaemonRecord(scanPath: string): Promise<DaemonRecord | null> {
  try {
    const raw = await fs.readFile(daemonJsonPath(scanPath), 'utf8')
    const parsed = JSON.parse(raw) as Partial<DaemonRecord>
    if (
      typeof parsed.project === 'string' &&
      parsed.ports &&
      typeof parsed.ports.rest === 'number' &&
      typeof parsed.ports.otlp === 'number' &&
      typeof parsed.ports.web === 'number'
    ) {
      return parsed as DaemonRecord
    }
    return null
  } catch {
    return null
  }
}

// Resolve the running @neat.is/core version for the daemon.json stamp. Mirrors
// neatd.ts#localVersion — NEAT_LOCAL_VERSION overrides for tests, else the
// bundled package.json, else a safe sentinel.
export function resolveNeatVersion(): string {
  if (process.env.NEAT_LOCAL_VERSION && process.env.NEAT_LOCAL_VERSION.length > 0) {
    return process.env.NEAT_LOCAL_VERSION
  }
  try {
    const req = createRequire(import.meta.url)
    const pkg = req('../package.json') as { version?: string }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

// Write the authoritative record + the machine-wide discovery copy, both
// atomically (tmp + rename, §2). Best-effort on the discovery copy: it is a
// read-optimization, so a failure to write it is logged but never aborts the
// daemon. The neat-out/ record is the one that matters and bubbles its error.
export async function writeDaemonRecord(record: DaemonRecord, home?: string): Promise<void> {
  const body = JSON.stringify(record, null, 2) + '\n'
  await writeAtomically(daemonJsonPath(record.projectPath), body)
  try {
    await writeAtomically(daemonDiscoveryPath(record.project, home), body)
  } catch (err) {
    console.warn(
      `neatd: could not write discovery copy for "${record.project}" — ${(err as Error).message}`,
    )
  }
}

// Mark the record stopped (neat-out/) and clear the discovery copy on graceful
// shutdown (§2/§6). The neat-out/ record is kept with status:"stopped" so a
// later read can tell "shut down cleanly" from "never ran"; the discovery copy
// is removed so `neat ps` stops listing a dead daemon. Both best-effort —
// shutdown must not throw on a missing file.
export async function clearDaemonRecord(record: DaemonRecord, home?: string): Promise<void> {
  try {
    const stopped: DaemonRecord = { ...record, status: 'stopped' }
    await writeAtomically(daemonJsonPath(record.projectPath), JSON.stringify(stopped, null, 2) + '\n')
  } catch {
    // best-effort
  }
  try {
    await fs.unlink(daemonDiscoveryPath(record.project, home))
  } catch {
    // best-effort — already gone is fine.
  }
}

// Reconcile a daemon's self-description synchronously on an unsupervised exit
// (project-daemon contract §2). The graceful `stop()` path already marks the
// record stopped and clears the discovery copy; this is the backstop for a
// crash or a fatal signal, where there's no chance to await async fs. A
// process-exit handler runs synchronously, so we mark the neat-out/ record
// `stopped` (tmp + renameSync keeps it atomic) and remove the discovery copy
// with sync calls. Best-effort throughout: a missing or already-reconciled
// file is fine, and a failure here must never throw out of an exit handler.
export function reconcileDaemonRecordSync(record: DaemonRecord, home?: string): void {
  try {
    const stopped: DaemonRecord = { ...record, status: 'stopped' }
    const target = daemonJsonPath(record.projectPath)
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(stopped, null, 2) + '\n')
    renameSync(tmp, target)
  } catch {
    // best-effort
  }
  try {
    unlinkSync(daemonDiscoveryPath(record.project, home))
  } catch {
    // best-effort — already gone is fine.
  }
}

export interface DaemonOptions {
  // Defaults to `~/.neat/`. Honors NEAT_HOME the same way registry.ts does.
  // Tests override via NEAT_HOME and don't pass this directly.
  neatHome?: string
  // ADR-096 — when set, this daemon is scoped to exactly one project. It serves
  // only that project, mounts a bare `/v1/traces` route that assigns every
  // incoming span to it (no service.name routing), and writes its
  // `daemon.json` self-description on start. `projectPath` is the project root
  // (the directory whose `neat-out/` holds the record). Absent → the legacy
  // multi-project daemon behaviour.
  project?: string
  projectPath?: string
  // Dashboard/web port to record in daemon.json. The daemon doesn't bind this
  // itself (neatd spawns the web UI), but it owns the record, so it stamps the
  // allocated value the orchestrator passed through.
  webPort?: number
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
  // Connectors plane (docs/contracts/connectors.md, ADR-124) — pull-based
  // OBSERVED connectors polled on an interval alongside every project this
  // daemon bootstraps, the same way every project gets the staleness loop.
  // These are applied to every project slot programmatically; on top of them,
  // each slot also loads its own project-matched connectors from
  // `~/.neat/connectors.json` at bootstrap (ADR-130, connector-config.md §6 —
  // resolved through the dispatch table in connectors/registry.ts). The two
  // sources merge: file-configured connectors join whatever a caller passes
  // here.
  connectors?: ConnectorRegistration[]
}

export interface ProjectSlot {
  entry: RegistryEntry
  graph: NeatGraph
  outPath: string
  paths: ProjectPaths
  stopPersist: () => void
  // Stops the OBSERVED→STALE clock-decay loop for this slot. Runs on the same
  // 60s cadence as `neat watch`, so the daemon keeps the STALE provenance state
  // current: once OBSERVED traffic quiets, edges past their threshold decay to
  // STALE instead of sitting live forever. Must be stopped alongside
  // stopPersist so no interval leaks when the slot is torn down or replaced.
  stopStaleness: () => void
  // Stops every connector poll loop registered for this slot (connectors/
  // index.ts's startConnectorPollLoop, one per opts.connectors entry). Same
  // lifecycle as stopStaleness — must run alongside it wherever the slot is
  // torn down or replaced.
  stopConnectors: () => void
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
    slot.stopStaleness()
  } catch {
    // best-effort
  }
  try {
    slot.stopConnectors()
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
  // ADR-096 — the per-project self-description this daemon wrote, or null in
  // the legacy multi-project mode. Tests assert the persisted ports + status.
  daemonRecord: DaemonRecord | null
  // The resolved NEAT_HOME this daemon discovers under. The entrypoint needs it
  // to clear the right discovery copy when it reconciles daemon.json on an
  // unsupervised exit (project-daemon contract §2).
  neatHome: string
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

// Does this span's `service.name` belong to the single project this daemon
// hosts? Single-project mode (ADR-096) binds the bare `/v1/traces` route to one
// project, but the OS-default OTLP endpoint (`localhost:4318`) is shared: a
// sibling service from a *different* project that exports with default settings
// lands here too. Merging its spans would mint that service's ServiceNode +
// incidents into this project's graph — cross-project contamination. We scope
// delivery to the project's owned services and quarantine the rest.
//
// A span is owned when:
//   - it carries no `service.name` (SDK misconfig in this project's own app;
//     handleSpan routes it to `service:unidentified`, refs #374), or
//   - its `service.name` matches the project name the same way the multi-
//     project router matches (exact / token-prefix / token-contained — covers
//     the monorepo case where `brief` owns `brief-api`, `brief-worker`), or
//   - a ServiceNode with that name already exists in the project's graph
//     (statically extracted, or observed-and-adopted on an earlier span).
//
// Everything else is foreign and gets quarantined to the unrouted ledger rather
// than merged. The trade is deliberate: a brand-new service of this project that
// NEAT can't statically read and whose name doesn't echo the project name has
// its first spans quarantined until extraction registers it — a far smaller
// failure than an entire sibling project bleeding into this graph.
function serviceNameMatchesProject(serviceName: string, project: string): boolean {
  if (serviceName === project) return true
  if (isTokenPrefix(project, serviceName)) return true
  if (isTokenContained(project, serviceName)) return true
  return false
}

function spanBelongsToSingleProject(
  graph: NeatGraph,
  project: string,
  serviceName: string | undefined,
): boolean {
  if (!serviceName) return true
  if (serviceNameMatchesProject(serviceName, project)) return true
  return graph.someNode(
    (_id, attrs) =>
      attrs.type === NodeType.ServiceNode &&
      (attrs as ServiceNode).name === serviceName,
  )
}

async function bootstrapProject(
  entry: RegistryEntry,
  connectors: ConnectorRegistration[] = [],
  neatHome?: string,
): Promise<ProjectSlot> {
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
      stopStaleness: () => {},
      stopConnectors: () => {},
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
    // The daemon owns shutdown, so the persist loop must not exit the process
    // on a signal — that would end us before `stop()` clears the daemon.json,
    // discovery copy, and pid file. `stop()` flushes this graph one last time
    // as it tears the slot down (see below).
    const stopPersist = startPersistLoop(graph, outPath, { exitOnSignal: false })
    // Keep the STALE provenance state maintained on the shipped daemon path,
    // the same way `neat watch` does. Once OBSERVED traffic quiets, this loop
    // ticks markStaleEdges so edges past their threshold decay to STALE and the
    // transition lands in this slot's stale-events.ndjson — exactly where the
    // REST `/stale-events` route reads them back from.
    const stopStaleness = startStalenessLoop(graph, {
      staleEventsPath: paths.staleEventsPath,
      project: entry.name,
    })
    // Connectors plane (docs/contracts/connectors.md, ADR-124; on-ramp
    // ADR-130) — every project-matched entry in `~/.neat/connectors.json`
    // becomes a registration here, resolved through
    // the dispatch table so no provider specifics leak into this file. The
    // env-ref credential resolves now, into memory only, and never reaches
    // the snapshot (connector-config.md §6). A bad entry is skipped with a
    // log, never fatal to the slot; these merge with any registrations a
    // programmatic caller passed in `opts.connectors`.
    const fileConnectors = neatHome
      ? await loadConnectorRegistrations({
          project: entry.name,
          graph,
          home: neatHome,
          onSkip: (skipped, reason) =>
            console.warn(
              `neatd: connector "${skipped.id}" (${skipped.provider}) skipped for project "${entry.name}" — ${reason}`,
            ),
        })
      : []
    const allConnectors = [...connectors, ...fileConnectors]
    // One poll loop per registered connector, same interval-loop shape as the
    // staleness loop above and torn down alongside it (teardownSlot).
    const stopFns = allConnectors.map((registration) =>
      startConnectorPollLoop(
        registration.connector,
        { projectDir: entry.path, credentials: registration.credentials },
        graph,
        registration.resolveTarget,
        // `connectorId` is threaded through so every tick lands in the
        // in-process status tracker the connector-status endpoint reads
        // (ADR-136). Undefined for a programmatic registration, which records
        // nothing.
        { intervalMs: registration.intervalMs, connectorId: registration.id },
      ),
    )
    const stopConnectors = (): void => {
      for (const stop of stopFns) stop()
    }
    await touchLastSeen(entry.name).catch(() => {})

    return {
      entry,
      graph,
      outPath,
      paths,
      stopPersist,
      stopStaleness,
      stopConnectors,
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

// The web/dashboard port the daemon records in daemon.json. The daemon never
// binds it (neatd spawns the web child), but it owns the self-description, so
// it stamps the resolved value. NEAT_WEB_PORT overrides the canonical 6328.
function resolveWebPort(): number {
  const env = process.env.NEAT_WEB_PORT
  if (env && env.length > 0) {
    const n = Number.parseInt(env, 10)
    if (Number.isFinite(n)) return n
  }
  return 6328
}

// Read the real bound port off a Fastify listen address (`http://host:port`).
// When the requested port was 0 the kernel chose one, and daemon.json must
// record what the app should actually reach — not the 0 we asked for. Falls
// back to the requested port if the address can't be parsed.
export function portFromListenAddress(address: string, fallback: number): number {
  try {
    const port = new URL(address).port
    const n = Number.parseInt(port, 10)
    if (Number.isFinite(n) && n > 0) return n
  } catch {
    // fall through
  }
  return fallback
}

export function resolveHost(opts: DaemonOptions, authTokenSet: boolean): string {
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

  // ADR-096 — single-project mode. The orchestrator spawns a daemon scoped to
  // one project, passing its name + root. In that mode the daemon serves only
  // that project: it bootstraps the one slot, mounts a bare `/v1/traces` route
  // that assigns every span to it, and writes its `daemon.json`
  // self-description. The legacy multi-project path (no opts.project) is left
  // intact so nothing on main breaks while Wave 2 retires the registry.
  //
  // The mode resolves from explicit opts first (the production path: neatd
  // reads NEAT_PROJECT/NEAT_PROJECT_PATH and passes them through), falling
  // back to the env directly so a bare `NEAT_PROJECT=… neatd start` works too.
  const projectArg =
    typeof opts.project === 'string' && opts.project.length > 0
      ? opts.project
      : process.env.NEAT_PROJECT && process.env.NEAT_PROJECT.length > 0
        ? process.env.NEAT_PROJECT
        : null
  const projectPathArg =
    opts.projectPath && opts.projectPath.length > 0
      ? opts.projectPath
      : process.env.NEAT_PROJECT_PATH && process.env.NEAT_PROJECT_PATH.length > 0
        ? process.env.NEAT_PROJECT_PATH
        : null
  const singleProject = projectArg
  const singleProjectPath =
    singleProject && projectPathArg ? path.resolve(projectPathArg) : null
  if (singleProject && !singleProjectPath) {
    throw new Error(
      `neatd: project "${singleProject}" given without a projectPath; pass NEAT_PROJECT_PATH alongside NEAT_PROJECT.`,
    )
  }

  // Graceful degradation per ADR-049 #6: missing registry refuses to boot
  // with a clear error rather than silently coming up empty. A single-project
  // daemon takes its project from spawn args, not the registry, so it doesn't
  // gate on the registry file existing.
  if (!singleProject) {
    try {
      await fs.access(regPath)
    } catch {
      throw new Error(
        `neatd: registry not found at ${regPath}. Run \`neat init <path>\` to register a project before starting the daemon.`,
      )
    }
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
      const fresh = await bootstrapProject(entry, opts.connectors ?? [], home)
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
      const slot = await bootstrapProject(entry, opts.connectors ?? [], home)
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

  // The set of projects this daemon manages. Single-project mode (ADR-096)
  // takes its one project from spawn args and never reads the registry for the
  // project list; the legacy daemon enumerates every registered project.
  async function enumerateProjects(): Promise<RegistryEntry[]> {
    if (singleProject && singleProjectPath) {
      return [
        {
          name: singleProject,
          path: singleProjectPath,
          registeredAt: new Date().toISOString(),
          languages: [],
          status: 'active',
        },
      ]
    }
    return listProjects()
  }

  async function loadAll(): Promise<void> {
    // #463 — drop long-dead entries before bootstrapping the rest. An entry
    // whose path is gone (definite ENOENT) and that's been quiet past the TTL
    // gets removed instead of marked `broken` and logged forever. Conservative
    // by design: a transient stat error or a fresh ENOENT entry stays, and the
    // staleness TTL is the safety margin. Best-effort — a prune failure never
    // blocks the daemon from coming up. A single-project daemon owns no
    // registry coordination, so it skips the prune entirely.
    if (!singleProject) {
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
    }

    const projects = await enumerateProjects()
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
  const initialEntries = await enumerateProjects().catch(() => [] as RegistryEntry[])
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
  // ADR-096 — the self-description this daemon owns, filled once it binds in
  // single-project mode. Null in legacy multi-project mode and when listeners
  // are skipped (bindListeners:false).
  let daemonRecord: DaemonRecord | null = null

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
        // ADR-096 §4/§5/§7 — hand the daemon's identity to buildApi so the REST
        // surface reflects "the daemon is the project": `GET /projects` reports
        // only this project (the dashboard pins to it), and the daemon-wide
        // `/health` carries it at the top level for the spawn-reuse identity
        // check. Absent for the legacy multi-project daemon.
        singleProject:
          singleProject && singleProjectPath
            ? { name: singleProject, path: singleProjectPath }
            : undefined,
        // ADR-136 — the connector-status endpoint reads ~/.neat/connectors.json
        // through the same resolved home the slot bootstrap read it from, so a
        // daemon given an explicit NEAT_HOME serves status for the same file it
        // polls.
        connectorsHome: home,
      })
      restAddress = await restApp.listen({ port: restPort, host })
      // Fastify reports a 0.0.0.0 bind back as http://127.0.0.1:port, so the
      // raw listen address hides a wildcard bind behind a loopback URL. Log the
      // host we actually asked for so the line matches what the port allocator
      // probed (the orchestrator threads this same host into its free check).
      console.log(
        `neatd: REST listening on http://${host}:${portFromListenAddress(restAddress, restPort)}`,
      )
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
    //
    // ADR-096 single-project mode short-circuits all of that: the daemon hosts
    // exactly one project, so every span on the bare `/v1/traces` route is its
    // span. The 3-pass `routeSpanToProject` heuristic and the unrouted-span
    // drop are moot here — assigning by service.name could only ever mis-route
    // or drop a span the daemon definitionally owns, which is precisely the
    // silent-dark-OBSERVED failure §1 exists to kill. We assign directly,
    // recovering the slot if it's broken, and never write to errors.ndjson on
    // the no-match path.
    async function resolveTargetSlot(
      serviceName: string | undefined,
      traceId: string | undefined,
    ): Promise<ProjectSlot | null> {
      if (singleProject) {
        let slot = slots.get(singleProject)
        if (!slot) {
          // The sole slot hasn't bootstrapped yet (span arrived during the
          // initial extraction window). Build it on demand from spawn args so
          // the span isn't dropped — the OBSERVED layer must not go dark.
          slot = await tryRecoverSlot({
            name: singleProject,
            path: singleProjectPath!,
            registeredAt: new Date().toISOString(),
            languages: [],
            status: 'active',
          })
        } else if (slot.status === 'broken') {
          slot = await tryRecoverSlot(slot.entry)
        }
        if (!slot || slot.status !== 'active') {
          warnDroppedSpan(singleProject, slot?.errorReason ?? 'unknown')
          return null
        }
        // Scope to this project's owned services — quarantine a sibling
        // project's spans that reached our shared OTLP port instead of merging
        // them (cross-project contamination). The unrouted ledger records what
        // we dropped so it isn't silently dark.
        if (!spanBelongsToSingleProject(slot.graph, singleProject, serviceName)) {
          await recordUnroutedSpan(serviceName, traceId)
          return null
        }
        return slot
      }
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
          await makeErrorSpanWriter(slot.paths.errorsPath, slot.graph, slot.entry.path)(span)
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
          await makeErrorSpanWriter(slot.paths.errorsPath, slot.graph, slot.entry.path)(span)
        },
      })
      // A held OTLP port steps to the next free one rather than crashing the
      // daemon (daemon.md §Binding). The recorded daemon.json port below reads
      // back from otlpAddress, so a stepped port is what otel-init resolves.
      otlpAddress = await listenSteppingOtlp(otlpApp, otlpPort, host)
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

    // ADR-096 §2 — write the self-description now that both listeners are up
    // and we know the real bound ports. Reading them back from the listen
    // addresses (rather than the requested ports) is what makes ephemeral-port
    // tests and the orchestrator's allocation agree: when the requested port
    // was 0, the kernel chose one, and the generated otel-init must read THAT.
    if (singleProject && singleProjectPath) {
      const ports: DaemonPorts = {
        rest: portFromListenAddress(restAddress, restPort),
        otlp: portFromListenAddress(otlpAddress, otlpPort),
        // The daemon doesn't bind the web port itself (neatd spawns the web
        // child); it records the allocated value passed through so the
        // dashboard and `neat ps` agree on where to look.
        web: typeof opts.webPort === 'number' ? opts.webPort : resolveWebPort(),
      }
      daemonRecord = {
        project: singleProject,
        projectPath: singleProjectPath,
        pid: process.pid,
        status: 'running',
        ports,
        startedAt: new Date().toISOString(),
        neatVersion: resolveNeatVersion(),
      }
      try {
        await writeDaemonRecord(daemonRecord, home)
        console.log(
          `neatd: project "${singleProject}" → REST ${ports.rest} / OTLP ${ports.otlp} / web ${ports.web} (daemon.json written)`,
        )
      } catch (err) {
        // The neat-out/ record is load-bearing — without it the instrumented
        // app can't resolve its OTLP endpoint and the OBSERVED layer goes
        // dark. Fail loud, rolling back the listeners + pid like the bind
        // failures above.
        for (const slot of slots.values()) teardownSlot(slot)
        if (restApp) await restApp.close().catch(() => {})
        if (otlpApp) await otlpApp.close().catch(() => {})
        await fs.unlink(pidPath).catch(() => {})
        throw new Error(
          `neatd: failed to write daemon.json for "${singleProject}" — ${(err as Error).message}`,
        )
      }
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
  // A single-project daemon takes its one project from spawn args and never
  // reads the machine registry for its project list, so there's nothing for
  // the registry watcher to react to — skip it (ADR-096 §6: no machine-wide
  // coordination surface).
  if (!singleProject) try {
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
    // Listeners are down, so the graph is now at its final state. Flush each
    // active slot once before tearing its persist loop down — the loops run
    // with `exitOnSignal: false`, so this is where the shutdown save lives now.
    for (const slot of slots.values()) {
      if (slot.status === 'active' && slot.outPath) {
        await saveGraphToDisk(slot.graph, slot.outPath).catch(() => {})
      }
    }
    for (const slot of slots.values()) {
      teardownSlot(slot)
    }
    // ADR-096 §2/§6 — mark the neat-out/ record stopped and remove the
    // machine-wide discovery copy so `neat ps` stops listing a dead daemon.
    if (daemonRecord) {
      await clearDaemonRecord(daemonRecord, home)
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
    daemonRecord,
    neatHome: home,
  }
}
