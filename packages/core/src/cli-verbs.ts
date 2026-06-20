/**
 * Lifecycle-verb implementations for the CLI. Query verbs live in
 * `cli-client.ts` next to the REST client; lifecycle verbs (currently
 * `neat sync`) live here because they orchestrate filesystem work and
 * daemon-state probes rather than wrapping a single REST endpoint.
 */

import path from 'node:path'
import type { RegistryEntry } from '@neat.is/types'
import {
  applyInstallersOver,
  extractAndPersist,
  type ExtractAndPersistResult,
} from './orchestrator.js'
import { listProjects, normalizeProjectPath } from './registry.js'
import { saveGraphToDisk, SCHEMA_VERSION, type PersistedGraph } from './persist.js'
import {
  HttpError,
  pushSnapshotToRemote,
  resolveAuthToken,
  TransportError,
} from './cli-client.js'

export interface SyncOptions {
  // Project name from `--project <name>`. When absent, sync resolves the
  // project by matching the cwd against the registered project paths.
  project?: string
  // Push the snapshot to a remote daemon URL. When absent, sync runs against
  // the local daemon on http://localhost:8080.
  to?: string
  // Bearer token for the remote daemon. Falls back to NEAT_REMOTE_TOKEN env.
  token?: string
  // Skip writing the snapshot or notifying the daemon. Mirrors `neat <path>
  // --dry-run`.
  dryRun: boolean
  // Skip the SDK install apply step.
  noInstrument: boolean
  // Emit a structured JSON payload on stdout instead of human text.
  json: boolean
  // Override the local daemon URL. Defaults to NEAT_API_URL or
  // http://localhost:8080. Useful for tests.
  daemonUrl?: string
  // Working directory the verb resolves against when `--project` isn't
  // passed. Defaults to process.cwd(); tests override.
  cwd?: string
}

export interface SyncResult {
  exitCode: number
  // Stable shape across human / json output paths. cli.ts decides which
  // formatter to invoke based on `--json`.
  project: string
  scanPath: string
  nodesAdded: number
  edgesAdded: number
  snapshotPath: string | null
  // Tracks which branch the run took for `--json` consumers.
  mode: 'dry-run' | 'local' | 'remote'
  daemon: 'reloaded' | 'down' | 'remote-ok' | 'skipped'
  apply: {
    instrumented: number
    alreadyInstrumented: number
    libOnly: number
    skipped: boolean
  }
  // Soft warning lines surfaced to stderr in the human path. Empty when the
  // run was fully clean.
  warnings: string[]
}

async function resolveProjectEntry(opts: SyncOptions): Promise<RegistryEntry | null> {
  const entries = await listProjects()
  if (opts.project) {
    const match = entries.find((e) => e.name === opts.project)
    return match ?? null
  }
  const cwd = opts.cwd ?? process.cwd()
  const resolvedCwd = await normalizeProjectPath(cwd)
  // Match by path: the cwd must be inside (or equal to) the registered path.
  for (const entry of entries) {
    if (
      resolvedCwd === entry.path ||
      resolvedCwd.startsWith(`${entry.path}${path.sep}`)
    ) {
      return entry
    }
  }
  return null
}

async function checkDaemonHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(1500),
    })
    return res.ok
  } catch {
    return false
  }
}

function snapshotForGraph(persisted: ExtractAndPersistResult): PersistedGraph {
  return {
    // Stamp the live schema version the daemon validates against on the
    // receiving `/snapshot` merge. Tracking the constant keeps the push
    // aligned with the current snapshot shape across schema migrations.
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    graph: persisted.graph.export(),
  }
}

function emitResult(result: SyncResult, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return
  }
  const verb =
    result.mode === 'dry-run'
      ? 'dry-run'
      : result.mode === 'remote'
        ? 'pushed'
        : 'synced'
  console.log(
    `${verb}: ${result.project} — ${result.nodesAdded} node(s) and ${result.edgesAdded} edge(s) added` +
      (result.snapshotPath ? `; snapshot at ${result.snapshotPath}` : ''),
  )
  if (!result.apply.skipped) {
    const { instrumented, alreadyInstrumented, libOnly } = result.apply
    console.log(
      `instrumented ${instrumented}, already ${alreadyInstrumented}, lib-only ${libOnly}`,
    )
  } else {
    console.log('skipped instrumentation (--no-instrument)')
  }
  for (const warn of result.warnings) console.error(warn)
}

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const entry = await resolveProjectEntry(opts)
  if (!entry) {
    const target = opts.project ?? opts.cwd ?? process.cwd()
    console.error(
      `neat sync: no registered project ${
        opts.project ? `named "${opts.project}"` : `covers ${target}`
      }. Run \`neat <path>\` or \`neat init <path>\` first.`,
    )
    return {
      exitCode: 1,
      project: opts.project ?? '',
      scanPath: target,
      nodesAdded: 0,
      edgesAdded: 0,
      snapshotPath: null,
      mode: opts.to ? 'remote' : 'local',
      daemon: 'skipped',
      apply: { instrumented: 0, alreadyInstrumented: 0, libOnly: 0, skipped: true },
      warnings: [],
    }
  }

  // ── Step 1 + 2: discovery + extraction (no snapshot in dry-run) ─────
  const persisted = await extractAndPersist({
    scanPath: entry.path,
    project: entry.name,
    projectExplicit: true,
    dryRun: true,
  })

  let snapshotPath: string | null = null
  if (!opts.dryRun) {
    const target = persisted.snapshotPath
    await saveGraphToDisk(persisted.graph, target)
    snapshotPath = target
  }

  // ── Step 3: SDK install apply (default yes; --dry-run + --no-instrument skip)
  const skipApply = opts.dryRun || opts.noInstrument
  const applyTally = skipApply
    ? { instrumented: 0, alreadyInstrumented: 0, libOnly: 0, browserBundle: 0, reactNative: 0 }
    : await applyInstallersOver(persisted.services, entry.name)

  // ── Step 4: daemon notify ────────────────────────────────────────────
  const warnings: string[] = []
  let daemonState: SyncResult['daemon'] = 'skipped'
  let exitCode = 0
  const mode: SyncResult['mode'] = opts.dryRun ? 'dry-run' : opts.to ? 'remote' : 'local'

  if (!opts.dryRun) {
    const snapshot = snapshotForGraph(persisted)
    if (opts.to) {
      const token = opts.token ?? process.env.NEAT_REMOTE_TOKEN
      try {
        await pushSnapshotToRemote({
          baseUrl: opts.to,
          token,
          project: entry.name,
          snapshot,
        })
        daemonState = 'remote-ok'
      } catch (err) {
        if (err instanceof HttpError) {
          console.error(`neat sync: ${err.message}`)
          exitCode = 1
        } else if (err instanceof TransportError) {
          console.error(`neat sync: ${err.message}`)
          exitCode = 3
        } else {
          console.error(`neat sync: ${(err as Error).message}`)
          exitCode = 1
        }
        daemonState = 'skipped'
      }
    } else {
      const daemonUrl =
        opts.daemonUrl ?? process.env.NEAT_API_URL ?? 'http://localhost:8080'
      const healthy = await checkDaemonHealth(daemonUrl)
      if (healthy) {
        try {
          await pushSnapshotToRemote({
            baseUrl: daemonUrl,
            token: resolveAuthToken(),
            project: entry.name,
            snapshot,
          })
          daemonState = 'reloaded'
        } catch (err) {
          warnings.push(
            `neat sync: daemon merge failed — ${(err as Error).message}. Snapshot is on disk at ${snapshotPath}.`,
          )
          daemonState = 'down'
          exitCode = 2
        }
      } else {
        warnings.push(
          'neat sync: daemon not running; snapshot updated, run `neatd start` to serve it',
        )
        daemonState = 'down'
        exitCode = 2
      }
    }
  }

  const result: SyncResult = {
    exitCode,
    project: entry.name,
    scanPath: entry.path,
    nodesAdded: persisted.nodesAdded,
    edgesAdded: persisted.edgesAdded,
    snapshotPath,
    mode,
    daemon: daemonState,
    apply: { ...applyTally, skipped: skipApply },
    warnings,
  }

  emitResult(result, opts.json)
  return result
}
