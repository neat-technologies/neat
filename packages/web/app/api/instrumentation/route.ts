import { endpointForProject } from '../../../lib/proxy'

// The two-mode observed overlay (GraphCanvas / ObservedOverlay) probes this to
// decide Mode A (instrumentation wired, idle) vs Mode B (didn't engage). The
// real diagnosis is the same signal the CLI prints (#547) and writes to
// errors.ndjson; ADR-101 resolves the selected profile's daemon and reads its
// ROOT `/instrumentation` endpoint where present.
//
// IMPORTANT (web-completeness #26 + file-awareness §4 honesty): when the daemon
// has no instrumentation-describe endpoint yet — or no daemon resolves — we
// return a NEUTRAL payload (`engaged: null`) rather than fabricating a
// diagnosis. The overlay defaults to Mode A on a neutral/absent signal, so we
// never wrongly accuse a healthy idle setup of "didn't engage." This is a soft
// probe — it never 502s into the toast bus.
export async function GET(request: Request): Promise<Response> {
  const project = new URL(request.url).searchParams.get('project')
  if (!project) {
    return Response.json({ engaged: null })
  }
  const endpoint = await endpointForProject(project)
  if (!endpoint) {
    return Response.json({ engaged: null })
  }
  try {
    const upstream = await fetch(`${endpoint}/instrumentation`, { cache: 'no-store' })
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
