// Connector poll-status tracker — the in-process record of each connector's
// most recent poll tick (docs/contracts/connectors.md §8, ADR-136).
//
// The connector poll loop (`startConnectorPollLoop`, index.ts) writes here on
// EVERY tick, success and failure; the connector-status endpoint
// (`GET /:project/connectors`, api.ts) reads here. A process-local module
// singleton is the right shape for the same reason `logs-store.ts` is: this is
// live runtime state, not graph or snapshot state — a daemon restart loses it
// and re-derives it on the next poll, exactly the "OBSERVED is a live signal,
// not an archive" trade the rest of the connectors plane already makes.
//
// Nothing here ever holds a credential. The tracker records an id, an outcome,
// a short error string, a signal count, and timestamps — the resolved secret
// stays inside the `ConnectorContext` that flows to `poll()` and never reaches
// this module (connectors.md §6, connector-config.md §6).

import type { ConnectorPollState, ConnectorStatus } from '@neat.is/types'

// A connector polls on a 60s default cadence (`DEFAULT_POLL_INTERVAL_MS`,
// index.ts). Five intervals of silence is the point past which "hasn't polled
// recently" is worth surfacing as `stale` rather than a healthy connector that
// simply hasn't ticked yet. This is a connector-poll concept, deliberately
// distinct from the per-edge-type OBSERVED→STALE thresholds (ingest.ts) — those
// decay graph edges; this flags a poll loop that has gone quiet or wedged.
export const CONNECTOR_STALE_THRESHOLD_MS = 5 * 60_000

// One connector's last recorded tick. `lastOkAt` is kept separately from
// `lastPollAt` so a run of failing ticks can still tell how long it has been
// since the connector last actually succeeded — that gap is what `stale` reads.
interface PollRecord {
  lastPollAt: string
  lastOutcome: 'ok' | 'error'
  lastError: string | null
  signalsLastPoll: number
  lastOkAt: string | null
}

const records = new Map<string, PollRecord>()

const MAX_ERROR_LEN = 200

/**
 * Reduce a poll error to a short, single-line string safe to expose on the
 * status endpoint. Collapses whitespace and truncates — a poll error carries a
 * provider name and HTTP status, never a credential (the junction's own error
 * strings are secret-free by construction, connectors/registry.ts §authProbe),
 * and the truncation caps any accidental verbosity.
 */
export function sanitizePollError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const collapsed = msg.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_ERROR_LEN ? `${collapsed.slice(0, MAX_ERROR_LEN - 1)}…` : collapsed
}

export interface PollTick {
  outcome: 'ok' | 'error'
  // The tick's own start time, ISO8601.
  at: string
  // Signals the tick returned — recorded on a successful tick, 0 otherwise.
  signalsLastPoll?: number
  // Short, secret-free message on a failing tick; ignored on a successful one.
  error?: string | null
}

/**
 * Record one poll tick for connector `id`. Called by the poll loop on every
 * tick. A successful tick advances `lastOkAt`; a failing tick leaves the prior
 * `lastOkAt` in place so `stale` still measures time-since-last-success.
 */
export function recordConnectorPoll(id: string, tick: PollTick): void {
  const prev = records.get(id)
  records.set(id, {
    lastPollAt: tick.at,
    lastOutcome: tick.outcome,
    lastError: tick.outcome === 'error' ? (tick.error ?? null) : null,
    signalsLastPoll: tick.signalsLastPoll ?? 0,
    lastOkAt: tick.outcome === 'ok' ? tick.at : (prev?.lastOkAt ?? null),
  })
}

// Derive the reported state from the raw record + wall clock. `error` wins over
// `stale` because "the last tick threw" is the fresher, more actionable signal;
// `stale` is for a connector whose last *success* has aged out of the window
// (a loop that stopped ticking, so no fresh error either).
function deriveState(rec: PollRecord, now: number, thresholdMs: number): ConnectorPollState {
  if (rec.lastOutcome === 'error') return 'error'
  const okAt = rec.lastOkAt ? Date.parse(rec.lastOkAt) : NaN
  if (!Number.isNaN(okAt) && now - okAt > thresholdMs) return 'stale'
  return 'healthy'
}

/**
 * The live status for connector `id`. An id with no recorded tick is `idle`
 * with null timestamps — the honest "configured but not yet polled" state, the
 * same shape the endpoint returns for a freshly added connector. `now` and
 * `thresholdMs` are injectable for deterministic tests.
 */
export function getConnectorStatus(
  id: string,
  now: number = Date.now(),
  thresholdMs: number = CONNECTOR_STALE_THRESHOLD_MS,
): ConnectorStatus {
  const rec = records.get(id)
  if (!rec) {
    return {
      state: 'idle',
      lastPollAt: null,
      lastOutcome: null,
      lastError: null,
      signalsLastPoll: 0,
    }
  }
  return {
    state: deriveState(rec, now, thresholdMs),
    lastPollAt: rec.lastPollAt,
    lastOutcome: rec.lastOutcome,
    lastError: rec.lastError,
    signalsLastPoll: rec.signalsLastPoll,
  }
}

/** Drop every recorded status. Test-only — the daemon never clears mid-run. */
export function resetConnectorStatus(): void {
  records.clear()
}
