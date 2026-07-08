'use client'

import { useEffect, useMemo, useState } from 'react'
import type { Divergence, DivergenceResult, DivergenceType } from '@neat.is/types'
import { authedFetch } from '../../lib/authed-fetch'
import { Badge } from '@/components/ui/badge'

// ---------------------------------------------------------------------------
// Divergences page — the peer query view over the fused graph (web-shell §6,
// divergence-query.md). Read-only, derived: `get_divergences` surfacing where a
// declared relationship and its observed twin diverge, at whichever grain both
// sides share (file-awareness §7). A row focuses that pair on the graph.
//
// This is a peer query, not the marquee — the fused graph is the spine. The
// copy never frames NEAT as a "divergence detector" (web-shell §1).
// ---------------------------------------------------------------------------

interface DivergencesPageProps {
  project: string | null
  onNodeSelect: (id: string) => void
  onNavigateGraph: () => void
}

// Human labels for the five locked divergence types (divergence.ts).
const TYPE_LABEL: Record<DivergenceType, string> = {
  'missing-observed': 'missing observed',
  'missing-extracted': 'missing extracted',
  'version-mismatch': 'version mismatch',
  'host-mismatch': 'host mismatch',
  'compat-violation': 'compat violation',
}

// One honest line per type describing what the mismatch means, shown as the
// column-empty hover / context. Kept terse; the reason field carries specifics.
const TYPE_HINT: Record<DivergenceType, string> = {
  'missing-observed': 'declared in code, never seen at runtime',
  'missing-extracted': 'seen at runtime, never declared in code',
  'version-mismatch': 'declared version differs from the observed one',
  'host-mismatch': 'declared host differs from the observed one',
  'compat-violation': 'a compat rule fires against the live edge',
}

// The evidence file:line rides on the embedded EXTRACTED / OBSERVED edge for the
// edge-shaped divergences (missing-observed / missing-extracted / compat). The
// value-shaped ones (host / version mismatch) carry no call site.
function evidenceOf(d: Divergence): string | null {
  const edge =
    'extracted' in d ? d.extracted : 'observed' in d ? d.observed : undefined
  if (edge && edge.evidence?.file) {
    return `${edge.evidence.file}${typeof edge.evidence.line === 'number' ? `:${edge.evidence.line}` : ''}`
  }
  return null
}

// The concrete declared-vs-observed values for the value-shaped divergences, so
// the mismatch is legible without opening the node.
function deltaOf(d: Divergence): string | null {
  if (d.type === 'host-mismatch') return `${d.extractedHost} → ${d.observedHost}`
  if (d.type === 'version-mismatch') return `${d.extractedVersion} → ${d.observedVersion}`
  return null
}

export function DivergencesPage({ project, onNodeSelect, onNavigateGraph }: DivergencesPageProps) {
  const [result, setResult] = useState<DivergenceResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeType, setActiveType] = useState<DivergenceType | 'all'>('all')

  // The peer query. Idle until a project resolves (#461, web-multi-project §2).
  useEffect(() => {
    if (!project) {
      setResult(null)
      return
    }
    setError(null)
    authedFetch(`/api/divergences?project=${encodeURIComponent(project)}`)
      .then((r) => r.json())
      .then((d: DivergenceResult) => {
        setResult(Array.isArray(d.divergences) ? d : { divergences: [], totalAffected: 0, computedAt: '' })
      })
      .catch(() => setError('could not load divergences'))
  }, [project])

  const divergences = result?.divergences ?? []

  // Type chips reflect only the types actually present, so the filter never
  // offers an empty bucket.
  const presentTypes = useMemo(() => {
    const s = new Set<DivergenceType>()
    for (const d of divergences) s.add(d.type)
    return [...s]
  }, [divergences])

  const shown = activeType === 'all' ? divergences : divergences.filter((d) => d.type === activeType)

  const focus = (id: string) => {
    onNodeSelect(id)
    onNavigateGraph()
  }

  return (
    <div className="page-scroll">
      <header className="page-head">
        <h1 className="page-title">Divergences</h1>
        <p className="page-sub">
          Where a declared relationship and its observed twin diverge — read off
          the fused graph, at whichever grain both sides share. A row focuses that
          pair on the graph.
        </p>
      </header>

      <section className="page-section">
        <div className="page-section-head">
          <h2>Flagged pairs</h2>
          <Badge variant="secondary" className="ml-2">live · read-only</Badge>
          {result && divergences.length > 0 && (
            <span className="page-count">{result.totalAffected} affected</span>
          )}
        </div>

        {presentTypes.length > 1 && (
          <div className="filter-chips" role="group" aria-label="Filter by divergence type">
            <button
              type="button"
              className={`chip${activeType === 'all' ? ' on' : ''}`}
              onClick={() => setActiveType('all')}
            >
              all <span className="chip-ct">{divergences.length}</span>
            </button>
            {presentTypes.map((t) => (
              <button
                key={t}
                type="button"
                className={`chip${activeType === t ? ' on' : ''}`}
                title={TYPE_HINT[t]}
                onClick={() => setActiveType(t)}
              >
                {TYPE_LABEL[t]}{' '}
                <span className="chip-ct">{divergences.filter((d) => d.type === t).length}</span>
              </button>
            ))}
          </div>
        )}

        {error && <div className="page-empty">{error}</div>}

        {!error && result === null && <div className="page-empty">loading divergences…</div>}

        {!error && result !== null && divergences.length === 0 && (
          <div className="page-empty">
            Nothing diverged — every declared relationship has its observed twin,
            and every observed one a declared match. The picture is fused.
          </div>
        )}

        {!error && shown.length > 0 && (
          <table className="page-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Relationship</th>
                <th>What diverged</th>
                <th>Evidence</th>
                <th>Conf.</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((d, i) => {
                const evidence = evidenceOf(d)
                const delta = deltaOf(d)
                return (
                  <tr key={`${d.type}-${d.source}-${d.target}-${i}`}>
                    <td>
                      <Badge variant="outline" title={TYPE_HINT[d.type]}>
                        {TYPE_LABEL[d.type]}
                      </Badge>
                    </td>
                    <td>
                      <span className="rel">
                        <button className="td-link" onClick={() => focus(d.source)} title="Focus this node on the graph">
                          {d.source}
                        </button>
                        <span className="rel-arrow" aria-hidden="true"> → </span>
                        <button className="td-link" onClick={() => focus(d.target)} title="Focus this node on the graph">
                          {d.target}
                        </button>
                      </span>
                    </td>
                    <td className="td-msg">
                      {d.reason}
                      {delta && <div className="td-delta">{delta}</div>}
                      {d.recommendation && <div className="td-fix">{d.recommendation}</div>}
                    </td>
                    <td className="td-mono">{evidence ?? '—'}</td>
                    <td className="td-mono">{d.confidence.toFixed(2)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
