/**
 * One-command orchestrator (ADR-073 §1).
 *
 * Bare `neat <path>` dispatches here when the first positional argument
 * resolves to a directory and doesn't match a registered verb. Six steps,
 * in order:
 *
 *   1. Discovery + extraction (per static-extraction contract).
 *   2. `.gitignore` automation (ADR-073 §6) + project registration.
 *   3. SDK install apply — patches manifests + writes otel-init + writes
 *      `.env.neat`. Default yes; `--no-instrument` opts out.
 *   4. Daemon spawn — `neatd start --detach` if no daemon is running.
 *      Polls `/health` up to 15s for readiness.
 *   5. Browser open against the web UI on port 6328 (T9 NEAT).
 *      Default yes; `--no-open` and headless runs skip the launch.
 *   6. Summary block — value-forward findings + OTel env-vars block.
 *
 * `neat init` retains its patch-by-default contract (ADR-046 §5). The
 * orchestrator runs apply unconditionally because the bare-`<path>` shape's
 * user intent is "make this work end-to-end."
 */

import { promises as fs } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import type { GraphEdge, GraphNode } from '@neat.is/types'
import { DEFAULT_PROJECT, getGraph, resetGraph } from './graph.js'
import { extractFromDirectory } from './extract.js'
import { discoverServices } from './extract/services.js'
import { ensureNeatOutIgnored } from './gitignore.js'
import { saveGraphToDisk } from './persist.js'
import { pathsForProject } from './projects.js'
import { addProject, listProjects, ProjectNameCollisionError, setStatus } from './registry.js'
import { readDaemonRecord, resolveHost, type DaemonPorts } from './daemon.js'
import { printBanner } from './banner.js'
import {
  isEmptyPlan,
  pickInstaller,
  type InstallPlan,
} from './installers/index.js'
import { appFrameworkDependencies, uninstrumentedLibraries } from './installers/javascript.js'
import {
  detectPackageManager,
  runPackageManagerInstall,
  type PackageManager,
  type PackageManagerInvocation,
} from './installers/package-manager.js'

export interface OrchestratorOptions {
  scanPath: string
  // Project name resolution mirrors `neat init` — basename of the scan
  // path unless overridden via --project.
  project: string
  projectExplicit: boolean
  // Skip step 3 (SDK install apply).
  noInstrument: boolean
  // Skip step 5 (browser open).
  noOpen: boolean
  // Skip the interactive prompt (CI invocation flag — implied when
  // stdin/stdout aren't a TTY).
  yes: boolean
  // Dashboard URL — defaults to http://localhost:6328 (T9 NEAT, ADR-059).
  dashboardUrl?: string
  // Health-check timeout in ms. Default 15s.
  daemonReadyTimeoutMs?: number
}

export interface OrchestratorResult {
  exitCode: number
  // High-level step-by-step status for the test surface.
  steps: {
    discovery: { services: number; languages: string[] }
    extraction: { nodesAdded: number; edgesAdded: number }
    gitignore: 'added' | 'created' | 'unchanged'
    apply: {
      instrumented: number
      alreadyInstrumented: number
      libOnly: number
      skipped: boolean
      bun?: number
      deno?: number
      cloudflareWorkers?: number
      electron?: number
      // Issue #381 — package-manager invocations the orchestrator ran
      // after apply() mutated package.json. Absent for `--no-instrument`
      // runs and runs where every plan was empty.
      packageManagerInstalls?: PackageManagerInvocation[]
    }
    daemon: 'spawned' | 'already-running' | 'timed-out' | 'skipped'
    browser: 'opened' | 'skipped' | 'failed'
  }
}

// Shared sub-pipeline `neat sync` re-uses (ADR-074 §1). Discovery + extract
// + snapshot write. Distinct from the first-run-only steps (registry add,
// daemon spawn, browser open, summary block) that the orchestrator owns
// directly.
export interface ExtractAndPersistOptions {
  scanPath: string
  project: string
  projectExplicit: boolean
  // When true, skip persisting to disk — for `neat sync --dry-run`.
  dryRun?: boolean
}

export interface ExtractAndPersistResult {
  graph: ReturnType<typeof getGraph>
  graphKey: string
  services: Awaited<ReturnType<typeof discoverServices>>
  languages: string[]
  nodesAdded: number
  edgesAdded: number
  snapshotPath: string
  errorsPath: string
}

export async function extractAndPersist(
  opts: ExtractAndPersistOptions,
): Promise<ExtractAndPersistResult> {
  const services = await discoverServices(opts.scanPath)
  const languages = [...new Set(services.map((s) => s.node.language))].sort()

  const graphKey = opts.projectExplicit ? opts.project : DEFAULT_PROJECT
  resetGraph(graphKey)
  const graph = getGraph(graphKey)
  const projectPaths = pathsForProject(graphKey, path.join(opts.scanPath, 'neat-out'))
  const extraction = await extractFromDirectory(graph, opts.scanPath, {
    errorsPath: projectPaths.errorsPath,
  })
  if (!opts.dryRun) {
    await saveGraphToDisk(graph, projectPaths.snapshotPath)
  }
  return {
    graph,
    graphKey,
    services,
    languages,
    nodesAdded: extraction.nodesAdded,
    edgesAdded: extraction.edgesAdded,
    snapshotPath: projectPaths.snapshotPath,
    errorsPath: projectPaths.errorsPath,
  }
}

// SDK-install apply over a discovered service list. Returns the same shape
// the orchestrator's result.steps.apply uses so callers (orchestrator + sync)
// share the rollup logic. v0.4.1 / refs #339 — `project` is threaded through
// to the installer so the per-package `.env.neat` carries
// `OTEL_SERVICE_NAME=<project>`, matching the daemon's routing key.
export interface ApplyInstallersTally {
  instrumented: number
  alreadyInstrumented: number
  libOnly: number
  browserBundle: number
  reactNative: number
  // Issues #389 #390 — BYO-OTel out-of-scope runtime counters.
  bun: number
  deno: number
  cloudflareWorkers: number
  electron: number
  // Issue #381 — package-manager invocations the orchestrator ran after
  // apply() mutated package.json. One entry per distinct lockfile-owning
  // directory (monorepos share a single install run regardless of how
  // many sub-packages got instrumented). Empty when nothing was added to
  // any package.json.
  packageManagerInstalls: PackageManagerInvocation[]
}

// Knobs the test surface uses to swap the real spawn for a no-op. Default
// uses the real installer; the contract suite passes a stub so the wiring
// can be asserted without spawning npm against an unreliable registry.
export interface ApplyInstallersOptions {
  runInstall?: (cmd: { pm: PackageManager; cwd: string; args: string[] }) => Promise<PackageManagerInvocation>
  resolveManager?: (serviceDir: string) => Promise<{ pm: PackageManager; cwd: string; args: string[] }>
}

export async function applyInstallersOver(
  services: Awaited<ReturnType<typeof discoverServices>>,
  project: string,
  options: ApplyInstallersOptions = {},
): Promise<ApplyInstallersTally> {
  const resolveManager = options.resolveManager ?? detectPackageManager
  const runInstall = options.runInstall ?? runPackageManagerInstall
  let instrumented = 0
  let already = 0
  let libOnly = 0
  let browserBundle = 0
  let reactNative = 0
  let bun = 0
  let deno = 0
  let cloudflareWorkers = 0
  let electron = 0
  // Distinct install commands keyed by `<pm>:<cwd>` so a monorepo with
  // multiple instrumented sub-packages still runs install exactly once at
  // its workspace root. The first plan that landed a dep edit for a given
  // root wins; later sub-packages skip the re-run.
  const installPlans = new Map<string, { pm: PackageManager; cwd: string; args: string[] }>()
  for (const svc of services) {
    const installer = await pickInstaller(svc.dir)
    if (!installer) continue
    const plan: InstallPlan = await installer.plan(svc.dir, { project })
    if (isEmptyPlan(plan) && !plan.libOnly && plan.runtimeKind === undefined) {
      already++
      continue
    }
    const outcome = await installer.apply(plan)
    if (outcome.outcome === 'instrumented') {
      instrumented++
      // Schedule an install whenever apply() actually added deps. The
      // generated otel-init file lives under the service dir but the
      // packages the user must resolve at runtime (`@opentelemetry/sdk-node`,
      // `@prisma/instrumentation`) live in package.json — without the
      // install, the next `npm run dev` throws `Cannot find module ...`
      // before any of NEAT's code even loads.
      if (plan.dependencyEdits.length > 0) {
        const cmd = await resolveManager(svc.dir)
        const key = `${cmd.pm}:${cmd.cwd}`
        if (!installPlans.has(key)) installPlans.set(key, cmd)
      }
    } else if (outcome.outcome === 'already-instrumented') already++
    else if (outcome.outcome === 'lib-only') {
      libOnly++
      // Issue #545 / #570 — a lib-only package that carries a web-framework or
      // background-worker dependency is almost certainly a runnable app whose
      // entry the installer couldn't find, not a true library. Left in the
      // `lib-only N` tally it's silent; the runtime layer never engages and the
      // user has no idea why. Name the dependency we found and the recovery path
      // loudly. A genuine library with no app signal stays quiet — there's
      // nothing for its runtime layer to engage.
      const appDeps = svc.pkg ? appFrameworkDependencies(svc.pkg) : []
      if (appDeps.length > 0) {
        const svcName = path.basename(svc.dir)
        const list = appDeps.join(', ')
        console.warn(
          `neat: runtime layer won't engage for ${svcName}: no entry point found.\n` +
            `  ${svc.dir} depends on ${list} — a runnable app — but neat couldn't resolve an entry to instrument.\n` +
            `  Add a "start" script to package.json, or point neat at the entry file directly.`,
        )
      }
    }
    else if (outcome.outcome === 'browser-bundle') {
      browserBundle++
      console.log(`skipping ${svc.dir}: browser bundle; browser-OTel support lands in a future release.`)
    } else if (outcome.outcome === 'react-native') {
      reactNative++
      const svcName = path.basename(svc.dir)
      console.log(
        `neat: ${svc.dir} detected as React Native / Expo\n` +
          `  The installer doesn't cover this runtime deterministically.\n` +
          `  Configure your OTel binding to send spans to:\n` +
          `    http://localhost:4318/projects/${project}/v1/traces\n` +
          `  Set OTEL_SERVICE_NAME=${svcName}\n` +
          `  See docs/installer-scope.md → "Manual setup for out-of-scope runtimes"`,
      )
    } else if (outcome.outcome === 'bun') {
      bun++
      const svcName = path.basename(svc.dir)
      console.log(
        `neat: ${svc.dir} detected as Bun\n` +
          `  The installer doesn't cover this runtime deterministically.\n` +
          `  Configure your OTel binding to send spans to:\n` +
          `    http://localhost:4318/projects/${project}/v1/traces\n` +
          `  Set OTEL_SERVICE_NAME=${svcName}\n` +
          `  See docs/installer-scope.md → "Manual setup for out-of-scope runtimes"`,
      )
    } else if (outcome.outcome === 'deno') {
      deno++
      const svcName = path.basename(svc.dir)
      console.log(
        `neat: ${svc.dir} detected as Deno\n` +
          `  The installer doesn't cover this runtime deterministically.\n` +
          `  Configure your OTel binding to send spans to:\n` +
          `    http://localhost:4318/projects/${project}/v1/traces\n` +
          `  Set OTEL_SERVICE_NAME=${svcName}\n` +
          `  See docs/installer-scope.md → "Manual setup for out-of-scope runtimes"`,
      )
    } else if (outcome.outcome === 'cloudflare-workers') {
      cloudflareWorkers++
      const svcName = path.basename(svc.dir)
      console.log(
        `neat: ${svc.dir} detected as Cloudflare Workers\n` +
          `  The installer doesn't cover this runtime deterministically.\n` +
          `  Configure your OTel binding to send spans to:\n` +
          `    http://localhost:4318/projects/${project}/v1/traces\n` +
          `  Set OTEL_SERVICE_NAME=${svcName}\n` +
          `  See docs/installer-scope.md → "Manual setup for out-of-scope runtimes"`,
      )
    } else if (outcome.outcome === 'electron') {
      electron++
      const svcName = path.basename(svc.dir)
      console.log(
        `neat: ${svc.dir} detected as Electron\n` +
          `  The installer doesn't cover this runtime deterministically.\n` +
          `  Configure your OTel binding to send spans to:\n` +
          `    http://localhost:4318/projects/${project}/v1/traces\n` +
          `  Set OTEL_SERVICE_NAME=${svcName}\n` +
          `  See docs/installer-scope.md → "Manual setup for out-of-scope runtimes"`,
      )
    }

    // Issue #546 — a service can be fully instrumented and still produce an
    // empty OBSERVED layer when it leans on a library the default
    // auto-instrumentation set doesn't cover (sqlite3 is the motivating case:
    // an in-process driver whose calls never cross an instrumented wire). The
    // differentiator goes silently empty. Name the libraries and point at the
    // extend path so the user knows why and what to do. Skip the lib-only and
    // out-of-scope buckets — there's no OBSERVED layer for them to be missing
    // from yet.
    if (svc.pkg && (outcome.outcome === 'instrumented' || outcome.outcome === 'already-instrumented')) {
      const gaps = uninstrumentedLibraries(svc.pkg)
      if (gaps.length > 0) {
        const svcName = path.basename(svc.dir)
        const list = gaps.join(', ')
        const subject = gaps.length === 1 ? 'this library' : 'these libraries'
        const aux = gaps.length === 1 ? "isn't" : "aren't"
        console.warn(
          `neat: calls to ${list} won't be observed by default in ${svcName}.\n` +
            `  ${subject} ${aux} in the default instrumentation set, so they produce no OBSERVED edges.\n` +
            `  Run \`neat list-uninstrumented\` to review them, then \`neat extend\` to capture them.`,
        )
      }
    }
  }

  // Run each distinct install command serially. Parallelism would race the
  // lockfile in the rare monorepo-of-monorepos case and most package
  // managers serialise themselves internally anyway — the time saving is
  // tiny next to the operator-trust cost of a corrupted lockfile.
  const packageManagerInstalls: PackageManagerInvocation[] = []
  for (const cmd of installPlans.values()) {
    console.log(`running \`${cmd.pm} ${cmd.args.join(' ')}\` in ${cmd.cwd}`)
    const result = await runInstall(cmd)
    packageManagerInstalls.push(result)
    if (result.exitCode !== 0) {
      console.error(
        `neat: ${cmd.pm} install failed in ${cmd.cwd} (exit ${result.exitCode}); run it manually to surface the error.`,
      )
      if (result.stderr.length > 0) {
        for (const line of result.stderr.split(/\r?\n/).slice(0, 20)) {
          console.error(`  ${line}`)
        }
      }
    }
  }

  return {
    instrumented,
    alreadyInstrumented: already,
    libOnly,
    browserBundle,
    reactNative,
    bun,
    deno,
    cloudflareWorkers,
    electron,
    packageManagerInstalls,
  }
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(`${question} [Y/n] `, (answer) => {
      rl.close()
      const trimmed = answer.trim().toLowerCase()
      resolve(trimmed === '' || trimmed === 'y' || trimmed === 'yes')
    })
  })
}

// 60s covers boot + per-project graph load across a registry with several
// sibling projects. Issue #340 — `app.listen()` now returns the moment the
// socket binds, so the steady-state happy path lands well inside the first
// second; the longer ceiling is the cold-clone window where multi-project
// bootstraps run in the background after listen.
const DEFAULT_DAEMON_READY_TIMEOUT_MS = 60_000

// 500ms poll cadence — responsive enough that the operator sees a fresh
// status line on every transition without spamming the daemon.
const PROBE_INTERVAL_MS = 500

interface DaemonHealthResponse {
  ok?: boolean
  uptimeMs?: number
  projects?: Array<{
    name: string
    status?: 'bootstrapping' | 'active' | 'broken'
    elapsedMs?: number
  }>
}

async function fetchDaemonHealth(restPort: number): Promise<DaemonHealthResponse | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${restPort}/health`, (res) => {
      const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300
      if (!ok) {
        res.resume()
        resolve(null)
        return
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as DaemonHealthResponse)
        } catch {
          resolve({ ok: true })
        }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(1000, () => {
      req.destroy()
      resolve(null)
    })
  })
}


async function probeProjectHealth(
  restPort: number,
  name: string,
): Promise<'bootstrapping' | 'active' | 'broken'> {
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${restPort}/projects/${encodeURIComponent(name)}/health`,
      (res) => {
        const code = res.statusCode ?? 0
        res.resume()
        if (code >= 200 && code < 300) resolve('active')
        else resolve('bootstrapping')
      },
    )
    req.on('error', () => resolve('bootstrapping'))
    req.setTimeout(1000, () => {
      req.destroy()
      resolve('bootstrapping')
    })
  })
}

// Resolve the status of the one project this run just started — and only that
// project (ADR-096: the orchestrator spawns a daemon scoped to a single
// project, so readiness is a single-project question). A broken or stale
// sibling sitting in the machine registry must never gate this run; it
// belongs to a different daemon and would otherwise poison an otherwise-healthy
// start. Prefers the daemon-wide /health entry for the project when one is
// carried (the legacy multi-project shape); otherwise probes that project's
// per-project /health directly. The registry is not consulted — siblings are
// out of scope by construction.
async function snapshotProjectStatus(
  restPort: number,
  project: string,
  body: DaemonHealthResponse,
): Promise<Array<{ name: string; status: 'bootstrapping' | 'active' | 'broken' }>> {
  if (body.projects && body.projects.length > 0) {
    const mine = body.projects.filter((p) => p.name === project)
    if (mine.length > 0) {
      return mine.map((p) => ({ name: p.name, status: p.status ?? 'active' }))
    }
  }
  return [{ name: project, status: await probeProjectHealth(restPort, project) }]
}

interface DaemonReadyResult {
  ready: boolean
  brokenProjects: string[]
  stillBootstrapping: string[]
}

async function waitForDaemonReady(
  restPort: number,
  project: string,
  timeoutMs: number,
): Promise<DaemonReadyResult> {
  const deadline = Date.now() + timeoutMs
  let lastBootstrapping: string[] = []
  while (Date.now() < deadline) {
    const body = await fetchDaemonHealth(restPort)
    if (body !== null) {
      const projects = await snapshotProjectStatus(restPort, project, body)
      const bootstrapping = projects
        .filter((p) => p.status === 'bootstrapping')
        .map((p) => p.name)
      const broken = projects.filter((p) => p.status === 'broken').map((p) => p.name)
      if (bootstrapping.length === 0) {
        return { ready: true, brokenProjects: broken, stillBootstrapping: [] }
      }
      const key = bootstrapping.slice().sort().join(',')
      const prevKey = lastBootstrapping.slice().sort().join(',')
      if (key !== prevKey) {
        const plural = bootstrapping.length === 1 ? '' : 's'
        console.log(
          `neat: waiting on ${bootstrapping.length} project${plural}: ${bootstrapping.join(', ')}`,
        )
        lastBootstrapping = bootstrapping
      }
    }
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS))
  }
  const final = await fetchDaemonHealth(restPort)
  const projects = final ? await snapshotProjectStatus(restPort, project, final) : []
  return {
    ready: false,
    brokenProjects: projects.filter((p) => p.status === 'broken').map((p) => p.name),
    stillBootstrapping: projects
      .filter((p) => p.status === 'bootstrapping')
      .map((p) => p.name),
  }
}

// Port-availability probe (#377 / ADR-079 §2).
//
// The orchestrator's daemon-spawn step assumes `:8080` (REST), `:4318` (OTLP
// HTTP), and `:6328` (web UI) are free. When a sibling daemon from another
// terminal session — or any unrelated listener — is holding one of them, the
// spawn exits 1 with no actionable message. The probe runs before
// `spawnDaemonDetached()` and surfaces the named port plus recovery commands
// on collision, exiting with code 3 (environmental) per the CLI exit-code
// surface.
export const NEAT_PORTS = [8080, 4318, 6328] as const

// Probe `host` so the availability answer reflects the interface the daemon
// will actually bind. The daemon binds 0.0.0.0 on the authenticated path
// (resolveHost) and 127.0.0.1 otherwise; probing loopback while the daemon
// binds the wildcard reads a wildcard-held port as free, hands it to the
// spawn, and the daemon dies on EADDRINUSE before it can write daemon.json —
// the silent "daemon.json timeout" (#574). Check host must equal bind host.
export async function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

export async function probePortsFree(): Promise<
  { free: true } | { free: false; held: number }
> {
  for (const port of NEAT_PORTS) {
    if (!(await isPortFree(port))) return { free: false, held: port }
  }
  return { free: true }
}

export function formatPortCollisionMessage(port: number): string[] {
  return [
    `neat: port ${port} is in use; the NEAT daemon needs it.`,
    `      run \`neatd stop\` to release the previous daemon, or`,
    `      \`lsof -i :${port}\` to find the holding process.`,
  ]
}

// ── Per-project port allocation (ADR-096 §3 / project-daemon contract) ──────
//
// One daemon per project means a second project's daemon must coexist with the
// first rather than fight for one binding. The canonical triple
// (8080/4318/6328) stays the first choice; when any of it is taken, allocation
// steps to the next free triple. Each project's ports are persisted (in its
// daemon.json, written by the daemon) and reused across restarts, so the
// instrumented app's endpoint stays constant — critical, because the generated
// otel-init reads `ports.otlp` back and a drifting port would silently dark the
// OBSERVED layer (§1).

// How far to step before giving up. 8 triples (8080→8101 etc.) is far more
// concurrent projects than a laptop ever runs; past it the environment is
// genuinely saturated and the operator wants the collision message, not an
// ever-climbing search.
const PORT_ALLOCATION_ATTEMPTS = 8
// Stride between candidate triples. Keeping rest/otlp/web on the same offset
// keeps each project's three ports visually grouped (8080/4318/6328 →
// 8081/4319/6329 …) so `neat ps` output reads cleanly.
const PORT_STRIDE = 1

export interface AllocatedPorts extends DaemonPorts {}

// True when all three ports of a candidate triple are free on `host` — the
// interface the daemon will bind (see isPortFree).
async function tripleFree(ports: AllocatedPorts, host = '127.0.0.1'): Promise<boolean> {
  for (const p of [ports.rest, ports.otlp, ports.web]) {
    if (!(await isPortFree(p, host))) return false
  }
  return true
}

// Allocate a free port triple, canonical 8080/4318/6328 first, stepping by
// PORT_STRIDE to the next free triple when the canonical set is taken (a
// sibling project's daemon already holds it). Returns null when nothing in the
// search window is free — a genuinely saturated environment. Reuse of a
// project's persisted ports is the caller's decision (it has the /health
// identity result); this only finds fresh free ports.
export async function allocatePorts(host = '127.0.0.1'): Promise<AllocatedPorts | null> {
  const [baseRest, baseOtlp, baseWeb] = NEAT_PORTS
  for (let i = 0; i < PORT_ALLOCATION_ATTEMPTS; i++) {
    const candidate: AllocatedPorts = {
      rest: baseRest + i * PORT_STRIDE,
      otlp: baseOtlp + i * PORT_STRIDE,
      web: baseWeb + i * PORT_STRIDE,
    }
    if (await tripleFree(candidate, host)) return candidate
  }
  return null
}

// Read this project's persisted ports from its daemon.json, if any. Returns
// null when the project has never run a daemon (fresh install) or the record
// is malformed — the caller falls back to fresh allocation.
export async function persistedPortsFor(scanPath: string): Promise<AllocatedPorts | null> {
  const record = await readDaemonRecord(scanPath)
  if (!record) return null
  return { rest: record.ports.rest, otlp: record.ports.otlp, web: record.ports.web }
}

// Project-local concurrent-spawn guard (contract §1 "exactly one daemon").
// Two `neat init` on the same project in the same instant would each find no
// healthy daemon, allocate the same canonical triple, and the second daemon's
// bind would crash on the conflict. A best-effort lockfile under the project's
// own neat-out/ serialises them: the loser waits for the winner's daemon to
// answer /health rather than racing it to the bind. It's project-local — no
// machine-wide lock — so two DIFFERENT projects never contend here.
async function acquireSpawnLock(scanPath: string): Promise<(() => Promise<void>) | null> {
  const lockPath = path.join(scanPath, 'neat-out', 'daemon.spawn.lock')
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  const STALE_LOCK_MS = 60_000
  try {
    const fd = await fs.open(lockPath, 'wx')
    await fd.writeFile(`${process.pid}\n`, 'utf8')
    await fd.close()
    return async () => {
      await fs.unlink(lockPath).catch(() => {})
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null
    // A lock exists. If it's stale (a crashed prior spawn), reclaim it.
    try {
      const stat = await fs.stat(lockPath)
      if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        await fs.unlink(lockPath).catch(() => {})
        return acquireSpawnLock(scanPath)
      }
    } catch {
      // stat raced with the holder's unlink — treat as not-held and retry once.
      return acquireSpawnLock(scanPath)
    }
    return null
  }
}

// Wait (briefly) for another concurrent spawn to bring up a daemon that answers
// /health for this project. Used by the loser of the spawn-lock race so it
// reuses the winner's daemon instead of erroring.
async function waitForPeerDaemon(
  restPort: number,
  project: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await healthIsForProject(restPort, project)) return true
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS))
  }
  return healthIsForProject(restPort, project)
}

// The spawn-vs-reuse identity check (contract §7). A daemon found answering
// /health on a candidate REST port is reused only when it reports THIS project;
// a different project's daemon on a reused port answers with its own name and
// is correctly treated as not-mine. Returns true only on a confirmed match.
async function healthIsForProject(restPort: number, project: string): Promise<boolean> {
  const body = await fetchDaemonHealth(restPort)
  if (body === null) return false
  // Single-project daemons stamp a top-level `project`; be tolerant of the
  // legacy daemon-wide shape that lists projects in an array, so a transitional
  // daemon still matches by name.
  const named = (body as { project?: string }).project
  if (typeof named === 'string') return named === project
  if (Array.isArray(body.projects)) {
    return body.projects.some((p) => p.name === project)
  }
  return false
}

// Test seam for the spawn-reuse identity check (project-daemon contract §7).
// Production callers go through the spawn flow; the integration suite asserts
// the matching-vs-not-mine decision directly.
export function healthIsForProjectForTest(restPort: number, project: string): Promise<boolean> {
  return healthIsForProject(restPort, project)
}

// Test seam for the readiness wait (one-command-cli contract §1 / ADR-096).
// The integration suite drives a fake single-project daemon against this to
// prove the gate scopes to the just-started project and never blocks on a
// broken sibling sitting in the registry.
export function waitForDaemonReadyForTest(
  restPort: number,
  project: string,
  timeoutMs: number,
): Promise<DaemonReadyResult> {
  return waitForDaemonReady(restPort, project, timeoutMs)
}

// Spawn the daemon as a child process the orchestrator drives. Returns the
// child handle so the caller can read its stderr verbatim when the bind
// gate (or any other startup failure) reports back through that pipe
// (issue #341). The `detached: true` + `unref()` pair survives the
// orchestrator exiting cleanly; the inherited stderr keeps the operator
// informed when something does fail.
//
// ADR-096 — when `spec` is given the daemon is spawned scoped to that one
// project on the allocated ports (passed through the env neatd + startDaemon
// read). The legacy no-arg form spawns the multi-project daemon on the
// canonical ports; it stays so callers we haven't migrated keep working.
export interface DaemonSpawnSpec {
  project: string
  projectPath: string
  ports: AllocatedPorts
}

function spawnDaemonDetached(
  spec?: DaemonSpawnSpec,
): import('node:child_process').ChildProcess {
  // Resolve the neatd entry inside the @neat.is/core dist next to this
  // file. `import.meta.url` is post-bundling — at runtime, this resolves
  // to `<core>/dist/neatd.{js,cjs}`. We pick the .cjs because tsup ships
  // it in both forms and node tolerates either.
  const here = path.dirname(new URL(import.meta.url).pathname)
  const candidates = [
    path.join(here, 'neatd.cjs'),
    path.join(here, 'neatd.js'),
  ]
  let entry: string | null = null
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsSync = require('node:fs') as typeof import('node:fs')
  for (const c of candidates) {
    try {
      fsSync.accessSync(c)
      entry = c
      break
    } catch {
      // try next
    }
  }
  if (!entry) {
    throw new Error(`orchestrator: cannot locate neatd entry in ${here}`)
  }

  // ADR-073 §3 + issue #341 — first-touch path is loopback-only. When the
  // operator hasn't set `NEAT_AUTH_TOKEN` the orchestrator hard-pins
  // HOST=127.0.0.1 in the child env so `assertBindAuthority` lets the bind
  // through. Public-bind is opt-in via the token (and an explicit
  // `HOST=0.0.0.0` if the operator wants the literal). The parent's HOST is
  // preserved untouched when the token is set — that's the deploy path,
  // where the platform owns the bind decision.
  const env = { ...process.env }
  const hasToken = typeof env.NEAT_AUTH_TOKEN === 'string' && env.NEAT_AUTH_TOKEN.length > 0
  if (!hasToken && (!env.HOST || env.HOST.length === 0)) {
    env.HOST = '127.0.0.1'
  }

  // ADR-096 — scope the spawned daemon to one project on the allocated ports.
  // neatd reads NEAT_PROJECT/NEAT_PROJECT_PATH and PORT/OTEL_PORT/NEAT_WEB_PORT
  // and threads them into startDaemon, which serves only this project and
  // writes its daemon.json self-description with these ports.
  if (spec) {
    env.NEAT_PROJECT = spec.project
    env.NEAT_PROJECT_PATH = spec.projectPath
    env.PORT = String(spec.ports.rest)
    env.OTEL_PORT = String(spec.ports.otlp)
    env.NEAT_WEB_PORT = String(spec.ports.web)
  }

  const child = spawn(process.execPath, [entry, 'start'], {
    detached: true,
    // stderr inherits the orchestrator's fd so the daemon's
    // `BindAuthorityError` message lands in front of the operator instead
    // of being swallowed (issue #341).
    stdio: ['ignore', 'ignore', 'inherit'],
    env,
  })
  child.unref()
  return child
}

function openBrowser(url: string): 'opened' | 'failed' {
  // Skip when running headlessly; we don't want CI invocations to fail
  // because xdg-open isn't installed.
  if (!process.stdout.isTTY) return 'failed'
  const platform = process.platform
  const cmd =
    platform === 'darwin' ? 'open' :
    platform === 'win32' ? 'cmd' :
    'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return 'opened'
  } catch {
    return 'failed'
  }
}

export async function runOrchestrator(opts: OrchestratorOptions): Promise<OrchestratorResult> {
  const result: OrchestratorResult = {
    exitCode: 0,
    steps: {
      discovery: { services: 0, languages: [] },
      extraction: { nodesAdded: 0, edgesAdded: 0 },
      gitignore: 'unchanged',
      apply: { instrumented: 0, alreadyInstrumented: 0, libOnly: 0, skipped: false },
      daemon: 'skipped',
      browser: 'skipped',
    },
  }

  // ── Path validation ───────────────────────────────────────────────────
  const stat = await fs.stat(opts.scanPath).catch(() => null)
  if (!stat || !stat.isDirectory()) {
    console.error(`neat: ${opts.scanPath} is not a directory`)
    result.exitCode = 2
    return result
  }

  // ASCII banner up front — this is the one-command zero-to-graph path's
  // first impression (issue #483). Same artwork `neat init` prints, shared
  // through banner.ts so it's never duplicated.
  printBanner()
  console.log(`neat: ${opts.scanPath}`)
  console.log('')

  // ── Step 1: discovery, Step 2: extraction + snapshot ─────────────────
  // Shared with `neat sync` (ADR-074 §1) via extractAndPersist.
  const persisted = await extractAndPersist({
    scanPath: opts.scanPath,
    project: opts.project,
    projectExplicit: opts.projectExplicit,
  })
  const { graph, services, languages } = persisted
  result.steps.discovery = { services: services.length, languages }
  console.log(`discovered ${services.length} service(s) across ${languages.length} language(s)`)

  // No services means nothing to instrument and no graph worth spawning a
  // daemon for. Bail with a clear pointer instead of standing up an empty
  // daemon (issue #483) — most often the operator ran from outside their
  // project root.
  if (services.length === 0) {
    console.error(
      `neat: no services found in ${opts.scanPath} — run from inside your project root, or \`npx neat.is <path>\``,
    )
    result.exitCode = 2
    return result
  }

  // ── Confirmation prompt (default yes; --no-instrument or no-TTY skip)
  let runApply = !opts.noInstrument
  if (runApply && !opts.yes && process.stdout.isTTY && process.stdin.isTTY) {
    runApply = await promptYesNo('instrument your services and open the dashboard?')
  }

  result.steps.extraction = {
    nodesAdded: persisted.nodesAdded,
    edgesAdded: persisted.edgesAdded,
  }

  const gi = await ensureNeatOutIgnored(opts.scanPath)
  result.steps.gitignore = gi.action
  if (gi.action !== 'unchanged') {
    console.log(`${gi.action} .gitignore (neat-out/)`)
  }

  let currentProjectName = opts.project
  try {
    const entry = await addProject({
      name: opts.project,
      path: opts.scanPath,
      languages,
      status: 'active',
    })
    currentProjectName = entry.name
  } catch (err) {
    if (!(err instanceof ProjectNameCollisionError)) throw err
    // Same path, same name → re-init. Different path → bail with a clear
    // message so the operator can pass --project <other-name>.
    console.error(`neat: ${err.message}`)
    console.error('pass --project <other-name> to register under a different name.')
    result.exitCode = 1
    return result
  }

  // Narrow the active-project surface to what the operator is currently in.
  // Every other `active` entry transitions to `paused`; `broken` is left alone
  // so the daemon's broken-path handling still surfaces. `neat resume <name>`
  // brings any of them back when cross-project work is the explicit intent.
  const siblings = await listProjects()
  const paused: string[] = []
  for (const p of siblings) {
    if (p.name !== currentProjectName && p.status === 'active') {
      await setStatus(p.name, 'paused')
      paused.push(p.name)
    }
  }
  if (paused.length > 0) {
    const plural = paused.length === 1 ? '' : 's'
    console.log(
      `neat: paused ${paused.length} sibling project${plural}; run \`neat resume <name>\` to bring one back active.`,
    )
  }

  // ── Step 3: SDK install apply (default yes; --no-instrument skips) ───
  if (!runApply) {
    result.steps.apply.skipped = true
    console.log('skipped instrumentation (--no-instrument)')
  } else {
    const tally = await applyInstallersOver(services, opts.project)
    result.steps.apply = { ...tally, skipped: false }
    console.log(
      `instrumented ${tally.instrumented}, already ${tally.alreadyInstrumented}, lib-only ${tally.libOnly}`,
    )
    const failedInstalls = tally.packageManagerInstalls.filter((i) => i.exitCode !== 0)
    if (failedInstalls.length > 0) {
      result.exitCode = 1
    }
  }

  // ── Step 4: daemon spawn + health poll (ADR-096 per-project daemon) ──
  //
  // One daemon per project: this project either has a live daemon to reuse,
  // or we allocate ports and spawn one scoped to it. The spawn-vs-reuse
  // decision turns on the /health identity check — a daemon answering on a
  // port must report THIS project to count as ours (a sibling project's
  // daemon on a port we'd otherwise reuse is correctly seen as not-mine).
  const timeoutMs = opts.daemonReadyTimeoutMs ?? DEFAULT_DAEMON_READY_TIMEOUT_MS
  // The interface the spawned daemon will bind — 0.0.0.0 on the authenticated
  // path, 127.0.0.1 otherwise. resolveHost is the single source of that
  // decision (the daemon calls it too), so the free-port probe below checks the
  // exact interface the bind will use; a wildcard-held port must read as taken
  // on the token path or the spawn collides on EADDRINUSE (#574).
  const bindHost = resolveHost(
    {},
    typeof process.env.NEAT_AUTH_TOKEN === 'string' && process.env.NEAT_AUTH_TOKEN.length > 0,
  )
  // Ports the project used last time (its daemon.json), if any — reuse keeps
  // the instrumented app's exporter endpoint stable across restarts (§3).
  const persistedPorts = await persistedPortsFor(opts.scanPath)
  // Allocated ports the spawned daemon binds. Settled below; defaults to the
  // canonical web port so the dashboard URL has a value even on early bailouts.
  let allocated: AllocatedPorts | null = null

  // Already running? A daemon answering /health on the persisted REST port and
  // reporting this project is reused outright.
  if (persistedPorts && (await healthIsForProject(persistedPorts.rest, currentProjectName))) {
    result.steps.daemon = 'already-running'
    allocated = persistedPorts
  } else {
    // Decide the ports to bind. Reuse the persisted triple when its REST port
    // is free (the prior daemon is gone, so we take its ports back and the
    // app's endpoint stays put); otherwise allocate a fresh free triple,
    // stepping past the canonical set when a sibling project holds it.
    if (
      persistedPorts &&
      (await isPortFree(persistedPorts.rest, bindHost)) &&
      (await tripleFree(persistedPorts, bindHost))
    ) {
      allocated = persistedPorts
    } else {
      allocated = await allocatePorts(bindHost)
    }
    if (!allocated) {
      // The search window is saturated — surface the canonical REST port as the
      // representative collision so the operator gets the recovery hints.
      for (const line of formatPortCollisionMessage(NEAT_PORTS[0])) {
        console.error(line)
      }
      result.exitCode = 3
      return result
    }

    // Concurrent-spawn guard (§1). The winner spawns; a loser that couldn't
    // take the lock waits for the winner's daemon to answer /health and reuses
    // it rather than racing it into a bind conflict.
    const release = await acquireSpawnLock(opts.scanPath)
    if (!release) {
      const reused = await waitForPeerDaemon(allocated.rest, currentProjectName, timeoutMs)
      if (reused) {
        result.steps.daemon = 'already-running'
      } else {
        console.error('neat: another `neat` is spawning this project but its daemon did not come up in time')
        result.exitCode = 1
        return result
      }
    } else {
      try {
        // Re-check under the lock: a daemon the winner brought up between our
        // first probe and acquiring the lock is reused instead of double-spawned.
        if (await healthIsForProject(allocated.rest, currentProjectName)) {
          result.steps.daemon = 'already-running'
        } else {
          spawnDaemonDetached({
            project: currentProjectName,
            projectPath: opts.scanPath,
            ports: allocated,
          })
          const ready = await waitForDaemonReady(allocated.rest, currentProjectName, timeoutMs)
          result.steps.daemon = ready.ready ? 'spawned' : 'timed-out'
          if (!ready.ready) {
            console.error(`neat: daemon did not become ready within ${timeoutMs}ms`)
            if (ready.stillBootstrapping.length > 0) {
              console.error(`neat: still bootstrapping: ${ready.stillBootstrapping.join(', ')}`)
            }
            if (ready.brokenProjects.length > 0) {
              console.error(`neat: broken projects: ${ready.brokenProjects.join(', ')}`)
            }
            result.exitCode = 1
            return result
          }
          if (ready.brokenProjects.length > 0) {
            console.warn(
              `neat: ${ready.brokenProjects.length} project(s) reported broken: ${ready.brokenProjects.join(', ')}`,
            )
          }
        }
      } catch (err) {
        console.error(`neat: daemon spawn failed — ${(err as Error).message}`)
        result.exitCode = 1
        return result
      } finally {
        await release()
      }
    }
  }

  // ── Step 5: browser open ─────────────────────────────────────────────
  // The dashboard lives on the daemon's allocated web port (§5), not a fixed
  // 6328 — a second project's daemon serves its dashboard one port over.
  const webPort = allocated?.web ?? NEAT_PORTS[2]
  const dashboardUrl = opts.dashboardUrl ?? `http://localhost:${webPort}`
  if (opts.noOpen || !process.stdout.isTTY) {
    result.steps.browser = 'skipped'
  } else {
    result.steps.browser = openBrowser(dashboardUrl)
  }

  // ── Step 6: summary (stub — PR 4 replaces with the value-forward shape)
  printSummary(result, graph, dashboardUrl)

  return result
}

function printSummary(
  result: OrchestratorResult,
  graph: ReturnType<typeof getGraph>,
  dashboardUrl: string,
): void {
  const nodes: GraphNode[] = []
  graph.forEachNode((_id, attrs) => nodes.push(attrs))
  const edges: GraphEdge[] = []
  graph.forEachEdge((_id, attrs) => edges.push(attrs))

  const byNode = new Map<string, number>()
  for (const n of nodes) byNode.set(n.type, (byNode.get(n.type) ?? 0) + 1)
  const byEdge = new Map<string, number>()
  for (const e of edges) byEdge.set(e.type, (byEdge.get(e.type) ?? 0) + 1)

  console.log('')
  console.log('=== summary ===')
  console.log(`graph: ${graph.order} nodes, ${graph.size} edges`)
  for (const [t, c] of [...byNode.entries()].sort()) console.log(`  ${t}: ${c}`)
  for (const [t, c] of [...byEdge.entries()].sort()) console.log(`  ${t}: ${c}`)
  console.log('')
  console.log(`dashboard: ${dashboardUrl}`)
  // Be honest about the auth posture (issue #483). The bare first-touch path
  // pins the daemon to loopback with no token (see spawnDaemonDetached), so
  // there's nothing to log in with. When the operator has set
  // NEAT_AUTH_TOKEN, the daemon enforces it and the user needs it to reach
  // the dashboard and to route OTel — so we print the real value rather than
  // fabricating one the daemon wouldn't accept.
  const token = process.env.NEAT_AUTH_TOKEN
  if (typeof token === 'string' && token.length > 0) {
    console.log(`auth token: ${token}`)
  } else {
    console.log('running locally — open the dashboard, no token needed')
  }
}
