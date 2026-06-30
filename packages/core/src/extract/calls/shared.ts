import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { EdgeEvidence, ExtractedConfidenceKind, FileNode, GraphEdge } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  extractedEdgeId,
  fileId,
} from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import {
  IGNORED_DIRS,
  SERVICE_FILE_EXTENSIONS,
  isNeatAuthoredSourceFile,
  isPythonVenvDir,
} from '../shared.js'

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
      } else if (
        entry.isFile() &&
        SERVICE_FILE_EXTENSIONS.has(path.extname(entry.name)) &&
        // Skip NEAT's own generated `otel-init.*` bootstrap — extracting it
        // would attribute our instrumentation imports to the user's service.
        !isNeatAuthoredSourceFile(entry.name)
      ) {
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

// Forward-slash a path so a FileNode id is byte-stable across platforms (the
// `relPath` segment of `file:<service>:<relPath>` must not vary by OS).
export function toPosix(p: string): string {
  return p.split('\\').join('/')
}

// Extension → language tag for a FileNode. Returns undefined for extensions we
// don't name rather than guessing — evidence is never fabricated (§6).
export function languageForPath(relPath: string): string | undefined {
  switch (path.extname(relPath).toLowerCase()) {
    case '.py':
      return 'python'
    case '.ts':
    case '.tsx':
      return 'typescript'
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript'
    default:
      return undefined
  }
}

// File-first emission (file-awareness.md §1–2). Ensure the FileNode for
// `relPath` and the owning `service ──CONTAINS──▶ file` edge both exist, then
// return the FileNode id so the caller can originate a relationship from it.
// `relPath` must already be service-relative and forward-slashed (use toPosix).
// CONTAINS is structural ownership — graded at the 'structural' tier like
// CONFIGURED_BY, never a flat value. Idempotent: re-running extraction over an
// unchanged file is a no-op.
export function ensureFileNode(
  graph: NeatGraph,
  serviceName: string,
  serviceNodeId: string,
  relPath: string,
): { fileNodeId: string; nodesAdded: number; edgesAdded: number } {
  let nodesAdded = 0
  let edgesAdded = 0
  const fileNodeId = fileId(serviceName, relPath)
  if (!graph.hasNode(fileNodeId)) {
    const language = languageForPath(relPath)
    const node: FileNode = {
      id: fileNodeId,
      type: NodeType.FileNode,
      service: serviceName,
      path: relPath,
      ...(language ? { language } : {}),
      discoveredVia: 'static',
    }
    graph.addNode(fileNodeId, node)
    nodesAdded++
  }
  const containsId = extractedEdgeId(serviceNodeId, fileNodeId, EdgeType.CONTAINS)
  if (!graph.hasEdge(containsId)) {
    const edge: GraphEdge = {
      id: containsId,
      source: serviceNodeId,
      target: fileNodeId,
      type: EdgeType.CONTAINS,
      provenance: Provenance.EXTRACTED,
      confidence: confidenceForExtracted('structural'),
      evidence: { file: relPath },
    }
    graph.addEdgeWithKey(containsId, serviceNodeId, fileNodeId, edge)
    edgesAdded++
  }
  return { fileNodeId, nodesAdded, edgesAdded }
}
