import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Provenance, observedEdgeId } from '@neat.is/types'
import type { NeatGraph } from './graph.js'

export const SCHEMA_VERSION = 4

export interface PersistedGraph {
  schemaVersion: number
  exportedAt: string
  graph: ReturnType<NeatGraph['export']>
}

// v1 → v2: ServiceNode shed `pgDriverVersion` (ADR-019). Compat traversal reads
// `dependencies[driver]` instead. Strip the field from any v1 snapshot rather
// than hard-failing — a stale snapshot on disk shouldn't cost a re-extract.
function migrateV1ToV2(payload: PersistedGraph): PersistedGraph {
  const nodes = (payload.graph as { nodes?: Array<{ attributes?: Record<string, unknown> }> })
    .nodes
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      if (node.attributes && 'pgDriverVersion' in node.attributes) {
        delete node.attributes.pgDriverVersion
      }
    }
  }
  return { ...payload, schemaVersion: 2 }
}

// v2 → v3: Provenance enum shrinks to four values (ADR-068). Any edge whose
// provenance still carries the pre-v0.3.5 'FRONTIER' literal is rewritten to
// Provenance.OBSERVED on load. The target ref is unchanged — FrontierNodes
// remain placeholders for unresolved peers; only how the edge was labelled
// changes. If the edge id still carries the legacy provenance segment, it
// is re-keyed to the OBSERVED wire format so consumers that parse the id
// (traversal, divergence query, MCP) see the same shape downstream.
//
// The 'FRONTIER' string literal here is the only place in the codebase that
// recognises the legacy value; the Rule 1 contract scan exempts persist.ts
// for exactly this reason.
// v3 → v4: ServiceNode identity gains an optional env discriminator
// (ADR-074 §2). The v4 wire format reads as a superset of v3 — the
// env-less `service:<name>` form is preserved as the env=`'unknown'`
// node and the v3 → v4 migration is a version-only bump.
//
// Edges and node ids that pre-date the env discriminator remain valid v4
// ids; no rewrite is needed. Idempotent — re-running on a v4 snapshot
// produces an identical payload.
function migrateV3ToV4(payload: PersistedGraph): PersistedGraph {
  return { ...payload, schemaVersion: 4 }
}

function migrateV2ToV3(payload: PersistedGraph): PersistedGraph {
  const edges = (payload.graph as {
    edges?: Array<{
      key?: string
      attributes?: Record<string, unknown>
    }>
  }).edges
  if (Array.isArray(edges)) {
    for (const edge of edges) {
      const attrs = edge.attributes
      // 'FRONTIER' is the pre-v0.3.5 literal — read-only here, never written
      // by current producers. The rewrite swaps to Provenance.OBSERVED.
      if (!attrs || attrs.provenance !== 'FRONTIER') continue
      attrs.provenance = Provenance.OBSERVED
      const type = typeof attrs.type === 'string' ? attrs.type : undefined
      const source = typeof attrs.source === 'string' ? attrs.source : undefined
      const target = typeof attrs.target === 'string' ? attrs.target : undefined
      if (type && source && target) {
        const newId = observedEdgeId(source, target, type)
        attrs.id = newId
        if (edge.key) edge.key = newId
      }
    }
  }
  return { ...payload, schemaVersion: 3 }
}

async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
}

export async function saveGraphToDisk(graph: NeatGraph, outPath: string): Promise<void> {
  await ensureDir(outPath)
  const payload: PersistedGraph = {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    graph: graph.export(),
  }
  // Atomic write: drop into <name>.tmp first, then rename. A crash mid-write
  // leaves the previous snapshot intact instead of a half-truncated file.
  const tmp = `${outPath}.tmp`
  await fs.writeFile(tmp, JSON.stringify(payload), 'utf8')
  await fs.rename(tmp, outPath)
}

export async function loadGraphFromDisk(graph: NeatGraph, outPath: string): Promise<void> {
  let raw: string
  try {
    raw = await fs.readFile(outPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  let payload = JSON.parse(raw) as PersistedGraph
  if (payload.schemaVersion === 1) {
    payload = migrateV1ToV2(payload)
  }
  if (payload.schemaVersion === 2) {
    payload = migrateV2ToV3(payload)
  }
  if (payload.schemaVersion === 3) {
    payload = migrateV3ToV4(payload)
  }
  if (payload.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `persist: unsupported snapshot schemaVersion ${payload.schemaVersion} (expected ${SCHEMA_VERSION})`,
    )
  }
  graph.clear()
  graph.import(payload.graph)
}

export interface PersistLoopOptions {
  // How often the periodic background save fires. Defaults to 60s.
  intervalMs?: number
  // Whether a SIGTERM/SIGINT should flush the graph and then exit the process.
  // Defaults to true, which is what the standalone owners (`neat serve`,
  // `neat watch`) want: the persist loop is the only thing holding the process
  // open, so it owns the shutdown — flush, then exit.
  //
  // The daemon owns its own orderly shutdown (it closes its listeners, flushes
  // every slot, clears its `daemon.json` + the machine-wide discovery copy, and
  // removes its pid file before exiting). It runs many persist loops, one per
  // project, and an exiting signal handler inside any of them would end the
  // process out from under that teardown — leaving the discovery copy and pid
  // file behind. So the daemon passes `false`: each loop still saves on its
  // interval and unhooks cleanly on teardown, but the daemon decides when the
  // process exits.
  exitOnSignal?: boolean
}

// Periodic save + (optionally) a best-effort save-and-exit on SIGTERM/SIGINT.
// Returns a cleanup that clears the interval and unhooks any signal handlers —
// important for tests so they don't keep the process alive, and for the daemon
// so a torn-down slot's loop stops reacting to signals.
export function startPersistLoop(
  graph: NeatGraph,
  outPath: string,
  opts: PersistLoopOptions = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 60_000
  const exitOnSignal = opts.exitOnSignal ?? true
  let stopped = false

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      await saveGraphToDisk(graph, outPath)
    } catch (err) {
      console.error('persist: periodic save failed', err)
    }
  }

  const interval = setInterval(() => {
    void tick()
  }, intervalMs)

  const onSignal = exitOnSignal
    ? (signal: NodeJS.Signals): void => {
        void (async () => {
          try {
            await saveGraphToDisk(graph, outPath)
          } catch (err) {
            console.error(`persist: ${signal} save failed`, err)
          } finally {
            process.exit(0)
          }
        })()
      }
    : null

  if (onSignal) {
    process.on('SIGTERM', onSignal)
    process.on('SIGINT', onSignal)
  }

  return () => {
    stopped = true
    clearInterval(interval)
    if (onSignal) {
      process.off('SIGTERM', onSignal)
      process.off('SIGINT', onSignal)
    }
  }
}

// Snapshot merge (ADR-074 §1) lives in ingest.ts — that's the mutation-
// authority boundary per the lifecycle contract (Rule 3 / ADR-030). The
// merge is a form of ingestion: an external snapshot lands on the live graph
// the same way an OTel span does, preserving the EXTRACTED + OBSERVED
// coexistence contract along the way.
