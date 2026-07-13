'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { authedFetch } from '../../lib/authed-fetch'
import {
  readProfileToken,
  writeProfileToken,
  clearProfileToken,
} from '../../lib/active-profile'
import type { Profile } from '../../lib/resolve-project'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'

// ---------------------------------------------------------------------------
// Settings page (ADR-135, web-shell.md §4) — the last `kind: 'todo'` nav entry
// graduates. Three real sections, each the same code path its scattered
// counterpart already used, not a link out to it:
//
//   Project    — the same `selectProfile` action TopBar's popover calls.
//   Connection — a live /api/health + SSE poll, mirroring StatusBar.
//   Token      — lib/active-profile.ts's read/write/clear, the same functions
//                /login and StatusBar's sign-out already call. Update
//                validates against /api/health before storing, same round
//                trip LoginForm runs.
// ---------------------------------------------------------------------------

interface SettingsPageProps {
  project: string | null
  profiles: Profile[]
  onSelectProfile: (p: Profile) => void
}

type ConnState = 'ok' | 'slow' | 'down'
type SseState = 'connected' | 'reconnecting' | 'disconnected'
type TokenFormState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'error'; message: string } | { kind: 'saved' }

const ERR_WRONG_TOKEN = "That token doesn't match this NEAT instance."
const ERR_NETWORK = "Can't reach the daemon; check the URL."

export function SettingsPage({ project, profiles, onSelectProfile }: SettingsPageProps) {
  const [connState, setConnState] = useState<ConnState>('down')
  const [rtt, setRtt] = useState<number | null>(null)
  const [sseState, setSseState] = useState<SseState>('disconnected')
  const [hasToken, setHasToken] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [tokenForm, setTokenForm] = useState<TokenFormState>({ kind: 'idle' })

  // Connection state — the same classification StatusBar uses, its own poll
  // (TopBar already runs an independent one for its dot; a third reader of
  // the same idempotent endpoint is the established pattern, not a new one).
  useEffect(() => {
    if (!project) return
    const proj = project
    let consecutiveFailures = 0
    const SLOW_MS = 800
    const DOWN_FAILS = 2

    async function check(): Promise<void> {
      const start = performance.now()
      try {
        const r = await authedFetch(`/api/health?project=${encodeURIComponent(proj)}`, { cache: 'no-store' })
        const elapsed = Math.round(performance.now() - start)
        if (!r.ok) {
          if (r.status === 404) return
          consecutiveFailures += 1
          setConnState(consecutiveFailures >= DOWN_FAILS ? 'down' : 'slow')
          setRtt(null)
          return
        }
        consecutiveFailures = 0
        setConnState(elapsed > SLOW_MS ? 'slow' : 'ok')
        setRtt(elapsed)
      } catch {
        consecutiveFailures += 1
        setConnState(consecutiveFailures >= DOWN_FAILS ? 'down' : 'slow')
        setRtt(null)
      }
    }

    void check()
    const id = setInterval(() => void check(), 5_000)
    return () => clearInterval(id)
  }, [project])

  useEffect(() => {
    if (!project) return
    const sse = new EventSource(`/api/events?project=${encodeURIComponent(project)}`)
    setSseState('reconnecting')
    let errorStreak = 0
    const MAX_ERRORS = 5
    sse.onopen = () => {
      errorStreak = 0
      setSseState('connected')
    }
    sse.onerror = () => {
      errorStreak += 1
      if (errorStreak >= MAX_ERRORS) {
        sse.close()
        setSseState('disconnected')
        return
      }
      setSseState(sse.readyState === EventSource.CLOSED ? 'disconnected' : 'reconnecting')
    }
    return () => sse.close()
  }, [project])

  useEffect(() => {
    setHasToken(!!readProfileToken(project))
    setTokenInput('')
    setTokenForm({ kind: 'idle' })
  }, [project])

  async function handleTokenSave(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    const trimmed = tokenInput.trim()
    if (!trimmed || !project) return
    setTokenForm({ kind: 'saving' })

    let res: Response
    try {
      res = await fetch(`/api/health?project=${encodeURIComponent(project)}`, {
        headers: { Authorization: `Bearer ${trimmed}` },
        cache: 'no-store',
      })
    } catch {
      setTokenForm({ kind: 'error', message: ERR_NETWORK })
      return
    }
    if (res.status === 401) {
      setTokenForm({ kind: 'error', message: ERR_WRONG_TOKEN })
      return
    }
    if (!res.ok) {
      setTokenForm({ kind: 'error', message: `Daemon returned ${res.status}; try again.` })
      return
    }

    writeProfileToken(project, trimmed)
    setHasToken(true)
    setTokenInput('')
    setTokenForm({ kind: 'saved' })
  }

  function handleTokenClear(): void {
    clearProfileToken(project)
    setHasToken(false)
    setTokenForm({ kind: 'idle' })
  }

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

  return (
    <div className="page-scroll">
      <header className="page-head">
        <h1 className="page-title">Settings</h1>
        <p className="page-sub">Project, daemon connection, and token — consolidated in one place.</p>
      </header>

      <section className="page-section">
        <div className="page-section-head">
          <h2>Project</h2>
          <Badge variant="secondary" className="ml-2">live</Badge>
        </div>
        {profiles.length === 0 ? (
          <div className="page-empty">no running daemons discovered</div>
        ) : (
          <table className="page-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Project</th>
                <th>Endpoint</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => {
                const active = p.project === project
                return (
                  <tr key={p.project}>
                    <td>
                      <Badge variant={p.status === 'stopped' ? 'outline' : 'secondary'}>
                        {p.status ?? 'running'}
                      </Badge>
                    </td>
                    <td className="td-mono">{p.project}</td>
                    <td className="td-mono">{p.endpoint}</td>
                    <td>
                      {active ? (
                        <span className="td-mono">active</span>
                      ) : (
                        <button
                          className="td-link"
                          disabled={p.status === 'stopped'}
                          onClick={() => onSelectProfile(p)}
                          title={p.status === 'stopped' ? 'daemon is stopped' : `Switch to ${p.project}`}
                        >
                          switch
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="page-section">
        <div className="page-section-head">
          <h2>Daemon connection</h2>
          <Badge variant="secondary" className="ml-2">live</Badge>
        </div>
        {!project ? (
          <div className="page-empty">no project resolved</div>
        ) : (
          <table className="page-table">
            <tbody>
              <tr>
                <td className="td-mono">health</td>
                <td>
                  <span className="dot" style={{ background: connColor[connState], marginRight: 8 }} />
                  {connState}
                  {rtt !== null ? ` · ${rtt}ms` : ''}
                </td>
              </tr>
              <tr>
                <td className="td-mono">live updates (sse)</td>
                <td>
                  <span className="dot" style={{ background: sseColor[sseState], marginRight: 8 }} />
                  {sseState}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </section>

      <section className="page-section">
        <div className="page-section-head">
          <h2>Token</h2>
          <Badge variant="secondary" className="ml-2">live</Badge>
        </div>
        {!project ? (
          <div className="page-empty">no project resolved</div>
        ) : (
          <>
            <p className="page-note">
              This profile {hasToken ? 'has a bearer token set.' : 'has no bearer token set.'}
            </p>
            <form onSubmit={handleTokenSave} className="settings-token-form">
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={hasToken ? 'update token…' : 'paste a token…'}
                value={tokenInput}
                onChange={(e) => {
                  setTokenInput(e.target.value)
                  if (tokenForm.kind === 'error' || tokenForm.kind === 'saved') setTokenForm({ kind: 'idle' })
                }}
                aria-invalid={tokenForm.kind === 'error'}
                aria-label="Bearer token"
              />
              <button
                type="submit"
                className="settings-btn"
                disabled={tokenForm.kind === 'saving' || tokenInput.trim().length === 0}
              >
                {tokenForm.kind === 'saving' ? 'checking…' : 'save'}
              </button>
              {hasToken && (
                <button type="button" className="settings-btn" onClick={handleTokenClear}>
                  clear
                </button>
              )}
            </form>
            {tokenForm.kind === 'error' && (
              <div role="alert" className="page-empty" style={{ color: '#e87a7a' }}>
                {tokenForm.message}
              </div>
            )}
            {tokenForm.kind === 'saved' && <div className="page-note">token saved.</div>}
          </>
        )}
      </section>
    </div>
  )
}
