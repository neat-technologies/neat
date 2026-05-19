'use client'

import { useEffect, useState } from 'react'
import type { GraphData } from './AppShell'
import {
  CORE_URL_PUBLIC,
  connectionBus,
  sseEventBus,
  type ConnectionEvent,
  type SseEvent,
} from '../../lib/proxy-client'
import { authedFetch } from '../../lib/authed-fetch'

const ENV_TOOLTIP =
  "Each NEAT instance has its own graph. Local sees your dev environment; remote sees what you've deployed it to."

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

export function EnvironmentIndicator() {
  const [hostname, setHostname] = useState<string | null>(null)

  useEffect(() => {
    setHostname(window.location.hostname)
  }, [])

  if (hostname === null) return null

  const local = isLocalHost(hostname)
  const label = local ? 'local' : `remote · ${hostname}`
  const bg = local ? 'rgba(95,207,158,0.18)' : 'rgba(216,165,84,0.20)'
  const fg = local ? 'var(--prov-observed)' : '#d8a554'
  const border = local ? 'rgba(95,207,158,0.35)' : 'rgba(216,165,84,0.45)'

  return (
    <div className="st-item" data-env-state={local ? 'local' : 'remote'}>
      <span
        className="env-chip"
        data-testid="env-chip"
        style={{
          background: bg,
          color: fg,
          border: `1px solid ${border}`,
          borderRadius: 999,
          padding: '1px 8px',
          fontSize: 10.5,
          letterSpacing: 0.2,
        }}
      >
        {label}
      </span>
      <span
        className="env-info"
        role="img"
        aria-label={ENV_TOOLTIP}
        title={ENV_TOOLTIP}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          opacity: 0.6,
          cursor: 'help',
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5" />
          <circle cx="12" cy="16.5" r="0.6" fill="currentColor" />
        </svg>
      </span>
    </div>
  )
}

interface StatusBarProps {
  project: string
  graphData: GraphData | null
}

// ADR-073 §3 — the operator can drop the bearer they pasted at /login and
// land back on the login surface without poking devtools. Hidden when no
// token is in storage (e.g. operator behind a reverse proxy terminating
// auth — NEXT_PUBLIC_NEAT_AUTH_PROXY=true).
export function SignOutButton() {
  const [hasToken, setHasToken] = useState(false)

  useEffect(() => {
    try {
      setHasToken(!!window.localStorage.getItem('neat:authToken'))
    } catch {
      /* private mode — keep hidden */
    }
  }, [])

  if (!hasToken) return null

  function onSignOut(): void {
    try {
      window.localStorage.removeItem('neat:authToken')
    } catch {
      /* ignore */
    }
    window.location.href = '/login'
  }

  return (
    <div className="st-item">
      <button
        type="button"
        onClick={onSignOut}
        data-testid="sign-out"
        title="Clear the bearer token and return to the login screen"
        style={{
          background: 'rgba(255,255,255,0.04)',
          color: 'var(--paper-3)',
          border: '1px solid var(--rule)',
          borderRadius: 999,
          padding: '1px 8px',
          fontSize: 10.5,
          letterSpacing: 0.2,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        sign out
      </button>
    </div>
  )
}

type ConnState = 'ok' | 'slow' | 'down'
type SseState = 'connected' | 'reconnecting' | 'disconnected'

function formatTime(d: Date): string {
  return d.toTimeString().slice(0, 8) + ' ' + d.toTimeString().slice(9, 12)
}

export function StatusBar({ project, graphData }: StatusBarProps) {
  const [now, setNow] = useState(() => formatTime(new Date()))
  // ADR-058 #1 — daemon connection state visible. Tracks /health latency
  // and consecutive failures.
  const [connState, setConnState] = useState<ConnState>('down')
  // ADR-058 #2 — SSE state visible.
  const [sseState, setSseState] = useState<SseState>('disconnected')
  const [healthy, setHealthy] = useState<boolean | null>(null)

  useEffect(() => {
    const id = setInterval(() => setNow(formatTime(new Date())), 1000)
    return () => clearInterval(id)
  }, [])

  // ADR-058 #1 — heartbeat every 5s; classify latency.
  useEffect(() => {
    let consecutiveFailures = 0
    const SLOW_MS = 800
    const DOWN_FAILS = 2

    async function check(): Promise<void> {
      const start = performance.now()
      try {
        const r = await authedFetch('/api/health', { cache: 'no-store' })
        const rtt = Math.round(performance.now() - start)
        const ok = r.ok
        if (!ok) {
          consecutiveFailures += 1
          const next: ConnState = consecutiveFailures >= DOWN_FAILS ? 'down' : 'slow'
          setConnState(next)
          setHealthy(false)
          connectionBus.emit({ state: next, rttMs: rtt, timestamp: Date.now() })
          return
        }
        consecutiveFailures = 0
        const next: ConnState = rtt > SLOW_MS ? 'slow' : 'ok'
        setConnState(next)
        setHealthy(true)
        connectionBus.emit({ state: next, rttMs: rtt, timestamp: Date.now() })
      } catch {
        consecutiveFailures += 1
        const next: ConnState = consecutiveFailures >= DOWN_FAILS ? 'down' : 'slow'
        setConnState(next)
        setHealthy(false)
        connectionBus.emit({ state: next, timestamp: Date.now() })
      }
    }

    void check()
    const id = setInterval(() => void check(), 5_000)
    return () => clearInterval(id)
  }, [project])

  // ADR-058 #2 — track SSE connection state. EventSource auto-reconnects
  // per spec; we surface the state transitions.
  useEffect(() => {
    const sse = new EventSource('/api/events')
    setSseState('reconnecting')

    sse.onopen = () => {
      setSseState('connected')
    }
    sse.onerror = () => {
      // EventSource toggles readyState; readyState 0 = CONNECTING (reconnect),
      // 2 = CLOSED.
      setSseState(sse.readyState === EventSource.CLOSED ? 'disconnected' : 'reconnecting')
    }

    function record(type: string): (e: MessageEvent) => void {
      return () => {
        sseEventBus.emit({ type, timestamp: Date.now() })
      }
    }
    sse.addEventListener('node-added', record('node-added'))
    sse.addEventListener('edge-added', record('edge-added'))
    sse.addEventListener('node-removed', record('node-removed'))
    sse.addEventListener('edge-removed', record('edge-removed'))

    return () => sse.close()
  }, [])

  const nodeCount = graphData?.nodes.length ?? '—'
  const edgeCount = graphData?.edges.length ?? '—'

  // ADR-058 #1 — `data-connection-state` is a stable attribute the contract
  // test asserts. The colour classes follow.
  const connColor: Record<ConnState, string> = {
    ok: 'var(--prov-observed)',
    slow: '#d3a847',
    down: '#e87a7a',
  }
  const sseColor: Record<SseState, string> = {
    connected: 'var(--prov-observed)',
    reconnecting: '#d3a847',
    disconnected: '#e87a7a',
  }

  // Suppress unused-var warnings for buses imported above so we keep the
  // module-side effect (event subscriptions in DebugPanel are wired).
  void connectionBus
  void sseEventBus
  type _typecheck = ConnectionEvent | SseEvent
  void (null as unknown as _typecheck)

  return (
    <footer className="status">
      <div
        className="st-item"
        data-connection-state={connState}
        title={`daemon @ ${CORE_URL_PUBLIC} — ${connState}`}
      >
        <span className="dot" style={{ background: connColor[connState] }} />
        <span className="k">neat</span>
        <span className="v">{project}</span>
      </div>
      <div className="st-item" data-sse-state={sseState} title={`live updates: ${sseState}`}>
        <span className="dot" style={{ background: sseColor[sseState] }} />
        <span className="k">sse</span>
        <span className="v">{sseState}</span>
      </div>
      <EnvironmentIndicator />
      <SignOutButton />
      <div className="st-item">
        <span className="k">nodes</span>
        <span className="v" id="st-nodes">{nodeCount}</span>
      </div>
      <div className="st-item">
        <span className="k">edges</span>
        <span className="v" id="st-edges">{edgeCount}</span>
      </div>
      {healthy === false && (
        <div className="st-item">
          <span className="k" style={{ color: '#e87a7a' }}>core offline</span>
        </div>
      )}

      <div className="st-spacer" />

      <div className="scrub">
        <span className="k">t</span>
        <div className="bar">
          <div className="fill" />
          <div className="head" />
        </div>
        <span className="now">now ⌐ {now}</span>
      </div>
    </footer>
  )
}
