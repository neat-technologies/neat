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
export function renderComment({
  graph,
  delta,
  changedFiles = [],
  divergences = [],
  connected = false,
}) {
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

  if (divergences.length) {
    L.push('', '**Divergence (declared vs observed)** — from the connected NEAT host')
    for (const d of divergences) L.push('- ' + d)
  }

  L.push(
    '',
    connected
      ? '> _Weighted against production traffic (OBSERVED) via the connected NEAT host._'
      : '> _Static graph (EXTRACTED) only — this run cannot see production. Without the OBSERVED layer the Action has no way to know whether anything here is called in prod, so it does not flag observed breaks. Point `neat-api-url` at a connected NEAT host to weight this by production traffic (OBSERVED), flag declared-vs-observed divergence, and get observed-break detection._',
  )
  return { marker: MARKER, body: L.join('\n') }
}

// The set of nodes this PR removes or changes — the surface the observed-break
// scan runs against. "Removed" is the classic break (present in base, gone in
// head); "changed" is a same-id node whose attributes moved under it (a route
// whose handler changed, a table whose columns shifted). Each carries the id the
// host's /graph/observed-dependencies endpoint is keyed on, plus a label/type for
// rendering. Bounded so a huge PR can't fan out into hundreds of host calls.
const stable = (obj) =>
  JSON.stringify(obj, Object.keys(obj ?? {}).sort())

export function changedNodesForObservedScan(base, head, { limit = 25 } = {}) {
  const out = []
  for (const [key, attrs] of base.nodes) {
    if (!head.nodes.has(key)) {
      out.push({ id: key, type: attrs.type, label: attrs.name ?? shortId(key), change: 'removed' })
    }
  }
  for (const [key, attrs] of head.nodes) {
    const b = base.nodes.get(key)
    if (b && stable(b) !== stable(attrs)) {
      out.push({ id: key, type: attrs.type, label: attrs.name ?? shortId(key), change: 'changed' })
    }
  }
  return out.slice(0, limit)
}

const plural = (n) => (n === 1 ? '' : 's')

// The fusion/freshness footnote. We state the provenance we actually have —
// EXTRACTED static graph fused with OBSERVED traffic from the connected host —
// and never invent a "last seen 14m ago" timestamp the host doesn't hand us.
const FUSION_NOTE =
  '<sub>Fused view — the static graph (EXTRACTED) weighted against production traffic (OBSERVED) from the connected NEAT host. Observed-break checks ran live against that host.</sub>'

const TONE_COPY = {
  loud: {
    green: '## ✅ NEAT — all clear',
    yellow: '## ⚠️ NEAT — a few minor problems',
    red: '## 🛑 NEAT — FUCK NO. Here are the problems:',
  },
  professional: {
    green: '## ✅ NEAT — all clear',
    yellow: '## ⚠️ NEAT — Minor issues to review',
    red: '## 🛑 NEAT — Critical: production will break',
  },
}

// One observed break → its ranked one-liner and its detail line. `dependentCount`
// is the host's inboundObservedCount (OBSERVED callers of the node); `callCount`
// is the number of OBSERVED outbound edges it makes. The host response carries
// neither a request volume nor a timestamp, so we render honest counts of
// observed dependents — never a fabricated "served N× in 7d" or "last seen 14m
// ago." If the shape ever grows those fields, this is where they'd surface.
function breakHeadline(b) {
  const verb = b.change === 'removed' ? 'deletes' : 'changes'
  const what = fence(b.label) + (b.type === 'InfraNode' ? ' (data store)' : '')
  if (b.dependentCount > 0) {
    const consequence =
      b.type === 'RouteNode'
        ? 'Live callers 404.'
        : b.type === 'InfraNode'
          ? 'Live readers and writers fail.'
          : 'Live callers break.'
    return `**🔴 Production will break** — this PR ${verb} ${what}, ${b.dependentCount} observed dependent${plural(b.dependentCount)} (OBSERVED). ${consequence}`
  }
  return `**🔴 Production will break** — this PR ${verb} ${what}, seen live in production making ${b.callCount} observed call${plural(b.callCount)} (OBSERVED). Runtime behavior changes.`
}

function breakDetail(b) {
  return (
    '- ' +
    fence(shortId(b.id)) +
    ` — ${b.change} ${b.type ?? 'node'}; ` +
    `${b.dependentCount} observed inbound dependent${plural(b.dependentCount)}, ` +
    `${b.callCount} observed outbound call${plural(b.callCount)}. ` +
    'Provenance: OBSERVED (live traffic on the connected host).'
  )
}

// Verdict-first report for the connected (fused) tier. The severity model:
//   🛑 RED    — one or more observed breaks (prod calls something this PR removes/changes)
//   ⚠️ YELLOW — divergences, or removed routes/tables (static blast-radius risk), no break
//   ✅ GREEN   — nothing observed is touched and no new divergence
// `observedBreaks` come from the host's /graph/observed-dependencies scan (see
// main.mjs). `divergences` are the pre-formatted strings from /graph/divergences.
// The Sniper dispatch and full-graph-diff links render only when their URLs are
// supplied — the Action points at those seams, it does not drive them.
export function renderVerdict({
  graph,
  delta,
  changedFiles = [],
  divergences = [],
  observedBreaks = [],
  tone = 'loud',
  sniperDispatchUrl = '',
  graphDiffUrl = '',
}) {
  const copy = TONE_COPY[tone] ?? TONE_COPY.loud

  // Dedupe: a removed route/table that is an observed break is a 🔴 finding, so
  // don't also list it as a 🟠 static "removed reference."
  const brokenRoutes = new Set(
    observedBreaks.filter((b) => b.type === 'RouteNode').map((b) => b.label),
  )
  const brokenTables = new Set(
    observedBreaks.filter((b) => b.type === 'InfraNode').map((b) => b.label),
  )
  const staticConcerns = []
  for (const r of delta.routesRemoved ?? []) {
    if (brokenRoutes.has(r)) continue
    staticConcerns.push({
      headline: `**🟠 Removed route** — ${fence(r)} no longer exists; confirm nothing in-repo still calls it.`,
      detail: `- Route ${fence(r)} removed. The connected host observed no production traffic on it — static-only concern.`,
    })
  }
  for (const t of delta.tablesRemoved ?? []) {
    if (brokenTables.has(t)) continue
    staticConcerns.push({
      headline: `**🟠 Removed reference** — ${fence(t)} no longer exists; confirm nothing in-repo still reads it.`,
      detail: `- Table/infra ${fence(t)} removed. The connected host observed no production traffic on it — static-only concern.`,
    })
  }

  // Ranked findings: observed breaks first (🔴), then divergences (🟠), then
  // static concerns (🟠).
  const findings = [
    ...observedBreaks.map((b) => ({ headline: breakHeadline(b), detail: breakDetail(b) })),
    ...divergences.map((d) => ({
      headline: `**🟠 Divergence** — ${d}`,
      detail: `- ${d}`,
    })),
    ...staticConcerns,
  ]

  const tier =
    observedBreaks.length > 0 ? 'red' : findings.length > 0 ? 'yellow' : 'green'

  const actionLinks = []
  if (sniperDispatchUrl)
    actionLinks.push(`**[⚡ Dispatch Sniper to fix these →](${sniperDispatchUrl})**`)
  if (graphDiffUrl) actionLinks.push(`[Full graph diff →](${graphDiffUrl})`)

  const L = [MARKER, '']

  if (tier === 'green') {
    L.push(
      copy.green,
      '',
      'Nothing this PR touches is observed in production, and it introduces no new divergences.',
      '',
      FUSION_NOTE,
    )
    return { marker: MARKER, body: L.join('\n'), tier }
  }

  if (tier === 'yellow') {
    L.push(
      copy.yellow,
      '',
      `${findings.length} minor problem${plural(findings.length)} — read ${findings.length === 1 ? 'it' : 'them'} below.`,
      '',
      '<details><summary>Read them →</summary>',
      '',
    )
    findings.forEach((f, i) => L.push(`${i + 1}. ${f.headline}`))
    L.push('', ...findings.map((f) => f.detail))
    L.push('', '</details>')
    if (actionLinks.length) L.push('', ...actionLinks)
    L.push('', FUSION_NOTE)
    return { marker: MARKER, body: L.join('\n'), tier }
  }

  // red
  L.push(copy.red, '')
  findings.forEach((f, i) => L.push(`${i + 1}. ${f.headline}`))
  L.push('', '<details><summary>Full detail →</summary>', '')
  L.push(...findings.map((f) => f.detail))

  // Fold the raw graph delta and in-repo blast radius into the detail block so
  // the structural context isn't lost under the verdict.
  const anyDelta =
    (delta.routesAdded?.length ?? 0) +
    (delta.routesRemoved?.length ?? 0) +
    (delta.tablesAdded?.length ?? 0) +
    (delta.tablesRemoved?.length ?? 0)
  if (anyDelta) {
    L.push('', '**Graph delta**')
    if (delta.routesAdded?.length) L.push('- ➕ routes: ' + delta.routesAdded.map(fence).join(', '))
    if (delta.routesRemoved?.length)
      L.push('- ➖ routes: ' + delta.routesRemoved.map(fence).join(', '))
    if (delta.tablesAdded?.length) L.push('- ➕ tables: ' + delta.tablesAdded.map(fence).join(', '))
    if (delta.tablesRemoved?.length)
      L.push('- ➖ tables: ' + delta.tablesRemoved.map(fence).join(', '))
  }
  const filesInGraph = (changedFiles ?? []).filter((f) => graph?.nodes?.has(f))
  if (filesInGraph.length) {
    L.push('', '**Blast radius (in-repo)**')
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
  L.push('', '</details>')
  if (actionLinks.length) L.push('', ...actionLinks)
  L.push('', FUSION_NOTE)
  return { marker: MARKER, body: L.join('\n'), tier }
}
