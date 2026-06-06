'use client'

// Public-facing daemon URL string. Browsers don't get NEAT_API_URL directly —
// the Next.js server routes proxy at /api/* — but the operator wants to see
// which daemon is on the other end (ADR-058 #5). This is the human-readable
// label, not a fetched URL.
export const CORE_URL_PUBLIC: string =
  (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_NEAT_API_URL) ||
  'localhost:8080'

// Tiny pub-sub for transient surfaces (toasts, debug-panel call log).
type Subscriber<T> = (value: T) => void

class Channel<T> {
  private subs = new Set<Subscriber<T>>()
  subscribe(fn: Subscriber<T>): () => void {
    this.subs.add(fn)
    return () => {
      this.subs.delete(fn)
    }
  }
  emit(value: T): void {
    this.subs.forEach((fn) => {
      try {
        fn(value)
      } catch {
        /* never let a subscriber kill the bus */
      }
    })
  }
}

export interface ToastEvent {
  id: number
  level: 'error' | 'warn' | 'info'
  message: string
  status?: number
  timestamp: number
}

export interface ApiCallEvent {
  path: string
  status: number
  durationMs: number
  timestamp: number
}

export interface SseEvent {
  type: string
  timestamp: number
}

export interface ConnectionEvent {
  state: 'ok' | 'slow' | 'down'
  rttMs?: number
  timestamp: number
}

export const toastBus = new Channel<ToastEvent>()
export const apiCallBus = new Channel<ApiCallEvent>()
export const sseEventBus = new Channel<SseEvent>()
export const connectionBus = new Channel<ConnectionEvent>()

let toastIdCounter = 0
function nextId(): number {
  toastIdCounter += 1
  return toastIdCounter
}

// Suppress duplicate toasts when multiple parallel requests fail with the
// same error at once (e.g. four requests all returning 404 on a missing project).
const recentToasts = new Map<string, number>()
const TOAST_DEDUP_MS = 2000
function isDuplicateToast(status: number, message: string): boolean {
  const key = `${status}:${message}`
  const last = recentToasts.get(key)
  if (last && Date.now() - last < TOAST_DEDUP_MS) return true
  recentToasts.set(key, Date.now())
  return false
}

// ADR-058 #3 — every non-2xx fetch surfaces a toast carrying the error
// envelope from ADR-040 (`{ error, status, details? }`). Wrap raw `fetch`
// instead of editing every call-site so the rule is centralized.
export async function trackedFetch(input: string, init?: RequestInit): Promise<Response> {
  const start = performance.now()
  let status = 0
  try {
    const res = await fetch(input, init)
    status = res.status
    if (!res.ok) {
      let message = `${input} → ${res.status}`
      try {
        const cloned = res.clone()
        const ct = cloned.headers.get('content-type') ?? ''
        if (ct.includes('application/json')) {
          const body = (await cloned.json()) as { error?: string; details?: string }
          if (body?.error) {
            message = body.error + (body.details ? ` — ${body.details}` : '')
          }
        }
      } catch {
        /* fall back to the default message */
      }
      if (!isDuplicateToast(res.status, message)) toastBus.emit({
        id: nextId(),
        level: res.status >= 500 ? 'error' : 'warn',
        message,
        status: res.status,
        timestamp: Date.now(),
      })
    }
    return res
  } catch (err) {
    toastBus.emit({
      id: nextId(),
      level: 'error',
      message: `${input} — ${(err as Error).message}`,
      timestamp: Date.now(),
    })
    throw err
  } finally {
    apiCallBus.emit({
      path: input,
      status,
      durationMs: Math.round(performance.now() - start),
      timestamp: Date.now(),
    })
  }
}
