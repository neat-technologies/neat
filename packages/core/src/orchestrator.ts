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
import {
  isEmptyPlan,
  pickInstaller,
  type InstallPlan,
} from './installers/index.js'

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
    apply: { instrumented: number; alreadyInstrumented: number; libOnly: number; skipped: boolean }
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
export async function applyInstallersOver(
  services: Awaited<ReturnType<typeof discoverServices>>,
  project: string,
): Promise<{ instrumented: number; alreadyInstrumented: number; libOnly: number }> {
  let instrumented = 0
  let already = 0
  let libOnly = 0
  for (const svc of services) {
    const installer = await pickInstaller(svc.dir)
    if (!installer) continue
    const plan: InstallPlan = await installer.plan(svc.dir, { project })
    if (isEmptyPlan(plan) && !plan.libOnly) {
      already++
      continue
    }
    const outcome = await installer.apply(plan)
    if (outcome.outcome === 'instrumented') instrumented++
    else if (outcome.outcome === 'already-instrumented') already++
    else if (outcome.outcome === 'lib-only') libOnly++
  }
  return { instrumented, alreadyInstrumented: already, libOnly }
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

async function checkDaemonHealth(restPort: number): Promise<boolean> {
  const body = await fetchDaemonHealth(restPort)
  return body !== null
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

// Resolve the project-status set the wait loop branches on. Prefers the
// daemon-wide /health response when it carries the list; otherwise reads
// the registry directly and probes each project's per-project /health.
// The fallback handles the case where the daemon-wide /health hasn't
// landed in this branch's main yet.
async function snapshotProjectStatus(
  restPort: number,
  body: DaemonHealthResponse,
): Promise<Array<{ name: string; status: 'bootstrapping' | 'active' | 'broken' }>> {
  if (body.projects && body.projects.length > 0) {
    return body.projects.map((p) => ({
      name: p.name,
      status: p.status ?? 'active',
    }))
  }
  const entries = await listProjects().catch(() => [])
  if (entries.length === 0) return []
  return Promise.all(
    entries.map(async (entry) => ({
      name: entry.name,
      status: await probeProjectHealth(restPort, entry.name),
    })),
  )
}

interface DaemonReadyResult {
  ready: boolean
  brokenProjects: string[]
  stillBootstrapping: string[]
}

async function waitForDaemonReady(restPort: number, timeoutMs: number): Promise<DaemonReadyResult> {
  const deadline = Date.now() + timeoutMs
  let lastBootstrapping: string[] = []
  while (Date.now() < deadline) {
    const body = await fetchDaemonHealth(restPort)
    if (body !== null) {
      const projects = await snapshotProjectStatus(restPort, body)
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
  const projects = final ? await snapshotProjectStatus(restPort, final) : []
  return {
    ready: false,
    brokenProjects: projects.filter((p) => p.status === 'broken').map((p) => p.name),
    stillBootstrapping: projects
      .filter((p) => p.status === 'bootstrapping')
      .map((p) => p.name),
  }
}

// Spawn the daemon as a child process the orchestrator drives. Returns the
// child handle so the caller can read its stderr verbatim when the bind
// gate (or any other startup failure) reports back through that pipe
// (issue #341). The `detached: true` + `unref()` pair survives the
// orchestrator exiting cleanly; the inherited stderr keeps the operator
// informed when something does fail.
function spawnDaemonDetached(): import('node:child_process').ChildProcess {
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
  }

  // ── Step 4: daemon spawn + health poll ───────────────────────────────
  const restPort = Number(process.env.PORT ?? 8080)
  const timeoutMs = opts.daemonReadyTimeoutMs ?? DEFAULT_DAEMON_READY_TIMEOUT_MS
  if (await checkDaemonHealth(restPort)) {
    result.steps.daemon = 'already-running'
  } else {
    try {
      spawnDaemonDetached()
    } catch (err) {
      console.error(`neat: daemon spawn failed — ${(err as Error).message}`)
      result.exitCode = 1
      return result
    }
    const ready = await waitForDaemonReady(restPort, timeoutMs)
    result.steps.daemon = ready.ready ? 'spawned' : 'timed-out'
    if (!ready.ready) {
      console.error(`neat: daemon did not become ready within ${timeoutMs}ms`)
      if (ready.stillBootstrapping.length > 0) {
        console.error(
          `neat: still bootstrapping: ${ready.stillBootstrapping.join(', ')}`,
        )
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

  // ── Step 5: browser open ─────────────────────────────────────────────
  const dashboardUrl = opts.dashboardUrl ?? 'http://localhost:6328'
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
}
