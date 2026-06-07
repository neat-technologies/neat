'use client'

import { useEffect, useState } from 'react'
import {
  CORE_URL_PUBLIC,
  apiCallBus,
  connectionBus,
  sseEventBus,
  type ApiCallEvent,
  type ConnectionEvent,
  type SseEvent,
} from '../../lib/proxy-client'

interface DebugPanelProps {
  // null until AppShell's resolution chain lands on a real project (#461).
  project: string | null
  onClose: () => void
}

// ADR-058 #4 — read-only diagnostic overlay toggled via Ctrl+Shift+D.
// Subscribes to the in-memory event buses populated by trackedFetch and the
// SSE/health hooks. No POST/PUT/DELETE buttons — observation only.
export function DebugPanel({ project, onClose }: DebugPanelProps) {
  const [calls, setCalls] = useState<ApiCallEvent[]>([])
  const [sseEvents, setSseEvents] = useState<SseEvent[]>([])
  const [heartbeats, setHeartbeats] = useState<ConnectionEvent[]>([])

  useEffect(() => {
    const unsubCalls = apiCallBus.subscribe((e) => {
      setCalls((prev) => [e, ...prev].slice(0, 10))
    })
    const unsubSse = sseEventBus.subscribe((e) => {
      setSseEvents((prev) => [e, ...prev].slice(0, 10))
    })
    const unsubConn = connectionBus.subscribe((e) => {
      setHeartbeats((prev) => [e, ...prev].slice(0, 20))
    })
    return () => {
      unsubCalls()
      unsubSse()
      unsubConn()
    }
  }, [])

  return (
    <div
      role="dialog"
      aria-label="Debug panel"
      style={{
        position: 'fixed',
        top: 72,
        right: 20,
        width: 420,
        maxHeight: '70vh',
        overflow: 'auto',
        background: 'var(--bg, #000)',
        border: '1px solid var(--rule, #333)',
        color: 'var(--fg, #fff)',
        fontFamily: 'var(--font-mono, monospace)',
        fontSize: 11,
        letterSpacing: '0.02em',
        padding: 16,
        zIndex: 1000,
        boxShadow: '0 16px 40px rgba(0,0,0,0.6)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
        <strong style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 400, fontSize: '0.62rem', letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>NEAT debug</strong>
        <button onClick={onClose} aria-label="Close debug panel" title="Close (Ctrl+Shift+D)" style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 14 }}>×</button>
      </div>

      <section style={{ marginBottom: 14 }}>
        <div style={{ color: 'var(--fg-muted)', marginBottom: 6, fontSize: '0.55rem', letterSpacing: '0.14em', textTransform: 'uppercase' }}>environment</div>
        <div>project: <code>{project ?? '(unresolved)'}</code></div>
        <div>NEAT_API_URL: <code>{CORE_URL_PUBLIC}</code></div>
      </section>

      <section style={{ marginBottom: 10 }}>
        <div style={{ color: 'var(--fg-muted)', marginBottom: 6, fontSize: '0.55rem', letterSpacing: '0.14em', textTransform: 'uppercase' }}>last {calls.length} api calls</div>
        {calls.length === 0 && <div style={{ opacity: 0.5 }}>none yet</div>}
        {calls.map((c, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, lineHeight: 1.5 }}>
            <span style={{ width: 36, color: c.status >= 400 ? '#e08a8a' : c.status === 0 ? 'var(--fg-muted)' : 'var(--fg)' }}>{c.status || '—'}</span>
            <span style={{ width: 50, opacity: 0.6 }}>{c.durationMs}ms</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.path}</span>
          </div>
        ))}
      </section>

      <section style={{ marginBottom: 10 }}>
        <div style={{ color: 'var(--fg-muted)', marginBottom: 6, fontSize: '0.55rem', letterSpacing: '0.14em', textTransform: 'uppercase' }}>last {sseEvents.length} sse events</div>
        {sseEvents.length === 0 && <div style={{ opacity: 0.5 }}>none yet</div>}
        {sseEvents.map((e, i) => (
          <div key={i} style={{ display: 'flex', gap: 8 }}>
            <span style={{ width: 90 }}>{new Date(e.timestamp).toLocaleTimeString()}</span>
            <span>{e.type}</span>
          </div>
        ))}
      </section>

      <section>
        <div style={{ color: 'var(--fg-muted)', marginBottom: 6, fontSize: '0.55rem', letterSpacing: '0.14em', textTransform: 'uppercase' }}>heartbeats</div>
        {heartbeats.length === 0 && <div style={{ opacity: 0.5 }}>none yet</div>}
        {heartbeats.map((h, i) => (
          <div key={i} style={{ display: 'flex', gap: 8 }}>
            <span style={{ width: 90 }}>{new Date(h.timestamp).toLocaleTimeString()}</span>
            <span style={{ width: 60 }}>{h.state}</span>
            <span style={{ opacity: 0.6 }}>{h.rttMs ? `${h.rttMs}ms` : ''}</span>
          </div>
        ))}
      </section>
    </div>
  )
}
