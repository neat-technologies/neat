'use client'

import { useEffect, useState } from 'react'
import type { Policy, PolicyViolation } from '@neat.is/types'
import { authedFetch } from '../../lib/authed-fetch'
import { Badge } from '@/components/ui/badge'

// ---------------------------------------------------------------------------
// Policies page — preview-enforcement (lead-03/04, eng-03/04).
//
// The honest live/preview line (corrected in eng-03):
//
//   LIVE (real, read-only): the VIOLATION VIEW — `evaluateAllPolicies` /
//     check_policies surfacing "these rules currently flag these nodes/edges."
//     Shipped + tested. Wired here against /api/policies/violations.
//
//   PREVIEW (designed, disabled-with-intent, flips when the governance kernel
//     ships — ADR-093/094/095): EVERYTHING THAT ACTS — gate, block,
//     approve/reject, would-violate-on-change simulation, block-on-promotion.
//     None of those execute today (block-on-FrontierNode-promotion is dead in
//     prod, #533 / audit do-not-say #2), so they render as explicit `preview`
//     per web-completeness #26's "wired or explicitly disabled" clause. We do
//     NOT fake a working gate.
// ---------------------------------------------------------------------------

interface PoliciesPageProps {
  project: string | null
  onNodeSelect: (id: string) => void
  onNavigateGraph: () => void
}

const SEVERITY_VARIANT: Record<string, 'destructive' | 'outline' | 'secondary'> = {
  critical: 'destructive',
  error: 'destructive',
  warn: 'outline',
  warning: 'outline',
  info: 'secondary',
}

// The five locked rule types (policy-schema.md), spelled out for the list.
const RULE_TYPE_LABEL: Record<string, string> = {
  structural: 'structural',
  compatibility: 'compatibility',
  provenance: 'provenance',
  ownership: 'ownership',
  'blast-radius': 'blast radius',
}

export function PoliciesPage({ project, onNodeSelect, onNavigateGraph }: PoliciesPageProps) {
  const [policies, setPolicies] = useState<Policy[] | null>(null)
  const [violations, setViolations] = useState<PolicyViolation[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // LIVE — the rule list (what's injected into the agent's context) + the
  // violation view. Both idle until a project resolves (#461).
  useEffect(() => {
    if (!project) {
      setPolicies(null)
      setViolations(null)
      return
    }
    authedFetch(`/api/policies?project=${encodeURIComponent(project)}`)
      .then((r) => r.json())
      .then((d: { policies?: Policy[] }) => setPolicies(Array.isArray(d.policies) ? d.policies : []))
      .catch(() => setPolicies([]))

    authedFetch(`/api/policies/violations?project=${encodeURIComponent(project)}`)
      .then((r) => r.json())
      .then((d: { violations?: PolicyViolation[] }) => {
        setViolations(Array.isArray(d.violations) ? d.violations : [])
        setError(null)
      })
      .catch(() => setError('could not load policy violations'))
  }, [project])

  return (
    <div className="page-scroll">
      <header className="page-head">
        <h1 className="page-title">Policies</h1>
        <p className="page-sub">
          The rules from <code>policy.json</code>, pinned into your agent&apos;s
          context so it works inside the lines. The rule list and the violation
          view are live; enforcement is in preview until the governance kernel ships.
        </p>
      </header>

      {/* ---- LIVE: the rule list injected into the agent's context ---- */}
      <section className="page-section">
        <div className="page-section-head">
          <h2>Injected into your agent&apos;s context</h2>
          <Badge variant="secondary" className="ml-2">live · read-only</Badge>
          {policies && policies.length > 0 && (
            <span className="page-count">{policies.length} rules</span>
          )}
        </div>

        {policies === null && <div className="page-empty">loading rules…</div>}

        {policies !== null && policies.length === 0 && (
          <div className="page-empty">
            No rules yet — add a <code>policy.json</code> at your project root and
            the rules land here, delivered to your agent as context (never a gate).
          </div>
        )}

        {policies && policies.length > 0 && (
          <table className="page-table">
            <thead>
              <tr>
                <th>Severity</th>
                <th>Rule</th>
                <th>Type</th>
                <th>What it asserts</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Badge variant={SEVERITY_VARIANT[p.severity] ?? 'outline'}>{p.severity}</Badge>
                  </td>
                  <td className="td-mono">{p.name}</td>
                  <td className="td-mono">{RULE_TYPE_LABEL[p.rule.type] ?? p.rule.type}</td>
                  <td className="td-msg">{p.description ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ---- LIVE: the violation view ---- */}
      <section className="page-section">
        <div className="page-section-head">
          <h2>Currently flagged</h2>
          <Badge variant="secondary" className="ml-2">live · read-only</Badge>
        </div>

        {error && <div className="page-empty">{error}</div>}

        {!error && violations === null && (
          <div className="page-empty">loading violations…</div>
        )}

        {!error && violations !== null && violations.length === 0 && (
          <div className="page-empty">
            Nothing flagged — no node or edge currently violates a rule in{' '}
            <code>policy.json</code>.
          </div>
        )}

        {!error && violations && violations.length > 0 && (
          <table className="page-table">
            <thead>
              <tr>
                <th>Severity</th>
                <th>Rule</th>
                <th>Subject</th>
                <th>What it flags</th>
              </tr>
            </thead>
            <tbody>
              {violations.map((v) => {
                const subjectId = v.subject.nodeId ?? v.subject.edgeId ?? (v.subject.path ?? []).join(' → ')
                const clickable = !!v.subject.nodeId
                return (
                  <tr key={v.id}>
                    <td>
                      <Badge variant={SEVERITY_VARIANT[v.severity] ?? 'outline'}>
                        {v.severity}
                      </Badge>
                    </td>
                    <td className="td-mono">{v.policyName}</td>
                    <td>
                      {clickable ? (
                        <button
                          className="td-link"
                          onClick={() => {
                            onNodeSelect(v.subject.nodeId as string)
                            onNavigateGraph()
                          }}
                          title="Focus this node on the graph"
                        >
                          {subjectId}
                        </button>
                      ) : (
                        <span className="td-mono">{subjectId || '—'}</span>
                      )}
                    </td>
                    <td className="td-msg">{v.message}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ---- PREVIEW: the enforcement layer (disabled-with-intent) ---- */}
      <section className="page-section">
        <div className="page-section-head">
          <h2>Enforcement</h2>
          <Badge variant="outline" className="ml-2">preview</Badge>
        </div>
        <p className="page-note">
          These controls are designed but not wired — the enforcement kernel
          (ADR-093/094/095) hasn&apos;t shipped, so nothing here acts on your
          graph yet. They switch from preview to live when it lands; until then
          they&apos;re shown disabled rather than faking a working gate
          (web-completeness #26).
        </p>

        <div className="preview-grid">
          {[
            { t: 'Gate mutations', d: 'Block a change that would violate a rule before it lands.' },
            { t: 'Would-violate simulation', d: 'Preview which rules a proposed change would trip.' },
            { t: 'Approve / reject', d: 'Review a flagged change and approve or reject it.' },
            { t: 'Block on promotion', d: 'Stop a FrontierNode promotion that breaks a policy.' },
          ].map((c) => (
            <div key={c.t} className="preview-card" aria-disabled="true">
              <div className="preview-card-head">
                <span className="preview-card-title">{c.t}</span>
                <Badge variant="outline">preview</Badge>
              </div>
              <p className="preview-card-body">{c.d}</p>
              <button className="preview-card-btn" disabled aria-disabled title="Lands with the governance kernel">
                not yet enforcing
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
