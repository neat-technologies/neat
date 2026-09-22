import { describe, it, expect } from 'vitest'
import { buildErrorEventForReceiver } from '../src/ingest.js'
import type { ParsedSpan } from '../src/otel.js'

// A failing span whose instrumentation copied request/response headers into the
// span attributes wholesale — the shape a `...req.headers` spread produces —
// alongside the attribution and status keys ingest actually reads.
function spanWithLeakedHeaders(): ParsedSpan {
  return {
    service: 'orders-api',
    traceId: 'trace-1',
    spanId: 'span-1',
    name: 'POST /orders',
    kind: 2, // SERVER
    startTimeUnixNano: '0',
    endTimeUnixNano: '0',
    durationNanos: 0n,
    startTimeIso: '2026-09-22T12:00:00.000Z',
    statusCode: 2,
    attributes: {
      // Credentials that must never persist.
      'http.request.header.cookie': 'session=secret-session',
      'http.request.header.authorization': 'Bearer secret-token',
      'http.request.header.Authorization': 'Bearer secret-token', // case-insensitive
      'http.response.header.set-cookie': 'session=rotated; HttpOnly',
      'http.request.header.x-api-key': 'sk-live-123',
      authorization: 'Bearer bare-token', // bare, unprefixed form
      // Context ingest and the contract rely on — all must survive.
      'code.filepath': 'app/orders.py',
      'code.lineno': 42,
      'http.route': '/orders',
      'http.response.status_code': 500,
      'rpc.grpc.status_code': 13,
      'http.response.header.content-type': 'application/json',
      'http.request.header.upgrade': 'websocket',
    },
  }
}

describe('ingest drops credential header attributes before persisting an incident', () => {
  it('scrubs authorization / cookie / set-cookie / api-key from the persisted attributes', () => {
    const ev = buildErrorEventForReceiver(spanWithLeakedHeaders())
    expect(ev).not.toBeNull()
    const attrs = ev!.attributes ?? {}

    // No credential in any form survives.
    expect(attrs['http.request.header.cookie']).toBeUndefined()
    expect(attrs['http.request.header.authorization']).toBeUndefined()
    expect(attrs['http.request.header.Authorization']).toBeUndefined()
    expect(attrs['http.response.header.set-cookie']).toBeUndefined()
    expect(attrs['http.request.header.x-api-key']).toBeUndefined()
    expect(attrs['authorization']).toBeUndefined()
    // Belt and braces: no persisted value carries a known secret.
    const dumped = JSON.stringify(attrs)
    expect(dumped).not.toContain('secret-session')
    expect(dumped).not.toContain('secret-token')
    expect(dumped).not.toContain('sk-live-123')
    expect(dumped).not.toContain('bare-token')
  })

  it('keeps code attribution, status, content-type, and the websocket upgrade header', () => {
    const ev = buildErrorEventForReceiver(spanWithLeakedHeaders())!
    const attrs = ev.attributes ?? {}
    expect(attrs['code.filepath']).toBe('app/orders.py')
    expect(attrs['code.lineno']).toBe(42)
    expect(attrs['http.route']).toBe('/orders')
    expect(attrs['rpc.grpc.status_code']).toBe(13)
    expect(attrs['http.response.header.content-type']).toBe('application/json')
    // The websocket upgrade header is a header attribute but not a credential —
    // otel.ts reads it to derive a channel, so it must survive the scrub.
    expect(attrs['http.request.header.upgrade']).toBe('websocket')
  })
})
