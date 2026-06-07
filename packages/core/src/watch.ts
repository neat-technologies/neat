import fs from 'node:fs'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { FastifyInstance } from 'fastify'
import type { NeatGraph } from './graph.js'
import { buildApi } from './api.js'
import { assertBindAuthority, readAuthEnv } from './auth.js'
import { ensureCompatLoaded } from './compat.js'
import { discoverServices, addServiceNodes } from './extract/services.js'
import { addServiceAliases } from './extract/aliases.js'
import { addImports } from './extract/imports.js'
import { addDatabasesAndCompat } from './extract/databases/index.js'
import { addConfigNodes } from './extract/configs.js'
import { addCallEdges } from './extract/calls/index.js'
import { addInfra } from './extract/infra/index.js'
import { retireEdgesByFile } from './extract/retire.js'
import {
  makeErrorSpanWriter,
  makeSpanHandler,
  promoteFrontierNodes,
  startStalenessLoop,
} from './ingest.js'
import {
  evaluateAllPolicies,
  loadPolicyFile,
  PolicyViolationsLog,
} from './policy.js'
import type { Policy } from '@neat.is/types'
import { buildOtelReceiver } from './otel.js'
import { startOtelGrpcReceiver } from './otel-grpc.js'
import { loadGraphFromDisk, startPersistLoop } from './persist.js'
import { buildSearchIndex, type SearchIndex } from './search.js'
import { DEFAULT_PROJECT } from './graph.js'
import { Projects, pathsForProject } from './projects.js'
import { attachGraphToEventBus, emitNeatEvent } from './events.js'

export type ExtractPhase =
  | 'services'
  | 'aliases'
  | 'imports'
  | 'databases'
  | 'configs'
  | 'calls'
  | 'infra'

const ALL_PHASES: ExtractPhase[] = [
  'services',
  'aliases',
  'imports',
  'databases',
  'configs',
  'calls',
  'infra',
]

// Map a changed path to the phases that need re-running. Anything not matched
// here falls back to a full re-extract — better an extra ~50ms of work than a
// missed update because the path didn't fit a regex.
//
// Mapping:
//   package.json / requirements.txt / pyproject.toml → services + aliases + databases
//     (deps drive compat; aliases pull from manifest fields)
//   .env / *.env.* / prisma / knex / ormconfig → databases + configs
//   docker-compose / Dockerfile / *.tf / k8s yaml → infra + aliases
//     (compose labels and Dockerfile labels feed alias discovery)
//   *.js / *.ts / *.tsx / *.py / *.jsx / *.mjs / *.cjs → imports + calls
//     (a source edit can shift both its IMPORTS and CALLS edges; the shared
//     evidence.file retirement mechanism — static-extraction.md §Ghost-edge
//     cleanup — drops the stale ones from either producer before re-running)
//   *.yaml / *.yml that isn't compose → databases + configs (ORM yaml fallbacks)
export function classifyChange(relPath: string): Set<ExtractPhase> {
  const phases = new Set<ExtractPhase>()
  const base = path.basename(relPath).toLowerCase()
  const segments = relPath.split(path.sep).map((s) => s.toLowerCase())

  if (
    base === 'package.json' ||
    base === 'requirements.txt' ||
    base === 'pyproject.toml' ||
    base === 'setup.py'
  ) {
    phases.add('services')
    phases.add('aliases')
    phases.add('databases')
  }

  if (
    base === '.env' ||
    base.startsWith('.env.') ||
    base === 'schema.prisma' ||
    /^knexfile\.(?:js|ts|cjs|mjs)$/.test(base) ||
    /^ormconfig\.(?:js|ts|json|ya?ml)$/.test(base)
  ) {
    phases.add('databases')
    phases.add('configs')
  }

  if (
    base === 'dockerfile' ||
    /^docker-compose.*\.ya?ml$/.test(base) ||
    base.endsWith('.tf') ||
    segments.includes('k8s') ||
    segments.includes('kustomize') ||
    segments.includes('manifests')
  ) {
    phases.add('infra')
    phases.add('aliases')
  }

  if (/\.(?:js|jsx|mjs|cjs|ts|tsx|py)$/.test(base)) {
    phases.add('imports')
    phases.add('calls')
  }

  if (/\.ya?ml$/.test(base) && !/^docker-compose.*\.ya?ml$/.test(base)) {
    // Generic yaml — could be an ORM file, k8s manifest, or random config.
    // Cheap to run databases + configs; if it was infra, the dir-name check
    // above already added that phase.
    phases.add('databases')
    phases.add('configs')
  }

  return phases
}

interface RunPhasesResult {
  phases: ExtractPhase[]
  nodesAdded: number
  edgesAdded: number
  frontiersPromoted: number
  durationMs: number
}

export async function runExtractPhases(
  graph: NeatGraph,
  scanPath: string,
  phases: Set<ExtractPhase>,
  // Project tag passed through for the runtime event bus (ADR-051) — not
  // required for extraction logic itself but threaded for parity with
  // extractFromDirectory's project option.
  project: string = DEFAULT_PROJECT,
): Promise<RunPhasesResult> {
  void project
  const started = Date.now()
  await ensureCompatLoaded()
  // Discovery is cheap and every phase needs the same DiscoveredService list,
  // so we always re-walk. If the user moved a service directory, this is also
  // the path that picks it up.
  const services = await discoverServices(scanPath)

  let nodesAdded = 0
  let edgesAdded = 0

  if (phases.has('services')) {
    nodesAdded += addServiceNodes(graph, services)
  }
  if (phases.has('aliases')) {
    await addServiceAliases(graph, scanPath, services)
  }
  if (phases.has('imports')) {
    const r = await addImports(graph, services)
    nodesAdded += r.nodesAdded
    edgesAdded += r.edgesAdded
  }
  if (phases.has('databases')) {
    const r = await addDatabasesAndCompat(graph, services, scanPath)
    nodesAdded += r.nodesAdded
    edgesAdded += r.edgesAdded
  }
  if (phases.has('configs')) {
    const r = await addConfigNodes(graph, services, scanPath)
    nodesAdded += r.nodesAdded
    edgesAdded += r.edgesAdded
  }
  if (phases.has('calls')) {
    const r = await addCallEdges(graph, services)
    nodesAdded += r.nodesAdded
    edgesAdded += r.edgesAdded
  }
  if (phases.has('infra')) {
    const r = await addInfra(graph, scanPath, services)
    nodesAdded += r.nodesAdded
    edgesAdded += r.edgesAdded
  }
  const frontiersPromoted = promoteFrontierNodes(graph)

  return {
    phases: ALL_PHASES.filter((p) => phases.has(p)),
    nodesAdded,
    edgesAdded,
    frontiersPromoted,
    durationMs: Date.now() - started,
  }
}

export interface WatchOptions {
  scanPath: string
  outPath: string
  errorsPath: string
  staleEventsPath: string
  embeddingsCachePath?: string
  // Project name this watch instance owns. Defaults to `default` for the
  // single-project workflow that's been the only one until #83.
  project?: string
  host?: string
  port?: number
  otelPort?: number
  otelGrpc?: boolean
  otelGrpcPort?: number
  debounceMs?: number
}

export interface WatchHandle {
  api: FastifyInstance
  stop: () => Promise<void>
}

// Anymatch-compatible ignore set passed to chokidar (#233). The earlier
// implementation passed a function alone, which forced chokidar to descend
// into every subdirectory before testing the path. On macOS with kqueue
// (chokidar 4 dropped fsevents in favour of kqueue), each subdir under the
// scan root opens a watch handle; nested `node_modules` blew through the
// per-process kqueue cap with EMFILE before the function-based ignore ever
// fired. Globs let chokidar prune at descent time — the dirs are never
// opened in the first place.
const IGNORED_WATCH_GLOBS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.turbo/**',
  '**/.next/**',
  '**/neat-out/**',
  // Python venv shapes (issue #344). chokidar opens one watch handle per
  // descended dir; a CPython venv carries 20k+ files and trivially blows
  // through the macOS kqueue cap before extraction even runs.
  '**/.venv/**',
  '**/venv/**',
  '**/__pypackages__/**',
  '**/.tox/**',
  '**/site-packages/**',
  '**/.DS_Store',
]

// Backstop regex set — covers anything chokidar surfaces post-descent that
// the globs missed (e.g. a path containing one of these segments at an
// unexpected depth). Same shape as before; the globs are the load-bearing
// pruning, this is defence in depth.
const IGNORED_WATCH_PATHS = [
  /(?:^|[\\/])node_modules[\\/]/,
  /(?:^|[\\/])\.git[\\/]/,
  /(?:^|[\\/])dist[\\/]/,
  /(?:^|[\\/])build[\\/]/,
  /(?:^|[\\/])\.turbo[\\/]/,
  /(?:^|[\\/])\.next[\\/]/,
  /(?:^|[\\/])neat-out[\\/]/,
  /(?:^|[\\/])\.venv[\\/]/,
  /(?:^|[\\/])venv[\\/]/,
  /(?:^|[\\/])__pypackages__[\\/]/,
  /(?:^|[\\/])\.tox[\\/]/,
  /(?:^|[\\/])site-packages[\\/]/,
  /[\\/]?\.DS_Store$/,
]

function shouldIgnore(absPath: string): boolean {
  return IGNORED_WATCH_PATHS.some((re) => re.test(absPath))
}

// Roughly the number of immediate, non-ignored subdirectories in the scan
// root above which `neat watch` should fall back to polling on darwin. kqueue
// opens one handle per watched dir; macOS's per-process file-descriptor cap
// is typically 256 (soft) / unlimited (hard) but raising the hard cap doesn't
// help with the kqueue-specific limits. Empirically anything north of ~500
// non-ignored dirs starts to flirt with EMFILE. Threshold sits comfortably
// under that.
const DARWIN_POLLING_DIR_THRESHOLD = 400

// Fast non-recursive count: walk top-level entries only, descending one
// level into non-ignored subdirs to capture the medusa-shaped case where
// `packages/*` itself looks small but each contains a heavy `node_modules`.
// Returns early once it crosses the threshold so we don't waste time on huge
// repos.
function countWatchableDirs(scanPath: string, limit: number): number {
  let count = 0
  const visit = (dir: string, depth: number): void => {
    if (count >= limit) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (count >= limit) return
      if (!e.isDirectory()) continue
      if (IGNORED_WATCH_PATHS.some((re) => re.test(path.join(dir, e.name) + path.sep))) continue
      count++
      // One level deeper — enough to surface nested `node_modules` shapes
      // without traversing the whole tree.
      if (depth < 2) visit(path.join(dir, e.name), depth + 1)
    }
  }
  visit(scanPath, 0)
  return count
}

// Darwin heuristic (#233). Forces chokidar onto polling when the scan root
// is large enough that kqueue would EMFILE. Override via NEAT_WATCH_POLLING:
//   - "1" / "true"  → force polling regardless of platform/threshold
//   - "0" / "false" → never poll (matches pre-#233 behaviour)
//   - unset         → auto-detect on darwin
function shouldUsePolling(scanPath: string): boolean {
  const env = process.env.NEAT_WATCH_POLLING
  if (env === '1' || env === 'true') return true
  if (env === '0' || env === 'false') return false
  if (process.platform !== 'darwin') return false
  return countWatchableDirs(scanPath, DARWIN_POLLING_DIR_THRESHOLD) >= DARWIN_POLLING_DIR_THRESHOLD
}

export async function startWatch(
  graph: NeatGraph,
  opts: WatchOptions,
): Promise<WatchHandle> {
  const debounceMs = opts.debounceMs ?? 1000
  const projectName = opts.project ?? DEFAULT_PROJECT

  await loadGraphFromDisk(graph, opts.outPath)

  // Wire graph mutations into the event bus (ADR-051) before extract begins
  // so the initial pass also produces node/edge events. Detached on stop().
  const detachEventBus = attachGraphToEventBus(graph, { project: projectName })

  // Load policies + open the violations log once at startup. policy.json
  // lives at the project root per ADR-042 §File location; absent file is
  // a perfectly fine state (loadPolicyFile returns []). Reload-on-change
  // is queued for v0.2.5 — the kickoff doc tracks it.
  const policyFilePath = path.join(opts.scanPath, 'policy.json')
  const policyViolationsPath = path.join(path.dirname(opts.outPath), 'policy-violations.ndjson')
  let policies: Policy[] = []
  try {
    policies = await loadPolicyFile(policyFilePath)
    if (policies.length > 0) {
      console.log(`policies: loaded ${policies.length} from ${policyFilePath}`)
    }
  } catch (err) {
    console.warn(`policies: failed to load ${policyFilePath} — ${(err as Error).message}`)
  }
  const policyLog = new PolicyViolationsLog(policyViolationsPath, projectName)

  // Single shared trigger callback wired into post-ingest, post-extract, and
  // post-stale per ADR-043. Failures append to console.warn but don't kill
  // the daemon — a malformed evaluator shouldn't take down ingest.
  const onPolicyTrigger = async (g: NeatGraph): Promise<void> => {
    if (policies.length === 0) return
    try {
      const violations = evaluateAllPolicies(g, policies, { now: () => Date.now() })
      for (const v of violations) await policyLog.append(v)
    } catch (err) {
      console.warn(`policies: evaluation failed — ${(err as Error).message}`)
    }
  }

  // The post-extract trigger fires from extractFromDirectory via opts.
  // For the initial extract here we run it inline so violations land on
  // startup before the receiver opens. Subsequent watch-driven re-extract
  // passes go through runExtractPhases which doesn't take the hook directly
  // — we run it after each flush() instead.
  const initial = await runExtractPhases(
    graph,
    opts.scanPath,
    new Set(ALL_PHASES),
    projectName,
  )
  console.log(
    `extract: ${initial.nodesAdded} new nodes, ${initial.edgesAdded} new edges (graph total ${graph.order}/${graph.size})`,
  )
  // extraction-complete for the initial pass (ADR-051). runExtractPhases
  // doesn't emit on its own — the event lives at the watch / orchestrator
  // boundary so the daemon can swap in its own emission shape.
  emitNeatEvent({
    type: 'extraction-complete',
    project: projectName,
    payload: {
      project: projectName,
      fileCount: 0,
      nodesAdded: initial.nodesAdded,
      edgesAdded: initial.edgesAdded,
    },
  })
  await onPolicyTrigger(graph)

  const stopPersist = startPersistLoop(graph, opts.outPath)
  const stopStaleness = startStalenessLoop(graph, {
    staleEventsPath: opts.staleEventsPath,
    project: projectName,
    onPolicyTrigger,
  })

  // ADR-073 §3/§4 + issue #341 — `neat watch` follows the same bind discipline
  // as the daemon: an explicit host wins; otherwise loopback-only without a
  // token (laptop dev), public bind once `NEAT_AUTH_TOKEN` is set. buildApi
  // mounts the bearer gate from the same env, so a token-protected watch
  // returns 401 to unauthenticated callers exactly as `neatd` does.
  const auth = readAuthEnv()
  const host = opts.host ?? (auth.authToken ? '0.0.0.0' : '127.0.0.1')
  assertBindAuthority(host, auth.authToken)
  const port = opts.port ?? 8080
  const otelPort = opts.otelPort ?? 4318

  const cachePath =
    opts.embeddingsCachePath ?? path.join(path.dirname(opts.outPath), 'embeddings.json')
  let searchIndex: SearchIndex | undefined
  try {
    searchIndex = await buildSearchIndex(graph, { cachePath })
    console.log(`semantic_search: ${searchIndex.provider} provider`)
  } catch (err) {
    console.warn(
      `semantic_search: index build failed (${(err as Error).message}); falling back to inline substring`,
    )
  }

  const registry = new Projects()
  registry.set(projectName, {
    graph,
    scanPath: opts.scanPath,
    paths: {
      // Paths are derived from the explicit options the watch caller passes
      // — pathsForProject is only used to fill in the embeddings/snapshot
      // fields so the registry shape is complete.
      ...pathsForProject(projectName, path.dirname(opts.outPath)),
      snapshotPath: opts.outPath,
      errorsPath: opts.errorsPath,
      staleEventsPath: opts.staleEventsPath,
    },
    searchIndex,
  })

  const api = await buildApi({ projects: registry })
  await api.listen({ port, host })
  console.log(`neat-core listening on http://${host}:${port}`)
  console.log(`  scan path:     ${opts.scanPath} (watching for changes)`)
  console.log(`  snapshot path: ${opts.outPath}`)
  console.log(`  errors log:    ${opts.errorsPath}`)

  // The receiver writes ErrorEvents synchronously before reply (durability).
  // makeSpanHandler runs on the async queue and skips the inline write
  // because the receiver already handled it. Ad-hoc callers that bypass the
  // receiver (CLI tests, fixtures) leave writeErrorEventInline at its default
  // and get the in-handleSpan write. ADR-033 §Error events.
  const onSpan = makeSpanHandler({
    graph,
    errorsPath: opts.errorsPath,
    scanPath: opts.scanPath,
    project: projectName,
    writeErrorEventInline: false,
    onPolicyTrigger,
  })
  const onErrorSpanSync = makeErrorSpanWriter(opts.errorsPath)
  const otelHttp = await buildOtelReceiver({ onSpan, onErrorSpanSync })
  await otelHttp.listen({ port: otelPort, host })
  console.log(`neat-core OTLP receiver on http://${host}:${otelPort}/v1/traces`)

  let grpcReceiver: { stop: () => Promise<void> } | null = null
  if (opts.otelGrpc) {
    const grpcPort = opts.otelGrpcPort ?? 4317
    // gRPC handler keeps the inline ErrorEvent write — the gRPC receiver
    // awaits onSpan synchronously (otel-grpc.ts), so the same durability
    // guarantee is met without a separate sync hook. Non-blocking gRPC
    // ingest is out of scope for the v0.2.2 batch.
    const onSpanGrpc = makeSpanHandler({
      graph,
      errorsPath: opts.errorsPath,
      scanPath: opts.scanPath,
      project: projectName,
      onPolicyTrigger,
    })
    const r = await startOtelGrpcReceiver({ onSpan: onSpanGrpc, host, port: grpcPort })
    console.log(`neat-core OTLP/gRPC receiver on ${r.address}`)
    grpcReceiver = r
  }

  // Coalesce bursts of changes into a single re-extract. chokidar fires one
  // event per affected path; an editor save can produce 3+ events on the same
  // file in <50ms.
  const pending = new Set<ExtractPhase>()
  const pendingPaths = new Set<string>()
  let timer: NodeJS.Timeout | null = null
  let inflight: Promise<void> | null = null

  const flush = async (): Promise<void> => {
    if (pending.size === 0) return
    const phases = new Set(pending)
    const paths = new Set(pendingPaths)
    pending.clear()
    pendingPaths.clear()
    try {
      // Drop EXTRACTED edges keyed to changed paths first, so the producer's
      // idempotent re-extract recreates only the edges that still apply.
      // Without this, edges from deleted code would survive forever
      // (docs/contracts/static-extraction.md §Ghost-edge cleanup).
      let retired = 0
      for (const p of paths) retired += retireEdgesByFile(graph, p)
      const result = await runExtractPhases(graph, opts.scanPath, phases, projectName)
      console.log(
        `[watch] re-extract phases=${result.phases.join(',')} retired=${retired} +${result.nodesAdded}n/+${result.edgesAdded}e in ${result.durationMs}ms`,
      )
      // extraction-complete after every re-extract pass (ADR-051). fileCount
      // is the number of paths that drove the pass — closest signal we have
      // for "how much source moved" without per-phase accounting.
      emitNeatEvent({
        type: 'extraction-complete',
        project: projectName,
        payload: {
          project: projectName,
          fileCount: paths.size,
          nodesAdded: result.nodesAdded,
          edgesAdded: result.edgesAdded,
        },
      })
      if (searchIndex) {
        try {
          await searchIndex.refresh(graph)
        } catch (err) {
          console.warn('[watch] semantic_search refresh failed', err)
        }
      }
      // Post-extract policy trigger (ADR-043). The runExtractPhases call
      // doesn't take the hook directly — it runs through promoteFrontierNodes
      // for FRONTIER → OBSERVED upgrades but doesn't load policies itself.
      // Firing the evaluator here keeps the trigger surface symmetric across
      // ingest / extract / stale paths.
      await onPolicyTrigger(graph)
    } catch (err) {
      console.error('[watch] re-extract failed', err)
    }
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      // Serialise re-extracts so two flushes can't interleave on the graph.
      inflight = (inflight ?? Promise.resolve()).then(flush)
    }, debounceMs)
  }

  const onPath = (absPath: string): void => {
    if (shouldIgnore(absPath)) return
    const rel = path.relative(opts.scanPath, absPath)
    if (!rel || rel.startsWith('..')) return
    pendingPaths.add(rel.split(path.sep).join('/'))
    const phases = classifyChange(rel)
    if (phases.size === 0) {
      // Unknown file kind — fall back to full re-extract rather than silently
      // miss it. Cheaper than the user wondering why their change didn't show.
      for (const p of ALL_PHASES) pending.add(p)
    } else {
      for (const p of phases) pending.add(p)
    }
    schedule()
  }

  const usePolling = shouldUsePolling(opts.scanPath)
  if (usePolling) {
    const reason =
      process.env.NEAT_WATCH_POLLING === '1' || process.env.NEAT_WATCH_POLLING === 'true'
        ? 'NEAT_WATCH_POLLING env override'
        : 'darwin heuristic — large scan root, kqueue cap risk'
    console.log(`[${projectName}] watch: usePolling=true (${reason})`)
  }
  const watcher: FSWatcher = chokidar.watch(opts.scanPath, {
    ignoreInitial: true,
    // Glob array prunes at descent time (#233) so chokidar never opens a
    // kqueue handle for `node_modules` and friends. The function backstop
    // catches any path that slipped through and matches the regex set.
    ignored: [...IGNORED_WATCH_GLOBS, (p: string) => shouldIgnore(p)],
    persistent: true,
    usePolling,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  })
  watcher.on('add', onPath)
  watcher.on('change', onPath)
  watcher.on('unlink', onPath)
  watcher.on('addDir', onPath)
  watcher.on('unlinkDir', onPath)

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    if (inflight) {
      try {
        await inflight
      } catch {
        // surfaced already in flush()
      }
    }
    await watcher.close()
    stopStaleness()
    stopPersist()
    detachEventBus()
    await api.close()
    await otelHttp.close()
    if (grpcReceiver) await grpcReceiver.stop()
  }

  return { api, stop }
}
