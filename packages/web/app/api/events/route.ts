import { NextRequest } from 'next/server'
import { endpointForProject } from '../../../lib/proxy'

// ADR-101 — the SSE stream comes from the selected profile's daemon at the ROOT
// (`/events`, no `/projects/:name` prefix). The `?project=<label>` only selects
// which daemon (endpoint); it is not a backend path segment.
export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url)
  const project = url.searchParams.get('project')
  const endpoint = await endpointForProject(project)
  // ADR-073 §3 — carry the operator's bearer through to the daemon. Without
  // this, every SSE attempt against a bearer-protected daemon comes back 401
  // and the dashboard's "sse: reconnecting" chip never resolves.
  //
  // EventSource can't set request headers, so the browser passes the bearer as
  // the `access_token` query param (authedEventSourceUrl). Promote it to the
  // Authorization header here so the token reaches the daemon as a header, not
  // a query string — preferring a real Authorization header if one is present.
  const headers: Record<string, string> = { Accept: 'text/event-stream' }
  const auth = request.headers.get('authorization')
  const tokenParam = url.searchParams.get('access_token')
  if (auth) headers.Authorization = auth
  else if (tokenParam) headers.Authorization = `Bearer ${tokenParam}`
  const lastEventId = request.headers.get('last-event-id')
  if (lastEventId) headers['Last-Event-ID'] = lastEventId
  // No discovered daemon for this profile — emit a single unavailable event and
  // close, the same shape the unreachable path below uses.
  if (!endpoint) {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('event: error\ndata: {"reason":"unavailable"}\n\n'),
        )
        controller.close()
      },
    })
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    })
  }
  try {
    const upstream = await fetch(`${endpoint}/events`, {
      cache: 'no-store',
      headers,
    })

    if (!upstream.ok || !upstream.body) {
      // Core doesn't have SSE yet (pre-v0.2.8) — send a single unavailable event and close
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('event: error\ndata: {"reason":"unavailable"}\n\n'),
          )
          controller.close()
        },
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      })
    }

    // Wrap the upstream body so we (a) flush headers immediately with a
    // keep-alive comment — the daemon emits nothing until a graph event,
    // and otherwise the Next.js runtime buffers our response indefinitely,
    // leaving the client `EventSource` stuck without `onopen` — and
    // (b) emit a periodic comment so the underlying HTTP connection
    // doesn't get clipped at the runtime's 5s idle timeout, which causes
    // EventSource to fire `onerror` and reconnect on a tight loop. Both
    // are ignored by `EventSource` per the SSE spec.
    const encoder = new TextEncoder()
    const reader = upstream.body.getReader()
    let heartbeat: ReturnType<typeof setInterval> | null = null
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': connected\n\n'))
        // 3s is well inside the Node runtime's 5s idle timeout that
        // otherwise clips a quiet upstream and forces EventSource into a
        // tight reconnect loop.
        heartbeat = setInterval(() => {
          try { controller.enqueue(encoder.encode(': keepalive\n\n')) } catch {}
        }, 3_000)
        function pump(): void {
          reader.read().then(({ done, value }) => {
            if (done) {
              if (heartbeat) clearInterval(heartbeat)
              controller.close()
              return
            }
            if (value) controller.enqueue(value)
            pump()
          }).catch(() => {
            if (heartbeat) clearInterval(heartbeat)
            try { controller.close() } catch {}
          })
        }
        pump()
      },
      cancel() {
        if (heartbeat) clearInterval(heartbeat)
        reader.cancel().catch(() => {})
      },
    })
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
      },
    })
  } catch {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('event: error\ndata: {"reason":"unavailable"}\n\n'),
        )
        controller.close()
      },
    })
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    })
  }
}
