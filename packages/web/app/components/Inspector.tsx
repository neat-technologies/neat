'use client'

import { useEffect, useState } from 'react'
import type { GraphNode, GraphEdge } from '@neat.is/types'
import type { GraphData } from './AppShell'
import { authedFetch } from '../../lib/authed-fetch'

interface RootCauseResult {
  origin: string
  rootCauseNode: string | null
  reason: string
  fixRecommendation: string | null
  confidence: number
  traversalPath: string[]
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c))
}

function visualProv(provenance: string): 'STATIC' | 'OBSERVED' | 'INFERRED' {
  if (provenance === 'OBSERVED') return 'OBSERVED'
  if (provenance === 'INFERRED') return 'INFERRED'
  return 'STATIC'
}

function nodeName(node: GraphNode): string {
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
  if (n.path) props.push(['path', String(n.path)])
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
  project: string
  selectedNodeId: string | null
  graphData: GraphData | null
}

export function Inspector({ project, selectedNodeId, graphData }: InspectorProps) {
  const [node, setNode] = useState<GraphNode | null>(null)
  const [rootCause, setRootCause] = useState<RootCauseResult | null>(null)
  const [activeTab, setActiveTab] = useState<'inspect' | 'edges' | 'owners' | 'history'>('inspect')

  // Metric values come from the OBSERVED signal block on incident edges
  // when present, or render as "—" when the selected node has no observed
  // signal (#357). p99 stays "—" until the OBSERVED edge schema carries a
  // span-duration histogram — that's its own schema-growth concern.
  // Deltas are similarly absent until per-edge history lands.

  // ADR-057 #3 — re-fetch when project or selection changes.
  useEffect(() => {
    if (!selectedNodeId) {
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
        <div className="insp-section" style={{ paddingTop: 32 }}>
          <div style={{ fontFamily: 'Spectral, serif', fontStyle: 'italic', color: 'var(--paper-3)', textAlign: 'center' }}>
            select a node to inspect
          </div>
        </div>
      </aside>
    )
  }

  // Derive edges from graphData (avoids extra fetch)
  const outEdges: EdgeRow[] = graphData
    ? graphData.edges
        .filter((e: GraphEdge) => e.source === node.id)
        .map((e: GraphEdge) => {
          const targetNode = graphData.nodes.find((n: GraphNode) => n.id === e.target)
          return {
            verb: e.type.toLowerCase().replace(/_/g, ' '),
            target: targetNode ? nodeName(targetNode) : e.target,
            prov: visualProv(e.provenance),
            conf: e.confidence,
          }
        })
    : []

  const inEdges: EdgeRow[] = graphData
    ? graphData.edges
        .filter((e: GraphEdge) => e.target === node.id)
        .map((e: GraphEdge) => {
          const srcNode = graphData.nodes.find((n: GraphNode) => n.id === e.source)
          return {
            verb: e.type.toLowerCase().replace(/_/g, ' '),
            target: srcNode ? nodeName(srcNode) : e.source,
            prov: visualProv(e.provenance),
            conf: e.confidence,
          }
        })
    : []

  const allEdges = [...outEdges, ...inEdges]
  const edgeCount = allEdges.length
  const props = nodeProps(node)
  const name = nodeName(node)
  const labelParts = name.split('/')
  const stem = labelParts.length > 1 ? labelParts[0] + '/' : ''
  const rest = labelParts.length > 1 ? labelParts.slice(1).join('/') : name

  const provCounts: Record<string, number> = { STATIC: 0, OBSERVED: 0, INFERRED: 0 }
  allEdges.forEach((e) => { provCounts[e.prov] = (provCounts[e.prov] ?? 0) + 1 })
  const total = allEdges.length || 1

  const typeLabel = node.type.replace('Node', '').toUpperCase()
  const showMetrics = !['ConfigNode', 'FrontierNode'].includes(node.type)
  const owner = (node as unknown as { owner?: string }).owner

  // Derive metrics from incident OBSERVED edges (#357). When the node has
  // no OBSERVED signal, every metric renders as "—" — the panel reports
  // absence honestly rather than rolling Math.random() noise. p99 stays
  // "—" until the OBSERVED edge schema carries a span-duration histogram.
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
        <div
          className={`inspect-tab${activeTab === 'inspect' ? ' on' : ''}`}
          role="tab"
          aria-selected={activeTab === 'inspect'}
          onClick={() => setActiveTab('inspect')}
        >
          Inspect
        </div>
        <div
          className={`inspect-tab${activeTab === 'edges' ? ' on' : ''}`}
          role="tab"
          aria-selected={activeTab === 'edges'}
          onClick={() => setActiveTab('edges')}
        >
          Edges<span className="ct">{edgeCount}</span>
        </div>
        {/* ADR-056 — Owners wired: shows ServiceNode.owner when available (ADR-054). */}
        <div
          className={`inspect-tab${activeTab === 'owners' ? ' on' : ''}`}
          role="tab"
          aria-selected={activeTab === 'owners'}
          onClick={() => setActiveTab('owners')}
        >
          Owners
        </div>
        {/* ADR-056 — History deferred: explicit disabled affordance. */}
        <div
          className="inspect-tab disabled"
          role="tab"
          aria-selected={false}
          aria-disabled={true}
          title="History — coming in v0.3.x"
          style={{ opacity: 0.4, cursor: 'not-allowed' }}
        >
          History
        </div>
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
                {(node as { language?: string }).language && (
                  <span className="tag">{escapeHtml((node as { language: string }).language)}</span>
                )}
                {(node as { engine?: string }).engine && (
                  <span className="tag">{escapeHtml((node as { engine: string }).engine)}</span>
                )}
                {(node as { kind?: string }).kind && (
                  <span className="tag">{escapeHtml((node as { kind: string }).kind)}</span>
                )}
                {props.length === 0 && <span className="tag">{escapeHtml(typeLabel.toLowerCase())}</span>}
              </div>
            </section>

            {showMetrics && (
              <section className="insp-section">
                <div className="metrics">
                  <div className="metric">
                    <div className="lbl">spans</div>
                    <div className="val">{rpsDisplay}</div>
                  </div>
                  <div className="metric">
                    <div className="lbl">p99 ms</div>
                    <div className="val">—</div>
                  </div>
                  <div className="metric">
                    <div className="lbl">err %</div>
                    <div className={`val${errBad ? ' bad' : ''}`}>{errDisplay}</div>
                  </div>
                </div>
                {!hasObservedSignal && (
                  <div className="insp-sub" style={{ marginTop: 8, fontStyle: 'italic' }}>
                    no observed signal — drive traffic to this service to populate
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
                  {rootCause.fixRecommendation && (
                    <div className="rc-fix">{escapeHtml(rootCause.fixRecommendation)}</div>
                  )}
                </div>
              </section>
            )}

            {props.length > 0 && (
              <section className="insp-section">
                <div className="insp-h">Properties <span className="ct">{props.length}</span></div>
                <dl className="kv">
                  {props.map(([k, v]) => (
                    <>
                      <dt key={`k-${k}`}>{escapeHtml(k)}</dt>
                      <dd key={`v-${k}`}>{escapeHtml(v)}</dd>
                    </>
                  ))}
                </dl>
              </section>
            )}

            <section className="insp-section">
              <div className="insp-h">Outgoing <span className="ct">{outEdges.length}</span></div>
              <ul className="edge-list">
                {outEdges.length ? outEdges.map((e, i) => (
                  <li key={i}>
                    <span className={`pdot ${e.prov}`} />
                    <span className="verb">{escapeHtml(e.verb)}</span>
                    <span className="target">{escapeHtml(e.target)}</span>
                    <span className="conf">{typeof e.conf === 'number' ? e.conf.toFixed(2) : '—'}</span>
                  </li>
                )) : (
                  <li><span className="verb">—</span><span className="target" style={{ color: 'var(--paper-3)' }}>no outgoing edges</span></li>
                )}
              </ul>
            </section>

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
                  <li><span className="verb">—</span><span className="target" style={{ color: 'var(--paper-3)' }}>no incoming edges</span></li>
                )}
              </ul>
            </section>

            <section className="insp-section">
              <div className="insp-h">Provenance <span className="ct">{edgeCount}</span></div>
              {(['STATIC', 'OBSERVED', 'INFERRED'] as const).map((k) => {
                const pct = (provCounts[k] / total) * 100
                return (
                  <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '11.5px', margin: '5px 0' }}>
                    <span className={`pdot ${k}`} style={{ width: 7, height: 7, borderRadius: '50%', background: `var(--prov-${k.toLowerCase()})`, flexShrink: 0 }} />
                    <span style={{ fontStyle: 'italic', width: 70, color: 'var(--paper-2)', fontFamily: 'Spectral, serif' }}>{k.toLowerCase()}</span>
                    <div style={{ flex: 1, height: 4, background: 'var(--ink-3)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: `var(--prov-${k.toLowerCase()})` }} />
                    </div>
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '10.5px', color: 'var(--paper-3)', width: 34, textAlign: 'right' }}>{provCounts[k]}</span>
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
                <li><span style={{ color: 'var(--paper-3)', fontStyle: 'italic', fontFamily: 'Spectral, serif' }}>no edges</span></li>
              )}
            </ul>
          </section>
        )}

        {activeTab === 'owners' && (
          <section className="insp-section">
            <div className="insp-h">Owners</div>
            {owner ? (
              <dl className="kv">
                <dt>owner</dt>
                <dd>{escapeHtml(owner)}</dd>
              </dl>
            ) : (
              <div style={{ color: 'var(--paper-3)', fontStyle: 'italic', fontFamily: 'Spectral, serif', fontSize: 12 }}>
                no owner declared in package.json or pyproject.toml (ADR-054)
              </div>
            )}
          </section>
        )}
      </div>
    </aside>
  )
}
