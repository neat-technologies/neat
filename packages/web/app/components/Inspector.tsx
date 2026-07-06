'use client'

import { useEffect, useMemo, useState } from 'react'
import type { GraphNode, GraphEdge } from '@neat.is/types'
import type { GraphData } from './AppShell'
import { authedFetch } from '../../lib/authed-fetch'
import { buildModel, callsFrom, importsFrom, filesOf } from './graph-model'

interface RootCauseResult {
  origin: string
  rootCauseNode: string | null
  reason: string
  fixRecommendation: string | null
  confidence: number
  traversalPath: string[]
}

function escapeHtml(s: string | null | undefined): string {
  // never crash the panel on a missing field — a node/edge can lack a name,
  // target, etc.; render empty rather than throwing on undefined.replace.
  return (s == null ? '' : String(s)).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c))
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

interface InspectorProps {
  // null until AppShell's resolution chain lands on a real project (#461).
  project: string | null
  selectedNodeId: string | null
  graphData: GraphData | null
  onNodeSelect: (id: string) => void
}

export function Inspector({ project, selectedNodeId, graphData, onNodeSelect }: InspectorProps) {
  const [node, setNode] = useState<GraphNode | null>(null)
  const [rootCause, setRootCause] = useState<RootCauseResult | null>(null)
  const [activeTab, setActiveTab] = useState<'inspect' | 'edges' | 'owners' | 'history'>('inspect')

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
          <div className="inspect-tab on" role="tab" aria-selected={true}>Inspect</div>
          <div className="inspect-tab" role="tab" aria-selected={false}>Edges</div>
          {/* ADR-056 — Owners deferred: explicit disabled affordance. */}
          <div className="inspect-tab disabled" role="tab" aria-selected={false} aria-disabled={true} title="Owners — coming in v0.3.x" style={{ opacity: 0.4, cursor: 'not-allowed' }}>Owners</div>
          {/* ADR-056 — History deferred: explicit disabled affordance. */}
          <div className="inspect-tab disabled" role="tab" aria-selected={false} aria-disabled={true} title="History — coming in v0.3.x" style={{ opacity: 0.4, cursor: 'not-allowed' }}>History</div>
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
        <div className={`inspect-tab${activeTab === 'inspect' ? ' on' : ''}`} role="tab" aria-selected={activeTab === 'inspect'} onClick={() => setActiveTab('inspect')}>Inspect</div>
        <div className={`inspect-tab${activeTab === 'edges' ? ' on' : ''}`} role="tab" aria-selected={activeTab === 'edges'} onClick={() => setActiveTab('edges')}>Edges<span className="ct">{edgeCount}</span></div>
        {/* ADR-056 — Owners wired: shows ServiceNode.owner when available (ADR-054). */}
        <div className={`inspect-tab${activeTab === 'owners' ? ' on' : ''}`} role="tab" aria-selected={activeTab === 'owners'} onClick={() => setActiveTab('owners')}>Owners</div>
        {/* ADR-056 — History deferred: explicit disabled affordance. */}
        <div className="inspect-tab disabled" role="tab" aria-selected={false} aria-disabled={true} title="History — coming in v0.3.x" style={{ opacity: 0.4, cursor: 'not-allowed' }}>History</div>
      </div>

      <div id="inspect-body">
        {activeTab === 'inspect' && (
          <>
            <section className="insp-section">
              <div className="insp-eyebrow">{escapeHtml(typeLabel)}</div>
              <div className="insp-title">
                {stem && <span className="stem">{escapeHtml(stem)}</span>}
                {escapeHtml(rest)}
              </div>
              <div className="insp-sub">{escapeHtml(node.id)}</div>
              <div className="insp-tags">
                {(node as { language?: string }).language && <span className="tag">{escapeHtml((node as { language: string }).language)}</span>}
                {(node as { engine?: string }).engine && <span className="tag">{escapeHtml((node as { engine: string }).engine)}</span>}
                {(node as { kind?: string }).kind && <span className="tag">{escapeHtml((node as { kind: string }).kind)}</span>}
                {!isFile && props.length === 0 && <span className="tag">{escapeHtml(typeLabel.toLowerCase())}</span>}
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
                  <span className="svc-name">{escapeHtml((owningService as { name?: string }).name ?? owningService.id)}</span>
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
                        <span
                          className="target clickable"
                          onClick={() => onNodeSelect(c.targetId)}
                          title={`Select ${c.targetName}`}
                        >{escapeHtml(c.targetName)}</span>
                        <span className="conf">{typeof c.confidence === 'number' ? c.confidence.toFixed(2) : '—'}</span>
                      </span>
                      {c.evidenceFile && (
                        <span className="edge-evidence" style={{ width: '100%' }}>
                          {escapeHtml(c.evidenceFile)}{typeof c.evidenceLine === 'number' ? `:${c.evidenceLine}` : ''}
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
                        <span
                          className="target clickable"
                          onClick={() => onNodeSelect(c.targetId)}
                          title={`Select ${c.targetName}`}
                        >{escapeHtml(c.targetName)}</span>
                        <span className="conf">{typeof c.confidence === 'number' ? c.confidence.toFixed(2) : '—'}</span>
                      </span>
                      {c.evidenceFile && (
                        <span className="edge-evidence" style={{ width: '100%' }}>
                          {escapeHtml(c.evidenceFile)}{typeof c.evidenceLine === 'number' ? `:${c.evidenceLine}` : ''}
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
                    <li
                      key={f.id}
                      onClick={() => { onNodeSelect(f.id) }}
                      title={(f as { path?: string }).path}
                    >
                      <svg className="fglyph" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" /></svg>
                      <span className="fpath">{escapeHtml((f as { path?: string }).path ?? f.id)}</span>
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

            {rootCause && (
              <section className="insp-section">
                <div className="insp-h">Root cause</div>
                <div className="root-cause-block">
                  <div className="rc-label">divergence detected</div>
                  <div className="rc-node">{escapeHtml(rootCause.rootCauseNode ?? '')}</div>
                  <div className="rc-reason">{escapeHtml(rootCause.reason)}</div>
                  {rootCause.fixRecommendation && <div className="rc-fix">{escapeHtml(rootCause.fixRecommendation)}</div>}
                </div>
              </section>
            )}

            {props.length > 0 && (
              <section className="insp-section">
                <div className="insp-h">Properties <span className="ct">{props.length}</span></div>
                <dl className="kv">
                  {props.map(([k, v]) => (
                    <div key={k} style={{ display: 'contents' }}>
                      <dt>{escapeHtml(k)}</dt>
                      <dd>{escapeHtml(v)}</dd>
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
                      <span className="verb">{escapeHtml(e.verb)}</span>
                      <span className="target">{escapeHtml(e.target)}</span>
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
                  <span className="verb">{escapeHtml(e.verb)}</span>
                  <span className="target">{escapeHtml(e.target)}</span>
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
              <dl className="kv"><dt>owner</dt><dd>{escapeHtml(owner)}</dd></dl>
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
