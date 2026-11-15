import { promises as fs } from 'node:fs'
import path from 'node:path'
import { scrubLedgerRow } from './credential-scrub.js'

/**
 * Append records to an NDJSON ledger, each one through the credential scrub
 * first (scrubLedgerRow). Every append-only ledger whose rows can carry text from
 * outside NEAT writes through here: incident records, extraction errors (a parser
 * may quote the offending source line), the rejected-edge log (source snippets),
 * and the extend log (an install's stderr). Creates the directory if missing.
 */
export async function appendLedgerRecords(filePath: string, records: readonly unknown[]): Promise<void> {
  if (records.length === 0) return
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const lines = records.map((r) => JSON.stringify(scrubLedgerRow(r))).join('\n') + '\n'
  await fs.appendFile(filePath, lines, 'utf8')
}
