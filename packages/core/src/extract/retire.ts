import { existsSync } from 'node:fs'
import path from 'node:path'
import type { FileNode, GraphEdge, GraphNode } from '@neat.is/types'
import { NodeType, Provenance } from '@neat.is/types'
import type { NeatGraph } from '../graph.js'

// Drop any FileNode left with no edges. A FileNode exists to originate a
// relationship (file-awareness.md §1); once its CALLS / CONTAINS edges are
// retired and no OBSERVED traffic remains, the bare node carries nothing and
// goes too. Called after edge retirement so the snapshot stays consistent with
// what's on disk. Returns the count dropped.
function dropOrphanedFileNodes(graph: NeatGraph, source?: string): number {
  const orphans: string[] = []
  graph.forEachNode((id, attrs) => {
    const node = attrs as GraphNode
    if (node.type !== NodeType.FileNode) return
    // Same scope rule as the edge sweep (ADR-233): a pass doesn't clean up after
    // a source it didn't read. Otherwise a restored file whose edges another
    // pass hasn't rebuilt yet is dropped by whichever repo syncs first.
    if (source && (node as FileNode).source !== source) return
    if (graph.inboundEdges(id).length === 0 && graph.outboundEdges(id).length === 0) {
      orphans.push(id)
    }
  })
  for (const id of orphans) graph.dropNode(id)
  return orphans.length
}

// Drop every EXTRACTED edge whose evidence.file matches the given path, then
// sweep any FileNode the retirement left orphaned. Called from watch.ts before
// re-running an extract phase, so the producer's idempotent re-write recreates
// only the edges that still apply. Edges from the deleted code stay deleted.
// See docs/contracts/static-extraction.md §Ghost-edge cleanup. Mutation
// authority lives under extract/* per ADR-030, so the dropEdge call must happen
// here, not in watch.ts. The returned count is edges dropped (FileNode cleanup
// is a structural side effect, not a ghost-edge count).
export function retireEdgesByFile(graph: NeatGraph, file: string): number {
  const normalized = file.split('\\').join('/')
  const toDrop: string[] = []
  graph.forEachEdge((id, attrs) => {
    const edge = attrs as GraphEdge
    if (edge.provenance !== Provenance.EXTRACTED) return
    if (!edge.evidence?.file) return
    if (edge.evidence.file === normalized) toDrop.push(id)
  })
  for (const id of toDrop) graph.dropEdge(id)
  dropOrphanedFileNodes(graph)
  return toDrop.length
}

// #140 — full-pass cleanup. Walk every EXTRACTED edge in the graph; if its
// `evidence.file` cannot be resolved on disk against the scan root or any
// discovered service directory, drop it. extractFromDirectory calls this at
// the end of every pass so a daemon bootstrap (or a re-init after the
// operator deleted some source) gets a snapshot consistent with what's
// actually on disk.
//
// Handles the deleted-file half of the ghost-edge bug. The edited-file half
// (file still exists, producer no longer emits the edge) is handled by
// watch.ts's per-file `retireEdgesByFile` on the mtime trigger.
//
// Path resolution is tolerant: producers in this tree are inconsistent about
// whether `evidence.file` is scanPath-relative (configs, databases, infra)
// or service-dir-relative (calls/*). We try every candidate base before
// concluding the file is gone — the cost is one extra `existsSync` per
// service dir per ghost candidate, which is cheap.

// A pass may only retire what its own source produced (ADR-233).
//
// The sweep's reach is the whole graph; its evidence is one directory. That is
// sound while the graph has one source and the pass is scanning it — a local
// daemon — and wrong the moment it doesn't. A hosted daemon breaks both halves:
// each bound repo is cloned to its own temp dir and extracted into the same
// graph, so repo B's pass finds none of repo A's files and retires them
// (#1294); and the boot pass runs over a path that holds no source at all, so
// it retires every restored edge (#1291).
//
// So a pass that names a source retires only the files carrying that source,
// and a pass that names none behaves exactly as it always has — which is every
// local daemon, untouched.
//
// A file carrying *no* source is out of scope too, not judged by existence.
// That looks over-cautious and isn't: a snapshot written before this field
// existed has no sources on it at all, so judging those the old way would have
// the first repo to sync after an upgrade sweep every other repo's restored
// files — the bug, surviving its own fix, once. Unowned files are instead
// claimed by the first pass that reads one (`ensureFileNode`), and are
// retirable from then on.
//
// The cost is bounded and worth naming: a file deleted from a repo while the
// daemon was down, and never read again, stays unowned and so is never retired.
// It lingers as a ghost rather than taking a live repo's graph down with it.
function outOfScope(graph: NeatGraph, edge: GraphEdge, source: string | undefined): boolean {
  if (!source) return false
  // The file an edge is about is its origin for a call, and its target for the
  // service ──CONTAINS──▶ file edge.
  for (const endpoint of [edge.source, edge.target]) {
    if (!graph.hasNode(endpoint)) continue
    const node = graph.getNodeAttributes(endpoint) as GraphNode
    if (node.type !== NodeType.FileNode) continue
    return (node as FileNode).source !== source
  }
  return false
}

export function retireExtractedEdgesByMissingFile(
  graph: NeatGraph,
  scanPath: string,
  serviceDirs: readonly string[] = [],
  source?: string,
): number {
  const toDrop: string[] = []
  const bases = [scanPath, ...serviceDirs]
  graph.forEachEdge((id, attrs) => {
    const edge = attrs as GraphEdge
    if (edge.provenance !== Provenance.EXTRACTED) return
    if (outOfScope(graph, edge, source)) return
    const evidenceFile = edge.evidence?.file
    if (!evidenceFile) return
    if (path.isAbsolute(evidenceFile)) {
      if (!existsSync(evidenceFile)) toDrop.push(id)
      return
    }
    // Tolerant: the file is "present" if any base resolves it.
    const found = bases.some((base) => existsSync(path.join(base, evidenceFile)))
    if (!found) toDrop.push(id)
  })
  for (const id of toDrop) graph.dropEdge(id)
  dropOrphanedFileNodes(graph, source)
  return toDrop.length
}
