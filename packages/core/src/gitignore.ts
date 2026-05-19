/**
 * `.gitignore` automation for the init flow (ADR-073 §6).
 *
 * Init writes a snapshot under `<projectDir>/neat-out/`. Un-ignored, that
 * directory leaks the snapshot into git history within one commit. The
 * helper here ensures `neat-out/` is present in `<projectDir>/.gitignore` —
 * appending to an existing file with a NEAT comment header, creating the
 * file when absent, no-oping when the line is already there.
 *
 * Idempotency rule: an exact-match line (`neat-out/` or `neat-out`, with
 * any surrounding whitespace) counts as already-present. No duplicate
 * line is written on a re-run.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

export const NEAT_OUT_LINE = 'neat-out/'
const NEAT_HEADER = '# NEAT — machine-local snapshots and events'

export interface EnsureNeatOutResult {
  // 'added' when the line was appended to an existing .gitignore.
  // 'created' when the file did not exist and was created with a single line.
  // 'unchanged' when the line was already present.
  action: 'added' | 'created' | 'unchanged'
  // Absolute path to the .gitignore file, regardless of action.
  file: string
}

function isNeatOutLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed === 'neat-out/' || trimmed === 'neat-out'
}

export async function ensureNeatOutIgnored(projectDir: string): Promise<EnsureNeatOutResult> {
  const file = path.join(projectDir, '.gitignore')
  let existing: string | null = null
  try {
    existing = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  if (existing === null) {
    await fs.writeFile(file, `${NEAT_HEADER}\n${NEAT_OUT_LINE}\n`, 'utf8')
    return { action: 'created', file }
  }

  for (const line of existing.split(/\r?\n/)) {
    if (isNeatOutLine(line)) return { action: 'unchanged', file }
  }

  // Append with a leading newline if the file doesn't already end in one,
  // so the comment header sits on its own line.
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n')
  const appended = `${needsLeadingNewline ? '\n' : ''}\n${NEAT_HEADER}\n${NEAT_OUT_LINE}\n`
  await fs.writeFile(file, existing + appended, 'utf8')
  return { action: 'added', file }
}
