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
import { addProject, ProjectNameCollisionError } from './registry.js'
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

// 15s is enough for boot + per-project graph load on a laptop. Faster on
// repeat runs (graph slot warm); the timeout kicks in only when something
// is genuinely wrong.
const DEFAULT_DAEMON_READY_TIMEOUT_MS = 15_000

async function checkDaemonHealth(restPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${restPort}/health`, (res) => {
      // Any 2xx counts — the response body has the project list, which
      // doesn't gate the orchestrator's "is it up" question.
      const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300
      res.resume()
      resolve(ok)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1000, () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function waitForDaemonReady(restPort: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await checkDaemonHealth(restPort)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

function spawnDaemonDetached(): void {
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
  const child = spawn(process.execPath, [entry, 'start'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
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

  // ── Step 1: discovery ─────────────────────────────────────────────────
  const services = await discoverServices(opts.scanPath)
  const languages = [...new Set(services.map((s) => s.node.language))].sort()
  result.steps.discovery = { services: services.length, languages }
  console.log(`discovered ${services.length} service(s) across ${languages.length} language(s)`)

  // ── Confirmation prompt (default yes; --no-instrument or no-TTY skip)
  let runApply = !opts.noInstrument
  if (runApply && !opts.yes && process.stdout.isTTY && process.stdin.isTTY) {
    runApply = await promptYesNo('instrument your services and open the dashboard?')
  }

  // ── Step 2: extraction + snapshot + gitignore + register ─────────────
  const graphKey = opts.projectExplicit ? opts.project : DEFAULT_PROJECT
  resetGraph(graphKey)
  const graph = getGraph(graphKey)
  const projectPaths = pathsForProject(graphKey, path.join(opts.scanPath, 'neat-out'))
  const errorsPath = projectPaths.errorsPath
  const extraction = await extractFromDirectory(graph, opts.scanPath, { errorsPath })
  await saveGraphToDisk(graph, projectPaths.snapshotPath)
  result.steps.extraction = {
    nodesAdded: extraction.nodesAdded,
    edgesAdded: extraction.edgesAdded,
  }

  const gi = await ensureNeatOutIgnored(opts.scanPath)
  result.steps.gitignore = gi.action
  if (gi.action !== 'unchanged') {
    console.log(`${gi.action} .gitignore (neat-out/)`)
  }

  try {
    await addProject({
      name: opts.project,
      path: opts.scanPath,
      languages,
      status: 'active',
    })
  } catch (err) {
    if (!(err instanceof ProjectNameCollisionError)) throw err
    // Same path, same name → re-init. Different path → bail with a clear
    // message so the operator can pass --project <other-name>.
    console.error(`neat: ${err.message}`)
    console.error('pass --project <other-name> to register under a different name.')
    result.exitCode = 1
    return result
  }

  // ── Step 3: SDK install apply (default yes; --no-instrument skips) ───
  if (!runApply) {
    result.steps.apply.skipped = true
    console.log('skipped instrumentation (--no-instrument)')
  } else {
    let instrumented = 0
    let already = 0
    let libOnly = 0
    for (const svc of services) {
      const installer = await pickInstaller(svc.dir)
      if (!installer) continue
      const plan: InstallPlan = await installer.plan(svc.dir)
      if (isEmptyPlan(plan) && !plan.libOnly) {
        already++
        continue
      }
      const outcome = await installer.apply(plan)
      if (outcome.outcome === 'instrumented') instrumented++
      else if (outcome.outcome === 'already-instrumented') already++
      else if (outcome.outcome === 'lib-only') libOnly++
    }
    result.steps.apply = { instrumented, alreadyInstrumented: already, libOnly, skipped: false }
    console.log(`instrumented ${instrumented}, already ${already}, lib-only ${libOnly}`)
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
    result.steps.daemon = ready ? 'spawned' : 'timed-out'
    if (!ready) {
      console.error(`neat: daemon did not become ready within ${timeoutMs}ms`)
      result.exitCode = 1
      return result
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
