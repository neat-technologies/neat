'use client'

import { useEffect, useState } from 'react'
import { authedFetch } from '../../lib/authed-fetch'

// ---------------------------------------------------------------------------
// The two-mode observed=0 overlay — the hero honesty screen (lead-02, eng-01).
//
// When the static graph is extracted but no OBSERVED layer is present, this
// overlay reads the instrumentation / audit signal and branches:
//
//   Mode A — healthy, idle (instrumentation wired, no traffic yet):
//     "Your code's mapped — run your app to complete the picture with what it
//      actually does." Neutral, expectant.
//
//   Mode B — didn't engage (#545/#546: no entry point / uninstrumented lib):
//     diagnosis + the one fix command, mirroring the CLI warnings (#547) /
//     errors.ndjson — "No entry point — add a `start` script", "sqlite3 isn't
//     instrumented — run `neat extend`."
//
// Framing is COMPLETION / FUSION, never gap/contrast (lead-05/06): the picture
// going incomplete → completing → complete. Mode B is the COMMON case until the
// ecosystem's instrumentation gaps close, so it gets equal design love (eng-02).
//
// A second, PARALLEL path — "or connect a provider" — sits alongside whichever
// mode is active (ADR-134, canvas-layout.md §3a). Not a third mode: OTLP (run
// your app) and a connector (point at where it already runs) are both real,
// honest routes to a complete picture. Provider list is exactly the shipped
// dispatch-table entries (connector-config.md §5) — never a provider without a
// working `neat connector add <provider>` behind it. No in-GUI credential
// form this cut; clicking a provider copies the real CLI command (a genuine
// wired action, not a mock "Connect" button — web-completeness #26).
// ---------------------------------------------------------------------------

export type ObservedMode = 'A' | 'B'

// Exactly the shipped connectors (connectors/registry.ts's dispatch table).
// Vercel stays out until #724 (Drains connector) actually ships — listing it
// here would be a live-looking control that does nothing.
const PROVIDERS: { id: string; label: string }[] = [
  { id: 'supabase', label: 'Supabase' },
  { id: 'railway', label: 'Railway' },
  { id: 'firebase', label: 'Firebase' },
  { id: 'cloudflare', label: 'Cloudflare' },
]

interface Diagnosis {
  // mirrors the CLI / errors.ndjson shape; all optional so a thin payload
  // still renders something honest.
  reason?: string
  fixCommand?: string
  detail?: string
}

interface ObservedOverlayProps {
  mode: ObservedMode
  project: string | null
  onDismiss: () => void
}

export function ObservedOverlay({ mode, project, onDismiss }: ObservedOverlayProps) {
  const [diag, setDiag] = useState<Diagnosis | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  // Copies the real CLI command — the connector path's one wired action. No
  // in-GUI add flow this cut (ADR-134); a clipboard write is genuine, not a
  // mock "Connect" button.
  function copyCommand(provider: string): void {
    if (!navigator.clipboard) return
    const cmd = `neat connector add ${provider}`
    navigator.clipboard
      .writeText(cmd)
      .then(() => {
        setCopied(provider)
        setTimeout(() => setCopied(null), 1500)
      })
      .catch(() => {
        /* clipboard write rejected (permissions / insecure context) — the
           command is still visible in the button's title */
      })
  }

  // Pull the real diagnosis for Mode B from the daemon's audit surface where it
  // exists. If the endpoint isn't there yet, we still show the generic Mode B
  // copy — never a fabricated specific cause.
  useEffect(() => {
    if (mode !== 'B' || !project) return
    let cancelled = false
    authedFetch(`/api/instrumentation?project=${encodeURIComponent(project)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { diagnosis?: Diagnosis } | null) => {
        if (!cancelled && d?.diagnosis) setDiag(d.diagnosis)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [mode, project])

  return (
    <div
      className="observed-overlay"
      role="dialog"
      aria-label="Live layer status"
      onClick={onDismiss}
    >
      <div className="oo-card" onClick={(e) => e.stopPropagation()}>
        <button
          className="oo-close"
          onClick={onDismiss}
          aria-label="Dismiss and explore the static graph"
          title="Explore the static graph"
        >
          ×
        </button>
        {/* completion meter — incomplete → completing → complete. With no
            OBSERVED data the picture is "extracted, not yet whole". */}
        <div className="oo-meter" aria-hidden="true">
          <span className="oo-meter-fill" data-state={mode === 'A' ? 'idle' : 'blocked'} />
        </div>
        <div className="oo-eyebrow">the live layer</div>

        {mode === 'A' ? (
          <>
            <h2 className="oo-title">Your code is mapped.</h2>
            <p className="oo-body">
              The static graph is extracted and waiting. Run your app to complete
              the picture with what it actually does — the observed layer fuses in
              over the code, and the graph becomes whole.
            </p>
            <div className="oo-cmd-block">
              <span className="oo-cmd-label">run your app, then</span>
              <code className="oo-cmd">neat sync</code>
            </div>
            <p className="oo-foot">
              Observed edges pulse in live as traffic flows — no reload needed.
            </p>
          </>
        ) : (
          <>
            <h2 className="oo-title">The live layer hasn&apos;t engaged yet.</h2>
            <p className="oo-body">
              NEAT mapped your code, but it isn&apos;t seeing your app run. That&apos;s
              usually one fixable thing — here&apos;s what to do so the picture can
              complete.
            </p>

            <div className="oo-diag">
              <div className="oo-diag-reason">
                {diag?.reason ??
                  'No instrumented entry point found, or a library on your hot path isn’t in the auto-instrumentation set.'}
              </div>
              {diag?.detail && <div className="oo-diag-detail">{diag.detail}</div>}
              <div className="oo-cmd-block">
                <span className="oo-cmd-label">try</span>
                <code className="oo-cmd">{diag?.fixCommand ?? 'neat extend'}</code>
              </div>
            </div>

            <p className="oo-foot">
              Same signal the CLI prints on <code>neat init</code> /{' '}
              <code>neat sync</code> and writes to <code>errors.ndjson</code>.
            </p>
          </>
        )}

        <div className="oo-or-divider" aria-hidden="true"><span>or</span></div>

        <div className="oo-provider-path">
          <div className="oo-eyebrow">connect a provider</div>
          <p className="oo-body oo-provider-body">
            Already running on one of these? Point NEAT at it directly — pull-based, zero
            instrumentation.
          </p>
          <div className="oo-provider-list" role="group" aria-label="Copy the connect command for a provider">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="oo-provider-btn"
                onClick={() => copyCommand(p.id)}
                title={`Copy: neat connector add ${p.id}`}
              >
                {p.label}
                <span className="oo-provider-copy">{copied === p.id ? 'copied' : 'copy cmd'}</span>
              </button>
            ))}
          </div>
          <p className="oo-foot">
            Copies <code>neat connector add &lt;provider&gt;</code> — run it in your terminal.
          </p>
        </div>

        <button className="oo-dismiss" onClick={onDismiss} title="Explore the static graph meanwhile">
          explore the static graph
        </button>
      </div>
    </div>
  )
}
