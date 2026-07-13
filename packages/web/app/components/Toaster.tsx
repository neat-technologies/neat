'use client'

import { useEffect, useState } from 'react'
import { toastBus, type ToastEvent } from '../../lib/proxy-client'

// ADR-058 #3 — surfaces non-2xx fetch responses as transient toasts.
// Subscribes to `toastBus` populated by trackedFetch. Auto-dismisses after
// six seconds; stacks up to four at a time.
export function Toaster() {
  const [toasts, setToasts] = useState<ToastEvent[]>([])

  useEffect(() => {
    const unsub = toastBus.subscribe((t) => {
      setToasts((prev) => [...prev, t].slice(-4))
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((p) => p.id !== t.id))
      }, 6_000)
    })
    return unsub
  }, [])

  if (toasts.length === 0) return null

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 56,
        right: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        // Above .observed-overlay (z-index 1000) so a toast is never buried
        // behind the observed=0 modal on the graph page.
        zIndex: 1100,
      }}
    >
      {toasts.map((t) => {
        const color = t.level === 'error' ? '#e08a8a' : t.level === 'warn' ? 'var(--fg)' : 'var(--prov-observed)'
        return (
          <div
            key={t.id}
            className="toast"
            onClick={() => setToasts((prev) => prev.filter((p) => p.id !== t.id))}
            style={{
              background: 'var(--bg, #000)',
              border: `1px solid var(--rule)`,
              borderLeft: `2px solid ${color}`,
              padding: '10px 14px',
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: 11,
              letterSpacing: '0.02em',
              color: 'var(--fg, #fff)',
              maxWidth: 360,
              cursor: 'pointer',
              boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span style={{ color, fontWeight: 600 }}>{t.status ?? t.level}</span>
              <span style={{ flex: 1 }}>{t.message}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
