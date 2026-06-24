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
// ---------------------------------------------------------------------------

export type ObservedMode = 'A' | 'B'

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
    <div className="observed-overlay" role="dialog" aria-label="Live layer status">
      <div className="oo-card">
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

        <button className="oo-dismiss" onClick={onDismiss} title="Explore the static graph meanwhile">
          explore the static graph
        </button>
      </div>
    </div>
  )
}
