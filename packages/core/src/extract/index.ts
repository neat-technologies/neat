// Static-extraction pipeline. Phase order is load-bearing:
//   services → aliases → databases (+ compat) → configs → calls → infra → frontier promotion.
//
// Contract anchors (see /docs/contracts.md):
//   * Rule 1 — Every emitted edge carries Provenance.EXTRACTED from @neat.is/types.
//   * Rule 2 — EXTRACTED edges use the plain `${type}:src->tgt` id pattern.
//     Never write under the OBSERVED id pattern; that's ingest.ts's territory.
//   * Rule 5 — Nodes/edges constructed against schemas in @neat.is/types; no
//     local interface redefinitions in this tree.
//   * Rule 8 — No demo-name hardcoding. Driver names come from package.json
//     dependencies; engine names from compat.json via compatPairs().
//   * Rule 14 — ConfigNodes record file existence only; never the contents.
import type { NeatGraph } from '../graph.js'
import { DEFAULT_PROJECT } from '../graph.js'
import { promoteFrontierNodes } from '../ingest.js'
import { ensureCompatLoaded } from '../compat.js'
import { emitNeatEvent } from '../events.js'
import { addServiceNodes, discoverServices } from './services.js'
import { addServiceAliases } from './aliases.js'
import { addFiles } from './files.js'
import { addImports } from './imports.js'
import { addDatabasesAndCompat } from './databases/index.js'
import { addConfigNodes } from './configs.js'
import { addCallEdges } from './calls/index.js'
import { addInfra } from './infra/index.js'
import {
  drainExtractionErrors,
  writeExtractionErrors,
  drainDroppedExtracted,
  isRejectedLogEnabled,
  writeRejectedExtracted,
  type ExtractionError,
  type DroppedExtractedEdge,
} from './errors.js'
import path from 'node:path'
import { retireExtractedEdgesByMissingFile } from './retire.js'

export interface ExtractResult {
  nodesAdded: number
  edgesAdded: number
  frontiersPromoted: number
  // ADR-065 — per-file extraction failures collected during the pass.
  // `extractionErrors` is the count; `errorEntries` is the drained list,
  // available for callers that want to surface per-file context. Both are
  // present on every pass (zero is observable as a positive signal).
  extractionErrors: number
  errorEntries: ExtractionError[]
  // #140 — count of EXTRACTED edges retired this pass because their
  // evidence.file no longer exists on disk. Zero on a clean pass; non-zero
  // means the snapshot was carrying ghosts from deleted source.
  ghostsRetired: number
  // ADR-066 — count of EXTRACTED candidates dropped at emit time because
  // their graded confidence fell below NEAT_EXTRACTED_PRECISION_FLOOR.
  // Always reported (zero is observable). Detail entries surface in
  // `droppedEntries` and route to rejected.ndjson when
  // NEAT_EXTRACTED_REJECTED_LOG=1.
  extractedDropped: number
  droppedEntries: DroppedExtractedEdge[]
}

export interface ExtractOptions {
  // Post-extract policy trigger (ADR-043). Awaited after frontier promotion
  // so policies see the final post-pass graph state. Daemons wire this to
  // evaluateAllPolicies + PolicyViolationsLog.append.
  onPolicyTrigger?: (graph: NeatGraph) => Promise<void> | void
  // Project tag for the extraction-complete event (ADR-051). Defaults to
  // DEFAULT_PROJECT when omitted.
  project?: string
  // ADR-065 — when set, drained extraction errors are appended to this
  // path as ndjson with `source: 'extract'`. Daemons / `neat init` /
  // `neat watch` wire this to `<projectDir>/neat-out/errors.ndjson`. When
  // omitted, errors are still drained and returned in the result, just
  // not persisted.
  errorsPath?: string
}

export async function extractFromDirectory(
  graph: NeatGraph,
  scanPath: string,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  await ensureCompatLoaded()
  // Clear any stale entries from a prior pass (the producer-side sink is
  // process-local). Per ADR-065, every pass collects its own errors; we drain
  // again at the end to capture this pass's failures.
  drainExtractionErrors()

  const services = await discoverServices(scanPath)

  const phase1Nodes = addServiceNodes(graph, services)
  await addServiceAliases(graph, scanPath, services)
  const fileEnum = await addFiles(graph, services, scanPath)
  const importGraph = await addImports(graph, services, scanPath)
  const phase2 = await addDatabasesAndCompat(graph, services, scanPath)
  const phase3 = await addConfigNodes(graph, services, scanPath)
  const phase4 = await addCallEdges(graph, services)
  const phase5 = await addInfra(graph, scanPath, services)
  // #140 — drop EXTRACTED edges whose evidence.file no longer exists on disk.
  // Catches the deleted-file ghost case for the full-pass entry point
  // (init / daemon bootstrap). The edited-file case is handled per-mtime by
  // watch.ts's `retireEdgesByFile`. Service dirs are passed alongside scanPath
  // because CALLS-family producers store service-dir-relative paths while
  // configs / databases / infra store scanPath-relative.
  const ghostsRetired = retireExtractedEdgesByMissingFile(
    graph,
    scanPath,
    services.map((s) => s.dir),
  )
  const frontiersPromoted = promoteFrontierNodes(graph)

  // Post-extract policy trigger (ADR-043). Fires after frontier promotion so
  // policies see the post-pass graph (including any FRONTIER → OBSERVED edge
  // upgrades that just landed).
  if (opts.onPolicyTrigger) await opts.onPolicyTrigger(graph)

  // ADR-065 — drain the per-file extraction errors collected during the pass.
  // If a sidecar path was supplied, append the entries; otherwise return them
  // for the caller to surface.
  const errorEntries = drainExtractionErrors()
  if (opts.errorsPath && errorEntries.length > 0) {
    try {
      await writeExtractionErrors(errorEntries, opts.errorsPath)
    } catch (err) {
      console.warn(
        `[neat] failed to write extraction errors to ${opts.errorsPath}: ${(err as Error).message}`,
      )
    }
  }

  // ADR-066 — drain the precision-floor drops. Always returned; only
  // persisted when NEAT_EXTRACTED_REJECTED_LOG=1 (opt-in to keep the
  // default sidecar surface quiet).
  const droppedEntries = drainDroppedExtracted()
  if (
    isRejectedLogEnabled() &&
    opts.errorsPath &&
    droppedEntries.length > 0
  ) {
    // rejected.ndjson lives alongside errors.ndjson under neat-out/. Derive
    // from errorsPath rather than re-plumbing a new option.
    const rejectedPath = path.join(path.dirname(opts.errorsPath), 'rejected.ndjson')
    try {
      await writeRejectedExtracted(droppedEntries, rejectedPath)
    } catch (err) {
      console.warn(
        `[neat] failed to write rejected extracted edges to ${rejectedPath}: ${(err as Error).message}`,
      )
    }
  }

  const result: ExtractResult = {
    nodesAdded:
      phase1Nodes +
      fileEnum.nodesAdded +
      importGraph.nodesAdded +
      phase2.nodesAdded +
      phase3.nodesAdded +
      phase4.nodesAdded +
      phase5.nodesAdded,
    edgesAdded:
      fileEnum.edgesAdded +
      importGraph.edgesAdded +
      phase2.edgesAdded + phase3.edgesAdded + phase4.edgesAdded + phase5.edgesAdded,
    frontiersPromoted,
    extractionErrors: errorEntries.length,
    errorEntries,
    ghostsRetired,
    extractedDropped: droppedEntries.length,
    droppedEntries,
  }

  // extraction-complete (ADR-051). fileCount is the number of services
  // discovered — the closest proxy we have for "how much source did this
  // pass touch" without a per-phase file accountant.
  emitNeatEvent({
    type: 'extraction-complete',
    project: opts.project ?? DEFAULT_PROJECT,
    payload: {
      project: opts.project ?? DEFAULT_PROJECT,
      fileCount: services.length,
      nodesAdded: result.nodesAdded,
      edgesAdded: result.edgesAdded,
    },
  })

  return result
}
