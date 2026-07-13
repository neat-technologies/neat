'use client'

import { useEffect, useState } from 'react'
import type { ConnectorState, ConnectorSummary } from '@neat.is/types'
import { authedFetch } from '../../lib/authed-fetch'
import { Badge } from '@/components/ui/badge'

// ---------------------------------------------------------------------------
// Connectors page (ADR-137, web-shell.md §4) — a read-only status view over
// the connectors plane's own OBSERVED sources. Every edge in the graph
// carries provenance; a connector is an OBSERVED source, and this is where
// that source's own health becomes visible — configured, polling, healthy,
// erroring, or stale (same STALE vocabulary the canvas legend already
// teaches). Mirrors `neat connector list` exactly: the credential rides as
// its redacted env-ref pointer, never a resolved secret.
//
// No in-GUI add form — credentials stay CLI-only. The re-test action renders
// as an explicit preview (disabled, labeled) rather than a mock: there is no
// REST path for an on-demand check yet, only `neat connector test <id>` at
// the terminal. It flips live the moment that endpoint ships.
// ---------------------------------------------------------------------------

interface ConnectorsPageProps {
  project: string | null
}

interface ConnectorsResponse {
  connectors: ConnectorSummary[]
}

const STATE_VARIANT: Record<ConnectorState, 'destructive' | 'outline' | 'secondary'> = {
  healthy: 'secondary',
  idle: 'outline',
  stale: 'outline',
  error: 'destructive',
}

const STATE_LABEL: Record<ConnectorState, string> = {
  idle: 'idle',
  healthy: 'healthy',
  error: 'error',
  stale: 'stale',
}

// The endpoint's credentialRef is a single redacted pointer ("$CF_TOKEN") or, for
// a multi-field credential, a field→pointer map. Render either as a flat string —
// never a resolved secret (ADR-136 §3).
function formatCredentialRef(ref: string | Record<string, string>): string {
  return typeof ref === 'string' ? ref : Object.values(ref).join(' · ')
}

function formatTs(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return d.toLocaleDateString() + ' ' + d.toTimeString().slice(0, 8)
  } catch {
    return iso
  }
}

export function ConnectorsPage({ project }: ConnectorsPageProps) {
  const [connectors, setConnectors] = useState<ConnectorSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!project) {
      setConnectors(null)
      return
    }
    setError(null)
    authedFetch(`/api/connectors?project=${encodeURIComponent(project)}`)
      .then((r) => r.json())
      .then((d: ConnectorsResponse) => setConnectors(Array.isArray(d.connectors) ? d.connectors : []))
      .catch(() => setError('could not load connectors'))
  }, [project])

  return (
    <div className="page-scroll">
      <header className="page-head">
        <h1 className="page-title">Connectors</h1>
        <p className="page-sub">
          Every edge in the graph carries provenance — a connector is an OBSERVED source, the
          same standing OTLP ingest has. This is that source&apos;s own health: configured,
          polling, healthy, erroring, or stale. Add a connector at the terminal —{' '}
          <code>neat connector add &lt;provider&gt;</code> — credentials never enter the browser.
        </p>
      </header>

      <section className="page-section">
        <div className="page-section-head">
          <h2>Configured connectors</h2>
          <Badge variant="secondary" className="ml-2">live · read-only</Badge>
          {connectors && connectors.length > 0 && (
            <span className="page-count">{connectors.length} configured</span>
          )}
        </div>

        {error && <div className="page-empty">{error}</div>}

        {!error && connectors === null && <div className="page-empty">loading connectors…</div>}

        {!error && connectors !== null && connectors.length === 0 && (
          <div className="page-empty">
            No connectors configured — run <code>neat connector add &lt;provider&gt;</code> at the
            terminal to pull OBSERVED signal with zero app instrumentation.
          </div>
        )}

        {!error && connectors && connectors.length > 0 && (
          <table className="page-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Id</th>
                <th>Provider</th>
                <th>Credential</th>
                <th>Last poll</th>
                <th>Signals</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {connectors.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Badge variant={STATE_VARIANT[c.status.state]} title={c.status.lastError ?? undefined}>
                      {STATE_LABEL[c.status.state]}
                    </Badge>
                  </td>
                  <td className="td-mono">{c.id}</td>
                  <td className="td-mono">{c.provider}</td>
                  <td className="td-mono">{formatCredentialRef(c.credentialRef)}</td>
                  <td className="td-mono">{formatTs(c.status.lastPollAt)}</td>
                  <td className="td-mono">{c.status.signalsLastPoll ?? '—'}</td>
                  <td>
                    <button
                      className="settings-btn"
                      disabled
                      aria-disabled="true"
                      title="Lands when an on-demand-test endpoint ships — today, run `neat connector test` at the terminal"
                    >
                      re-test <span className="chip-ct">preview</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!error && connectors && connectors.some((c) => c.status.lastError) && (
          <p className="page-note" style={{ marginTop: 16 }}>
            {connectors
              .filter((c) => c.status.lastError)
              .map((c) => (
                <span key={c.id} style={{ display: 'block' }}>
                  <code>{c.id}</code>: {c.status.lastError}
                </span>
              ))}
          </p>
        )}
      </section>
    </div>
  )
}
