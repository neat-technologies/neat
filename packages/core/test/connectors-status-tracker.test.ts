import { describe, it, expect, beforeEach } from 'vitest'
import {
  CONNECTOR_STALE_THRESHOLD_MS,
  getConnectorStatus,
  recordConnectorPoll,
  resetConnectorStatus,
  sanitizePollError,
} from '../src/connectors/status.js'

// docs/contracts/connectors.md §8 / ADR-136 — the in-process poll-status
// tracker. The poll loop writes on every tick; the connector-status endpoint
// reads. State is derived at read time from the raw record + wall clock.

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

describe('connector poll-status tracker', () => {
  beforeEach(() => resetConnectorStatus())

  it('reports idle with null fields for an id that has never polled', () => {
    expect(getConnectorStatus('cf-prod')).toEqual({
      state: 'idle',
      lastPollAt: null,
      lastOutcome: null,
      lastError: null,
      signalsLastPoll: 0,
    })
  })

  it('records a successful tick as healthy, carrying the signal count', () => {
    const at = iso(0)
    recordConnectorPoll('cf-prod', { outcome: 'ok', at, signalsLastPoll: 12 })
    expect(getConnectorStatus('cf-prod')).toEqual({
      state: 'healthy',
      lastPollAt: at,
      lastOutcome: 'ok',
      lastError: null,
      signalsLastPoll: 12,
    })
  })

  it('records a failing tick as error, keeping the message and zeroing signals', () => {
    const at = iso(0)
    recordConnectorPoll('cf-prod', { outcome: 'error', at, error: 'cloudflare auth check returned HTTP 500' })
    const status = getConnectorStatus('cf-prod')
    expect(status.state).toBe('error')
    expect(status.lastOutcome).toBe('error')
    expect(status.lastError).toBe('cloudflare auth check returned HTTP 500')
    expect(status.signalsLastPoll).toBe(0)
    expect(status.lastPollAt).toBe(at)
  })

  it('derives stale when the last successful poll is beyond the threshold', () => {
    const at = iso(0)
    recordConnectorPoll('cf-prod', { outcome: 'ok', at, signalsLastPoll: 3 })
    // Within the window: healthy.
    const now = Date.parse(at)
    expect(getConnectorStatus('cf-prod', now + CONNECTOR_STALE_THRESHOLD_MS - 1).state).toBe('healthy')
    // Past the window with no newer successful tick: stale.
    expect(getConnectorStatus('cf-prod', now + CONNECTOR_STALE_THRESHOLD_MS + 1).state).toBe('stale')
  })

  it('reports stale from a real old timestamp against the default threshold', () => {
    recordConnectorPoll('cf-prod', { outcome: 'ok', at: iso(-(CONNECTOR_STALE_THRESHOLD_MS + 60_000)) })
    expect(getConnectorStatus('cf-prod').state).toBe('stale')
  })

  it('lets error win over stale — a fresh throw is the more actionable signal', () => {
    // A success long ago, then a failing tick now: the endpoint should surface
    // the error, not the age.
    recordConnectorPoll('cf-prod', { outcome: 'ok', at: iso(-(CONNECTOR_STALE_THRESHOLD_MS + 60_000)) })
    recordConnectorPoll('cf-prod', { outcome: 'error', at: iso(0), error: 'boom' })
    expect(getConnectorStatus('cf-prod').state).toBe('error')
  })

  it('advances healthy again after a recovering success following an error', () => {
    recordConnectorPoll('cf-prod', { outcome: 'error', at: iso(-1000), error: 'transient' })
    recordConnectorPoll('cf-prod', { outcome: 'ok', at: iso(0), signalsLastPoll: 5 })
    const status = getConnectorStatus('cf-prod')
    expect(status.state).toBe('healthy')
    expect(status.lastError).toBeNull()
    expect(status.signalsLastPoll).toBe(5)
  })

  it('tracks each connector id independently', () => {
    recordConnectorPoll('cf-prod', { outcome: 'ok', at: iso(0), signalsLastPoll: 1 })
    recordConnectorPoll('supabase-brief', { outcome: 'error', at: iso(0), error: 'nope' })
    expect(getConnectorStatus('cf-prod').state).toBe('healthy')
    expect(getConnectorStatus('supabase-brief').state).toBe('error')
    expect(getConnectorStatus('railway-api').state).toBe('idle')
  })

  it('sanitizePollError collapses whitespace and truncates long messages', () => {
    expect(sanitizePollError(new Error('one\n  two   three'))).toBe('one two three')
    const long = 'x'.repeat(500)
    const out = sanitizePollError(new Error(long))
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out.endsWith('…')).toBe(true)
    expect(sanitizePollError('a plain string')).toBe('a plain string')
  })
})
