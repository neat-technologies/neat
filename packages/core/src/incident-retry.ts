import type { ErrorEvent } from '@neat.is/types'
import { appendRuntimeIncident } from './durable-incident.js'

// When an incident can't be stored, everything else is kept and the lost incident
// is counted loudly (ruled by Deniz 2026-11-15, #1678; otel-ingest.md §Error events).
// Storing an incident is never a precondition for accepting the span batch or the
// connector poll it arrived in. A failed write is held in a small in-memory queue
// per project and retried until the sink takes it; when the queue is full the
// oldest held incident is dropped and counted. Pending and dropped counts are on
// /health, and the daemon log gets one line per state change, never one per
// incident.

/** Incidents held per project before the oldest is dropped. */
export const INCIDENT_RETRY_CAP = 200
/** How often held incidents are retried while the sink is failing. */
export const INCIDENT_RETRY_MS = 5_000

export interface IncidentSinkHealth {
  /** Incidents held in memory, waiting for the sink to take them. */
  pending: number
  /** Incidents lost since the daemon started: dropped from a full queue, or never built. */
  dropped: number
  /** True while the sink is refusing writes. */
  failing: boolean
}

type Write = (errorsPath: string, project: string, event: ErrorEvent) => Promise<void>

interface Held {
  errorsPath: string
  event: ErrorEvent
  onStored?: (event: ErrorEvent) => void
}

interface ProjectState {
  held: Held[]
  dropped: number
  failing: boolean
  /** Whether this failing spell has already logged that it is dropping. */
  droppingLogged: boolean
  storedThisSpell: number
  droppedThisSpell: number
  /** Whether a lost incident has been logged since the last stored one. */
  lostLogged: boolean
}

export interface IncidentRetryOptions {
  cap?: number
  retryMs?: number
  write?: Write
  log?: (line: string) => void
}

export class IncidentRetryQueue {
  private readonly cap: number
  private readonly retryMs: number
  private readonly write: Write
  private readonly log: (line: string) => void
  private readonly projects = new Map<string, ProjectState>()
  private timer: ReturnType<typeof setInterval> | undefined
  private draining: Promise<void> | undefined

  constructor(options: IncidentRetryOptions = {}) {
    this.cap = Math.max(1, options.cap ?? INCIDENT_RETRY_CAP)
    this.retryMs = options.retryMs ?? INCIDENT_RETRY_MS
    this.write = options.write ?? ((errorsPath, project, event) => appendRuntimeIncident(errorsPath, project, event))
    this.log = options.log ?? ((line) => console.error(line))
  }

  /**
   * Store one incident, or hold it for retry if the sink refuses it. Never throws.
   * Resolves true when the incident is stored now. `onStored` runs once the
   * incident is stored, now or on a later retry, and never for a dropped one.
   */
  async store(
    errorsPath: string,
    project: string,
    event: ErrorEvent,
    onStored?: (event: ErrorEvent) => void,
  ): Promise<boolean> {
    const state = this.stateOf(project)
    const entry: Held = { errorsPath, event, ...(onStored ? { onStored } : {}) }
    // While older incidents are held, a new one waits behind them, so the ledger
    // keeps arrival order and a failing sink isn't hit once per incident.
    if (state.held.length > 0) {
      this.hold(project, state, entry)
      return false
    }
    try {
      await this.write(errorsPath, project, event)
    } catch (error) {
      this.markFailing(project, state, error)
      this.hold(project, state, entry)
      return false
    }
    state.lostLogged = false
    stored(entry)
    return true
  }

  /**
   * Count an incident that was lost before it reached the sink (it could not be
   * built or routed). Logged once until the next incident for the project is stored.
   */
  lost(project: string, error: unknown): void {
    const state = this.stateOf(project)
    state.dropped++
    if (state.failing) state.droppedThisSpell++
    if (state.lostLogged) return
    state.lostLogged = true
    const reason = error instanceof Error ? error.message : String(error)
    this.log(`[neat] an incident for project ${project} could not be stored (${reason}) and was dropped; counted on /health`)
  }

  /** Pending and dropped counts for one project, or summed across every project. */
  health(project?: string): IncidentSinkHealth {
    const states = project === undefined ? [...this.projects.values()] : [this.projects.get(project)].filter(isState)
    return {
      pending: states.reduce((n, s) => n + s.held.length, 0),
      dropped: states.reduce((n, s) => n + s.dropped, 0),
      failing: states.some((s) => s.failing),
    }
  }

  /** Retry every held incident once, in order, stopping at a project's first refusal. */
  async retryNow(): Promise<void> {
    if (this.draining) return this.draining
    this.draining = this.drain().finally(() => {
      this.draining = undefined
      if (![...this.projects.values()].some((s) => s.held.length > 0)) this.stopTimer()
    })
    return this.draining
  }

  /** Drop every held incident and counter. For tests and daemon shutdown. */
  reset(): void {
    this.stopTimer()
    this.projects.clear()
  }

  private async drain(): Promise<void> {
    for (const [project, state] of this.projects) {
      while (state.held.length > 0) {
        const head = state.held[0]!
        try {
          await this.write(head.errorsPath, project, head.event)
        } catch {
          break
        }
        if (state.held[0] === head) {
          state.held.shift()
        } else {
          // The queue overflowed during the write and dropped this entry, which the sink took after all.
          state.dropped--
          state.droppedThisSpell--
        }
        state.storedThisSpell++
        stored(head)
      }
      if (state.failing && state.held.length === 0) this.recover(project, state)
    }
  }

  private hold(project: string, state: ProjectState, entry: Held): void {
    state.held.push(entry)
    while (state.held.length > this.cap) {
      state.held.shift()
      state.dropped++
      state.droppedThisSpell++
      if (!state.droppingLogged) {
        state.droppingLogged = true
        this.log(
          `[neat] incident retry queue for project ${project} is full (${this.cap}); dropping the oldest held incidents, counted on /health`,
        )
      }
    }
    this.startTimer()
  }

  private markFailing(project: string, state: ProjectState, error: unknown): void {
    if (state.failing) return
    state.failing = true
    state.storedThisSpell = 0
    state.droppedThisSpell = 0
    state.droppingLogged = false
    const reason = error instanceof Error ? error.message : String(error)
    this.log(
      `[neat] incident sink failing for project ${project} (${reason}); spans and connectors keep ingesting, incidents are held for retry (up to ${this.cap})`,
    )
  }

  private recover(project: string, state: ProjectState): void {
    state.failing = false
    this.log(
      `[neat] incident sink recovered for project ${project}; stored ${state.storedThisSpell} held incident(s), ${state.droppedThisSpell} dropped while it was failing`,
    )
  }

  private stateOf(project: string): ProjectState {
    let state = this.projects.get(project)
    if (!state) {
      state = { held: [], dropped: 0, failing: false, droppingLogged: false, storedThisSpell: 0, droppedThisSpell: 0, lostLogged: false }
      this.projects.set(project, state)
    }
    return state
  }

  private startTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.retryNow() }, this.retryMs)
    this.timer.unref?.()
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}

function stored(entry: Held): void {
  try {
    entry.onStored?.(entry.event)
  } catch {
    // A listener failing doesn't unstore the incident.
  }
}

function isState(state: ProjectState | undefined): state is ProjectState {
  return state !== undefined
}

/** The daemon's one queue. Every runtime incident write goes through it. */
export const incidentRetry = new IncidentRetryQueue()

/** Store a runtime incident through the daemon's queue. Never throws; see IncidentRetryQueue.store. */
export function storeRuntimeIncident(
  errorsPath: string,
  project: string,
  event: ErrorEvent,
  onStored?: (event: ErrorEvent) => void,
): Promise<boolean> {
  return incidentRetry.store(errorsPath, project, event, onStored)
}

/** Where an incident lost before its project was known is counted (the bare /v1/traces route). */
export const UNRESOLVED_INCIDENT_PROJECT = '(unresolved)'
