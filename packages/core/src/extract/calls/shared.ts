import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { EdgeEvidence, ExtractedConfidenceKind } from '@neat.is/types'
import { IGNORED_DIRS, SERVICE_FILE_EXTENSIONS, isPythonVenvDir } from '../shared.js'

export interface SourceFile {
  path: string
  content: string
}

export interface ExternalEndpoint {
  // Stable id of the InfraNode this evidence implies. Format
  // `infra:<kind>:<name>` so the orchestrator can dedupe across services.
  infraId: string
  // Display name on the InfraNode (e.g., "orders" for kafka-topic:orders).
  name: string
  kind: string
  edgeType: 'CALLS' | 'PUBLISHES_TO' | 'CONSUMES_FROM'
  evidence: EdgeEvidence
  // Confidence grade per ADR-066 — set by the per-shape detector. The
  // orchestrator (calls/index.ts) writes this onto the EXTRACTED edge and
  // applies the precision floor before adding the edge to the graph.
  confidenceKind: ExtractedConfidenceKind
}

export async function walkSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        if (await isPythonVenvDir(full)) continue
        await walk(full)
      } else if (entry.isFile() && SERVICE_FILE_EXTENSIONS.has(path.extname(entry.name))) {
        out.push(full)
      }
    }
  }
  await walk(dir)
  return out
}

export async function loadSourceFiles(dir: string): Promise<SourceFile[]> {
  const paths = await walkSourceFiles(dir)
  const out: SourceFile[] = []
  for (const p of paths) {
    try {
      const content = await fs.readFile(p, 'utf8')
      out.push({ path: p, content })
    } catch {
      // unreadable, skip
    }
  }
  return out
}

// Locate the line of the first occurrence of `needle` in `text`, 1-indexed.
// Falls back to line 1 if the needle isn't found verbatim — better to point at
// the file than to drop the evidence entirely.
export function lineOf(text: string, needle: string): number {
  const idx = text.indexOf(needle)
  if (idx < 0) return 1
  return text.slice(0, idx).split('\n').length
}

export function snippet(text: string, line: number): string {
  const lines = text.split('\n')
  return (lines[line - 1] ?? '').trim()
}
