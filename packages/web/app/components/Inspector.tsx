'use client'

import { useEffect, useMemo, useState } from 'react'
import type { GraphNode, GraphEdge } from '@neat.is/types'
import type { GraphData } from './AppShell'
import { authedFetch } from '../../lib/authed-fetch'
import { buildModel, callsFrom, importsFrom, filesOf } from './graph-model'

interface RootCauseResult {
  origin: string
  rootCauseNode: string | null
  // #809 — the live daemon emits `rootCauseReason`; the demo fixture uses
  // `reason`. Accept both so the reason line renders against a real daemon.
  reason?: string
  rootCauseReason?: string
  fixRecommendation: string | null
  confidence: number
  traversalPath: string[]
}

function visualProv(provenance: string): 'STATIC' | 'OBSERVED' | 'INFERRED' {
  if (provenance === 'OBSERVED') return 'OBSERVED'
  if (provenance === 'INFERRED') return 'INFERRED'
  return 'STATIC'
}

function nodeName(node: GraphNode): string {
  if (node.type === 'FileNode') return (node as { path?: string }).path ?? node.id
  return (node as unknown as { name?: string }).name ?? node.id
}

function nodeProps(node: GraphNode): [string, string][] {
  const props: [string, string][] = []
  const n = node as Record<string, unknown>
  if (n.language) props.push(['language', String(n.language)])
  if (n.version) props.push(['version', String(n.version)])
  if (n.engine) props.push(['engine', String(n.engine)])
  if (n.engineVersion) props.push(['engine version', String(n.engineVersion)])
  if (n.provider) props.push(['provider', String(n.provider)])
  if (n.region) props.push(['region', String(n.region)])
  if (n.kind) props.push(['kind', String(n.kind)])
  if (n.host) props.push(['host', String(n.host)])
  if (n.port) props.push(['port', String(n.port)])
  if (n.fileType) props.push(['file type', String(n.fileType)])
  if (n.firstObserved) props.push(['first seen', String(n.firstObserved)])
  if (n.lastObserved) props.push(['last seen', String(n.lastObserved)])
  return props
}

interface EdgeRow {
  verb: string
  target: string
  prov: 'STATIC' | 'OBSERVED' | 'INFERRED'
  conf?: number
}

// A node-scoped traversal result (blast-radius / dependencies), normalized to
// the fields the panel shows. Both daemon shapes carry nodeId + distance; the
// count comes from totalAffected / total, else the row count (web-shell §6 —
// these are inspector actions, not pages).
interface TraversalRow {
  nodeId: string
  distance: number
}
type TraversalMode = 'deps' | 'blast'
interface TraversalState {
  mode: TraversalMode
  rows: TraversalRow[]
  total: number
}

interface InspectorProps {
  // null until AppShell's resolution chain lands on a real project (#461).
  project: string | null
  selectedNodeId: string | null
  graphData: GraphData | null
  onNodeSelect: (id: string) => void
  // Highlight a BFS set on the canvas (web-shell §6 — the node-scoped query
  // focuses the canvas rather than navigating to a page). Optional so the
  // Inspector still renders in isolation (tests, storybook).
  onFocusNodes?: (ids: string[]) => void
}

export function Inspector({ project, selectedNodeId, graphData, onNodeSelect, onFocusNodes }: InspectorProps) {
  const [node, setNode] = useState<GraphNode | null>(null)
  const [rootCause, setRootCause] = useState<RootCauseResult | null>(null)
  const [activeTab, setActiveTab] = useState<'inspect' | 'edges' | 'owners' | 'history'>('inspect')
  // Node-scoped traversal (blast-radius / dependencies) — run on demand.
  const [traversal, setTraversal] = useState<TraversalState | null>(null)
  const [traversalLoading, setTraversalLoading] = useState<TraversalMode | null>(null)

  // ADR-057 #3 — re-fetch when project or selection changes. Idle until a
  // project resolves (#461); nothing can be selected without a graph anyway.
  useEffect(() => {
    if (!selectedNodeId || !project) {
      setNode(null)
      setRootCause(null)
      return
    }
    const proj = `?project=${encodeURIComponent(project)}`
    authedFetch(`/api/graph/node/${encodeURIComponent(selectedNodeId)}${proj}`)
      .then((r) => r.json())
      .then((d: { node: GraphNode }) => setNode(d.node))
      .catch(() => {})

    authedFetch(`/api/graph/root-cause/${encodeURIComponent(selectedNodeId)}${proj}`)
      .then((r) => r.json())
      .then((d: RootCauseResult) => setRootCause(d.rootCauseNode ? d : null))
      .catch(() => {})
  }, [selectedNodeId, project])

  // Clear any run traversal when the selection (or project) changes — the
  // blast-radius / dependency set belongs to the previously-selected node.
  useEffect(() => {
    setTraversal(null)
    setTraversalLoading(null)
  }, [selectedNodeId, project])

  // Run the node-scoped query on demand (web-shell §6 — an inspector action, not
  // a page). `blast` = what depends on this, transitively; `deps` = what this
  // depends on. Both daemon shapes carry nodeId + distance; normalize and count.
  const runTraversal = (mode: TraversalMode) => {
    if (!selectedNodeId || !project) return
    setTraversalLoading(mode)
    const proj = `?project=${encodeURIComponent(project)}`
    const path =
      mode === 'blast'
        ? `/api/graph/blast-radius/${encodeURIComponent(selectedNodeId)}${proj}`
        : `/api/graph/dependencies/${encodeURIComponent(selectedNodeId)}${proj}`
    authedFetch(path)
      .then((r) => r.json())
      .then((d: Record<string, unknown>) => {
        const list = (mode === 'blast' ? d.affectedNodes : d.dependencies) as
          | { nodeId: string; distance?: number }[]
          | undefined
        const rows: TraversalRow[] = Array.isArray(list)
          ? list.map((x) => ({ nodeId: x.nodeId, distance: x.distance ?? 1 }))
          : []
        const total =
          typeof d.totalAffected === 'number'
            ? d.totalAffected
            : typeof d.total === 'number'
              ? d.total
              : rows.length
        setTraversal({ mode, rows, total })
        setTraversalLoading(null)
      })
      .catch(() => setTraversalLoading(null))
  }

  // file-first model off the full graph, for file→target detail and the
  // service→files view. Memoized so it's not rebuilt on every render.
  const model = useMemo(
    () => (graphData ? buildModel(graphData.nodes, graphData.edges) : null),
    [graphData],
  )

  if (!selectedNodeId || !node) {
    return (
      <aside className="inspect" id="inspect">
        <div className="inspect-tabs" role="tablist">
          <button type="button" className="inspect-tab on" role="tab" aria-selected={true}>Inspect</button>
          <button type="button" className="inspect-tab" role="tab" aria-selected={false}>Edges</button>
          {/* ADR-056 — Owners deferred: explicit disabled affordance. */}
          <button type="button" className="inspect-tab disabled" role="tab" aria-selected={false} disabled title="Owners — coming in v0.3.x" style={{ opacity: 0.4, cursor: 'not-allowed' }}>Owners</button>
          {/* ADR-056 — History deferred: explicit disabled affordance. */}
          <button type="button" className="inspect-tab disabled" role="tab" aria-selected={false} disabled title="History — coming in v0.3.x" style={{ opacity: 0.4, cursor: 'not-allowed' }}>History</button>
        </div>
        <div className="insp-section" style={{ paddingTop: 40 }}>
          <div style={{ fontFamily: 'var(--font-body)', fontStyle: 'italic', color: 'var(--fg-muted)', textAlign: 'center', fontSize: '1rem' }}>
            select a node to inspect
          </div>
        </div>
      </aside>
    )
  }

  const isFile = node.type === 'FileNode'
  const isService = node.type === 'ServiceNode'

  // FileNode: the runtime calls originating from it, file-grained, with evidence.
  const originating = isFile && graphData && model
    ? callsFrom(node.id, graphData.edges, model.byId)
    : []
  // FileNode: the static module imports originating from it (file-awareness §10
  // — IMPORTS is distinct from CALLS, surfaced in its own section).
  const imports = isFile && graphData && model
    ? importsFrom(node.id, graphData.edges, model.byId)
    : []
  // FileNode: its owning service via the inbound CONTAINS edge.
  const owningServiceId = isFile && model ? model.serviceByFile.get(node.id) : undefined
  const owningService = owningServiceId && model ? model.byId.get(owningServiceId) : undefined
  // ServiceNode: the files it CONTAINS.
  const serviceFiles = isService && model ? filesOf(node.id, model) : []

  // Generic edge rows (for the Edges tab + the incoming list).
  const outEdges: EdgeRow[] = graphData
    ? graphData.edges
        .filter((e: GraphEdge) => e.source === node.id && e.type !== 'CONTAINS')
        .map((e: GraphEdge) => {
          const targetNode = graphData.nodes.find((n: GraphNode) => n.id === e.target)
          return { verb: e.type.toLowerCase().replace(/_/g, ' '), target: targetNode ? nodeName(targetNode) : e.target, prov: visualProv(e.provenance), conf: e.confidence }
        })
    : []
  const inEdges: EdgeRow[] = graphData
    ? graphData.edges
        .filter((e: GraphEdge) => e.target === node.id && e.type !== 'CONTAINS')
        .map((e: GraphEdge) => {
          const srcNode = graphData.nodes.find((n: GraphNode) => n.id === e.source)
          return { verb: e.type.toLowerCase().replace(/_/g, ' '), target: srcNode ? nodeName(srcNode) : e.source, prov: visualProv(e.provenance), conf: e.confidence }
        })
    : []
  const allEdges = [...outEdges, ...inEdges]
  const edgeCount = allEdges.length

  const props = nodeProps(node)
  const name = nodeName(node)
  const labelParts = name.split('/')
  const stem = labelParts.length > 1 ? labelParts.slice(0, -1).join('/') + '/' : ''
  const rest = labelParts.length > 1 ? labelParts[labelParts.length - 1] : name

  const provCounts: Record<string, number> = { STATIC: 0, OBSERVED: 0, INFERRED: 0 }
  allEdges.forEach((e) => { provCounts[e.prov] = (provCounts[e.prov] ?? 0) + 1 })
  const total = allEdges.length || 1

  const typeLabel = node.type.replace('Node', '').toUpperCase()
  const showMetrics = !['ConfigNode', 'FrontierNode', 'FileNode'].includes(node.type)
  const owner = (node as unknown as { owner?: string }).owner

  // Metrics derived from incident OBSERVED edges (#357), honest "—" otherwise.
  let observedSpans = 0
  let observedErrors = 0
  if (graphData) {
    for (const e of graphData.edges) {
      if (e.provenance !== 'OBSERVED') continue
      if (e.source !== node.id && e.target !== node.id) continue
      const signal = (e as { signal?: { spanCount?: number; errorCount?: number } }).signal
      observedSpans += signal?.spanCount ?? 0
      observedErrors += signal?.errorCount ?? 0
    }
  }
  const hasObservedSignal = observedSpans > 0
  const rpsDisplay = hasObservedSignal ? observedSpans.toLocaleString() : '—'
  const errDisplay = hasObservedSignal ? ((observedErrors / observedSpans) * 100).toFixed(2) : '—'
  const errBad = hasObservedSignal && observedErrors / observedSpans > 0.04

  return (
    <aside className="inspect" id="inspect">
      <div className="inspect-tabs" role="tablist">
        <button type="button" className={`inspect-tab${activeTab === 'inspect' ? ' on' : ''}`} role="tab" aria-selected={activeTab === 'inspect'} aria-controls="inspect-body" onClick={() => setActiveTab('inspect')}>Inspect</button>
        <button type="button" className={`inspect-tab${activeTab === 'edges' ? ' on' : ''}`} role="tab" aria-selected={activeTab === 'edges'} aria-controls="inspect-body" onClick={() => setActiveTab('edges')}>Edges<span className="ct">{edgeCount}</span></button>
        {/* ADR-056 — Owners wired: shows ServiceNode.owner when available (ADR-054). */}
        <button type="button" className={`inspect-tab${activeTab === 'owners' ? ' on' : ''}`} role="tab" aria-selected={activeTab === 'owners'} aria-controls="inspect-body" onClick={() => setActiveTab('owners')}>Owners</button>
        {/* ADR-056 — History deferred: explicit disabled affordance. */}
        <button type="button" className="inspect-tab disabled" role="tab" aria-selected={false} disabled title="History — coming in v0.3.x" style={{ opacity: 0.4, cursor: 'not-allowed' }}>History</button>
      </div>

      <div id="inspect-body">
        {activeTab === 'inspect' && (
          <>
            <section className="insp-section">
              <div className="insp-eyebrow">{typeLabel}</div>
              <div className="insp-title">
                {stem && <span className="stem">{stem}</span>}
                {rest}
              </div>
              <div className="insp-sub">{node.id}</div>
              <div className="insp-tags">
                {(node as { language?: string }).language && <span className="tag">{(node as { language: string }).language}</span>}
                {(node as { engine?: string }).engine && <span className="tag">{(node as { engine: string }).engine}</span>}
                {(node as { kind?: string }).kind && <span className="tag">{(node as { kind: string }).kind}</span>}
                {!isFile && props.length === 0 && <span className="tag">{typeLabel.toLowerCase()}</span>}
              </div>
            </section>

            {/* FileNode — owning service (file-awareness §2). Clickable: drills
                into the service so the file's siblings come into view. */}
            {isFile && owningService && (
              <section className="insp-section">
                <div className="insp-h">Owning service</div>
                <button
                  className="owning-service"
                  onClick={() => { onNodeSelect(owningService.id) }}
                  title="Open this service's files"
                >
                  <svg className="glyph" viewBox="0 0 12 12" aria-hidden="true">
                    <polygon points="6,0.5 11,3.25 11,8.75 6,11.5 1,8.75 1,3.25" strokeLinejoin="round" />
                  </svg>
                  <span className="svc-name">{(owningService as { name?: string }).name ?? owningService.id}</span>
                </button>
              </section>
            )}

            {/* FileNode — the calls originating from this file, file-grained,
                each with provenance + evidence file:line (file-awareness §1/§6). */}
            {isFile && (
              <section className="insp-section">
                <div className="insp-h">Calls from this file <span className="ct">{originating.length}</span></div>
                <ul className="edge-list">
                  {originating.length ? originating.map((c) => (
                    <li key={c.edgeId} style={{ flexWrap: 'wrap', borderBottom: 'none' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
                        <span className={`pdot ${visualProv(c.provenance)}`} />
                        <span className="verb">{visualProv(c.provenance).toLowerCase()}</span>
                        <button
                          type="button"
                          className="target clickable"
                          onClick={() => onNodeSelect(c.targetId)}
                          title={`Select ${c.targetName}`}
                        >{c.targetName}</button>
                        <span className="conf">{typeof c.confidence === 'number' ? c.confidence.toFixed(2) : '—'}</span>
                      </span>
                      {c.evidenceFile && (
                        <span className="edge-evidence" style={{ width: '100%' }}>
                          {c.evidenceFile}{typeof c.evidenceLine === 'number' ? `:${c.evidenceLine}` : ''}
                        </span>
                      )}
                    </li>
                  )) : (
                    <li style={{ borderBottom: 'none' }}><span style={{ color: 'var(--fg-muted)', fontStyle: 'italic', fontFamily: 'var(--font-body)' }}>no calls originate from this file</span></li>
                  )}
                </ul>
              </section>
            )}

            {/* FileNode — the static module imports originating from this file,
                file-grained, each with provenance + evidence file:line. Kept
                separate from "Calls from this file": IMPORTS is a compile-time
                module dependency, not a runtime invocation (file-awareness §10). */}
            {isFile && (
              <section className="insp-section">
                <div className="insp-h">Imports <span className="ct">{imports.length}</span></div>
                <ul className="edge-list">
                  {imports.length ? imports.map((c) => (
                    <li key={c.edgeId} style={{ flexWrap: 'wrap', borderBottom: 'none' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
                        <span className={`pdot ${visualProv(c.provenance)}`} />
                        <span className="verb">{visualProv(c.provenance).toLowerCase()}</span>
                        <button
                          type="button"
                          className="target clickable"
                          onClick={() => onNodeSelect(c.targetId)}
                          title={`Select ${c.targetName}`}
                        >{c.targetName}</button>
                        <span className="conf">{typeof c.confidence === 'number' ? c.confidence.toFixed(2) : '—'}</span>
                      </span>
                      {c.evidenceFile && (
                        <span className="edge-evidence" style={{ width: '100%' }}>
                          {c.evidenceFile}{typeof c.evidenceLine === 'number' ? `:${c.evidenceLine}` : ''}
                        </span>
                      )}
                    </li>
                  )) : (
                    <li style={{ borderBottom: 'none' }}><span style={{ color: 'var(--fg-muted)', fontStyle: 'italic', fontFamily: 'var(--font-body)' }}>no imports originate from this file</span></li>
                  )}
                </ul>
              </section>
            )}

            {/* ServiceNode — the files it CONTAINS (file-awareness §2).
                Clicking a file drills the canvas open and selects it. */}
            {isService && (
              <section className="insp-section">
                <div className="insp-h">Files <span className="ct">{serviceFiles.length}</span></div>
                <ul className="file-list">
                  {serviceFiles.length ? serviceFiles.map((f) => (
                    <li key={f.id}>
                      <button
                        type="button"
                        className="file-row"
                        onClick={() => { onNodeSelect(f.id) }}
                        title={(f as { path?: string }).path}
                      >
                        <svg className="fglyph" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" /></svg>
                        <span className="fpath">{(f as { path?: string }).path ?? f.id}</span>
                      </button>
                    </li>
                  )) : (
                    <li style={{ cursor: 'default' }}><span className="fpath" style={{ color: 'var(--fg-muted)', fontStyle: 'italic', fontFamily: 'var(--font-body)' }}>no files attributed to this service</span></li>
                  )}
                </ul>
              </section>
            )}

            {showMetrics && (
              <section className="insp-section">
                <div className="metrics">
                  <div className="metric"><div className="lbl">spans</div><div className="val">{rpsDisplay}</div></div>
                  <div className="metric"><div className="lbl">p99 ms</div><div className="val">—</div></div>
                  <div className="metric"><div className="lbl">err %</div><div className={`val${errBad ? ' bad' : ''}`}>{errDisplay}</div></div>
                </div>
                {!hasObservedSignal && (
                  <div className="insp-sub" style={{ marginTop: 12, fontStyle: 'italic', fontFamily: 'var(--font-body)' }}>
                    no observed signal — drive traffic to populate
                  </div>
                )}
              </section>
            )}

            {/* Node-scoped queries: blast radius (what depends on this,
                transitively) + dependencies (what this depends on). These are
                inspector actions that focus the canvas — never a page
                (web-shell §6). Run on demand. */}
            <section className="insp-section">
              <div className="insp-h">Impact</div>
              <div className="traversal-actions">
                <button
                  type="button"
                  className={`traversal-btn${traversal?.mode === 'blast' ? ' on' : ''}`}
                  onClick={() => runTraversal('blast')}
                  disabled={traversalLoading !== null}
                >
                  {traversalLoading === 'blast' ? 'computing…' : 'Blast radius'}
                </button>
                <button
                  type="button"
                  className={`traversal-btn${traversal?.mode === 'deps' ? ' on' : ''}`}
                  onClick={() => runTraversal('deps')}
                  disabled={traversalLoading !== null}
                >
                  {traversalLoading === 'deps' ? 'computing…' : 'Dependencies'}
                </button>
              </div>
              <div className="traversal-hint">
                {traversal
                  ? traversal.mode === 'blast'
                    ? 'what breaks if this changes — transitively'
                    : 'what this depends on — transitively'
                  : 'trace this node’s reach across the graph'}
              </div>
              {traversal &&
                (traversal.rows.length === 0 ? (
                  <div className="insp-sub" style={{ fontStyle: 'italic', fontFamily: 'var(--font-body)', marginTop: 8 }}>
                    {traversal.mode === 'blast' ? 'nothing depends on this node' : 'this node depends on nothing'}
                  </div>
                ) : (
                  <>
                    <div className="traversal-summary">
                      <span>
                        {traversal.total} {traversal.mode === 'blast' ? 'affected' : 'dependencies'}
                      </span>
                      {onFocusNodes && (
                        <button
                          type="button"
                          className="traversal-highlight"
                          onClick={() => onFocusNodes(traversal.rows.map((r) => r.nodeId))}
                        >
                          highlight on graph
                        </button>
                      )}
                    </div>
                    <ul className="edge-list">
                      {traversal.rows.slice(0, 40).map((r) => (
                        <li key={r.nodeId}>
                          <span className="verb">{r.distance} hop{r.distance === 1 ? '' : 's'}</span>
                          <button
                            type="button"
                            className="target clickable"
                            onClick={() => onNodeSelect(r.nodeId)}
                            title={`Select ${r.nodeId}`}
                          >
                            {r.nodeId}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                ))}
            </section>

            {rootCause && (
              <section className="insp-section">
                <div className="insp-h">Root cause</div>
                <div className="root-cause-block">
                  <div className="rc-label">divergence detected</div>
                  <div className="rc-node">{rootCause.rootCauseNode ?? ''}</div>
                  <div className="rc-reason">{rootCause.reason ?? rootCause.rootCauseReason ?? ''}</div>
                  {rootCause.fixRecommendation && <div className="rc-fix">{rootCause.fixRecommendation}</div>}
                </div>
              </section>
            )}

            {props.length > 0 && (
              <section className="insp-section">
                <div className="insp-h">Properties <span className="ct">{props.length}</span></div>
                <dl className="kv">
                  {props.map(([k, v]) => (
                    <div key={k} style={{ display: 'contents' }}>
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            {/* Incoming relationships — kept for non-file nodes; for files the
                originating-calls block above is the file-grained surface. */}
            {!isFile && (
              <section className="insp-section">
                <div className="insp-h">Incoming <span className="ct">{inEdges.length}</span></div>
                <ul className="edge-list">
                  {inEdges.length ? inEdges.map((e, i) => (
                    <li key={i}>
                      <span className={`pdot ${e.prov}`} />
                      <span className="verb">{e.verb}</span>
                      <span className="target">{e.target}</span>
                      <span className="conf">{typeof e.conf === 'number' ? e.conf.toFixed(2) : '—'}</span>
                    </li>
                  )) : (
                    <li><span className="verb">—</span><span className="target" style={{ color: 'var(--fg-muted)' }}>no incoming edges</span></li>
                  )}
                </ul>
              </section>
            )}

            <section className="insp-section">
              <div className="insp-h">Provenance <span className="ct">{edgeCount}</span></div>
              {(['STATIC', 'OBSERVED', 'INFERRED'] as const).map((k) => {
                const pct = (provCounts[k] / total) * 100
                return (
                  <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '7px 0' }}>
                    <span className={`pdot ${k}`} style={{ width: 7, height: 7, borderRadius: '50%', background: `var(--prov-${k.toLowerCase()})`, flexShrink: 0 }} />
                    <span style={{ width: 76, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', fontSize: '0.55rem', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{k.toLowerCase()}</span>
                    <div style={{ flex: 1, height: 1, background: 'var(--rule)', position: 'relative' }}>
                      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, background: `var(--prov-${k.toLowerCase()})` }} />
                    </div>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--fg-muted)', width: 28, textAlign: 'right' }}>{provCounts[k]}</span>
                  </div>
                )
              })}
            </section>
          </>
        )}

        {activeTab === 'edges' && (
          <section className="insp-section">
            <div className="insp-h">All edges <span className="ct">{edgeCount}</span></div>
            <ul className="edge-list">
              {allEdges.length ? allEdges.map((e, i) => (
                <li key={i}>
                  <span className={`pdot ${e.prov}`} />
                  <span className="verb">{e.verb}</span>
                  <span className="target">{e.target}</span>
                  <span className="conf">{typeof e.conf === 'number' ? e.conf.toFixed(2) : '—'}</span>
                </li>
              )) : (
                <li><span style={{ color: 'var(--fg-muted)', fontStyle: 'italic', fontFamily: 'var(--font-body)' }}>no edges</span></li>
              )}
            </ul>
          </section>
        )}

        {activeTab === 'owners' && (
          <section className="insp-section">
            <div className="insp-h">Owners</div>
            {owner ? (
              <dl className="kv"><dt>owner</dt><dd>{owner}</dd></dl>
            ) : (
              <div style={{ color: 'var(--fg-muted)', fontStyle: 'italic', fontFamily: 'var(--font-body)', fontSize: '0.92rem' }}>
                no owner declared in package.json or pyproject.toml (ADR-054)
              </div>
            )}
          </section>
        )}
      </div>
    </aside>
  )
}
