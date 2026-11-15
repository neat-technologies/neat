import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as sourceMapJs from 'source-map-js'
import type {
  FileNode,
  GraphEdge,
  GraphNode,
  ServiceNode,
  SymbolNode,
} from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  fileId,
  symbolId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import type { ParsedSpan } from '../otel.js'
import {
  codeFilepathOf,
  codeFunctionOf,
  codeLinenoOf,
} from '../otel-code-attrs.js'
import { makeObservedEdgeId } from './edges.js'

// Call-site capture (file-awareness.md §4): code.* to a service-relative file,
// source maps, and the observed FileNode/SymbolNode an edge originates from.
// Moved out of ingest.ts; ingest.ts re-exports the public names.

// One-time-per-session-per-service audit for a compiled `dist/...js` call site
// that carried no adjacent source map (file-awareness.md §4 + §6). Without a
// map, ingest can't reconcile the observed dist file to the static `src/...ts`
// the extractor parsed — the dist path is the honest answer, never a fabricated
// src path. The leak this surfaces (issue #430) was hiding behind an absolute
// path prefix; once the path is service-root-relative the mismatch is legible,
// and this line tells the operator how to close it.
export const noSourceMapWarnedServices = new Set<string>()

export function warnNoSourceMaps(serviceName: string): void {
  if (noSourceMapWarnedServices.has(serviceName)) return
  noSourceMapWarnedServices.add(serviceName)
  console.warn(
    `[neat] ${serviceName}: no .map files found under dist/; observed file edges will land on dist paths, not src. Set sourceMap: true in tsconfig to enable file-level reconciliation.`,
  )
}

// Test seam — mirrors resetUnidentifiedSpanWarnings for the once-per-service
// audit above.
export function resetNoSourceMapWarnings(): void {
  noSourceMapWarnedServices.clear()
}

export function toPosix(p: string): string {
  return p.split('\\').join('/')
}

export function languageForExt(relPath: string): string | undefined {
  const dot = relPath.lastIndexOf('.')
  if (dot === -1) return undefined
  switch (relPath.slice(dot).toLowerCase()) {
    case '.py':
      return 'python'
    case '.go':
      return 'go'
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

// Join the runtime `code.filepath` against the service root so the OBSERVED
// relPath lines up with the EXTRACTED service-relative path (file-awareness.md
// §4 + §7). ServiceNode.repoPath is the scanPath-relative package dir; its
// segments appear inside the absolute runtime path, so anchoring on it recovers
// the package-relative tail. With no usable anchor, the real runtime path is
// returned in a relative-looking form — honest, even if it doesn't align with a
// static src path. Never fabricated.
export function relPathForRuntimeFile(
  filepath: string,
  serviceNode?: ServiceNode,
  scanPath?: string,
): string | null {
  let p = toPosix(filepath).replace(/^file:\/\//, '')
  // When ingest knows the absolute scan root, the service's absolute root is
  // `scanPath/<repoPath>`. Stripping it directly recovers the service-relative
  // tail (`dist/foo.js`) even for a single-package service whose `repoPath` is
  // empty — the segment anchor below has nothing to grab in that case, so the
  // absolute path used to leak into the FileNode key (issue #430).
  if (scanPath && scanPath.length > 0) {
    const absRoot = toPosix(path.resolve(scanPath, serviceNode?.repoPath ?? ''))
    const anchor = absRoot.endsWith('/') ? absRoot : `${absRoot}/`
    if (p.startsWith(anchor)) return p.slice(anchor.length)
  }
  const root = serviceNode?.repoPath
  if (root && root !== '.' && root.length > 0) {
    const rootPosix = toPosix(root)
    const anchor = `/${rootPosix}/`
    const idx = p.lastIndexOf(anchor)
    if (idx !== -1) return p.slice(idx + anchor.length)
    const base = rootPosix.split('/').filter(Boolean).pop()
    if (base) {
      const baseAnchor = `/${base}/`
      const bidx = p.lastIndexOf(baseAnchor)
      if (bidx !== -1) return p.slice(bidx + baseAnchor.length)
    }
  }
  p = p.replace(/^[A-Za-z]:/, '').replace(/^\/+/, '')
  return p.length > 0 ? p : null
}

// Exported so the connectors plane (packages/core/src/connectors/index.ts,
// docs/contracts/connectors.md) can build one from a signal's own callSite —
// a connector's file:line comes from the provider's telemetry rather than an
// OTel span's code.* attributes, but reconciles onto the same EXTRACTED
// FileNode through the same primitives below.
export interface CallSite {
  relPath: string
  line?: number
  fn?: string
  // The service-relative dist path the call site was captured on, when ingest
  // resolved it through a source map to a different (source) `relPath`
  // (file-awareness.md §4). Surfaces as FileNode.originalPath. Absent when the
  // captured frame was already source-grained.
  originalRelPath?: string
}

// dist→src source-map resolution (file-awareness.md §4). A runtime call site in
// a compiled `dist/...js` is resolved through a disk-adjacent `.map` to the
// original `src/...ts`, so an OBSERVED edge lands on the source file an agent
// can open. Same-host only — when the daemon's filesystem doesn't carry the map
// (a service that ran on a different machine) the dist frame is kept, honestly,
// never fabricated (§6). Each dist file is read from disk once: a present map
// caches its consumer, an absent one caches `null`. Synchronous reads keep
// callSiteFromSpan synchronous; the cost is amortised across a file's spans.
export const sourceMapCache = new Map<
  string,
  { consumer: sourceMapJs.SourceMapConsumer; dir: string } | null
>()

export interface ResolvedSrc {
  filepath: string
  line?: number
}

export function resolveDistToSrc(absFilepath: string, line?: number): ResolvedSrc | null {
  if (!absFilepath.endsWith('.js')) return null
  let entry = sourceMapCache.get(absFilepath)
  if (entry === undefined) {
    entry = null
    const mapPath = `${absFilepath}.map`
    try {
      if (existsSync(mapPath)) {
        const raw = JSON.parse(readFileSync(mapPath, 'utf8')) as unknown
        const consumer = new sourceMapJs.SourceMapConsumer(raw as never)
        entry = { consumer, dir: path.dirname(mapPath) }
      }
    } catch {
      entry = null
    }
    sourceMapCache.set(absFilepath, entry)
  }
  if (!entry) return null
  try {
    const queryLine = line !== undefined && Number.isFinite(line) ? line : 1
    // tsc anchors every mapping at the token's real (indented) column, so a
    // column-0 lookup under the default GREATEST_LOWER_BOUND bias finds no
    // mapping on any indented statement — which is exactly the call site an
    // OBSERVED CLIENT span reports for compiled Nest/TS code (issue #915). The
    // map is on disk and read fine; only the position lookup came back empty,
    // so the whole dist frame used to fall through to the raw path. Retry the
    // lookup biased to the LEAST_UPPER_BOUND — the first mapping at or after
    // column 0 on that generated line — so the line resolves to its source.
    let pos = entry.consumer.originalPositionFor({ line: queryLine, column: 0 })
    if (!pos || !pos.source) {
      pos = entry.consumer.originalPositionFor({
        line: queryLine,
        column: 0,
        bias: sourceMapJs.SourceMapConsumer.LEAST_UPPER_BOUND,
      })
    }
    if (!pos || !pos.source) return null
    const root = entry.consumer.sourceRoot ?? ''
    const resolved = path.resolve(entry.dir, root, pos.source)
    return { filepath: resolved, ...(pos.line ? { line: pos.line } : {}) }
  } catch {
    return null
  }
}

// Whether a disk-adjacent `.map` was found for a compiled `dist/...js` frame.
// Reuses the module-level cache resolveDistToSrc already warmed — a non-null
// entry means the map is present (resolution may still have missed a specific
// line), a null entry means none was on disk. Lets the missing-map audit stay
// honest: it must not claim "no .map files found" when a map exists but a lone
// line failed to resolve (file-awareness.md §6, issue #915).
export function hasAdjacentSourceMap(absFilepath: string): boolean {
  return sourceMapCache.get(absFilepath) != null
}

// Read the call-site attributes off a span. Returns null when the span carries
// no `code.filepath` (SERVER spans, un-instrumented peers, callee side) so the
// caller falls back to a service-level edge.
export function callSiteFromSpan(
  span: ParsedSpan,
  serviceNode?: ServiceNode,
  scanPath?: string,
): CallSite | null {
  const filepath = codeFilepathOf(span.attributes)
  if (filepath === undefined) return null
  let line = codeLinenoOf(span.attributes)
  // Resolve a compiled dist frame to its source before computing the service-
  // relative path, so the FileNode lands on the original `src/...ts`.
  const abs = toPosix(filepath).replace(/^file:\/\//, '')
  const resolved = resolveDistToSrc(abs, line)
  let effectivePath = filepath
  let originalRelPath: string | undefined
  if (resolved) {
    originalRelPath = relPathForRuntimeFile(filepath, serviceNode, scanPath) ?? undefined
    effectivePath = resolved.filepath
    if (resolved.line !== undefined) line = resolved.line
  }
  const relPath = relPathForRuntimeFile(effectivePath, serviceNode, scanPath)
  if (!relPath) return null
  // A compiled `dist/...js` call site that didn't resolve through a map keeps
  // the (honest) dist path. Surface the absence once per service so the
  // operator can enable source maps and recover src-level reconciliation
  // (file-awareness.md §4 + §6, issue #430). Only warn when no `.map` is
  // actually on disk — a present-but-unresolved line must not masquerade as a
  // missing map, the misdiagnosis issue #915 called out.
  if (
    !resolved &&
    abs.endsWith('.js') &&
    relPath.startsWith('dist/') &&
    !hasAdjacentSourceMap(abs) &&
    serviceNode?.name
  ) {
    warnNoSourceMaps(serviceNode.name)
  }
  const fn = codeFunctionOf(span.attributes)
  return {
    relPath,
    ...(line !== undefined ? { line } : {}),
    ...(fn ? { fn } : {}),
    ...(originalRelPath && originalRelPath !== relPath ? { originalRelPath } : {}),
  }
}

// Reconcile a runtime-derived relPath onto the service-relative path the
// extractor already minted, so OBSERVED and EXTRACTED FileNodes for the same
// source file fuse into ONE node instead of two disjoint subgraphs
// (file-awareness.md §4 — ingest joins the runtime path against the service
// root to land the edge on a FileNode).
//
// relPathForRuntimeFile anchors the absolute `code.filepath` against scanPath /
// repoPath. When that anchor can't be found — no scanPath wired, or the span
// was emitted from a service whose absolute root differs from the daemon's
// checkout (a container image rooted at `/app`, a relocated clone) — the
// leftover relPath still carries the unanchored leading segments
// (`app/src/foo.ts`, `Users/me/repo/src/foo.ts`) and forks a parallel FileNode
// keyed off the absolute path. That splits the graph: the OBSERVED layer never
// lands on the EXTRACTED `src/foo.ts` node, and divergence/traversal see two
// half-graphs for one file.
//
// The extractor's FileNode paths are ground truth for which service-relative
// paths exist. Recover the right one by matching the longest EXTRACTED (non-
// OTel) FileNode path that is a trailing segment-suffix of the runtime relPath.
// A match means the runtime path is the same file the extractor parsed, just
// carrying extra leading directories the anchor couldn't strip — reuse the
// extractor's path so both layers key the same node. No match means the file is
// genuinely OTel-only; the honest runtime path stands (never fabricated, §6).
export function reconcileObservedRelPath(
  graph: NeatGraph,
  serviceName: string,
  relPath: string,
): string {
  // Already lands on a known node (the anchor resolved cleanly, or a prior span
  // created this node) — fused, nothing to recover.
  if (graph.hasNode(fileId(serviceName, relPath))) return relPath
  let best: string | null = null
  graph.forEachNode((_id, attrs) => {
    const a = attrs as FileNode & { type?: string }
    if (a.type !== NodeType.FileNode || a.service !== serviceName) return
    // Only fuse onto a statically-known file. An existing OTel-only node would
    // already have matched the hasNode short-circuit above.
    if (a.discoveredVia === 'otel') return
    const p = a.path
    if (!p) return
    if ((relPath === p || relPath.endsWith(`/${p}`)) && (!best || p.length > best.length)) {
      best = p
    }
  })
  return best ?? relPath
}

// Ensure the FileNode for an observed call site and the owning service's
// OBSERVED `CONTAINS` edge both exist, returning the FileNode id so the caller
// can originate the relationship from it (file-awareness.md §1–2 + §4). The
// CONTAINS edge carries no `lastObserved` — structural ownership doesn't go
// STALE when traffic quiets (markStaleEdges skips edges without lastObserved),
// and divergence detection skips CONTAINS so an OTel-only file node doesn't
// surface as a missing-extracted finding.
export function ensureObservedFileNode(
  graph: NeatGraph,
  serviceName: string,
  serviceNodeId: string,
  callSite: CallSite,
): string {
  // Key the file node on the service the span already FUSED onto, not the raw
  // span service.name. ensureServiceNode resolves a differently-cased or
  // env-tagged OTEL_SERVICE_NAME onto the extracted service (`proofrun` → the
  // ServiceNode named `ProofRun`, #880). Keying the file on the raw name here
  // forks a `file:proofrun:…` twin off the extracted `file:ProofRun:…` — the
  // file-level sibling of #880. Reading the canonical name back off the fused
  // service node also lets reconcileObservedRelPath recover the extractor's
  // relative path from a runtime absolute path: its file scan filters by an
  // exact-cased `service`, so the raw name skipped every extracted file before
  // the suffix match could run. Both forks — case and absolute path — close here.
  const svcAttrs = graph.hasNode(serviceNodeId) ? (graph.getNodeAttributes(serviceNodeId) as ServiceNode) : undefined
  const canonicalService =
    svcAttrs && svcAttrs.type === NodeType.ServiceNode && typeof svcAttrs.name === 'string'
      ? svcAttrs.name
      : serviceName
  const relPath = reconcileObservedRelPath(graph, canonicalService, callSite.relPath)
  const fileNodeId = fileId(canonicalService, relPath)
  if (!graph.hasNode(fileNodeId)) {
    const language = languageForExt(relPath)
    const node: FileNode = {
      id: fileNodeId,
      type: NodeType.FileNode,
      service: canonicalService,
      path: relPath,
      ...(language ? { language } : {}),
      ...(callSite.originalRelPath ? { originalPath: callSite.originalRelPath } : {}),
      discoveredVia: 'otel',
    }
    graph.addNode(fileNodeId, node)
  }
  const containsId = makeObservedEdgeId(EdgeType.CONTAINS, serviceNodeId, fileNodeId)
  if (!graph.hasEdge(containsId)) {
    const edge: GraphEdge = {
      id: containsId,
      source: serviceNodeId,
      target: fileNodeId,
      type: EdgeType.CONTAINS,
      provenance: Provenance.OBSERVED,
    }
    graph.addEdgeWithKey(containsId, serviceNodeId, fileNodeId, edge)
  }
  // Observed-first edges land one grain finer than the file when the call site
  // falls inside a symbol's definition span (ADR-158, file-awareness.md §4).
  return landObservedSymbol(graph, fileNodeId, canonicalService, relPath, callSite)
}

// The terminal name of a source-declared qualname (`OrderService.create` →
// `create`) — what `code.function` carries on a span, and the tiebreaker that
// picks the intended symbol when nested definition spans both contain the line.
export function terminalName(qualname: string): string {
  const dot = qualname.lastIndexOf('.')
  return dot === -1 ? qualname : qualname.slice(dot + 1)
}

// Given the symbols whose definition span contains the observed `code.line`,
// pick the one the edge lands on. Line-in-span is primary (every candidate
// already contains the line); `code.function` is the tiebreaker and drift check —
// when it names one of the candidates, that symbol wins; otherwise the innermost
// (smallest) span wins, since a call site inside nested definitions belongs to
// the tightest one enclosing it (ADR-158 point 4).
export function pickContainingSymbol(
  candidates: { id: string; symbol: SymbolNode }[],
  fn: string | undefined,
): string {
  const bySpan = (a: { symbol: SymbolNode }, b: { symbol: SymbolNode }): number => {
    const sizeA = a.symbol.span.endLine - a.symbol.span.startLine
    const sizeB = b.symbol.span.endLine - b.symbol.span.startLine
    if (sizeA !== sizeB) return sizeA - sizeB
    // Deterministic tiebreak on an exact-size tie: the later-starting span is the
    // more deeply nested one.
    return b.symbol.span.startLine - a.symbol.span.startLine
  }
  if (fn) {
    const named = candidates.filter((c) => terminalName(c.symbol.qualname) === fn)
    if (named.length > 0) return [...named].sort(bySpan)[0]!.id
  }
  return [...candidates].sort(bySpan)[0]!.id
}

// Mint the OBSERVED symbol a runtime call landed on that static never produced —
// the symbol-grain missing-extracted signal (ADR-158 point 5, lifecycle.md
// auto-create-and-merge). `code.function` names it, so the symbol is honest, not
// guessed; the span is the single observed line NEAT can vouch for, and static
// fields override it on the next extract pass if the definition later resolves.
// The file owns it through an OBSERVED `file ──CONTAINS──▶ symbol` edge.
export function ensureObservedSymbolNode(
  graph: NeatGraph,
  fileNodeId: string,
  service: string,
  relPath: string,
  fn: string,
  line: number,
): string {
  const sid = symbolId(service, relPath, fn)
  if (!graph.hasNode(sid)) {
    const node: SymbolNode = {
      id: sid,
      type: NodeType.SymbolNode,
      kind: 'function',
      qualname: fn,
      span: { startLine: line, endLine: line },
      service,
      relPath,
      discoveredVia: 'otel',
    }
    graph.addNode(sid, node)
  }
  const containsId = makeObservedEdgeId(EdgeType.CONTAINS, fileNodeId, sid)
  if (!graph.hasEdge(containsId)) {
    const edge: GraphEdge = {
      id: containsId,
      source: fileNodeId,
      target: sid,
      type: EdgeType.CONTAINS,
      provenance: Provenance.OBSERVED,
    }
    graph.addEdgeWithKey(containsId, fileNodeId, sid, edge)
  }
  return sid
}

// Resolve the observed edge's origin to a symbol under the file when the call
// site's line falls inside a symbol's definition span; otherwise land on the file
// (ADR-158, file-awareness.md §4–§5). Boundary-grained, not a full call graph:
// the returned node is what the edge originates from.
//
// Degrade to the file honestly when there is no line, or the line is inside no
// symbol span and either the file was never symbol-extracted (no symbols to be
// "missing" from) or the span carries no function name. When the file *was*
// symbol-extracted, the line is in no static symbol, and `code.function` names
// the executing function, mint an `otel` symbol — the missing-extracted signal at
// symbol grain (point 5), never a degrade that hides the dynamic wiring.
export function landObservedSymbol(
  graph: NeatGraph,
  fileNodeId: string,
  service: string,
  relPath: string,
  callSite: CallSite,
  // Whether to MINT an observed-only symbol when the line is in no static symbol
  // span (the missing-extracted-at-symbol-grain signal, ADR-158 §5). The edge
  // mint path leaves it true; the incident resolver (ADR-191) passes false so it
  // reads the containing static symbol without mutating — safe at the receiver,
  // which runs before reply and off the mutation queue (otel-ingest §Non-blocking).
  mint = true,
): string {
  const line = callSite.line
  if (line === undefined) return fileNodeId

  let sawSymbol = false
  const candidates: { id: string; symbol: SymbolNode }[] = []
  graph.forEachOutboundEdge(fileNodeId, (_edge, edgeAttrs, _source, target) => {
    if (edgeAttrs.type !== EdgeType.CONTAINS) return
    const t = graph.getNodeAttributes(target) as GraphNode
    if (t.type !== NodeType.SymbolNode) return
    sawSymbol = true
    if (line >= t.span.startLine && line <= t.span.endLine) {
      candidates.push({ id: target, symbol: t })
    }
  })

  if (candidates.length > 0) return pickContainingSymbol(candidates, callSite.fn)

  if (mint && sawSymbol && callSite.fn) {
    return ensureObservedSymbolNode(graph, fileNodeId, service, relPath, callSite.fn, line)
  }
  return fileNodeId
}
