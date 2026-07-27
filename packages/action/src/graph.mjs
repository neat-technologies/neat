// Pure graph logic for the NEAT PR action — no dependencies, so it runs and
// tests with plain Node. Given two NEAT `graph.json` snapshots (a PR's base and
// head), it computes what the graph gained/lost and the blast radius of the
// changed files, and renders the sticky PR comment.

import { readFileSync } from 'node:fs'

export const MARKER = '<!-- neat-action:graph-impact -->'

const shortId = (id) => String(id).split(':').slice(-1)[0]
const fence = (s) => '`' + s + '`'

// Load a NEAT snapshot (graph.json). Nodes/edges live under `.graph` (graphology
// export); tolerate a flat shape too.
export function loadGraph(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const g = raw.graph ?? raw
  const nodes = new Map((g.nodes ?? []).map((n) => [n.key, n.attributes ?? {}]))
  const edges = (g.edges ?? []).map((e) => ({
    key: e.key,
    source: e.source,
    target: e.target,
    ...(e.attributes ?? {}),
  }))
  return { nodes, edges }
}

const namesByType = (entries, type) =>
  entries.filter(([, a]) => a.type === type).map(([k, a]) => a.name ?? shortId(k))

// The route/table delta between base and head, keyed on node id.
export function diffGraphs(base, head) {
  const added = [...head.nodes].filter(([k]) => !base.nodes.has(k))
  const removed = [...base.nodes].filter(([k]) => !head.nodes.has(k))
  return {
    routesAdded: namesByType(added, 'RouteNode'),
    routesRemoved: namesByType(removed, 'RouteNode'),
    tablesAdded: namesByType(added, 'InfraNode'),
    tablesRemoved: namesByType(removed, 'InfraNode'),
  }
}

// Transitive inbound dependents of a node — everything that would be affected if
// it changed. Follows edges *into* the node (an importer, or the owning service),
// bounded by depth. Mirrors the direction NEAT's getBlastRadius walks; the
// production action calls the engine's getBlastRadius, this is the CI-local form.
export function blastRadius(graph, nodeId, maxDepth = 10) {
  const inbound = new Map()
  for (const e of graph.edges) {
    if (!inbound.has(e.target)) inbound.set(e.target, [])
    inbound.get(e.target).push({ source: e.source, type: e.type })
  }
  const seen = new Set([nodeId])
  const dependents = []
  let frontier = [nodeId]
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = []
    for (const n of frontier) {
      for (const { source } of inbound.get(n) ?? []) {
        if (seen.has(source)) continue
        seen.add(source)
        dependents.push(source)
        next.push(source)
      }
    }
    frontier = next
  }
  return dependents
}

// Render the sticky comment. `changedFiles` are FileNode ids (from git ∩ graph);
// `connected` flips the footer to the fused-tier message.
export function renderComment({ graph, delta, changedFiles = [], connected = false }) {
  const L = [MARKER, '### 🔷 NEAT — graph impact of this PR', '']

  const anyDelta =
    delta.routesAdded.length +
    delta.routesRemoved.length +
    delta.tablesAdded.length +
    delta.tablesRemoved.length
  L.push('**What changed in the graph**')
  if (delta.routesAdded.length) L.push('- ➕ routes: ' + delta.routesAdded.map(fence).join(', '))
  if (delta.routesRemoved.length) L.push('- ➖ routes: ' + delta.routesRemoved.map(fence).join(', '))
  if (delta.tablesAdded.length) L.push('- ➕ tables: ' + delta.tablesAdded.map(fence).join(', '))
  if (delta.tablesRemoved.length)
    L.push(
      '- ➖ tables: ' +
        delta.tablesRemoved.map(fence).join(', ') +
        '  ⚠️ removed reference — confirm nothing else still reads it',
    )
  if (!anyDelta) L.push('- no route/table/dependency changes detected')

  const filesInGraph = changedFiles.filter((f) => graph.nodes.has(f))
  if (filesInGraph.length) {
    L.push('', '**Blast radius**')
    for (const f of filesInGraph) {
      const deps = blastRadius(graph, f)
        .filter((d) => d.startsWith('file:'))
        .map(shortId)
      L.push(
        '- ' +
          fence(shortId(f)) +
          ' → depended on by ' +
          (deps.length ? deps.map(fence).join(', ') : '_nothing else in-repo_'),
      )
    }
  }

  L.push(
    '',
    connected
      ? '> _Weighted by production traffic (OBSERVED) via the connected NEAT host._'
      : '> _Static graph (EXTRACTED). Set `neat-api-url` to weight this by production traffic (OBSERVED) and flag declared-vs-observed divergence._',
  )
  return { marker: MARKER, body: L.join('\n') }
}
