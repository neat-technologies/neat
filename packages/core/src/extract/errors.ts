// ADR-065 — loud failure mode for static extraction.
//
// Per-file extraction failures used to land as a single `console.warn` line
// with no aggregate count and no on-disk record. The 2026-05-12 medusa
// experiment ran `neat init` against ~90 files that all silently failed
// extraction with "Invalid argument"; the snapshot shipped with those files
// missing, the user had no signal it had happened, and the divergence query
// couldn't surface gaps it didn't know it had.
//
// This module is the failure-mode plumbing: a process-local sink that every
// producer appends to when a per-file parse fails, with helpers to drain the
// sink to `<projectDir>/neat-out/errors.ndjson` and to surface the aggregate
// count in init / watch banners.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { EdgeEvidence, ExtractionCoverage } from '@neat.is/types'

export interface ExtractionError {
  // Producer name (e.g. "http", "services", "infra docker-compose"). Stable
  // human-readable identifier for logs and contract assertions.
  producer: string
  // Absolute or relative path of the file that failed. Stored verbatim from
  // the call site; no normalisation here.
  file: string
  // The error's `.message`. Stringified if the throw value wasn't an Error.
  error: string
  // Optional stack trace (captured at the call site). Useful for diagnosing
  // tree-sitter "Invalid argument" cases where the message alone is generic.
  stack?: string
  // ISO timestamp of when the error was recorded.
  ts: string
  // Discriminator for `errors.ndjson` consumers — separates extract failures
  // from OTel error events that share the same file (ADR-033).
  source: 'extract'
}

const sink: ExtractionError[] = []

// Record a per-file extraction failure. Preserves the visible warn line so
// existing scripts/CI consumers still see a per-file message; appends to the
// process-local sink so the aggregate count + sidecar write can fire later.
export function recordExtractionError(
  producer: string,
  file: string,
  err: unknown,
): void {
  const e = err instanceof Error ? err : new Error(String(err))
  sink.push({
    producer,
    file,
    error: e.message,
    stack: e.stack,
    ts: new Date().toISOString(),
    source: 'extract',
  })
  // Visible warn preserved (pre-ADR-065 callers logged this). Banners
  // aggregate, but per-file context still useful for tail -f sessions.
  console.warn(`[neat] ${producer} skipped ${file}: ${e.message}`)
}

// Drain all queued errors. Idempotent — subsequent calls return an empty
// array until new errors land. Callers (extractFromDirectory) drain at start
// to clear stale state from prior runs, then drain again at end to collect
// the pass's failures.
export function drainExtractionErrors(): ExtractionError[] {
  return sink.splice(0, sink.length)
}

// Read-only count of currently-queued errors. Used by callers that want the
// count without consuming the sink (the banner case — we want the count for
// display and the entries for `errors.ndjson`).
export function pendingExtractionErrors(): number {
  return sink.length
}

// Append the drained entries to `<projectDir>/neat-out/errors.ndjson`. The
// file is shared with OTel error events (per ADR-033); the `source: 'extract'`
// discriminator separates them for consumers. Creates the directory if
// missing. Append-only — never rewritten.
export async function writeExtractionErrors(
  errors: ExtractionError[],
  errorsPath: string,
): Promise<void> {
  if (errors.length === 0) return
  await fs.mkdir(path.dirname(errorsPath), { recursive: true })
  const lines = errors.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await fs.appendFile(errorsPath, lines, 'utf8')
}

// ─────────────────────────────────────────────────────────────────────────
// #883 — extraction coverage in the query surface.
//
// errors.ndjson is append-only and shared with OTel error events, so it can't
// answer "is the CURRENT graph complete?" — its extract lines accumulate across
// every pass. This sidecar is overwritten each full pass (zero included), so it
// always reflects the latest coverage, and a daemon reads it to put the count on
// /health. Without it, a partial extraction is invisible to anything querying
// the graph.
// ─────────────────────────────────────────────────────────────────────────

// The health sidecar sits beside errors.ndjson and mirrors its per-project
// naming: errors.ndjson → extraction-health.json;
// errors.<project>.ndjson → extraction-health.<project>.json.
export function extractionHealthPathFor(errorsPath: string): string {
  const dir = path.dirname(errorsPath)
  const suffix = path.basename(errorsPath).replace(/^errors/, '').replace(/\.ndjson$/, '')
  return path.join(dir, `extraction-health${suffix}.json`)
}

// Up to this many failed-file paths are sampled into the sidecar; the count is
// always exact, the list is a bounded aid.
const HEALTH_FILE_SAMPLE = 100

// Overwrite the sidecar with this pass's coverage. Called on every full pass so
// a clean re-run clears a prior gap (skippedFiles: 0). Best-effort at the call
// site; failure to write never fails extraction.
export async function writeExtractionHealth(
  errors: ExtractionError[],
  healthPath: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  const byProducer: Record<string, number> = {}
  for (const e of errors) byProducer[e.producer] = (byProducer[e.producer] ?? 0) + 1
  const coverage: ExtractionCoverage = {
    skippedFiles: errors.length,
    byProducer,
    files: errors.slice(0, HEALTH_FILE_SAMPLE).map((e) => e.file),
    updatedAt: now,
  }
  await fs.mkdir(path.dirname(healthPath), { recursive: true })
  await fs.writeFile(healthPath, JSON.stringify(coverage), 'utf8')
}

// Read the coverage sidecar. Returns undefined when absent or malformed —
// discovery is convenience, never fatal, so a missing/garbled file just means
// "no recorded coverage," not an error.
export async function readExtractionHealth(
  healthPath: string,
): Promise<ExtractionCoverage | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(healthPath, 'utf8')
  } catch {
    return undefined
  }
  try {
    const obj = JSON.parse(raw) as ExtractionCoverage
    if (typeof obj?.skippedFiles !== 'number' || !obj.byProducer || !Array.isArray(obj.files)) {
      return undefined
    }
    return obj
  } catch {
    return undefined
  }
}

// ADR-065 — `NEAT_STRICT_EXTRACTION=1` makes any per-file extraction failure
// cause the calling command to exit non-zero. Default is forgiving (banner
// only). The check is at the caller (cli.ts / server.ts / watch.ts) so the
// extraction phase itself stays library-shaped.
export function isStrictExtractionEnabled(): boolean {
  const raw = process.env.NEAT_STRICT_EXTRACTION
  return raw === '1' || raw === 'true'
}

// Format the unconditional summary banner. Zero errors is a positive signal
// ("0 files skipped") so callers print this even on clean runs.
export function formatExtractionBanner(count: number): string {
  if (count === 1) return `[neat] 1 file skipped due to parse errors`
  return `[neat] ${count} files skipped due to parse errors`
}

// ─────────────────────────────────────────────────────────────────────────
// ADR-066 — precision-floor drop accounting.
//
// EXTRACTED candidates whose graded confidence falls below
// NEAT_EXTRACTED_PRECISION_FLOOR (default 0.7) are computed but never added
// to the graph. The drop count surfaces on the extraction banner;
// NEAT_EXTRACTED_REJECTED_LOG=1 routes the per-candidate detail to
// `<projectDir>/neat-out/rejected.ndjson`. The default keeps the sidecar
// surface quiet.
// ─────────────────────────────────────────────────────────────────────────

export interface DroppedExtractedEdge {
  source: string
  target: string
  type: string
  confidence: number
  confidenceKind: string
  evidence: EdgeEvidence
}

const droppedSink: DroppedExtractedEdge[] = []

export function noteExtractedDropped(edge: DroppedExtractedEdge): void {
  droppedSink.push(edge)
}

export function drainDroppedExtracted(): DroppedExtractedEdge[] {
  return droppedSink.splice(0, droppedSink.length)
}

export function pendingDroppedExtracted(): number {
  return droppedSink.length
}

export function isRejectedLogEnabled(): boolean {
  const raw = process.env.NEAT_EXTRACTED_REJECTED_LOG
  return raw === '1' || raw === 'true'
}

export async function writeRejectedExtracted(
  drops: DroppedExtractedEdge[],
  rejectedPath: string,
): Promise<void> {
  if (drops.length === 0) return
  await fs.mkdir(path.dirname(rejectedPath), { recursive: true })
  const lines = drops.map((d) => JSON.stringify({ ...d, ts: new Date().toISOString() })).join('\n') + '\n'
  await fs.appendFile(rejectedPath, lines, 'utf8')
}

export function formatPrecisionFloorBanner(count: number): string {
  if (count === 1) return `[neat] 1 extracted edge dropped below precision floor`
  return `[neat] ${count} extracted edges dropped below precision floor`
}
