#!/usr/bin/env node

import path from 'node:path'
import { promises as fs } from 'node:fs'
import { printBanner, readPackageVersion } from './banner.js'
import { DEFAULT_PROJECT, getGraph, resetGraph } from './graph.js'
import { extractFromDirectory } from './extract.js'
import {
  formatExtractionBanner,
  formatPrecisionFloorBanner,
  isStrictExtractionEnabled,
} from './extract/errors.js'
import { discoverServices } from './extract/services.js'
import type { DiscoveredService } from './extract/shared.js'
import { computeDivergences } from './divergences.js'
import { saveGraphToDisk } from './persist.js'
import { ensureNeatOutIgnored } from './gitignore.js'
import { renderValueForwardSummary } from './summary.js'
import { startWatch, type WatchHandle } from './watch.js'
import { runDeploy, renderOtelEnvBlock } from './deploy/detect.js'
import { pathsForProject } from './projects.js'
import {
  addProject,
  findDaemonByProject,
  listMachineProjects,
  listProjects,
  ProjectNameCollisionError,
  pruneRegistry,
  removeProject,
  removeDaemonRecord,
  setStatus,
  signalDaemonStop,
  type MachineProject,
} from './registry.js'
import {
  INSTALLERS,
  isEmptyPlan,
  pickInstaller,
  renderPatch,
  type InstallPlan,
  type PatchSection,
} from './installers/index.js'
import { runOrchestrator } from './orchestrator.js'
import { runSync } from './cli-verbs.js'
import { DivergenceTypeSchema, type DivergenceType } from '@neat.is/types'
import {
  createHttpClient,
  exitCodeForError,
  formatHuman,
  formatJson,
  HttpError,
  type HttpClient,
  resolveAuthToken,
  runBlastRadius,
  runDependencies,
  runDiff,
  runDivergences,
  runIncidents,
  runObservedDependencies,
  runPolicies,
  runRootCause,
  runSearch,
  runStaleEdges,
  TransportError,
  type VerbResult,
} from './cli-client.js'

export interface InitOptions {
  scanPath: string
  outPath: string
  // The project's registry name. Defaults to the basename of the scan path
  // when the user didn't pass `--project` (ADR-046 — project naming).
  project: string
  // Whether `project` was set explicitly via `--project`. The flag affects
  // which in-memory graph slot we use: explicit names get isolated slots
  // per ADR-026, the default basename keeps using DEFAULT_PROJECT for
  // back-compat with `neat watch`.
  projectExplicit: boolean
  apply: boolean
  dryRun: boolean
  noInstall: boolean
  // ADR-073 §5 — when true, append the per-type node/edge breakdown after
  // the value-forward findings block. Default false.
  verbose: boolean
}

export interface InitResult {
  // Process exit code. 0 on success, 1 on collision / runtime failure,
  // 2 on misuse (handled before we get here, but documented for completeness).
  exitCode: number
  // Paths the run actually wrote to. Empty in `--dry-run` except for
  // `neat.patch`. Useful for tests asserting "init only wrote X".
  writtenFiles: string[]
}

// True when this run came in through `npx neat.is` rather than a global
// `neat` binary on PATH. npx never puts `neat`/`neatd`/`neat-mcp` on PATH —
// only `npm i -g neat.is` does — so an npx user who copies a bare `neat init`
// example from the help screen hits `command not found`. We render every
// example with the prefix that actually works for how they invoked us.
//
// Two robust signals: npm sets `npm_command` / `npm_execpath` for anything it
// spawns (including `npx`), and an npx run resolves argv[1] under a temporary
// `_npx` cache dir rather than a global bin dir. Either one is enough.
export function isNpxInvocation(): boolean {
  if (process.env.npm_command === 'exec') return true
  const execpath = process.env.npm_execpath ?? ''
  if (execpath.includes('npx')) return true
  const entry = process.argv[1] ?? ''
  if (entry.includes('/_npx/') || entry.includes('\\_npx\\')) return true
  return false
}

// The command prefix every help example renders with. `npx neat.is` for an
// npx run, plain `neat` for a global install.
export function commandPrefix(): string {
  return isNpxInvocation() ? 'npx neat.is' : 'neat'
}

export function usage(): void {
  const neat = commandPrefix()
  console.log('Installed via npx? Prefix commands with `npx neat.is`, or install once: `npm i -g neat.is`.')
  console.log('')
  console.log(`usage: ${neat} <command> [args] [--project <name>]`)
  console.log('')
  console.log(`Run \`${neat}\` with no command from inside your project to go zero-to-graph in one step.`)
  console.log('')
  console.log('lifecycle commands:')
  console.log('  init <path>    One-time install: discover, extract, register, plan SDK install.')
  console.log('                 Snapshot lands in <path>/neat-out/graph.json by default')
  console.log('                 (or <path>/neat-out/<project>.json for non-default).')
  console.log('                 Flags:')
  console.log('                   --apply       run the SDK install patch in place')
  console.log('                   --dry-run     write only neat.patch; do not register or snapshot')
  console.log('                   --no-install  skip SDK install planning entirely')
  console.log('  watch <path>   Start neat-core, watch <path>, re-extract on changes.')
  console.log('                 PORT (default 8080), OTEL_PORT (4318), HOST (0.0.0.0)')
  console.log('                 control listeners. NEAT_OTLP_GRPC=true also opens 4317.')
  console.log('  list           Report the daemons running on this machine (alias: ps).')
  console.log('                 Reads ~/.neat/daemons/ and folds in any registered')
  console.log('                 project no daemon has self-described yet.')
  console.log('  ps             Alias of list.')
  console.log('  pause <name>   Stop a project\'s daemon until it is started again.')
  console.log('  resume <name>  Bring a paused project back; for a stopped daemon, re-run')
  console.log('                 `neat <path>` to start it.')
  console.log('  uninstall <name>')
  console.log('                 Stop a project\'s daemon and retire it. Does not touch')
  console.log('                 neat-out/, policy.json, or any user file.')
  console.log('  prune          Drop registry entries whose path is gone from disk.')
  console.log('                 Flags: --json   emit the removed list as JSON')
  console.log('  version        Print the installed @neat.is/core version and exit.')
  console.log('                 Aliases: --version, -v.')
  console.log('  skill          Install or print the Claude Code MCP drop-in.')
  console.log('                 Flags:')
  console.log('                   --print-config   print the JSON snippet to stdout')
  console.log('                   --apply          merge mcpServers.neat into ~/.claude.json')
  console.log('  deploy         Detect the deploy substrate, generate NEAT_AUTH_TOKEN,')
  console.log('                 emit a docker-compose / systemd / docker run artifact, and')
  console.log('                 print the OTel env-vars block to paste into your platform.')
  console.log('  sync           Re-run discovery, extraction, and SDK apply against the')
  console.log('                 registered project, then notify the running daemon.')
  console.log('                 Flags:')
  console.log('                   --project <name>   target a registered project by name')
  console.log('                   --to <url>         push the snapshot to a remote daemon')
  console.log('                   --token <token>    bearer token for --to (or $NEAT_REMOTE_TOKEN)')
  console.log('                   --dry-run          run extraction in-memory; do not write')
  console.log('                   --no-instrument    skip the SDK install apply step')
  console.log('                   --json             emit the delta summary as JSON')
  console.log('')
  console.log('query commands (mirror the MCP tools, ADR-050):')
  console.log('  root-cause <node-id>             Walk inbound edges to find what broke first.')
  console.log(`                                   example: ${neat} root-cause service:<name>`)
  console.log('  blast-radius <node-id>           BFS outbound — what would break if this dies.')
  console.log(`                                   example: ${neat} blast-radius database:<host>`)
  console.log('  dependencies <node-id>           Transitive outbound dependencies.')
  console.log('                                   Flags: --depth N (default 3, max 10)')
  console.log(`                                   example: ${neat} dependencies service:<name> --depth 2`)
  console.log('  observed-dependencies <node-id>  OBSERVED-only outbound edges (runtime traffic).')
  console.log(`                                   example: ${neat} observed-dependencies service:<name>`)
  console.log('  incidents [<node-id>]            Recent error events; per-node when an id is given.')
  console.log('                                   Flags: --limit N (default 20)')
  console.log(`                                   example: ${neat} incidents service:<name> --limit 5`)
  console.log('  search <query>                   Semantic (or substring) match on node names/ids.')
  console.log(`                                   example: ${neat} search "checkout"`)
  console.log('  diff --against <snapshot>        Compare the live graph to a saved snapshot.')
  console.log(`                                   example: ${neat} diff --against ./snapshots/baseline.json`)
  console.log('  stale-edges                      Recent OBSERVED → STALE transitions.')
  console.log('                                   Flags: --limit N, --edge-type CALLS|CONNECTS_TO|...')
  console.log(`                                   example: ${neat} stale-edges --edge-type CALLS`)
  console.log('  policies                         Current policy violations.')
  console.log('                                   Flags: --node <id>, --hypothetical-action <json>')
  console.log(`                                   example: ${neat} policies --node service:<name> --json`)
  console.log('  divergences                      Where code (EXTRACTED) and production (OBSERVED) disagree.')
  console.log('                                   Flags: --type <list>, --min-confidence <0..1>, --node <id>')
  console.log(`                                   example: ${neat} divergences --min-confidence 0.7`)
  console.log('')
  console.log('flags:')
  console.log('  --project <name>   Name the project this command targets. Default: "default".')
  console.log('  --json             Emit machine-readable JSON instead of human text. Query verbs only.')
  console.log('')
  console.log('exit codes:')
  console.log('  0  success')
  console.log('  1  server error (4xx/5xx body printed to stderr)')
  console.log('  2  misuse (missing args, bad flags) — handled before any network call')
  console.log('  3  environmental — daemon unreachable, or one of ports 8080 / 4318 / 6328')
  console.log('     is held by another process when `neat <path>` tries to spawn the daemon')
  console.log('')
  console.log('environment:')
  console.log('  NEAT_API_URL    base URL for the core REST API (default http://localhost:8080)')
  console.log('                  alias: NEAT_CORE_URL (the name the MCP server reads)')
  console.log('  NEAT_PROJECT    project name when --project isn\'t passed')
}

// Tiny argv parser — pulls `--project <name>`, the v0.2.5 init flags, and
// the v0.2.8 verb flags out of `rest`. Boolean / value flags are surfaced
// unconditionally; per-command validation lives in `main`.
interface ParsedArgs {
  project: string | null
  apply: boolean
  dryRun: boolean
  noInstall: boolean
  noInstrument: boolean
  noOpen: boolean
  yes: boolean
  verbose: boolean
  printConfig: boolean
  json: boolean
  depth: number | null
  limit: number | null
  edgeType: string | null
  node: string | null
  since: string | null
  against: string | null
  errorId: string | null
  hypotheticalAction: string | null
  type: string | null
  minConfidence: number | null
  // `neat sync` (ADR-074 §1) — remote daemon URL + bearer token.
  to: string | null
  token: string | null
  positional: string[]
}

// String-valued flags supported across the verb surface. Each entry maps the
// canonical `--flag` name (and its `--flag=` equivalent) to the parsed-args
// field that receives it. Centralising the table keeps misuse diagnostics
// (exit code 2) consistent across verbs.
const STRING_FLAGS = [
  ['--project', 'project'],
  ['--depth', 'depth'],
  ['--limit', 'limit'],
  ['--edge-type', 'edgeType'],
  ['--node', 'node'],
  ['--since', 'since'],
  ['--against', 'against'],
  ['--error-id', 'errorId'],
  ['--hypothetical-action', 'hypotheticalAction'],
  ['--type', 'type'],
  ['--min-confidence', 'minConfidence'],
  ['--to', 'to'],
  ['--token', 'token'],
] as const

function parseArgs(rest: string[]): ParsedArgs {
  const positional: string[] = []
  const out: ParsedArgs = {
    project: null,
    apply: false,
    dryRun: false,
    noInstall: false,
    noInstrument: false,
    noOpen: false,
    yes: false,
    verbose: false,
    printConfig: false,
    json: false,
    depth: null,
    limit: null,
    edgeType: null,
    node: null,
    since: null,
    against: null,
    errorId: null,
    hypotheticalAction: null,
    type: null,
    minConfidence: null,
    to: null,
    token: null,
    positional: [],
  }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string

    // Boolean flags first.
    if (arg === '--apply') { out.apply = true; continue }
    if (arg === '--dry-run') { out.dryRun = true; continue }
    if (arg === '--no-install') { out.noInstall = true; continue }
    if (arg === '--no-instrument') { out.noInstrument = true; continue }
    if (arg === '--no-open') { out.noOpen = true; continue }
    if (arg === '--yes' || arg === '-y') { out.yes = true; continue }
    if (arg === '--verbose') { out.verbose = true; continue }
    if (arg === '--print-config') { out.printConfig = true; continue }
    if (arg === '--json') { out.json = true; continue }

    // String/number flags via the shared table.
    let matched = false
    for (const [flag, field] of STRING_FLAGS) {
      if (arg === flag) {
        const next = rest[i + 1]
        if (next === undefined) {
          console.error(`neat: ${flag} requires a value`)
          process.exit(2)
        }
        assignFlag(out, field, next)
        i++
        matched = true
        break
      }
      if (arg.startsWith(`${flag}=`)) {
        assignFlag(out, field, arg.slice(flag.length + 1))
        matched = true
        break
      }
    }
    if (matched) continue
    positional.push(arg)
  }
  out.positional = positional
  return out
}

export { parseArgs }

// Number flags get parsed at assignment time so misuse (`--depth foo`)
// surfaces with exit code 2 before any network call.
function assignFlag(out: ParsedArgs, field: (typeof STRING_FLAGS)[number][1], value: string): void {
  if (field === 'depth' || field === 'limit') {
    const n = Number(value)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      console.error(`neat: --${field === 'depth' ? 'depth' : 'limit'} must be a positive integer`)
      process.exit(2)
    }
    out[field] = n
    return
  }
  if (field === 'minConfidence') {
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      console.error('neat: --min-confidence must be a number in [0, 1]')
      process.exit(2)
    }
    out.minConfidence = n
    return
  }
  // String fields.
  ;(out as unknown as Record<string, unknown>)[field] = value
}

// Per-type node/edge counts + compat formatting moved into summary.ts as
// part of the value-forward findings block (issue #305 / ADR-073 §5).

// `readPackageVersion` + `printBanner` live in banner.ts so the orchestrator
// can print the same artwork without pulling in the whole CLI dispatch (and
// without a cli ↔ orchestrator import cycle). Re-exported here so existing
// importers of `cli.js` (e.g. the banner test, MCP) keep resolving them.
export { printBanner, readPackageVersion }

function printVersion(): void {
  process.stdout.write(`${readPackageVersion()}\n`)
}

// One `neat list` / `neat ps` row. A discovery-backed row reports the daemon's
// state and ports; a legacy registry row (no daemon file yet) reports
// `registered` and the registry status so the migration window stays legible.
function formatMachineProjectRow(r: MachineProject): string {
  if (r.ports) {
    const where = r.pid !== undefined ? `\tpid=${r.pid}` : ''
    return `${r.project}\t${r.state}\trest=${r.ports.rest} otlp=${r.ports.otlp} web=${r.ports.web}\t${r.projectPath}${where}`
  }
  const status = r.registryStatus ? `\t(${r.registryStatus})` : ''
  return `${r.project}\t${r.state}${status}\t${r.projectPath}`
}

function printDiscoveryReport(opts: InitOptions, services: DiscoveredService[]): void {
  const languages = [...new Set(services.map((s) => s.node.language))].sort()
  const mode = opts.dryRun ? 'dry-run' : opts.apply ? 'apply' : 'patch-only'
  printBanner()
  console.log('=== neat init: discovery ===')
  console.log(`scan path: ${opts.scanPath}`)
  console.log(`project:   ${opts.project}`)
  console.log(`mode:      ${mode}`)
  console.log(`services:  ${services.length}`)
  for (const s of services) {
    const where = s.node.repoPath && s.node.repoPath.length > 0 ? s.node.repoPath : '.'
    console.log(`  - ${s.node.name} (${s.node.language}) — ${where}`)
  }
  console.log(`languages: ${languages.length > 0 ? languages.join(', ') : '(none)'}`)
  if (opts.noInstall) {
    console.log('install:   skipped (--no-install)')
  } else if (opts.dryRun) {
    console.log('install:   patch will be written to neat.patch; nothing else.')
  } else if (opts.apply) {
    console.log('install:   patch will be applied in place. Run `npm install` afterwards.')
  } else {
    console.log('install:   patch will be written to neat.patch for review.')
  }
  console.log('')
}

async function buildPatchSections(
  services: DiscoveredService[],
  project: string,
): Promise<PatchSection[]> {
  const sections: PatchSection[] = []
  for (const svc of services) {
    const installer = await pickInstaller(svc.dir)
    if (!installer) continue
    // v0.4.1 / refs #339 — pass the registered project name so the per-
    // package `.env.neat` carries `OTEL_SERVICE_NAME=<project>`. The daemon
    // routes spans by registered project name; matching keys end-to-end
    // is what keeps OBSERVED edges landing.
    const plan: InstallPlan = await installer.plan(svc.dir, { project })
    // Lib-only + runtime-kind-skipped packages keep a section so the dry-run
    // patch documents the skip and the apply summary counts them (ADR-069 §2,
    // v0.4.4 / #370). Empty plans without either flag are already-instrumented
    // end-to-end and drop out.
    if (isEmptyPlan(plan) && !plan.libOnly && plan.runtimeKind === undefined) continue
    sections.push({ installer: installer.name, plan })
  }
  return sections
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const written: string[] = []

  // ── Step 1: validate path ────────────────────────────────────────────
  const stat = await fs.stat(opts.scanPath).catch(() => null)
  if (!stat || !stat.isDirectory()) {
    console.error(`neat init: ${opts.scanPath} is not a directory`)
    return { exitCode: 2, writtenFiles: written }
  }

  // ── Step 2: discovery (ADR-046 #2 — before any mutation) ─────────────
  const services = await discoverServices(opts.scanPath)
  printDiscoveryReport(opts, services)

  // ── Step 3: plan SDK install (pure data, no fs writes) ───────────────
  const sections = opts.noInstall ? [] : await buildPatchSections(services, opts.project)
  const patch = renderPatch(sections)
  const patchPath = path.join(opts.scanPath, 'neat.patch')

  // ── Step 4: dry-run shortcut — only neat.patch is allowed to land ────
  if (opts.dryRun) {
    await fs.writeFile(patchPath, patch, 'utf8')
    written.push(patchPath)
    console.log(`dry-run: patch written to ${patchPath}`)
    // ADR-073 §6 — list the planned `.gitignore` write alongside the other
    // planned writes. No file mutation in dry-run; only the announcement.
    const gitignorePath = path.join(opts.scanPath, '.gitignore')
    const gitignoreExists = await fs.stat(gitignorePath).then(() => true).catch(() => false)
    const verb = gitignoreExists ? 'append' : 'create'
    console.log(`dry-run: would ${verb} ${gitignorePath} (add neat-out/)`)
    console.log('rerun without --dry-run to register and snapshot.')
    return { exitCode: 0, writtenFiles: written }
  }

  // ── Step 5: extraction + snapshot ────────────────────────────────────
  // Use DEFAULT_PROJECT for the in-memory graph slot when --project wasn't
  // explicitly passed; named projects get isolated slots per ADR-026.
  const graphKey = opts.projectExplicit ? opts.project : DEFAULT_PROJECT
  resetGraph(graphKey)
  const graph = getGraph(graphKey)
  // ADR-065 — per-file extraction failures land alongside the snapshot in
  // <projectDir>/neat-out/errors.ndjson. Same file as OTel error events
  // (ADR-033) with a `source: 'extract'` discriminator.
  const projectPaths = pathsForProject(
    graphKey,
    path.join(opts.scanPath, 'neat-out'),
  )
  const errorsPath = path.join(path.dirname(opts.outPath), path.basename(projectPaths.errorsPath))
  const result = await extractFromDirectory(graph, opts.scanPath, { errorsPath })
  await saveGraphToDisk(graph, opts.outPath)
  written.push(opts.outPath)

  // ADR-073 §6 — ensure `neat-out/` is git-ignored. Snapshot just landed on
  // disk; an un-ignored neat-out/ would leak into git history on the next
  // commit. Idempotent: the helper no-ops when the line is already present.
  const gitignoreResult = await ensureNeatOutIgnored(opts.scanPath)
  if (gitignoreResult.action !== 'unchanged') {
    written.push(gitignoreResult.file)
  }

  // ── Step 6: register in the machine-level registry ───────────────────
  // Idempotent re-init of the same path under the same name refreshes the
  // entry; collision against a different path exits non-zero (ADR-046 #7).
  const languages = [...new Set(services.map((s) => s.node.language))].sort()
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
    if (err instanceof ProjectNameCollisionError) {
      console.error(`neat init: ${err.message}`)
      console.error('pass --project <other-name> to register under a different name.')
      return { exitCode: 1, writtenFiles: written }
    }
    throw err
  }

  // Narrow the active-project surface to the project the operator just
  // registered. Mirrors the bare-orchestrator behaviour so `neat init` and
  // `neat <path>` agree on the activation contract.
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

  // ── Step 7: write or apply patch ─────────────────────────────────────
  if (!opts.noInstall) {
    if (opts.apply) {
      let instrumented = 0
      let alreadyInstrumented = 0
      let libOnly = 0
      let browserBundle = 0
      let reactNative = 0
      for (const section of sections) {
        const installer = INSTALLERS.find((i) => i.name === section.installer)
        if (!installer) continue
        const outcome = await installer.apply(section.plan)
        if (outcome.outcome === 'instrumented') {
          instrumented++
          for (const f of outcome.writtenFiles) written.push(f)
        } else if (outcome.outcome === 'already-instrumented') {
          alreadyInstrumented++
        } else if (outcome.outcome === 'lib-only') {
          libOnly++
        } else if (outcome.outcome === 'browser-bundle') {
          browserBundle++
          console.log(`skipping ${section.plan.serviceDir}: browser bundle; browser-OTel support lands in a future release.`)
        } else if (outcome.outcome === 'react-native') {
          reactNative++
          console.log(`skipping ${section.plan.serviceDir}: React Native target; browser-OTel support lands in a future release.`)
        }
      }
      if (sections.length > 0) {
        console.log('')
        const parts = [
          `instrumented ${instrumented}`,
          `already-instrumented ${alreadyInstrumented}`,
          `lib-only ${libOnly}`,
        ]
        if (browserBundle > 0) parts.push(`browser-bundle ${browserBundle}`)
        if (reactNative > 0) parts.push(`react-native ${reactNative}`)
        console.log(`apply: ${parts.join(', ')}`)
        console.log('Run `npm install` (or your language equivalent) to refresh lockfiles.')
      }
    } else {
      await fs.writeFile(patchPath, patch, 'utf8')
      written.push(patchPath)
    }
  }

  // ── Step 8: summary + incompatibilities ──────────────────────────────
  // ADR-073 §5 / issue #305 — findings-first: compat violations, top
  // divergences, services without OBSERVED coverage, then the OTel env-vars
  // block. Per-type counts ride behind `--verbose`.
  console.log('')
  console.log(`snapshot: ${opts.outPath}`)
  console.log(`added: ${result.nodesAdded} nodes, ${result.edgesAdded} edges`)
  console.log('')
  const divergenceResult = computeDivergences(graph)
  console.log(
    renderValueForwardSummary({
      graph,
      divergences: divergenceResult.divergences,
      verbose: opts.verbose,
    }),
  )
  // ADR-065 — loud failure mode banner. Unconditional; 0 is a positive
  // signal. When errors > 0, also surface the sidecar path so the operator
  // can read per-file detail.
  console.log(formatExtractionBanner(result.extractionErrors))
  if (result.extractionErrors > 0) {
    console.log(`errors:   ${errorsPath}`)
  }
  // ADR-066 — precision-floor drop banner. Always emitted; 0 is observable
  // as a positive signal that no cross-service heuristic edges grew the
  // graph this pass.
  console.log(formatPrecisionFloorBanner(result.extractedDropped))

  // ADR-065 — NEAT_STRICT_EXTRACTION=1 makes any per-file failure exit
  // non-zero. Default is forgiving (banner only). Exit code 4 keeps
  // misuse (2) and daemon-down (3) distinguishable per the CLI contract.
  if (result.extractionErrors > 0 && isStrictExtractionEnabled()) {
    return { exitCode: 4, writtenFiles: written }
  }

  return { exitCode: 0, writtenFiles: written }
}

// ── Claude Code skill (ADR-049 / v0.2.5 step 6) ────────────────────────
//
// The skill is a one-shot MCP-config drop-in. Source of truth for the
// snippet lives here (the @neat.is/claude-skill package's
// claude_code_config.json holds an identical copy for documentation; a
// contract test keeps the two byte-aligned).
export const CLAUDE_SKILL_CONFIG = {
  mcpServers: {
    neat: {
      type: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@neat.is/mcp'],
      env: {
        NEAT_CORE_URL: 'http://localhost:8080',
      },
    },
  },
}

function claudeConfigPath(): string {
  // ~/.claude.json is Claude Code's user-level MCP config. Tests override
  // via NEAT_CLAUDE_CONFIG so they don't touch the real file.
  const override = process.env.NEAT_CLAUDE_CONFIG
  if (override && override.length > 0) return path.resolve(override)
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  return path.join(home, '.claude.json')
}

export interface SkillOptions {
  apply: boolean
  printConfig: boolean
}

export async function runSkill(opts: SkillOptions): Promise<{ exitCode: number }> {
  const snippet = JSON.stringify(CLAUDE_SKILL_CONFIG, null, 2) + '\n'

  if (opts.printConfig) {
    process.stdout.write(snippet)
    return { exitCode: 0 }
  }

  if (opts.apply) {
    const target = claudeConfigPath()
    let existing: Record<string, unknown> = {}
    try {
      existing = JSON.parse(await fs.readFile(target, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`neat skill: failed to read ${target} — ${(err as Error).message}`)
        return { exitCode: 1 }
      }
    }
    // Merge mcpServers.neat without disturbing other entries the user
    // might have wired up by hand.
    const mcp =
      (existing as { mcpServers?: Record<string, unknown> }).mcpServers ?? {}
    const merged = {
      ...existing,
      mcpServers: { ...mcp, neat: CLAUDE_SKILL_CONFIG.mcpServers.neat },
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, JSON.stringify(merged, null, 2) + '\n', 'utf8')
    console.log(`neat skill: wrote mcpServers.neat to ${target}`)
    console.log('restart Claude Code to pick up the new MCP server.')
    return { exitCode: 0 }
  }

  console.log('neat skill — Claude Code MCP drop-in for NEAT')
  console.log('')
  console.log('  --print-config   print the JSON snippet to stdout')
  console.log('  --apply          merge mcpServers.neat into ~/.claude.json')
  console.log('')
  console.log('Manual install: copy mcpServers.neat from --print-config into ~/.claude.json,')
  console.log('then restart Claude Code. See packages/claude-skill/SKILL.md for the tool list.')
  console.log('')
  console.log('The MCP server reads NEAT_CORE_URL for the daemon URL — point it at a')
  console.log('non-default daemon by editing that value in the generated config.')
  return { exitCode: 0 }
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  // First token, for the help/version flag checks. The command dispatch below
  // keys off the first *positional* (flag-stripped) instead, so a bare
  // `npx neat.is --no-open` still reaches the orchestrator.
  const cmd0 = argv[0]

  // `-h` / `--help` print the usage screen and exit clean.
  if (cmd0 === '-h' || cmd0 === '--help') {
    usage()
    process.exit(0)
  }

  // The dispatcher honors three spellings: --version, -v, version.
  if (cmd0 === '--version' || cmd0 === '-v' || cmd0 === 'version') {
    printVersion()
    process.exit(0)
  }

  // No positional command — `npx neat.is` (optionally with flags like
  // `--no-open`) run from inside a repo. This is the zero-to-graph path
  // (issue #483): run the orchestrator on the current working directory, the
  // same dispatch the explicit `neat <path>` form takes (project name =
  // basename of cwd). We detect "no command" by the absence of any
  // positional after flag-stripping, so a bare `npx neat.is --no-instrument`
  // still lands here instead of treating the flag as a command.
  const argvParsed = parseArgs(argv)
  if (argvParsed.positional.length === 0) {
    const orchestratorCode = await tryOrchestrator(process.cwd(), argvParsed)
    // tryOrchestrator returns null only when its path isn't a directory,
    // which can't happen for process.cwd(); the non-null branch always runs.
    if (orchestratorCode !== null && orchestratorCode !== 0) process.exit(orchestratorCode)
    return
  }

  // From here on, the first positional is the command. Reuse the already-
  // parsed flags and drop the command token from the positional list, so each
  // verb's `parsed.positional[0]` stays the verb's own first argument (e.g.
  // the node-id for `root-cause`), unchanged from the pre-#483 dispatch.
  const cmd = argvParsed.positional[0] as string
  const parsed: ParsedArgs = { ...argvParsed, positional: argvParsed.positional.slice(1) }
  const { positional, apply, dryRun, noInstall } = parsed
  const project = parsed.project ?? DEFAULT_PROJECT

  if (cmd === 'init') {
    const target = positional[0]
    if (!target) {
      console.error('neat init: missing <path>')
      usage()
      process.exit(2)
    }
    if (apply && dryRun) {
      console.error('neat init: --apply and --dry-run are mutually exclusive')
      process.exit(2)
    }
    const scanPath = path.resolve(target)
    // ADR-046 — when --project isn't passed, the registry name defaults to
    // the basename of the scan path. The in-memory graph slot stays on
    // DEFAULT_PROJECT (back-compat with existing `neat watch` invocations).
    const projectExplicit = parsed.project !== null
    const projectName = projectExplicit ? project : path.basename(scanPath)
    // Default project keeps writing to graph.json (ADR-026 back-compat);
    // named projects use <project>.json under the same neat-out directory.
    const projectKey = projectExplicit ? project : DEFAULT_PROJECT
    const fallback = pathsForProject(projectKey, path.join(scanPath, 'neat-out')).snapshotPath
    const outPath = path.resolve(process.env.NEAT_OUT_PATH ?? fallback)
    const result = await runInit({
      scanPath,
      outPath,
      project: projectName,
      projectExplicit,
      apply,
      dryRun,
      noInstall,
      verbose: parsed.verbose,
    })
    if (result.exitCode !== 0) process.exit(result.exitCode)
    return
  }

  if (cmd === 'watch') {
    const target = positional[0]
    if (!target) {
      console.error('neat watch: missing <path>')
      usage()
      process.exit(2)
    }
    const scanPath = path.resolve(target)
    const stat = await fs.stat(scanPath).catch(() => null)
    if (!stat || !stat.isDirectory()) {
      console.error(`neat watch: ${scanPath} is not a directory`)
      process.exit(2)
    }
    const projectPaths = pathsForProject(project, path.join(scanPath, 'neat-out'))
    const outPath = path.resolve(process.env.NEAT_OUT_PATH ?? projectPaths.snapshotPath)
    const errorsPath = path.resolve(
      process.env.NEAT_ERRORS_PATH ??
        path.join(path.dirname(outPath), path.basename(projectPaths.errorsPath)),
    )
    const staleEventsPath = path.resolve(
      process.env.NEAT_STALE_EVENTS_PATH ??
        path.join(path.dirname(outPath), path.basename(projectPaths.staleEventsPath)),
    )

    const embeddingsCachePath = process.env.NEAT_EMBEDDINGS_CACHE_PATH
      ? path.resolve(process.env.NEAT_EMBEDDINGS_CACHE_PATH)
      : undefined

    const handle: WatchHandle = await startWatch(getGraph(project), {
      scanPath,
      outPath,
      errorsPath,
      staleEventsPath,
      project,
      ...(embeddingsCachePath ? { embeddingsCachePath } : {}),
      host: process.env.HOST ?? '0.0.0.0',
      port: Number(process.env.PORT ?? 8080),
      otelPort: Number(process.env.OTEL_PORT ?? 4318),
      otelGrpc: process.env.NEAT_OTLP_GRPC === 'true',
      otelGrpcPort: process.env.NEAT_OTLP_GRPC_PORT
        ? Number(process.env.NEAT_OTLP_GRPC_PORT)
        : undefined,
    })

    // startPersistLoop already wires SIGTERM/SIGINT to flush + exit. Hook in
    // ahead of it so the watcher closes cleanly first; the persist handler's
    // `process.exit(0)` will still run after our stop() resolves.
    let shuttingDown = false
    const shutdown = (signal: NodeJS.Signals): void => {
      if (shuttingDown) return
      shuttingDown = true
      console.log(`neat watch: ${signal} received, stopping…`)
      void handle.stop().catch((err) => {
        console.error('neat watch: shutdown error', err)
      })
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
    return
  }

  // `list` / `ps` both report the daemons discovered on the machine. ADR-096
  // §6 — discovery reads the lock-free `~/.neat/daemons/` directory and folds
  // in any legacy registry entries no daemon has self-described yet, so a
  // pre-migration install still lists its projects.
  if (cmd === 'list' || cmd === 'ps') {
    const rows = await listMachineProjects()
    if (rows.length === 0) {
      console.log('no daemons running and no projects registered. run `neat init <path>` to register one.')
      return
    }
    for (const r of rows) {
      console.log(formatMachineProjectRow(r))
    }
    return
  }

  // `pause` stops a project's daemon. Under one-daemon-per-project (ADR-096)
  // that is the per-daemon shutdown driven by the discovery record's pid. While
  // a project still lives only in the legacy registry (the migration window
  // before #508 lands), it falls back to flipping the registry status the
  // multi-project daemon reads.
  if (cmd === 'pause') {
    const name = positional[0]
    if (!name) {
      console.error('neat pause: missing <name>')
      usage()
      process.exit(2)
    }
    const daemon = await findDaemonByProject(name)
    if (daemon) {
      if (daemon.live && signalDaemonStop(daemon.record.pid)) {
        console.log(`paused: ${name} (${daemon.record.projectPath}) — stopped daemon pid ${daemon.record.pid}`)
      } else {
        console.log(`paused: ${name} (${daemon.record.projectPath}) — daemon was not running`)
      }
      return
    }
    try {
      const entry = await setStatus(name, 'paused')
      console.log(`paused: ${entry.name} (${entry.path})`)
    } catch (err) {
      console.error((err as Error).message)
      process.exit(1)
    }
    return
  }

  // `resume` brings a paused project back. Spawning a per-project daemon is the
  // orchestrator's job (`neat <path>`), so against a stopped daemon record we
  // point the operator at it; against a legacy registry entry we flip the
  // status the multi-project daemon reads, preserving the pre-migration shape.
  if (cmd === 'resume') {
    const name = positional[0]
    if (!name) {
      console.error('neat resume: missing <name>')
      usage()
      process.exit(2)
    }
    const daemon = await findDaemonByProject(name)
    if (daemon) {
      if (daemon.live) {
        console.log(`resume: ${name} (${daemon.record.projectPath}) — daemon already running`)
      } else {
        console.log(`resume: ${name} (${daemon.record.projectPath}) — run \`neat ${daemon.record.projectPath}\` to start its daemon again`)
      }
      return
    }
    try {
      const entry = await setStatus(name, 'active')
      console.log(`resumed: ${entry.name} (${entry.path})`)
    } catch (err) {
      console.error((err as Error).message)
      process.exit(1)
    }
    return
  }

  if (cmd === 'skill') {
    const result = await runSkill({ apply: parsed.apply, printConfig: parsed.printConfig })
    if (result.exitCode !== 0) process.exit(result.exitCode)
    return
  }

  // `uninstall` retires a project. Under ADR-096 that means stopping its daemon
  // (via the discovery record's pid) and clearing its discovery file, then
  // dropping any legacy registry row. As before it never touches neat-out/,
  // policy.json, or user files at the project path (ADR-048 #6).
  if (cmd === 'uninstall') {
    const name = positional[0]
    if (!name) {
      console.error('neat uninstall: missing <name>')
      usage()
      process.exit(2)
    }
    const daemon = await findDaemonByProject(name)
    const removed = await removeProject(name)
    if (!daemon && !removed) {
      console.error(`neat uninstall: no project named "${name}"`)
      process.exit(1)
    }
    const projectPath = daemon?.record.projectPath ?? removed?.path ?? '(unknown path)'
    if (daemon) {
      if (daemon.live && signalDaemonStop(daemon.record.pid)) {
        console.log(`uninstall: ${name} — stopped daemon pid ${daemon.record.pid}`)
      }
      // Clear the discovery copy. A live daemon clears its own on graceful stop,
      // but removing it here covers a daemon that crashed without cleanup and
      // makes the verb idempotent against a stale record.
      await removeDaemonRecord(daemon.source)
    }
    console.log(`unregistered: ${name} (${projectPath})`)
    console.log('note: neat-out/, policy.json, and other files at the project path were left in place.')
    return
  }

  if (cmd === 'prune') {
    // #463 — one-shot cleanup of registry entries whose path is gone. Explicit
    // user intent, so it drops any ENOENT entry immediately regardless of the
    // auto-prune TTL. Only definite ENOENT entries go — a project whose path
    // still exists, or one behind a transient stat error, is left alone.
    const removed = await pruneRegistry({ ttlMs: 0 })
    if (parsed.json) {
      console.log(JSON.stringify(removed.map((p) => ({ name: p.name, path: p.path })), null, 2))
      return
    }
    if (removed.length === 0) {
      console.log('nothing to prune — every registered project path still exists.')
      return
    }
    console.log(`pruned ${removed.length} project${removed.length === 1 ? '' : 's'}: ${removed.map((p) => p.name).join(', ')}`)
    return
  }

  if (cmd === 'deploy') {
    // ADR-073 §2 — detect substrate, generate token, emit artifact, print
    // the OTel env-vars block. Token is the only secret printed to stdout;
    // the artifact written to disk names the env-var by reference only.
    const artifact = await runDeploy()
    const block = renderOtelEnvBlock(artifact.token)

    console.log()
    console.log(`Substrate detected: ${artifact.substrate}`)
    if (artifact.artifactPath) {
      console.log(`Artifact written:   ${artifact.artifactPath}`)
    } else {
      console.log('No on-disk artifact — copy the snippet below into your substrate.')
      console.log()
      console.log(artifact.contents)
    }
    console.log()
    console.log('NEAT_AUTH_TOKEN (store this — it will not be printed again):')
    console.log(`  ${artifact.token}`)
    console.log()
    console.log("For your application's deploy platform, set these env vars:")
    console.log(block.split('\n').map((l) => `  ${l}`).join('\n'))
    console.log()
    console.log('Once NEAT is running, your dashboard will be at:')
    console.log('  https://<host>:6328')
    console.log()
    console.log('To start NEAT, run:')
    console.log(`  ${artifact.startCommand}`)
    return
  }

  if (cmd === 'sync') {
    // ADR-074 §1 — re-runs discovery + extract + SDK apply + daemon notify
    // against the registered project. Skips registry registration, browser
    // open, daemon spawn, and the first-run summary block.
    const result = await runSync({
      ...(parsed.project ? { project: parsed.project } : {}),
      ...(parsed.to ? { to: parsed.to } : {}),
      ...(parsed.token ? { token: parsed.token } : {}),
      dryRun: parsed.dryRun,
      noInstrument: parsed.noInstrument,
      json: parsed.json,
    })
    if (result.exitCode !== 0) process.exit(result.exitCode)
    return
  }

  // ── Query verbs (ADR-050) ────────────────────────────────────────────
  // The nine verbs mirror the MCP tool allowlist. Same multi-project
  // routing, same three-part response shape (summary + block + footer),
  // exit codes branch on misuse vs server error vs daemon-down.
  if (QUERY_VERBS.has(cmd)) {
    const code = await runQueryVerb(cmd, parsed)
    if (code !== 0) process.exit(code)
    return
  }

  // ── Bare-path orchestrator (ADR-073 §1) ──────────────────────────────
  // `neat <path>` — when the first positional doesn't match any verb but
  // resolves to a directory, hand the run off to the orchestrator. This is
  // the `npx neat.is <path>` shape from ADR-073: one command, end-to-end.
  const orchestratorCode = await tryOrchestrator(cmd, parsed)
  if (orchestratorCode !== null) {
    if (orchestratorCode !== 0) process.exit(orchestratorCode)
    return
  }

  console.error(`neat: unknown command "${cmd}"`)
  usage()
  process.exit(1)
}

// Returns null when the first positional doesn't resolve to a directory
// (so the caller can fall through to the unknown-command error). Returns
// an exit code when the orchestrator ran.
async function tryOrchestrator(cmd: string, parsed: ParsedArgs): Promise<number | null> {
  const scanPath = path.resolve(cmd)
  const stat = await fs.stat(scanPath).catch(() => null)
  if (!stat || !stat.isDirectory()) return null

  const projectExplicit = parsed.project !== null
  const projectName = projectExplicit ? (parsed.project as string) : path.basename(scanPath)
  const result = await runOrchestrator({
    scanPath,
    project: projectName,
    projectExplicit,
    noInstrument: parsed.noInstrument,
    noOpen: parsed.noOpen,
    yes: parsed.yes,
  })
  return result.exitCode
}

// ── Query verb dispatcher ──────────────────────────────────────────────

export const QUERY_VERBS: Set<string> = new Set([
  'root-cause',
  'blast-radius',
  'dependencies',
  'observed-dependencies',
  'incidents',
  'search',
  'diff',
  'stale-edges',
  'policies',
  // Tenth verb (ADR-060) — amends ADR-050's locked allowlist of nine.
  'divergences',
])

// ADR-050 #2: --project flag → NEAT_PROJECT env → undefined (server's
// `default` slot). undefined keeps legacy unprefixed routes; explicit names
// route through /projects/:project/... Returns undefined when neither was set,
// which is the signal to resolveProjectForVerb that it should look at the
// registered projects and pick intelligently.
function resolveProjectFlag(parsed: ParsedArgs): string | undefined {
  if (parsed.project) return parsed.project
  const env = process.env.NEAT_PROJECT
  if (env && env.length > 0 && env !== DEFAULT_PROJECT) return env
  return undefined
}

// Thrown when a bare query verb (no --project, no NEAT_PROJECT) can't pick a
// project on its own — either nothing is registered, or several are and none
// is named `default`. Carries an exit code so the dispatcher can surface a
// helpful message instead of letting the request 404 on the `default` slot.
export class ProjectResolutionError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = 2,
  ) {
    super(message)
    this.name = 'ProjectResolutionError'
  }
}

// What `GET /projects` hands back (registry.ts RegistryEntry passthrough). We
// only read `name`, so keep the shape minimal.
interface RegistryProjectSummary {
  name: string
}

// Decide which project a bare query verb should route to (issue #500). When the
// user passed --project or set NEAT_PROJECT, that wins untouched. Otherwise we
// ask the daemon which projects it has registered and pick:
//
//   • exactly one registered → use it (the one-command `npx neat.is` case, so
//     `neat divergences` "just works" without --project)
//   • a project literally named `default` exists → keep the legacy default
//     routing (return undefined → unprefixed routes the server maps to default)
//   • several registered, none `default` → don't guess; error and list them
//   • none registered → error clearly rather than 404 on `default`
//
// A daemon that can't be reached lets the TransportError propagate, so the verb
// still exits 3 with the existing "is the daemon running?" message.
export async function resolveProjectForVerb(
  client: HttpClient,
  parsed: ParsedArgs,
): Promise<string | undefined> {
  const explicit = resolveProjectFlag(parsed)
  if (explicit) return explicit

  // Bare verb. Let TransportError out (exit 3); only HttpError/parse issues
  // become a resolution error here.
  const projects = await client.get<RegistryProjectSummary[]>('/projects')

  if (projects.some((p) => p.name === DEFAULT_PROJECT)) {
    // Back-compat: a real `default` project exists, so the legacy unprefixed
    // routes resolve. Returning undefined keeps that path.
    return undefined
  }

  if (projects.length === 1) {
    return projects[0]!.name
  }

  if (projects.length === 0) {
    throw new ProjectResolutionError(
      'No projects are registered with the daemon yet. Run `npx neat.is` in a repo to build a graph first, then re-run this command.',
    )
  }

  const names = projects
    .map((p) => p.name)
    .sort()
    .map((n) => `  ${n}`)
    .join('\n')
  throw new ProjectResolutionError(
    `Several projects are registered and none is named "default", so I can't pick one for you.\n` +
      `Pass --project <name> to choose:\n${names}`,
  )
}

// The daemon URL the CLI verbs talk to. `NEAT_API_URL` is the name the verbs
// have always read, so it keeps precedence for existing users; `NEAT_CORE_URL`
// is honored as an alias so a single env var works for both the CLI and the MCP
// server (which names it `NEAT_CORE_URL`).
function resolveDaemonUrl(): string {
  return process.env.NEAT_API_URL ?? process.env.NEAT_CORE_URL ?? 'http://localhost:8080'
}

export async function runQueryVerb(cmd: string, parsed: ParsedArgs): Promise<number> {
  const baseUrl = resolveDaemonUrl()
  // ADR-073 §3 — read the bearer once and thread it into the single client
  // every verb shares, so no verb path can reach a secured daemon without it.
  const client = createHttpClient(baseUrl, resolveAuthToken())
  const positional = parsed.positional

  // Per-verb arg/flag validation runs first so misuse exits 2 before any
  // network call (ADR-050 #4). Each case builds a thunk that takes the
  // resolved project — we resolve the project (issue #500) only after the verb
  // proves well-formed, since resolution itself hits the daemon's /projects.
  let makeWork: (project: string | undefined) => Promise<VerbResult>
  switch (cmd) {
    case 'root-cause': {
      const node = positional[0]
      if (!node) {
        console.error('neat root-cause: missing <node-id>')
        return 2
      }
      makeWork = (project) => runRootCause(client, {
        errorNode: node,
        ...(parsed.errorId ? { errorId: parsed.errorId } : {}),
        ...(project ? { project } : {}),
      })
      break
    }
    case 'blast-radius': {
      const node = positional[0]
      if (!node) {
        console.error('neat blast-radius: missing <node-id>')
        return 2
      }
      makeWork = (project) => runBlastRadius(client, {
        nodeId: node,
        ...(parsed.depth !== null ? { depth: parsed.depth } : {}),
        ...(project ? { project } : {}),
      })
      break
    }
    case 'dependencies': {
      const node = positional[0]
      if (!node) {
        console.error('neat dependencies: missing <node-id>')
        return 2
      }
      makeWork = (project) => runDependencies(client, {
        nodeId: node,
        ...(parsed.depth !== null ? { depth: parsed.depth } : {}),
        ...(project ? { project } : {}),
      })
      break
    }
    case 'observed-dependencies': {
      const node = positional[0]
      if (!node) {
        console.error('neat observed-dependencies: missing <node-id>')
        return 2
      }
      makeWork = (project) => runObservedDependencies(client, {
        nodeId: node,
        ...(project ? { project } : {}),
      })
      break
    }
    case 'incidents': {
      // node-id is optional — bare `neat incidents` returns the global log.
      makeWork = (project) => runIncidents(client, {
        ...(positional[0] ? { nodeId: positional[0] } : {}),
        ...(parsed.limit !== null ? { limit: parsed.limit } : {}),
        ...(project ? { project } : {}),
      })
      break
    }
    case 'search': {
      const q = positional.join(' ').trim()
      if (!q) {
        console.error('neat search: missing <query>')
        return 2
      }
      makeWork = (project) => runSearch(client, { query: q, ...(project ? { project } : {}) })
      break
    }
    case 'diff': {
      // --against names a snapshot file the core can resolve via
      // loadSnapshotForDiff. --since is reserved for a future date-range
      // mode (the contract lists it as `[--since <date>]`); for MVP, the
      // diff verb requires --against.
      const against = parsed.against ?? parsed.since
      if (!against) {
        console.error('neat diff: --against <snapshot-path> is required')
        return 2
      }
      makeWork = (project) => runDiff(client, {
        againstSnapshot: against,
        ...(project ? { project } : {}),
      })
      break
    }
    case 'stale-edges': {
      makeWork = (project) => runStaleEdges(client, {
        ...(parsed.limit !== null ? { limit: parsed.limit } : {}),
        ...(parsed.edgeType ? { edgeType: parsed.edgeType } : {}),
        ...(project ? { project } : {}),
      })
      break
    }
    case 'policies': {
      let hypothetical: ReturnType<typeof JSON.parse> | undefined
      if (parsed.hypotheticalAction) {
        try {
          hypothetical = JSON.parse(parsed.hypotheticalAction)
        } catch (err) {
          console.error(
            `neat policies: --hypothetical-action must be valid JSON: ${(err as Error).message}`,
          )
          return 2
        }
      }
      makeWork = (project) => runPolicies(client, {
        ...(parsed.node ? { nodeId: parsed.node } : {}),
        ...(hypothetical ? { hypotheticalAction: hypothetical } : {}),
        ...(project ? { project } : {}),
      })
      break
    }
    case 'divergences': {
      let typeFilter: DivergenceType[] | undefined
      if (parsed.type) {
        const parts = parsed.type
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
        const out: DivergenceType[] = []
        for (const p of parts) {
          const r = DivergenceTypeSchema.safeParse(p)
          if (!r.success) {
            console.error(
              `neat divergences: unknown --type "${p}". allowed: ${DivergenceTypeSchema.options.join(', ')}`,
            )
            return 2
          }
          out.push(r.data)
        }
        typeFilter = out
      }
      makeWork = (project) => runDivergences(client, {
        ...(typeFilter ? { type: typeFilter } : {}),
        ...(parsed.minConfidence !== null ? { minConfidence: parsed.minConfidence } : {}),
        ...(parsed.node ? { node: parsed.node } : {}),
        ...(project ? { project } : {}),
      })
      break
    }
    default:
      // Unreachable — QUERY_VERBS gates the dispatch.
      console.error(`neat: unknown query verb "${cmd}"`)
      return 2
  }

  try {
    // Resolve which project to route to (issue #500). When --project /
    // NEAT_PROJECT are set this is a no-op; otherwise it asks the daemon's
    // /projects list and picks the single registered one (or keeps `default`).
    // A TransportError from here means the daemon is down — same exit-3 path as
    // any verb call.
    const project = await resolveProjectForVerb(client, parsed)
    const result = await makeWork(project)
    if (parsed.json) process.stdout.write(formatJson(result) + '\n')
    else process.stdout.write(formatHuman(result) + '\n')
    return 0
  } catch (err) {
    // Server / transport errors land on stderr per ADR-050 #3 (stderr for
    // diagnostics, stdout for results — never mix). Exit code branches per
    // ADR-050 #4: 1 for HttpError, 3 for TransportError.
    if (err instanceof ProjectResolutionError) {
      // Couldn't pick a project on the user's behalf (none registered, or
      // several and none named `default`). The message already says what to do.
      console.error(`neat ${cmd}: ${err.message}`)
      return err.exitCode
    }
    if (err instanceof HttpError) {
      const detail = err.responseBody.length > 0 ? err.responseBody : err.message
      console.error(`neat ${cmd}: ${detail.trim()}`)
    } else if (err instanceof TransportError) {
      console.error(`neat ${cmd}: ${err.message}. Is the daemon running? (NEAT_API_URL=${resolveDaemonUrl()})`)
    } else {
      console.error(`neat ${cmd}: ${(err as Error).message}`)
    }
    return exitCodeForError(err)
  }
}

// Only auto-run when invoked as the CLI entry point. Importing this module
// from tests must not start the parser; otherwise vitest sees a stray
// `process.exit` from `main()` running with no argv.
const entry = process.argv[1] ?? ''
if (/[\\/]cli\.(?:cjs|js)$/.test(entry) || entry.endsWith('/cli') || entry.endsWith('/neat') || entry.endsWith('/neat.is')) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
