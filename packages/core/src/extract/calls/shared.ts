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
import { loadIgnoreChain, extendIgnoreChain, isIgnored, decide, type IgnoreChain } from '../gitignore.js'
import {
  IGNORED_DIRS,
  SERVICE_FILE_EXTENSIONS,
  isNeatAuthoredSourceFile,
  isPythonVenvDir,
  type DiscoveredService,
} from '../shared.js'

// Host → owning ServiceNode id, the cross-service resolution the HTTP call-site
// producers share (ADR-065 #5, ADR-119). A service is reachable by either its
// directory basename or its manifest name; both map to the same node id. Reused
// by http.ts (host-level CALLS edges) and route-match.ts (client↔route
// matching) so the two producers resolve a URL's host to a service identically.
export interface ServiceHostIndex {
  knownHosts: Set<string>
  hostToNodeId: Map<string, string>
}

export function buildServiceHostIndex(services: DiscoveredService[]): ServiceHostIndex {
  const knownHosts = new Set<string>()
  const hostToNodeId = new Map<string, string>()
  for (const service of services) {
    const base = path.basename(service.dir)
    knownHosts.add(base)
    knownHosts.add(service.pkg.name)
    hostToNodeId.set(base, service.node.id)
    hostToNodeId.set(service.pkg.name, service.node.id)
  }
  return { knownHosts, hostToNodeId }
}

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
  // Declared schema columns for a `sql-table` endpoint (ADR-157 §3), at
  // database-name fidelity. Set only by a schema-column producer (the Drizzle
  // recognizer today); the orchestrator folds these onto the table node's
  // `columns` list with EXTRACTED provenance. Absent on every other endpoint.
  columns?: string[]
  // Per-written-field SDK tags for a `firestore-collection` endpoint (ADR-167):
  // which SDK (`client` = firebase/firestore, `admin` = firebase-admin/firestore)
  // wrote each field. Set only by calls/firestore.ts; the orchestrator folds these
  // onto the collection node's columns via `foldSdkWrites` (the parallel of the
  // `columns` fold — `foldColumns` stays untouched). The write-SDK dimension is the
  // seam the field-guard policy (ADR-169) joins on. Absent on every other endpoint.
  sdkWrites?: Record<string, ('client' | 'admin')[]>
}

// A foreign-key relationship between two SQL tables (ADR-161) — the data-axis
// sibling of a symbol INHERITS edge. `childTable` declares the FK, `parentTable`
// is the referenced table; both are the DATABASE table name (the fusion key
// `infra:sql-table:<name>` the column/table extractors and OTLP already target),
// reproduced verbatim the way the ORM names the table, not the code model name.
// A schema-FK producer (Drizzle / Prisma / SQLAlchemy) emits one per resolved
// reference; a computed or unresolvable parent is left unclaimed (the producer
// returns nothing), never guessed. `table-edges.ts` mints the EXTRACTED
// `child ──REFERENCES──▶ parent` edge from these, with `evidence` pinned to the
// FK declaration site.
export interface TableReference {
  childTable: string
  parentTable: string
  evidence: EdgeEvidence
}

// ADR-200 — nearest-service-wins ownership. `excludeDirs` names the subtrees this
// walk must not descend into: the dirs of other discovered services nested under
// `dir`. Skipping the subtree at its root drops every file beneath it, so an
// ancestor service never re-enumerates a nested service's source. Default empty —
// a single-service or leaf walk is unchanged.
// A gitignored path is absent from the graph, not present-but-unextracted
// (#1255): the walk never yields it, so no FileNode is minted and no recogniser
// runs over it. Directory-level pruning is how git thinks about it and the
// cheaper shape — skipping `dist/` at its root costs one test, not one per file
// underneath.
export async function walkSourceFiles(
  dir: string,
  excludeDirs: string[] = [],
): Promise<string[]> {
  const excluded = new Set(excludeDirs.map((d) => path.resolve(d)))
  const out: string[] = []
  // The rules governing `dir` itself: every `.gitignore` from the repo root
  // down. A service nested in a monorepo inherits its ancestors' rules the same
  // way it would on the command line.
  const rootChain = await loadIgnoreChain(dir)
  async function walk(current: string, inherited: IgnoreChain): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    // This directory's own `.gitignore` governs everything below it. Reading the
    // listing we already have beats probing for the file: a blind `readFile` per
    // directory is a failed open on almost every one of them, and on a repo the
    // size of this one that alone doubled the walk.
    const chain = entries.some((e) => e.isFile() && e.name === '.gitignore')
      ? await extendIgnoreChain(inherited, current)
      : inherited
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        if (excluded.has(path.resolve(full))) continue
        // `subtree` is the chain minus anything a deeper rule overrode for this
        // directory, so a re-included dir isn't re-excluded file by file.
        const verdict = decide(chain, full, true)
        if (verdict.ignored) continue
        if (await isPythonVenvDir(full)) continue
        await walk(full, verdict.subtree)
      } else if (
        entry.isFile() &&
        SERVICE_FILE_EXTENSIONS.has(path.extname(entry.name)) &&
        // Skip NEAT's own generated `otel-init.*` bootstrap — extracting it
        // would attribute our instrumentation imports to the user's service.
        !isNeatAuthoredSourceFile(entry.name) &&
        !isIgnored(chain, full, false)
      ) {
        out.push(full)
      }
    }
  }
  // `loadIgnoreChain` already includes `dir`'s own file, and `walk` would add it
  // a second time from the listing — harmless but pointless, so start from the
  // chain above it and let the walk pick `dir`'s up like every other directory.
  await walk(dir, rootChain.filter((l) => path.resolve(l.dir) !== path.resolve(dir)))
  return out
}

export async function loadSourceFiles(
  dir: string,
  excludeDirs: string[] = [],
): Promise<SourceFile[]> {
  const paths = await walkSourceFiles(dir, excludeDirs)
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

// static-extraction.md §evidence: `snippet?: string // small source fragment,
// max ~120 chars`. The cap is the contract's, not a new rule — evidence is a
// pointer to the source, and the source is already on disk at `file:line`.
//
// Uncapped, the snippet is the whole line, and one line is not bounded by
// anything: a minified bundle can put a 227 KB file on a single line, and every
// edge into that file then carries the entire file. A real repo reached 1,012 MB
// of edges that way and the snapshot could not be written at all (#1254).
const SNIPPET_MAX_CHARS = 120

export function snippet(text: string, line: number): string {
  const lines = text.split('\n')
  const raw = (lines[line - 1] ?? '').trim()
  if (raw.length <= SNIPPET_MAX_CHARS) return raw
  // Say it was cut and by how much, so a reader can tell a truncated fragment
  // from a genuinely short line — and spot a minified file for what it is.
  return `${raw.slice(0, SNIPPET_MAX_CHARS)}… (+${raw.length - SNIPPET_MAX_CHARS} chars)`
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
    case '.go':
      return 'go'
    case '.rb':
      return 'ruby'
    case '.php':
      return 'php'
    case '.cs':
      return 'csharp'
    case '.java':
      return 'java'
    case '.kt':
      return 'kotlin'
    case '.rs':
      return 'rust'
    case '.cpp':
    case '.cc':
    case '.cxx':
    case '.c++':
    case '.hpp':
    case '.hh':
    case '.hxx':
    case '.h++':
      return 'cpp'
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
