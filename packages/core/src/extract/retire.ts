import { existsSync } from 'node:fs'
import path from 'node:path'
import type { FileNode, GraphEdge, GraphNode } from '@neat.is/types'
import { NodeType, Provenance, isDependencyNodeId, fileId, parseSymbolId, parseServiceId } from '@neat.is/types'
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
    // A dependency's own `index.js` isn't the repo file of that name.
    if (isDependencyNodeId(edge.source)) return
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
// The FileNode an edge belongs to when neither endpoint is one (#1723). A symbol
// endpoint names its file in its own id (service + relPath), so a symbol-grain
// CALLS edge still has a file even with no FileNode endpoint; resolve it. As a
// fallback the edge's evidence.file names the file, scoped to the service of a
// symbol or service endpoint. Returns the FileNode when it is in the graph, else
// null.
function owningFileNode(graph: NeatGraph, edge: GraphEdge): FileNode | null {
  for (const endpoint of [edge.source, edge.target]) {
    const sym = parseSymbolId(endpoint)
    if (!sym) continue
    const id = fileId(sym.service, sym.relPath)
    if (graph.hasNode(id)) return graph.getNodeAttributes(id) as FileNode
  }
  const evidenceFile = edge.evidence?.file
  if (evidenceFile) {
    for (const endpoint of [edge.source, edge.target]) {
      const service = parseSymbolId(endpoint)?.service ?? parseServiceId(endpoint)?.name
      if (!service) continue
      const id = fileId(service, evidenceFile)
      if (graph.hasNode(id)) return graph.getNodeAttributes(id) as FileNode
    }
  }
  return null
}

// The set of sources on each service's FileNodes, built once per sweep. A
// service-rooted edge with no FileNode or symbol endpoint (a service ──DEPENDS_ON──▶
// dep edge, and the same shape for a service's infra RUNS_ON, config, database or
// route edges) has no file to resolve (a manifest gets no FileNode), so its owner is
// inferred from the sources on the service's own code files instead (#1723). This is
// inference from the files, not ownership recorded on the edge; recording source on
// the edge or the dependency node is the open decision on #1698.
function serviceFileSources(graph: NeatGraph): Map<string, Set<string | undefined>> {
  const byService = new Map<string, Set<string | undefined>>()
  graph.forEachNode((_id, attrs) => {
    const node = attrs as GraphNode
    if (node.type !== NodeType.FileNode) return
    const file = node as FileNode
    const sources = byService.get(file.service) ?? new Set<string | undefined>()
    sources.add(file.source)
    byService.set(file.service, sources)
  })
  return byService
}

function outOfScope(
  graph: NeatGraph,
  edge: GraphEdge,
  source: string | undefined,
  fileSourcesByService: Map<string, Set<string | undefined>>,
): boolean {
  if (!source) return false
  // The file an edge is about is its origin for a call, and its target for the
  // service ──CONTAINS──▶ file edge.
  for (const endpoint of [edge.source, edge.target]) {
    if (!graph.hasNode(endpoint)) continue
    const node = graph.getNodeAttributes(endpoint) as GraphNode
    if (node.type !== NodeType.FileNode) continue
    return (node as FileNode).source !== source
  }
  // No FileNode endpoint. A symbol ──CALLS──▶ symbol edge still names its file in the
  // symbol id; resolve it and judge scope by that FileNode's source (#1723). A
  // same-source edge returns false and falls to the existence check, so a file
  // deleted from the repo that owns it is still retired.
  const owner = owningFileNode(graph, edge)
  if (owner) return owner.source !== source
  // A service-rooted edge with no file at all (service ──DEPENDS_ON──▶ dep, and the
  // same for a service's infra/config/database/route edges) is scoped by the sources
  // on the service's own files (#1723, service-source inference). Out of scope only
  // when the service HAS files and NONE carries this pass's source: a service with no
  // files cannot be judged, and one with files from both sources (the #1294
  // collision, where the pass owns some of them) has this pass's among them, so both
  // fall through to the existence check below, which is today's behaviour. An
  // unstamped file counts as not-this-pass's, exactly as a FileNode endpoint with no
  // source does above.
  for (const endpoint of [edge.source, edge.target]) {
    const svc = parseServiceId(endpoint)
    if (!svc) continue
    const sources = fileSourcesByService.get(svc.name)
    if (sources && sources.size > 0 && !sources.has(source)) return true
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
  // Precompute each service's FileNode sources once, so the per-edge service-source
  // check (outOfScope) is a map lookup rather than a graph walk (#1723).
  const fileSourcesByService = serviceFileSources(graph)
  graph.forEachEdge((id, attrs) => {
    const edge = attrs as GraphEdge
    if (edge.provenance !== Provenance.EXTRACTED) return
    if (outOfScope(graph, edge, source, fileSourcesByService)) return
    // An edge out of dependency code (ADR-274) points at a file in the package,
    // not the repo, and the dependency-symbols phase replaces those edges itself.
    if (isDependencyNodeId(edge.source)) return
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
