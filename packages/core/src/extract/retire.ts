import { existsSync } from 'node:fs'
import path from 'node:path'
import type { GraphEdge, GraphNode } from '@neat.is/types'
import { NodeType, Provenance } from '@neat.is/types'
import type { NeatGraph } from '../graph.js'

// Drop any FileNode left with no edges. A FileNode exists to originate a
// relationship (file-awareness.md §1); once its CALLS / CONTAINS edges are
// retired and no OBSERVED traffic remains, the bare node carries nothing and
// goes too. Called after edge retirement so the snapshot stays consistent with
// what's on disk. Returns the count dropped.
function dropOrphanedFileNodes(graph: NeatGraph): number {
  const orphans: string[] = []
  graph.forEachNode((id, attrs) => {
    if ((attrs as GraphNode).type !== NodeType.FileNode) return
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
export function retireExtractedEdgesByMissingFile(
  graph: NeatGraph,
  scanPath: string,
  serviceDirs: readonly string[] = [],
): number {
  const toDrop: string[] = []
  const bases = [scanPath, ...serviceDirs]
  graph.forEachEdge((id, attrs) => {
    const edge = attrs as GraphEdge
    if (edge.provenance !== Provenance.EXTRACTED) return
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
  dropOrphanedFileNodes(graph)
  return toDrop.length
}
