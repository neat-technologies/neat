// SSE handler for the frontend-facing event stream (ADR-051 #1).
// Subscribes to the bus in events.ts, filters by project, writes
// `event: <type>\ndata: <json>\n\n` frames to the client. An initial
// `:open\n\n` comment goes out at the handshake so EventSource opens
// right away instead of waiting on the first event or heartbeat.
//
// Backpressure: per-connection queue cap of 1000 outstanding writes; once
// hit, the connection is dropped with `event: error data: { reason:
// 'backpressure' }` per ADR-051 #8. Heartbeat: comment line every 30s
// keeps proxies from idle-timing out (ADR-051 #3).

import type { FastifyReply, FastifyRequest } from 'fastify'
import { readFileSync, statSync } from 'node:fs'
import { z } from 'zod'
import { ErrorEventSchema, IncidentEventPayloadSchema, incidentKindOf } from '@neat.is/types'
import {
  EVENT_BUS_CHANNEL,
  eventBus,
  type NeatEventEnvelope,
} from './events.js'

export const SSE_HEARTBEAT_MS = 30_000
export const SSE_BACKPRESSURE_CAP = 1000

export interface HandleSseOptions {
  project: string
  heartbeatMs?: number
  backpressureCap?: number
  incidentOnly?: boolean
  incidentReplay?: z.infer<typeof IncidentTriggerSchema>[]
}

export const INCIDENT_TRIGGER_STREAM_SCOPE = 'incident-only-v1'
const IncidentTriggerSchema = IncidentEventPayloadSchema.extend({
  incidentId: z.string().regex(/^[A-Za-z0-9:_-]{1,100}$/),
  affectedNode: z.string().min(1).max(512),
  service: z.string().min(1).max(256),
  at: z.string().datetime(),
})

const MAX_REPLAY_BYTES = 16 * 1024 * 1024
const MAX_REPLAY_EVENTS = 10_000

/** Read the append-ordered incident ledger before opening a hosted stream.
 * Any corruption, missing cursor, or oversized ledger fails closed. The
 * source-bearing ErrorEvents are decoded only inside the daemon.
 */
export function loadIncidentReplay(errorsPath: string, cursor?: string): z.infer<typeof IncidentTriggerSchema>[] {
  if (cursor !== undefined && !/^[A-Za-z0-9:_-]{1,100}$/.test(cursor)) throw new Error('incident replay unavailable')
  try {
    if (statSync(errorsPath).size > MAX_REPLAY_BYTES) throw new Error('incident replay unavailable')
    const raw = readFileSync(errorsPath, 'utf8')
    if (raw && !raw.endsWith('\n')) throw new Error('incident replay unavailable')
    const seen = new Map<string, string>()
    const events: z.infer<typeof IncidentTriggerSchema>[] = []
    for (const line of raw.split('\n')) {
      if (!line) continue
      if (events.length >= MAX_REPLAY_EVENTS) throw new Error('incident replay unavailable')
      const event = ErrorEventSchema.parse(JSON.parse(line) as unknown)
      const trigger = IncidentTriggerSchema.parse({incidentId:event.id,affectedNode:event.affectedNode,
        service:event.service,incidentKind:incidentKindOf(event),at:event.timestamp})
      const prior = seen.get(trigger.incidentId), encoded = JSON.stringify(trigger)
      if (prior !== undefined) {
        if (prior !== encoded) throw new Error('incident replay unavailable')
        continue
      }
      seen.set(trigger.incidentId, encoded)
      events.push(trigger)
    }
    if (cursor === undefined) return events
    const at = events.findIndex(event => event.incidentId === cursor)
    if (at < 0) throw new Error('incident replay unavailable')
    return events.slice(at + 1)
  } catch { throw new Error('incident replay unavailable') }
}

export function handleSse(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: HandleSseOptions,
): void {
  const heartbeatMs = opts.heartbeatMs ?? SSE_HEARTBEAT_MS
  const backpressureCap = opts.backpressureCap ?? SSE_BACKPRESSURE_CAP

  reply.raw.setHeader('Content-Type', 'text/event-stream')
  reply.raw.setHeader('Cache-Control', 'no-cache, no-transform')
  reply.raw.setHeader('Connection', 'keep-alive')
  reply.raw.setHeader('X-Accel-Buffering', 'no')
  if (opts.incidentOnly) {
    reply.raw.setHeader('X-NEAT-Event-Scope', INCIDENT_TRIGGER_STREAM_SCOPE)
    reply.raw.setHeader('X-NEAT-Project', opts.project)
    if (opts.incidentReplay) reply.raw.setHeader('X-NEAT-Replay-Complete', '1')
  }
  reply.raw.flushHeaders?.()

  // Flushing headers leaves the response body empty, so the browser's
  // EventSource stays in CONNECTING (readyState 0) until the first body byte
  // lands — which, on a quiet graph, is the first real event or the 30s
  // heartbeat, whichever comes first. Write a comment line right away so the
  // stream opens at the handshake and EventSource fires onopen immediately.
  // A colon-prefixed comment is a no-op per the SSE spec (clients ignore it,
  // same as the heartbeat), so it sits outside the locked ADR-051 taxonomy.
  // Written raw, bypassing the backpressure accounting below, exactly like
  // the heartbeat does.
  reply.raw.write(':open\n\n')
  for (const trigger of opts.incidentReplay ?? []) {
    reply.raw.write(`id: ${trigger.incidentId}\nevent: incident\ndata: ${JSON.stringify(trigger)}\n\n`)
  }

  let pending = 0
  let dropped = false

  const closeConnection = (): void => {
    if (dropped) return
    dropped = true
    eventBus.off(EVENT_BUS_CHANNEL, listener)
    clearInterval(heartbeat)
    if (!reply.raw.writableEnded) reply.raw.end()
  }

  const writeFrame = (frame: string): void => {
    if (dropped) return
    if (pending >= backpressureCap) {
      // Past the cap — emit one final error frame and drop. Don't try to
      // gracefully drain; a slow consumer that's already 1000 frames behind
      // is not going to catch up.
      const errFrame = `event: error\ndata: ${JSON.stringify({ reason: 'backpressure' })}\n\n`
      reply.raw.write(errFrame)
      closeConnection()
      return
    }
    pending++
    reply.raw.write(frame, () => {
      pending = Math.max(0, pending - 1)
    })
  }

  const listener = (envelope: NeatEventEnvelope): void => {
    if (envelope.project !== opts.project) return
    if (opts.incidentOnly) {
      if (envelope.type !== 'incident') return
      const trigger = IncidentTriggerSchema.safeParse(envelope.payload)
      if (!trigger.success) return
      writeFrame(`id: ${trigger.data.incidentId}\nevent: incident\ndata: ${JSON.stringify(trigger.data)}\n\n`)
      return
    }
    writeFrame(`event: ${envelope.type}\ndata: ${JSON.stringify(envelope.payload)}\n\n`)
  }

  eventBus.on(EVENT_BUS_CHANNEL, listener)

  const heartbeat = setInterval(() => {
    if (dropped) return
    reply.raw.write(':heartbeat\n\n')
  }, heartbeatMs)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  req.raw.on('close', closeConnection)
  reply.raw.on('close', closeConnection)
  reply.raw.on('error', closeConnection)
}
