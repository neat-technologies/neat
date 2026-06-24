import { CORE_URL } from '../../../lib/proxy'

// The two-mode observed overlay (GraphCanvas / ObservedOverlay) probes this to
// decide Mode A (instrumentation wired, idle) vs Mode B (didn't engage). The
// real diagnosis is the same signal the CLI prints (#547) and writes to
// errors.ndjson; the daemon surfaces it under /projects/<name>/instrumentation
// where that endpoint exists.
//
// IMPORTANT (web-completeness #26 + file-awareness §4 honesty): when the daemon
// has no instrumentation-describe endpoint yet, we return a NEUTRAL payload
// (`engaged: null`) rather than fabricating a diagnosis. The overlay defaults
// to Mode A on a neutral/absent signal, so we never wrongly accuse a healthy
// idle setup of "didn't engage." This is a soft probe — it never 502s into the
// toast bus.
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url)
  const project = searchParams.get('project')
  if (!project) {
    return Response.json({ engaged: null })
  }
  const path = `/projects/${encodeURIComponent(project)}/instrumentation`
  try {
    const upstream = await fetch(`${CORE_URL}${path}`, { cache: 'no-store' })
    if (!upstream.ok) {
      // endpoint absent / not implemented on this daemon — neutral, Mode A.
      return Response.json({ engaged: null })
    }
    const body = await upstream.text()
    return new Response(body, {
      status: 200,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    })
  } catch {
    return Response.json({ engaged: null })
  }
}
