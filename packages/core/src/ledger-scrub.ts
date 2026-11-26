import { createReadStream, promises as fs } from 'node:fs'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { scrubLedgerRow } from './credential-scrub.js'
import { replaceLedgerViaSidecar } from './durable-incident.js'

// The at-rest half of the credential scrub. The write path (appendRuntimeIncident)
// and the read path (readErrorEvents) already keep credentials away from every
// surface, but a ledger written before those existed still holds the raw bytes on
// disk. The daemon rewrites each project's errors.ndjson once at slot bootstrap,
// before any producer for that slot is running, so nothing can append mid-rewrite.
//
// The marker file next to the ledger records which scrub version the ledger has
// been through. Bump LEDGER_SCRUB_VERSION when credential-scrub.ts learns a new
// pattern, and every ledger is rewritten once more on the next daemon start.
//
// Version 2 extends the rewrite from incident records to every row: extraction
// errors and any other JSON row get the same value redaction (scrubLedgerRow).
// Version 3 adds credentials written inline: unquoted keys, lower-case and
// camelCase assignments, env-read fallbacks and error prose (#1769).
export const LEDGER_SCRUB_VERSION = 3

export function ledgerScrubMarkerPath(errorsPath: string): string {
  return `${errorsPath}.scrubbed`
}

export type LedgerScrubResult =
  | { status: 'current' }
  | { status: 'clean'; records: number }
  | { status: 'rewritten'; records: number; scrubbed: number }
  // The ledger grew while it was being rewritten. The rewrite is dropped, the
  // original is left untouched, and the next start tries again.
  | { status: 'skipped-busy' }
  // Hosted only: the sidecar refused the rewrite as too large to hold in its
  // memory (413). Nothing was written; the next start tries again.
  | { status: 'too-large'; records: number; scrubbed: number }

/** How many times a hosted rewrite re-reads and resends after the ledger moved underneath it (409). */
const SIDECAR_REPLACE_ATTEMPTS = 3

/**
 * The at-rest rewrite on a hosted tenant, where the snapshot sidecar owns the
 * ledger and its archive (neat-infra #273). Same row scrub as scrubLedgerAtRest,
 * but the result goes to the sidecar's verified replace instead of a rename:
 *
 * - Complete records only. A torn last line is dropped, the same way the sidecar
 *   never archives one; the sidecar refuses a ledger that doesn't end in a newline.
 * - 409 means an append landed between the read and the replace, so the record
 *   count moved. Re-read and resend, a bounded number of times, then leave it to
 *   the next start ('skipped-busy').
 * - 413 means the ledger is too large for the sidecar to rewrite in memory. Logged
 *   by the caller; the slot carries on and the next start tries again.
 * - Anything else throws, and the caller logs it without blocking the slot.
 *
 * The marker lives beside the ledger on the instance's in-memory volume, which a
 * cold start doesn't keep, so a clean ledger is re-read on each cold start and
 * left alone.
 */
export async function scrubLedgerThroughSidecar(
  errorsPath: string,
  project: string,
  options: { token: string; fetchImpl?: typeof fetch; attempts?: number },
): Promise<LedgerScrubResult> {
  if ((await markerVersion(errorsPath)) >= LEDGER_SCRUB_VERSION) return { status: 'current' }
  const attempts = options.attempts ?? SIDECAR_REPLACE_ATTEMPTS
  for (let attempt = 0; attempt < attempts; attempt++) {
    let text: string
    try {
      text = await fs.readFile(errorsPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      await writeMarker(errorsPath)
      return { status: 'clean', records: 0 }
    }
    const complete = text.slice(0, text.lastIndexOf('\n') + 1)
    let records = 0
    let scrubbed = 0
    const out: string[] = []
    for (const raw of complete.split('\n').slice(0, -1)) {
      const r = scrubLine(raw)
      if (r.record) records++
      if (r.changed) scrubbed++
      out.push(r.line)
    }
    if (scrubbed === 0) {
      await writeMarker(errorsPath)
      return { status: 'clean', records }
    }
    const status = await replaceLedgerViaSidecar(project, out.map((l) => `${l}\n`).join(''), options)
    if (status === 204) {
      await writeMarker(errorsPath)
      return { status: 'rewritten', records, scrubbed }
    }
    if (status === 413) return { status: 'too-large', records, scrubbed }
    if (status !== 409) throw new Error(`ledger replace failed: sidecar answered ${status}`)
  }
  return { status: 'skipped-busy' }
}

async function markerVersion(errorsPath: string): Promise<number> {
  try {
    const parsed = JSON.parse(await fs.readFile(ledgerScrubMarkerPath(errorsPath), 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'number' ? parsed.version : 0
  } catch {
    return 0
  }
}

// A fresh project has no neat-out/ yet, so the marker creates the directory the
// ledger will live in rather than failing the scrub on every start (#1693).
async function writeMarker(errorsPath: string): Promise<void> {
  await fs.mkdir(path.dirname(errorsPath), { recursive: true })
  await fs.writeFile(
    ledgerScrubMarkerPath(errorsPath),
    JSON.stringify({ version: LEDGER_SCRUB_VERSION, at: new Date().toISOString() }) + '\n',
    'utf8',
  )
}

// One line of the ledger, scrubbed. A JSON object row (an incident, an
// extraction error) goes through scrubLedgerRow; anything else (a torn write)
// comes back byte-for-byte, as does a row with nothing to scrub.
function scrubLine(line: string): { line: string; changed: boolean; record: boolean } {
  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    return { line, changed: false, record: false }
  }
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return { line, changed: false, record: false }
  const scrubbed = scrubLedgerRow(row)
  if (scrubbed === row) return { line, changed: false, record: true }
  return { line: JSON.stringify(scrubbed), changed: true, record: true }
}

/**
 * Rewrite a project's errors.ndjson so no record on disk carries a credential the
 * scrub would drop or redact today. Runs once per LEDGER_SCRUB_VERSION. The
 * rewrite goes to a temp file next to the ledger and is renamed over it, so a
 * crash mid-rewrite leaves the original in place.
 */
export async function scrubLedgerAtRest(errorsPath: string): Promise<LedgerScrubResult> {
  if ((await markerVersion(errorsPath)) >= LEDGER_SCRUB_VERSION) return { status: 'current' }

  let before
  try {
    before = await fs.stat(errorsPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    // No ledger yet: every record from here on goes through the write-path scrub.
    await writeMarker(errorsPath)
    return { status: 'clean', records: 0 }
  }

  const tmpPath = `${errorsPath}.scrub-${process.pid}.tmp`
  let records = 0
  let scrubbed = 0
  const out = await fs.open(tmpPath, 'w', before.mode & 0o777)
  try {
    // Read only the bytes that existed at stat time, and keep a missing final
    // newline missing, so the rewrite is the same file with credentials removed.
    let endsWithNewline = true
    if (before.size > 0) {
      const last = Buffer.alloc(1)
      const fh = await fs.open(errorsPath, 'r')
      try {
        await fh.read(last, 0, 1, before.size - 1)
      } finally {
        await fh.close()
      }
      endsWithNewline = last[0] === 0x0a
    }
    let pending: string | undefined
    const emit = async (line: string, newline: boolean) => {
      await out.write(newline ? `${line}\n` : line)
    }
    if (before.size > 0) {
      const lines = createInterface({
        input: createReadStream(errorsPath, { start: 0, end: before.size - 1, encoding: 'utf8' }),
        crlfDelay: Infinity,
      })
      for await (const raw of lines) {
        if (pending !== undefined) await emit(pending, true)
        const r = scrubLine(raw)
        if (r.record) records++
        if (r.changed) scrubbed++
        pending = r.line
      }
    }
    if (pending !== undefined) await emit(pending, endsWithNewline)
    await out.sync()
  } catch (err) {
    await out.close()
    await fs.rm(tmpPath, { force: true })
    throw err
  }
  await out.close()

  if (scrubbed === 0) {
    await fs.rm(tmpPath, { force: true })
    await writeMarker(errorsPath)
    return { status: 'clean', records }
  }

  const after = await fs.stat(errorsPath)
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    await fs.rm(tmpPath, { force: true })
    return { status: 'skipped-busy' }
  }
  await fs.rename(tmpPath, errorsPath)
  await writeMarker(errorsPath)
  return { status: 'rewritten', records, scrubbed }
}
