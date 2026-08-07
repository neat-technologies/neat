// LogEntry -> ObservedSignal mapping (docs/connectors/cloud-run.md, ADR-165).
// One signal per request-log entry — no aggregation — so each concrete request
// stays traceable back to the raw log line it came from; the shared pipeline
// (connectors/index.ts) already replays a signal's callCount/errorCount as
// individual upserts, so nothing is lost by keeping this 1:1.

import type { ObservedSignal } from '../types.js'
import type { LogEntry } from './client.js'
import { CLOUD_RUN_TARGET_KIND, packCloudRunTargetName } from './types.js'

// Only the Cloud Run request-log resource. The filter (client.ts) already pins
// `resource.type = "cloud_run_revision"`, but the mapper never trusts the
// filter alone — a shape drift or a hand-supplied fixture entry of another
// resource type drops honestly rather than being mis-attributed.
const CLOUD_RUN_RESOURCE_TYPE = 'cloud_run_revision'

// `httpRequest.requestUrl` is documented as "typically without the scheme,
// host, port, and query portion" — usually already a bare path — but a
// deployment that logs a full absolute URL is handled too. Returns null when
// the value is neither a bare path nor a parseable absolute URL, the same
// "honest miss, never guessed" discipline `pathOf` uses in
// extract/calls/route-match.ts.
function pathFromRequestUrl(requestUrl: unknown): string | null {
  // Typed a string upstream, but this reads a raw Cloud Logging record — a
  // shape drift handing a number/object here drops honestly rather than
  // throwing on `.startsWith` (connectors.md §4).
  if (typeof requestUrl !== 'string' || requestUrl.length === 0) return null
  if (requestUrl.startsWith('/')) {
    const withoutQuery = requestUrl.split('?')[0]
    return withoutQuery && withoutQuery.length > 0 ? withoutQuery : '/'
  }
  try {
    const candidate = requestUrl.startsWith('//') ? `https:${requestUrl}` : requestUrl
    const parsed = new URL(candidate)
    return parsed.pathname || '/'
  } catch {
    return null
  }
}

// A response is counted as an error at the 5xx threshold — the same
// unambiguous-failure line ingest.ts draws for a failing HTTP response. A 4xx
// is a plausible client error, not necessarily a service defect, so it isn't
// counted here.
const ERROR_STATUS_THRESHOLD = 500

// Maps one Cloud Logging LogEntry to one ObservedSignal. Returns null for an
// entry this connector can't honestly attribute — a non-Cloud-Run resource, a
// resource with no `service_name` label, or an httpRequest missing the
// method/path a signal needs. Nothing here is guessed or fabricated.
export function mapLogEntryToSignal(entry: LogEntry | null | undefined): ObservedSignal | null {
  // A shape-drifted response can carry a null/garbage slot; drop it honestly
  // rather than throwing on `.resource` (connectors.md §4).
  if (!entry || typeof entry !== 'object') return null
  if (entry.resource?.type !== CLOUD_RUN_RESOURCE_TYPE) return null

  const serviceName = entry.resource?.labels?.['service_name']
  if (typeof serviceName !== 'string' || serviceName.length === 0) return null

  const req = entry.httpRequest
  if (!req) return null
  if (typeof req.requestMethod !== 'string' || req.requestMethod.length === 0) return null
  const method = req.requestMethod.toUpperCase()
  const path = pathFromRequestUrl(req.requestUrl)
  if (path === null) return null

  const timestamp = entry.timestamp
  if (typeof timestamp !== 'string' || timestamp.length === 0) return null

  const isError = typeof req.status === 'number' && req.status >= ERROR_STATUS_THRESHOLD

  return {
    targetKind: CLOUD_RUN_TARGET_KIND,
    targetName: packCloudRunTargetName({ serviceName, method, path }),
    callCount: 1,
    errorCount: isError ? 1 : 0,
    lastObservedIso: timestamp,
  }
}

export function mapLogEntriesToSignals(entries: LogEntry[]): ObservedSignal[] {
  const out: ObservedSignal[] = []
  for (const entry of entries) {
    const signal = mapLogEntryToSignal(entry)
    if (signal) out.push(signal)
  }
  return out
}
